import assert from "node:assert/strict";
import { reconcileProblemEvidence, stripExampleBlocks, visionEvidenceSystemPrompt } from "../src/lib/problemEvidence.ts";

const original = "Find the sum of two numbers.\nExample 1:\nInput: nums = [1, 2]\nOutput: 3\nConstraints:\n1 <= nums.length <= 10";
const correct = "Example 1:\nInput: nums = [1, 2]\nOutput: 3";
const incorrect = "Example 1:\nInput: nums = [1, 2]\nOutput: 7";
const unordered = "Task.\nExample 1:\nInput: x = [1, 2]\nOutput: [2, 1]\nExplanation: Output may be in any order.";

const typed = reconcileProblemEvidence(original, false, []);
assert.equal(typed.status, "text");
assert.equal(typed.fixtures.length, 1);

const verified = reconcileProblemEvidence(original, true, [correct, correct]);
assert.equal(verified.status, "corroborated");
assert.equal(verified.fixtures.length, 1);
assert.equal(verified.fixtures[0].output, "3");
assert.match(verified.question, /Constraints:/);

for (const readers of [[correct], [correct, incorrect], [correct, ""], ["", ""]]) {
  const uncertain = reconcileProblemEvidence(original, true, readers);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.fixtures.length, 0);
  assert.equal(uncertain.question.includes("Output: 3"), false,
    "uncorroborated OCR expected answers must never reach the executable harness");
}
const whitespaceDisagreement = reconcileProblemEvidence("Task.", true, [
  "Example 1:\nInput: x = 1\nOutput: ['a  b']",
  "Example 1:\nInput: x = 1\nOutput: ['a b']",
]);
assert.equal(whitespaceDisagreement.fixtures.length, 0,
  "distinct literal string outputs must not be collapsed into agreement");
assert.match(stripExampleBlocks(unordered), /Multiple valid outputs/,
  "non-unique output constraints must survive removal of the screenshot sample");
assert.doesNotMatch(stripExampleBlocks(original), /Input:\s*nums/);
assert.match(visionEvidenceSystemPrompt(), /ORIGINAL screenshots/);
assert.match(visionEvidenceSystemPrompt(), /Never solve the problem/);
console.log("PASS: screenshot examples require independently corroborated vision evidence");
