import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  buildProvidedHarness, extractProvidedFixtures, providedCaseEvidence, requiredHarnessCases,
} from "../src/lib/providedCaseHarness.ts";
import { spliceSuite, countCases } from "../src/lib/council.ts";

const twoSum = [
  "Two Sum",
  "Example 1:",
  "Input: nums = [2,7,11,15], target = 9",
  "Output: [0,1]",
  "Example 2:",
  "Input: nums = [3,2,4], target = 6",
  "Output: [1,2]",
  "Example 3:",
  "Input: nums = [3,3], target = 6",
  "Output: [0,1]",
].join("\n");
const correct = [
  "class Solution:",
  "    def twoSum(self, nums: List[int], target: int) -> List[int]:",
  "        seen = {}",
  "        for i, value in enumerate(nums):",
  "            if target - value in seen:",
  "                return [seen[target-value], i]",
  "            seen[value] = i",
  "        return []",
].join("\n");
const provided = extractProvidedFixtures(twoSum);
assert.equal(provided.length, 3);
assert.deepEqual({...provided[0].kwargs}, {nums: [2,7,11,15], target: 9});
assert.deepEqual(provided[2].expected, [0,1]);

function runProgram(program: string) {
  const result = spawnSync("python3", ["-c", program], {encoding: "utf8", timeout: 120_000});
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

const suite = buildProvidedHarness(twoSum, "python", correct);
assert.ok(suite, "Python function must have deterministic harness");
assert.equal(suite.source, "provided");
assert.equal(suite.runnerLanguage, "python");
assert.equal(suite.providedCaseCount, 3);
assert.equal(requiredHarnessCases(suite), 3);
const program = spliceSuite(suite, correct);
assert.ok(program?.includes("CA_CASE"));
const success = runProgram(program!);
assert.equal(success.status, 0, success.stderr);
assert.deepEqual(providedCaseEvidence(success.stdout, 3), {passed: 3, failed: 0, complete: true});
assert.equal(countCases(success.stdout).passed, 3);

const broken = "class Solution:\n    def twoSum(self, nums, target):\n        return [0,0]\n";
const failedSuite = buildProvidedHarness(twoSum, "python", broken);
assert.ok(failedSuite);
const bad = runProgram(spliceSuite(failedSuite, broken)!);
assert.equal(bad.status, 1);
assert.deepEqual(providedCaseEvidence(bad.stdout, 3), {passed: 0, failed: 3, complete: true});

// No arbitrary 8-case minimum: only one question-provided test is sufficient
// to report precisely one tested example, not general correctness.
const one = "Input: nums = [2,7], target = 9\nOutput: [0,1]";
const single = buildProvidedHarness(one, "python", correct)!;
assert.equal(requiredHarnessCases(single), 1);
const singleResult = runProgram(spliceSuite(single, correct)!);
assert.deepEqual(providedCaseEvidence(singleResult.stdout, 1), {passed: 1, failed: 0, complete: true});
assert.equal(requiredHarnessCases({source: "generated"}), 8,
  "AI-authored suites keep the independent coverage floor");

// The same supplied fixtures must adapt to each model's own valid callable
// name; one model's signature must not make another candidate fail E2B.
const renamed = "class Solution:\n    def solve(self, nums, target):\n        seen = {}\n        for i, value in enumerate(nums):\n            if target - value in seen: return [seen[target-value], i]\n            seen[value] = i\n        return []\n";
const renamedSuite = buildProvidedHarness(twoSum, "python", renamed)!;
assert.match(renamedSuite.harness, /CA_METHOD = "solve"/);
const renamedRun = runProgram(spliceSuite(renamedSuite, renamed)!);
assert.equal(renamedRun.status, 0, renamedRun.stderr);
assert.deepEqual(providedCaseEvidence(renamedRun.stdout, 3), {passed: 3, failed: 0, complete: true});

// A constructor is not the problem's callable, even when it appears first.
const withConstructor = "class Solution:\n    def __init__(self):\n        pass\n    def twoSum(self, nums, target):\n        return [0, 1]\n";
const constructorSuite = buildProvidedHarness(one, "python", withConstructor)!;
assert.match(constructorSuite.harness, /CA_METHOD = "twoSum"/);

// Reject missing/ambiguous source evidence; never let AI fabricate an oracle.
assert.deepEqual(extractProvidedFixtures("Example 1:\nInput: [1,2]\nExplanation: no output supplied"), []);
assert.equal(buildProvidedHarness("Find two sum with no examples", "python", correct), null);
assert.equal(buildProvidedHarness(one, "cpp", "class Solution { };"), null);
assert.equal(buildProvidedHarness(one, "rust", "impl Solution {}"), null);
assert.equal(extractProvidedFixtures("Input: x = __import__('os').system('id')\nOutput: 0")[0].args, undefined);

// A duplicate screenshot example must not inflate pass counts.
const duplicates = extractProvidedFixtures(one + "\nExample 2:\n" + one);
assert.equal(duplicates.length, 1);
assert.deepEqual(providedCaseEvidence("PASS provided_1\nPASS provided_2\n", 1),
  {passed: 0, failed: 0, complete: false});
assert.deepEqual(providedCaseEvidence("CA_CASE " + JSON.stringify({id:"provided_1",status:"passed"}) + "\n", 2),
  {passed: 1, failed: 0, complete: false});

// Native stdin examples are supported for Python, Rust and C++23 by the same
// non-model-generated runner. Do not mistake function input kwargs for stdin.
const stdinProblem = "Read two integers from standard input and print their sum.\n" +
  "Sample Input:\n2 3\nSample Output:\n5\n" +
  "Sample Input:\n10 12\nSample Output:\n22";
const programs = {
  python: "a, b = map(int, input().split())\nprint(a + b)",
  cpp: "#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<(a+b)<<'\\n';}",
  rust: "use std::io::{self, Read};\nfn main(){let mut s=String::new();io::stdin().read_to_string(&mut s).unwrap();let n:Vec<i32>=s.split_whitespace().map(|v|v.parse().unwrap()).collect();println!(\"{}\",n[0]+n[1]);}",
};
for (const [language, source] of Object.entries(programs)) {
  const tool = language === "rust" ? "rustc" : language === "cpp" ? "g++" : "python3";
  if (spawnSync(tool, ["--version"], {encoding:"utf8"}).error) {
    console.log("SKIP optional native compiler:", tool);
    continue;
  }
  const fixtureSuite = buildProvidedHarness(stdinProblem, language, source);
  assert.ok(fixtureSuite, language + " stdin harness should be compiled deterministically");
  assert.equal(fixtureSuite.providedCaseCount, 2);
  const result = runProgram(spliceSuite(fixtureSuite, source)!);
  assert.equal(result.status, 0, language + ": " + result.stderr + "\n" + result.stdout);
  assert.deepEqual(providedCaseEvidence(result.stdout, 2), {passed: 2, failed: 0, complete: true});
}

console.log("Harness Engine V2 supplied-case extraction, compilation and evidence verified");
