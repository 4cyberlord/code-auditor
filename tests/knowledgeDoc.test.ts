/**
 * Markdown in, record out, and back again.
 *
 * The Knowledge tab's whole premise is that you write prose and the library
 * gets structure. That only holds if the parser is forgiving about how people
 * actually write and strict about what reaches a model — so these are mostly
 * documents written slightly wrong.
 */
import { markdownToRecord, recordToMarkdown, blankDocument, slugify } from "../src/lib/knowledgeDoc.ts";
import { allKnowledgeRecords, knowledgePackFor } from "../src/lib/knowledge.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const DOC = `---
id: two-pointers
kind: pattern
tags: array, two-pointers, sorted
complexity: O(n) after the sort
runtime: 0
memory: 10
---
# Two pointers on sorted input

Walk both ends inward instead of scanning every pair.

## Guidance
- Sort first when the input is not already sorted.
- Decide what happens when both pointers see equal values.

## Sources
- cp-algorithms — https://cp-algorithms.com/two-pointers.html — reference — the canonical write-up
`;

console.log("\n1. a written document becomes a record");
{
  const { record, problems } = markdownToRecord(DOC);
  check("nothing to fix", problems.length === 0, JSON.stringify(problems));
  check("id, kind and tags come from the front matter", record.id === "two-pointers" && record.kind === "pattern" && record.tags.length === 3);
  check("the heading is the title", record.title === "Two pointers on sorted input", record.title);
  check("the prose under it is the summary", record.summary.startsWith("Walk both ends"), record.summary);
  check("the bullets are the guidance", record.guidance.length === 2, JSON.stringify(record.guidance));
  check("targets arrive as numbers", record.targetRuntimeMs === 0 && record.targetMemoryMb === 10);
  check("the source is parsed whole", record.sources?.[0]?.trust === "reference" && record.sources?.[0]?.note.includes("canonical"), JSON.stringify(record.sources));
}

console.log("\n2. a record survives the round trip");
{
  for (const original of allKnowledgeRecords().slice(0, 6)) {
    const { record } = markdownToRecord(recordToMarkdown(original));
    const same =
      record.id === original.id &&
      record.title === original.title &&
      record.kind === original.kind &&
      record.tags.join("|") === original.tags.join("|") &&
      record.guidance.join("|") === original.guidance.join("|") &&
      record.summary.trim() === original.summary.trim() &&
      record.targetRuntimeMs === original.targetRuntimeMs &&
      record.targetMemoryMb === original.targetMemoryMb;
    check(`round trip: ${original.id}`, same, JSON.stringify({ was: original, now: record }));
  }
  // The point of the round trip: an imported record can be edited and saved
  // without quietly losing a field nobody looked at.
  const imported = markdownToRecord(recordToMarkdown(allKnowledgeRecords()[0])).record;
  check(
    "and it still retrieves",
    knowledgePackFor(imported.tags.join(" "), 3, [imported]).includes(imported.title),
    imported.title
  );
}

console.log("\n3. documents written slightly wrong still parse, and say what is missing");
{
  const noFront = markdownToRecord("# Sliding window\n\nKeep a window and move it.\n\n## Guidance\n- Shrink from the left.\n");
  check("no front matter is fine", noFront.record.title === "Sliding window" && noFront.record.guidance.length === 1);
  check("the id is made from the title", noFront.record.id === "sliding-window", noFront.record.id);
  check("but the missing tags are named", noFront.problems.some((p) => p.includes("tags")), JSON.stringify(noFront.problems));

  const noGuidance = markdownToRecord("# Bare\n\nA summary and nothing else.\n");
  check("a record with no guidance is flagged", noGuidance.problems.some((p) => p.includes("Guidance")), JSON.stringify(noGuidance.problems));

  const badKind = markdownToRecord("---\nkind: opinion\ntags: x\n---\n# T\n\nS\n\n## Guidance\n- g\n");
  check("an unknown kind falls back and says so", badKind.record.kind === "pattern" && badKind.problems.some((p) => p.includes("opinion")));

  const markdownLink = markdownToRecord(
    "---\ntags: x\n---\n# T\n\nS\n\n## Guidance\n- g\n\n## Sources\n- [Node docs](https://nodejs.org/api/perf_hooks.html) — official — timing\n"
  );
  check("a markdown link is a source too", markdownLink.record.sources?.[0]?.url === "https://nodejs.org/api/perf_hooks.html", JSON.stringify(markdownLink.record.sources));

  const noUrl = markdownToRecord("---\ntags: x\n---\n# T\n\nS\n\n## Guidance\n- g\n\n## Sources\n- something I half remember\n");
  check("a source with no URL is dropped, and counted", !noUrl.record.sources && noUrl.problems.some((p) => p.includes("URL")), JSON.stringify(noUrl.problems));

  const badRuntime = markdownToRecord("---\ntags: x\nruntime: fast\n---\n# T\n\nS\n\n## Guidance\n- g\n");
  check("a runtime that is not a number is named, not guessed", badRuntime.record.targetRuntimeMs === undefined && badRuntime.problems.some((p) => p.includes("runtime")));
}

console.log("\n4. collections");
{
  const doc = `---
id: s3-lifecycle
collection: AWS
kind: pattern
tags: storage, cost
---
# S3 lifecycle rules

Move objects to cheaper classes on a schedule rather than by hand.

## Guidance
- Transition to Infrequent Access at 30 days when reads are rare.
`;
  const parsed = markdownToRecord(doc);
  check("the collection is read", parsed.category === "AWS", parsed.category);
  // It is also a retrieval signal: twelve records under "AWS" have said
  // something about themselves that no individual tag on them says.
  check("and it searches like a tag", parsed.record.tags.includes("aws"), JSON.stringify(parsed.record.tags));
  check("but it is not doubled up", parsed.record.tags.filter((t) => t === "aws").length === 1);
  check(
    "it survives the round trip",
    markdownToRecord(recordToMarkdown(parsed.record, parsed.category)).category === "AWS",
    recordToMarkdown(parsed.record, parsed.category).slice(0, 80)
  );
  check("a record with no collection has none", markdownToRecord("# T\n\nS\n\n## Guidance\n- g\n").category === "");
  check("`category:` is accepted as a synonym", markdownToRecord("---\ncategory: Postgres\ntags: x\n---\n# T\n\nS\n\n## Guidance\n- g\n").category === "Postgres");
}

console.log("\n5. the blank document is a shape, not an empty page");
{
  const { record, problems } = markdownToRecord(blankDocument());
  check("it parses", typeof record.id === "string");
  check("and it tells you what to fill in", problems.length >= 2, JSON.stringify(problems));
  check("slugs stay filename-safe", slugify("Two Pointers & Windows!") === "two-pointers-windows", slugify("Two Pointers & Windows!"));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall knowledge document checks passed\n");
process.exit(fail ? 1 : 0);
