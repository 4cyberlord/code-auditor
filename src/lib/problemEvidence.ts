import { extractProvidedFixtures, type ProvidedFixture } from "./providedCaseHarness.ts";

/** Independent screenshot evidence, separate from solver or AI-authored harness output. */
export interface ProblemEvidence {
  status: "text" | "corroborated" | "uncertain";
  question: string;
  fixtures: ProvidedFixture[];
  disagreements: string[];
  reviewers: number;
}
const norm = (value: string) => value.replace(/\r\n/g, "\n").trim();
/**
 * Remove unlabeled/uncorroborated sample blocks before any model may construct
 * expected values for a test harness. Never send an ambiguous screenshot example
 * back as though it were the user's authoritative expected result.
 */
export function stripExampleBlocks(question: string): string {
  const out: string[] = [];
  let inExample = false;
  for (const line of String(question || "").split(/\r?\n/)) {
    if (/^\s*(?:example|sample|test\s*case)\s*\d*\s*:/i.test(line)) { inExample = true; continue; }
    if (inExample && /^\s*(?:constraints|requirements|notes?|function\s+signature|input\s+format|output\s+format)\s*:/i.test(line))
      inExample = false;
    if (inExample) continue;
    if (/^\s*(?:input|output|expected\s*output|explanation)\s*:/i.test(line)) continue;
    out.push(line);
  }
  // Preserve non-unique answer semantics even if the warning appeared only in
  // a screenshot's Example/Explanation block. Exact equality would be unsafe.
  if (/\b(?:any order|any valid|multiple valid|in any order|arbitrary order|order does not matter|in.place modification|do not return anything)\b/i.test(question)) {
    out.push("Multiple valid outputs may exist; do not impose exact sample-output equality.");
  }
  return out.join("\n").trim();
}
const id = (item: ProvidedFixture) => norm(item.input);
const pair = (item: ProvidedFixture) => JSON.stringify([norm(item.input), norm(item.output)]);
function casesText(fixtures: ProvidedFixture[]): string {
  return fixtures.map((item, index) =>
    "Example " + (index + 1) + ":\nInput: " + item.input + "\nOutput: " + item.output
  ).join("\n\n");
}
/**
 * Screenshot assertions require two distinct, successful vision readers to
 * independently agree on the exact input AND output. An AI's generated example
 * or a single OCR reading can never satisfy this gate. This is an agreement
 * check, not a proof of semantic correctness or hidden-case coverage.
 *
 * If there is no screenshot, the user's typed examples remain authoritative.
 */
export function reconcileProblemEvidence(
  question: string, hasImages: boolean, independentVisionReadings: readonly string[],
): ProblemEvidence {
  const original = String(question || "");
  if (!hasImages) return {
    status: "text", question: original, fixtures: extractProvidedFixtures(original),
    disagreements: [], reviewers: 0,
  };
  const readings = independentVisionReadings.map(text => extractProvidedFixtures(text))
    .filter(cases => cases.length > 0);
  if (readings.length < 2) return {
    status: "uncertain",
    question: stripExampleBlocks(original) + "\n\nScreenshot examples unconfirmed; derive independent tests only from unambiguous requirements.",
    fixtures: [], reviewers: readings.length,
    disagreements: ["Fewer than two independent vision readers confirmed labelled input/output examples."],
  };
  const [first, ...others] = readings;
  const confirmed = first.filter(item => others.every(list => list.some(candidate => pair(candidate) === pair(item))));
  // If an identical input has competing outputs, it is never authoritative.
  const conflicts = new Set<string>();
  for (const list of readings) for (const item of list) {
    if (readings.some(other => other.some(candidate => id(candidate) === id(item) && pair(candidate) !== pair(item))))
      conflicts.add(id(item));
  }
  const unique = [...new Map(confirmed.filter(item => !conflicts.has(id(item)))
    .map(item => [pair(item), item] as const)).values()]
    .map((item, index) => ({...item, id: "provided_" + (index + 1)}));
  const union = new Set(readings.flat().map(pair));
  const disagreements = [...conflicts].map(input => "Conflicting expected output for input: " + input.slice(0, 160));
  if (union.size > unique.length)
    disagreements.push("Some screenshot examples were omitted because the independent readers did not agree.");
  return {
    status: unique.length ? "corroborated" : "uncertain",
    question: [stripExampleBlocks(original), unique.length ? casesText(unique) :
      "Screenshot examples unconfirmed; derive independent tests only from unambiguous requirements."].filter(Boolean).join("\n\n"),
    fixtures: unique, disagreements, reviewers: readings.length,
  };
}
export function visionEvidenceSystemPrompt(): string {
  return [
    "You are an independent evidence reader, NOT a solver. Inspect the ORIGINAL screenshots.",
    "Copy only literal sample INPUT and OUTPUT pairs visibly printed in the question.",
    "Never solve the problem, run code, calculate missing outputs or invent test cases.",
    "For every unambiguous visible pair output exactly Example N:, Input:, Output: on separate lines.",
    "If any symbol, constraint, input or output is unreadable or conflicting, omit that pair.",
    "If no unambiguous example is visible, answer NO_CONFIRMED_EXAMPLES.",
  ].join("\n");
}
export function evidenceJudgeBrief(evidence: ProblemEvidence): string {
  return [
    "INDEPENDENT SCREENSHOT EVIDENCE: " + evidence.status,
    "Confirmed literal sample input/output pairs: " + evidence.fixtures.length,
    ...evidence.fixtures.map(c => c.id + " INPUT " + c.input + " EXPECTED " + c.output),
    ...evidence.disagreements.map(s => "UNCERTAINTY: " + s),
    "Evaluate code against the original screenshot when vision is verified. Only actual E2B runs establish test passes.",
  ].join("\n").slice(0, 6500);
}
