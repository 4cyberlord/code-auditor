import { parseVerdict, highlights } from "../src/lib/verdict.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const CLEAN = `VERDICT: They agree, and the agreed answer is right.
CORRECT: GPT, Claude, Kimi
WHY: The brute-force answer is O(n^2) and times out at n=10^4.
APPROACH: One-pass hash map storing each value's index, looking up the complement
before inserting. That ordering is what stops an element pairing with itself.
EFFICIENCY: O(n) time — one pass with O(1) amortised lookups. O(n) space — the map
holds up to n entries.
STYLE: Clear names. The trailing return is unreachable given the guarantee; raising
would fail louder if the guarantee were ever wrong.
BEST ANSWER: def twoSum(...)`;

console.log("\n1. the format the judge is asked for");
{
  const v = parseVerdict(CLEAN);
  check("verdict", v.verdict.startsWith("They agree"));
  check("correct", v.correct === "GPT, Claude, Kimi");
  check("why mentions the complexity", v.why.includes("O(n^2)"));
  check("approach spans its wrapped lines", v.approach.includes("pairing with itself"), v.approach);
  check("efficiency", v.efficiency.includes("O(n) time"));
  check("style", v.style.includes("unreachable"));
  check("best answer", v.best.includes("twoSum"));
  check("no stray preamble", v.preamble === "", v.preamble);
}

console.log("\n2. the ways a model drifts from it");
{
  const bolded = parseVerdict("**VERDICT:** fine\n**APPROACH:** hash map\n**EFFICIENCY:** O(n)");
  check("bold labels", bolded.approach === "hash map", bolded.approach);
  check("bold verdict", bolded.verdict === "fine");

  const lower = parseVerdict("verdict: ok\napproach: two pointers");
  check("lower case labels", lower.approach === "two pointers", lower.approach);

  const listed = parseVerdict("- VERDICT: ok\n- STYLE: tidy");
  check("list markers", listed.style === "tidy", listed.style);

  const aliased = parseVerdict("COMPLEXITY: O(1)\nCODE STYLE: neat");
  check("COMPLEXITY counts as efficiency", aliased.efficiency === "O(1)");
  check("CODE STYLE counts as style", aliased.style === "neat");

  const chatty = parseVerdict("Let me work through this.\n\nVERDICT: they agree");
  check("thinking aloud is kept as preamble", chatty.preamble.includes("work through"));
  check("and does not pollute the verdict", chatty.verdict === "they agree");
}

console.log("\n3. when it ignores the format entirely");
{
  const freeform = parseVerdict("All three are correct and I would ship the second one.");
  check("nothing is lost", freeform.verdict.includes("ship the second"));
  check("and it is not double-counted", freeform.preamble === "");

  const empty = parseVerdict("");
  check("empty in, empty out", empty.verdict === "" && highlights(empty).length === 0);
  check("whitespace only", parseVerdict("   \n\n ").verdict === "");
}

console.log("\n4. the highlight strip");
{
  const all = highlights(parseVerdict(CLEAN));
  check("three sections", all.length === 3, String(all.length));
  check("approach first", all[0].label === "Approach");
  check("efficiency second", all[1].label === "Efficiency");
  check("style last", all[2].label === "Code style");

  // A judge that skipped one must not leave an empty green box behind.
  const partial = highlights(parseVerdict("VERDICT: ok\nEFFICIENCY: O(n)"));
  check("empty sections are dropped", partial.length === 1 && partial[0].label === "Efficiency");
}

console.log("\n5. a colon in the body does not start a new section");
{
  const v = parseVerdict("APPROACH: use a map: value -> index\nEFFICIENCY: O(n)");
  check("kept whole", v.approach === "use a map: value -> index", v.approach);
  check("next label still found", v.efficiency === "O(n)");
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall verdict checks passed\n");
process.exit(fail ? 1 : 0);
