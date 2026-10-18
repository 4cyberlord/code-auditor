import assert from "node:assert/strict";
import { reconcileProblemEvidence, stripExampleBlocks, evidenceJudgeBrief, visionEvidenceSystemPrompt } from "../src/lib/problemEvidence.ts";

const context = "Compute the sum.\nExample 1:\nInput: nums = [1,2]\nOutput: 99\nConstraints:\nThe input is an integer array.";
const screenshot = "Example 1:\nInput: nums = [1,2]\nOutput: 3";
const alternate = "Example 1:\nInput: nums = [1,2]\nOutput: 3";
const trusted = reconcileProblemEvidence(context, true, [screenshot, alternate]);
assert.equal(trusted.status, "corroborated");
assert.equal(trusted.fixtures.length, 1);
assert.equal(trusted.fixtures[0].output, "3");
assert.ok(!trusted.question.includes("Output: 99"));
assert.match(trusted.question, /Output: 3/);
assert.match(trusted.question, /Constraints:/);
assert.match(evidenceJudgeBrief(trusted), /Confirmed literal sample/);

const conflict = reconcileProblemEvidence(context, true, [screenshot,
  "Example 1:\nInput: nums = [1,2]\nOutput: 4"]);
assert.equal(conflict.status, "uncertain");
assert.equal(conflict.fixtures.length, 0);
assert.ok(conflict.disagreements.some(item => item.includes("Conflicting")));
assert.ok(!conflict.question.includes("Output: 99"));
assert.ok(!conflict.question.includes("Output: 3"));
const single = reconcileProblemEvidence(context, true, [screenshot]);
assert.equal(single.status, "uncertain");
assert.equal(single.fixtures.length, 0);
const unreadable = reconcileProblemEvidence(context, true, ["NO_CONFIRMED_EXAMPLES", "NO_CONFIRMED_EXAMPLES"]);
assert.equal(unreadable.fixtures.length, 0);
const typed = reconcileProblemEvidence(context, false, []);
assert.equal(typed.status, "text");
assert.equal(typed.fixtures[0].output, "99");
assert.ok(!stripExampleBlocks(context).includes("Output: 99"));
assert.match(visionEvidenceSystemPrompt(), /Never solve the problem/);
console.log("PASS: original screenshot examples need independent consensus, disputed OCR cannot create E2B expectations");
