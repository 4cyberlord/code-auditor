/**
 * Certification matrix: every certified template must pass a correct candidate
 * and fail a deliberately wrong one in the real toolchain it will judge with.
 * A template without an entry here does not deserve `certified: true`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { buildProvidedHarness } from "../src/lib/providedCaseHarness.ts";
import { spliceSuite } from "../src/lib/council.ts";
import { HARNESS_REGISTRY } from "../src/lib/harnessRegistry.ts";

const addQ = ["Add", "Example 1:", "Input: a = 2, b = 3", "Output: 5"].join("\n");
const twoQ = ["Two Sum", "Example 1:", "Input: nums = [2,7], target = 9", "Output: [0,1]"].join("\n");
const listQ = ["Reverse", "Example 1:", "Input: head = [1,2]", "Output: [2,1]"].join("\n");
const stdinQ = ["Double", "Example 1:", "Input: 3", "Read from standard input.", "Example 1:", "Input: 3", "Output: 6"].join("\n");

interface Case {
  template: string;
  language: "python" | "cpp" | "rust";
  question: string;
  good: string;
  bad: string;
}

const cases: Case[] = [
  { template: "python.callable-scalar", language: "python", question: addQ,
    good: "def add(a, b):\n    return a + b", bad: "def add(a, b):\n    return a - b" },
  { template: "cpp.callable-scalar", language: "cpp", question: addQ,
    good: "int add(int a, int b) { return a + b; }", bad: "int add(int a, int b) { return a - b; }" },
  { template: "rust.callable-scalar", language: "rust", question: addQ,
    good: "pub fn add(a: i64, b: i64) -> i64 { a + b }", bad: "pub fn add(a: i64, b: i64) -> i64 { a - b }" },
  { template: "python.callable-vector", language: "python", question: twoQ,
    good: "def twoSum(nums, target):\n    return [0, 1]", bad: "def twoSum(nums, target):\n    return [1, 0]" },
  { template: "native.callable-vector", language: "cpp", question: twoQ,
    good: "class Solution { public: vector<int> twoSum(vector<int>& n, int t) { return {0,1}; } };",
    bad: "class Solution { public: vector<int> twoSum(vector<int>& n, int t) { return {1,0}; } };" },
  { template: "native.callable-vector", language: "rust", question: twoQ,
    good: "impl Solution { pub fn two_sum(n: Vec<i64>, t: i64) -> Vec<i64> { vec![0,1] } }",
    bad: "impl Solution { pub fn two_sum(n: Vec<i64>, t: i64) -> Vec<i64> { vec![1,0] } }" },
  { template: "callable-node", language: "python", question: listQ,
    good: "class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val=val; self.next=next\nclass Solution:\n    def reverse(self, head):\n        prev=None\n        while head:\n            nxt=head.next; head.next=prev; prev=head; head=nxt\n        return prev",
    bad: "class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val=val; self.next=next\nclass Solution:\n    def reverse(self, head):\n        return head" },
  { template: "callable-node", language: "cpp", question: listQ,
    good: "class Solution { public: ListNode* reverse(ListNode* h) { ListNode* p=nullptr; while(h){ ListNode* n=h->next; h->next=p; p=h; h=n; } return p; } };",
    bad: "class Solution { public: ListNode* reverse(ListNode* h) { return h; } };" },
  { template: "callable-node", language: "rust", question: listQ,
    good: "impl Solution { pub fn reverse(h: Option<Box<ListNode>>) -> Option<Box<ListNode>> { let mut p=None; let mut c=h; while let Some(mut n)=c { c=n.next.take(); n.next=p; p=Some(n); } p } }",
    bad: "impl Solution { pub fn reverse(h: Option<Box<ListNode>>) -> Option<Box<ListNode>> { h } }" },
  { template: "stdin.wrapper", language: "python", question: stdinQ,
    good: "n = int(input())\nprint(n * 2)", bad: "n = int(input())\nprint(n)" },
];

function execute(testCase: Case, program: string) {
  const file = `/tmp/cert-${testCase.template.replace(/\W/g, "-")}-${testCase.language}.${testCase.language === "cpp" ? "cpp" : testCase.language === "rust" ? "rs" : "py"}`;
  writeFileSync(file, program);
  if (testCase.language === "python") return spawnSync("python3", [file]);
  const binary = file + ".bin";
  const argv = testCase.language === "cpp"
    ? ["-std=c++20", "-O1", file, "-o", binary]
    : ["-O", file, "-o", binary];
  const built = spawnSync(testCase.language === "cpp" ? "c++" : "rustc", argv);
  assert.equal(built.status, 0, testCase.template + " failed to compile: " + String(built.stderr));
  return spawnSync(binary);
}

const covered = new Set(cases.map((testCase) => testCase.template));
assert.equal(covered.size, HARNESS_REGISTRY.filter((entry) => entry).length);

for (const testCase of cases) {
  if (testCase.language !== "python") {
    const tool = testCase.language === "cpp" ? "c++" : "rustc";
    if (spawnSync(tool, ["--version"]).status !== 0) { console.log("SKIP", testCase.template); continue; }
  }
  const suite = buildProvidedHarness(testCase.question, testCase.language, testCase.good);
  assert.ok(suite, testCase.template + " did not build");
  assert.equal(suite.templateId, testCase.template);
  const goodOut = String(execute(testCase, spliceSuite(suite, testCase.good) ?? "").stdout);
  assert.ok((goodOut.match(/status":\s*"passed/g) || []).length >= 1, testCase.template + " rejected a correct answer");
  const badOut = String(execute(testCase, spliceSuite(suite, testCase.bad) ?? "").stdout);
  assert.equal((badOut.match(/status":\s*"passed/g) || []).length, 0, testCase.template + " accepted a wrong answer");
}

for (const template of HARNESS_REGISTRY.filter((entry) => entry.certified)) {
  assert.ok(covered.has(template.id), template.id + " is certified without a case");
}
console.log("PASS: every certified template passes good and fails bad code");
