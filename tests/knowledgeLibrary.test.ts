/**
 * The two shelves the library can be read from.
 *
 * The rule under test is the one that matters in production: a database that is
 * empty, malformed or unreachable costs a run its newest guidance and nothing
 * else. Every path here ends with a usable library.
 */
import {
  recordsFromRows,
  loadKnowledgeLibrary,
  resetKnowledgeCache,
  bundledLibrary,
  type RecordRow,
} from "../src/lib/knowledgeLibrary.ts";
import { knowledgePackFor } from "../src/lib/knowledge.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const row = (over: Partial<RecordRow> = {}): RecordRow => ({
  id: "two-pointers",
  title: "Two pointers on sorted input",
  kind: "pattern",
  summary: "Walk both ends inward instead of scanning pairs.",
  guidance: ["Sort first when the input is not sorted.", "Watch the equal-element case."],
  tags: ["array", "two-pointers", "sorted"],
  complexity: "O(n) after the sort",
  target_runtime_ms: 0,
  target_memory_mb: 10,
  source_urls: ["https://example.org/two-pointers"],
  ...over,
});

console.log("\n1. rows become records, and bad rows are dropped rather than repaired");
{
  const records = recordsFromRows(
    [
      row(),
      row({ id: "no-guidance", guidance: [] }),
      row({ id: "bad-kind", kind: "opinion" }),
      row({ id: "", title: "nameless" }),
    ],
    [{ title: "Two pointers", url: "https://example.org/two-pointers", note: "reference", trust: "reference" }]
  );
  check("only the sound row survived", records.length === 1 && records[0].id === "two-pointers", JSON.stringify(records.map((r) => r.id)));
  check("numbers arrive as numbers", records[0].targetRuntimeMs === 0 && records[0].targetMemoryMb === 10);
  check("sources are joined by url", records[0].sources?.[0]?.title === "Two pointers", JSON.stringify(records[0].sources));
  // A record with half its guidance missing is worse in a prompt than one
  // fewer record, which is why the drop is silent and total.
  check("a record with no guidance is not half-filed", !records.some((r) => r.id === "no-guidance"));
}

console.log("\n2. a loaded library is what retrieval searches");
{
  resetKnowledgeCache();
  const library = await loadKnowledgeLibrary({
    fetchRows: async (table) => (table === "intelligence_records" ? [row()] : []),
    now: 1_000,
  });
  check("the database was used", library.source === "database", library.source);
  const pack = knowledgePackFor("two pointers on a sorted array", 3, library.records);
  check("and its records reach the pack", pack.includes("Walk both ends inward"), pack.slice(0, 120));
  // The bundled pack does not know this record, so the two shelves are
  // provably different — which is the whole reason the run records which one.
  check("the bundle would not have found it", !knowledgePackFor("two pointers on a sorted array", 3).includes("Walk both ends inward"));
}

console.log("\n3. every failure degrades to the bundle, and says why");
{
  const bundled = bundledLibrary().records.length;

  resetKnowledgeCache();
  const down = await loadKnowledgeLibrary({
    fetchRows: async () => {
      throw new Error("ECONNREFUSED");
    },
    now: 2_000,
  });
  check("an unreachable database still yields a library", down.source === "bundle" && down.records.length === bundled);
  check("and the reason travels with it", down.note.includes("ECONNREFUSED"), down.note);

  resetKnowledgeCache();
  const empty = await loadKnowledgeLibrary({ fetchRows: async () => [], now: 3_000 });
  check("an empty table is not a library of nothing", empty.source === "bundle" && empty.records.length === bundled);

  resetKnowledgeCache();
  const none = await loadKnowledgeLibrary({ now: 4_000 });
  check("no transport at all is fine too", none.source === "bundle", none.note);

  resetKnowledgeCache();
  const forced = await loadKnowledgeLibrary({ preferBundle: true, fetchRows: async () => [row()], now: 5_000 });
  check("and the bundle can be demanded outright", forced.source === "bundle", forced.source);
}

console.log("\n4. loaded once per process, not once per lookup");
{
  resetKnowledgeCache();
  let calls = 0;
  const fetchRows = async (table: string) => {
    if (table === "intelligence_records") calls += 1;
    return table === "intelligence_records" ? [row()] : [];
  };
  await loadKnowledgeLibrary({ fetchRows, ttlMs: 60_000, now: 10_000 });
  await loadKnowledgeLibrary({ fetchRows, ttlMs: 60_000, now: 20_000 });
  await loadKnowledgeLibrary({ fetchRows, ttlMs: 60_000, now: 40_000 });
  check("three jobs, one query", calls === 1, `${calls} queries`);
  await loadKnowledgeLibrary({ fetchRows, ttlMs: 60_000, now: 90_000 });
  check("and it refreshes once the TTL passes", calls === 2, `${calls} queries`);
  // The cost worth avoiding is the round trip, not the search: retrieval over
  // the loaded array is about a millisecond either way.
  resetKnowledgeCache();
  let failures = 0;
  const flaky = async (table: string) => {
    // Both tables are asked for on every load; only the records query says
    // whether the loader tried again.
    if (table === "intelligence_records") failures += 1;
    throw new Error("down");
  };
  await loadKnowledgeLibrary({ fetchRows: flaky, now: 100_000 });
  await loadKnowledgeLibrary({ fetchRows: flaky, now: 100_100 });
  check("a failure is never cached", failures === 2, `${failures} attempts`);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall knowledge library checks passed\n");
process.exit(fail ? 1 : 0);
