import assert from "node:assert/strict";
import { HARNESS_REGISTRY, bestTemplate, describeHarnessSupport } from "../src/lib/harnessRegistry.ts";

for (const template of HARNESS_REGISTRY) {
  assert.ok(template.id && template.description);
  assert.ok(template.languages.length > 0, template.id + " needs a language");
  assert.ok(template.materialises.length > 0, template.id + " must say what it can build");
}

assert.equal(bestTemplate("cpp", "callable-vector")?.id, "native.callable-vector");
assert.equal(bestTemplate("python", "stdin")?.id, "stdin.wrapper");
assert.equal(bestTemplate("go", "stdin"), undefined);

assert.equal(describeHarnessSupport("python", true, false).templateId, "python.callable-vector");
assert.equal(describeHarnessSupport("rust", true, false).templateId, "native.callable-vector");
assert.equal(describeHarnessSupport("java", true, false).supported, false);
assert.match(describeHarnessSupport("python", false, false).reason, /no recognizable/);
assert.match(describeHarnessSupport("java", true, false).reason, /no adapter/);

console.log("PASS: certified templates are declared and refusals are explained");

// Certification is only meaningful if a builder actually reaches each certified
// template. Representative problems cover every family.
import { buildProvidedHarness } from "../src/lib/providedCaseHarness.ts";

const callQ = ["Sum", "Example 1:", "Input: a = 1, b = 2", "Output: 3"].join("\n");
const listQ = ["Reverse", "Example 1:", "Input: head = [1,2]", "Output: [2,1]"].join("\n");
const stdinQ2 = ["Echo", "Example 1:", "Input: 2", "Output: 2", "Read from standard input"].join("\n");
const vecQ = ["Two Sum", "Example 1:", "Input: nums = [2,7], target = 9", "Output: [0,1]"].join("\n");
const emitted = new Set<string | undefined>([
  buildProvidedHarness(vecQ, "python", "def twoSum(nums, target):\n    return [0, 1]")?.templateId,
  buildProvidedHarness(vecQ, "cpp", "class Solution { public: vector<int> twoSum(vector<int>& n, int t) { return {0,1}; } };")?.templateId,
  buildProvidedHarness(vecQ, "rust", "impl Solution { pub fn two_sum(n: Vec<i64>, t: i64) -> Vec<i64> { vec![0,1] } }")?.templateId,
  buildProvidedHarness(callQ, "python", "def add(a, b):\n    return a + b")?.templateId,
  buildProvidedHarness(callQ, "cpp", "int add(int a, int b) { return a + b; }")?.templateId,
  buildProvidedHarness(callQ, "rust", "pub fn add(a: i64, b: i64) -> i64 { a + b }")?.templateId,
  buildProvidedHarness(listQ, "python", "class ListNode:\n  def __init__(self, val=0, next=None):\n    self.val=val; self.next=next\nclass Solution:\n  def reverse(self, head):\n    return head")?.templateId,
  buildProvidedHarness(listQ, "cpp", "class Solution {\npublic:\n ListNode* reverse(ListNode* head) { return head; }\n};")?.templateId,
  buildProvidedHarness(listQ, "rust", "impl Solution {\n pub fn reverse(head: Option<Box<ListNode>>) -> Option<Box<ListNode>> { head }\n}")?.templateId,
  buildProvidedHarness(stdinQ2, "python", "n = int(input())\nprint(n)")?.templateId,
]);
for (const template of HARNESS_REGISTRY.filter((entry) => entry.certified)) {
  assert.ok(emitted.has(template.id), `no builder reaches certified template ${template.id}`);
}
console.log("PASS: every certified template is reachable by a builder");
