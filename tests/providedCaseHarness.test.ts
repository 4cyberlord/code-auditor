import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  buildProvidedHarness, buildGeneratedPythonHarness, extractProvidedFixtures, providedCaseEvidence, requiredHarnessCases,
} from "../src/lib/providedCaseHarness.ts";
import { spliceSuite, countCases } from "../src/lib/council.ts";
import { contractHash } from "../src/lib/providedCaseHarness.ts";
import { contractIdentity } from "../src/lib/problemContract.ts";

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

// Screenshot readers frequently flatten the visual Sample/Example layout.
// These literal pairs must still enter the deterministic provided-case path,
// rather than silently falling back to model-invented expected outputs.
const flattened = extractProvidedFixtures([
  "Example 1: Input: nums = [2, 7], target = 9 Output: [0, 1]",
  "Test Case 2: Input: nums = [3, 2, 4] Expected Output: [1, 2]",
].join("\n"));
assert.equal(flattened.length, 2);
assert.deepEqual({...flattened[0].kwargs}, {nums: [2, 7], target: 9});
assert.deepEqual(flattened[1].expected, [1, 2]);

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

// Model-authored Python test DATA compiles through our fixed runner. Supplied
// examples must remain byte-for-byte equivalent, and generated code is never
// asked to emit executable harness syntax.
const generatedCases = [
  {id:"sample-a",args:[[2,7,11,15],9],kwargs:{},expected:[0,1]},
  {id:"sample-b",args:[[3,2,4],6],kwargs:{},expected:[1,2]},
  {id:"edge-1",args:[[3,3],6],kwargs:{},expected:[0,1]},
  {id:"edge-2",args:[[1,5,4,7],9],kwargs:{},expected:[1,2]},
  {id:"edge-3",args:[[-1,-2,-3],-5],kwargs:{},expected:[1,2]},
  {id:"edge-4",args:[[0,4],4],kwargs:{},expected:[0,1]},
  {id:"edge-5",args:[[8,1,6,2],3],kwargs:{},expected:[1,3]},
  {id:"edge-6",args:[[10,20,30],50],kwargs:{},expected:[1,2]},
];
const generated = buildGeneratedPythonHarness(twoSum, JSON.stringify({
  mode:"callable", method:"twoSum", cases:generatedCases,
  reference_code:"class Solution:\n    def twoSum(self, nums, target):\n        for i in range(len(nums)):\n            for j in range(i + 1, len(nums)):\n                if nums[i] + nums[j] == target: return [i, j]\n        return []",
}));
assert.ok(generated, "valid structured spec must compile locally");
assert.equal(generated.source, "generated");
assert.equal(requiredHarnessCases(generated), 8);
const generatedProgram = spliceSuite(generated, correct)!;
const generatedSuccess = runProgram(generatedProgram);
assert.equal(generatedSuccess.status, 0, generatedSuccess.stderr + generatedSuccess.stdout);
assert.equal(countCases(generatedSuccess.stdout).passed, 8);
assert.match(generatedSuccess.stdout, /CA_CASE \{"id": "generated_1", "input": \{"args": \[\[2, 7, 11, 15\], 9\]/,
  "generated Python cases expose their exact executed inputs to the report");
const generatedReferenceRun = runProgram(spliceSuite(generated, generated.referenceCode!)!);
assert.equal(generatedReferenceRun.status, 0, generatedReferenceRun.stderr + generatedReferenceRun.stdout);
assert.equal(buildGeneratedPythonHarness(twoSum, "{}"), null, "incomplete structured responses fail closed");
assert.equal(buildGeneratedPythonHarness("Return any valid pair; any order is accepted.", JSON.stringify({
  mode:"callable", cases:generatedCases, reference_code:"class Solution: pass",
})), null, "equality harnesses refuse contracts with multiple valid outputs");
const droppedSample = buildGeneratedPythonHarness(twoSum, JSON.stringify({
  mode:"callable", method:"twoSum", cases:generatedCases.slice(2), reference_code:"pass",
}));
assert.equal(droppedSample, null, "all parseable statement examples are mandatory");

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

// The registry identity must be stable for one contract and change with it.
const fixtureSet = extractProvidedFixtures(twoSum);
assert.equal(contractHash(twoSum, fixtureSet), contractHash(twoSum, fixtureSet));
assert.notEqual(contractHash(twoSum, fixtureSet), contractHash(twoSum + "\n", fixtureSet));
const registered = buildProvidedHarness(twoSum, "python", correct);
assert.equal(registered?.harnessVersion, "v2.6");
assert.equal(registered?.contractHash, contractIdentity(registered!.contract!, fixtureSet));
console.log("PASS: harness registry identity is stable and contract-scoped");

// ------------------------------------------------- native judge adapters

const nativeQuestion = ["Two Sum", "Example 1:",
  "Input: nums = [2,7,11,15], target = 9", "Output: [0,1]"].join("\n");
const cppSolution = "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        return {0, 1};\n    }\n};";
const rustSolution = "impl Solution {\n    pub fn two_sum(nums: Vec<i64>, target: i64) -> Vec<i64> { vec![0, 1] }\n}";

for (const [language, source] of [["cpp", cppSolution], ["rust", rustSolution]] as const) {
  const suite = buildProvidedHarness(nativeQuestion, language, source);
  assert.ok(suite, language + " judge API should build a native suite");
  assert.equal(suite.runnerLanguage, language);
  assert.equal(suite.candidateAsString, false);
  assert.equal(suite.contractHash, contractIdentity(suite.contract!, extractProvidedFixtures(nativeQuestion)));
  const program = spliceSuite(suite, source) ?? "";
  assert.ok(program.includes("twoSum") || program.includes("two_sum"));
  assert.ok(!program.includes('"class Solution'), "native candidates splice unwrapped");
  const compiler = spawnSync(language === "cpp" ? "c++" : "rustc", ["--version"]);
  if (compiler.status !== 0) { console.log("SKIP native compile:", language); continue; }
  const file = `/tmp/fixture-${language}.${language === "cpp" ? "cpp" : "rs"}`;
  writeFileSync(file, program);
  const binary = `/tmp/fixture-${language}.bin`;
  const build = spawnSync(language === "cpp" ? "c++" : "rustc",
    language === "cpp" ? ["-std=c++20", "-O1", file, "-o", binary] : ["-O", file, "-o", binary]);
  assert.equal(build.status, 0, language + " compile failed: " + String(build.stderr));
  const run = spawnSync(binary);
  assert.equal(run.status, 0);
  assert.equal((String(run.stdout).match(/status":"passed"/g) || []).length, 1);
}

// Unsupported signatures fall back instead of emitting a broken driver.
assert.ok(buildProvidedHarness(nativeQuestion, "cpp",
  "class Solution { public: TreeNode* f(TreeNode* n) { return n; } };"));
assert.equal(buildProvidedHarness(nativeQuestion, "cpp",
  "class Solution { public: unordered_map<int,int> f(vector<int>& n) { return {}; } };"), null);

// Feature flag: the certified registry can be switched off to fall back to the
// reference harness without touching the builders.
(globalThis as { __COUNCIL_HARNESS_REGISTRY__?: boolean }).__COUNCIL_HARNESS_REGISTRY__ = false;
assert.equal(buildProvidedHarness(nativeQuestion, "cpp", cppSolution), null);
(globalThis as { __COUNCIL_HARNESS_REGISTRY__?: boolean }).__COUNCIL_HARNESS_REGISTRY__ = true;
assert.ok(buildProvidedHarness(nativeQuestion, "cpp", cppSolution));
console.log("PASS: registry flag falls back cleanly");

// ------------------------------------------------- node adapters

const listQ = ["Reverse Linked List", "Example 1:", "Input: head = [1,2,3,4,5]", "Output: [5,4,3,2,1]"].join("\n");
const listGood = "class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val=val; self.next=next\nclass Solution:\n    def reverseList(self, head):\n        prev=None\n        while head:\n            nxt=head.next; head.next=prev; prev=head; head=nxt\n        return prev";
const treeQ = ["Maximum Depth", "Example 1:", "Input: root = [3,9,20,null,null,15,7]", "Output: 3"].join("\n");
const treeGood = "class TreeNode:\n    def __init__(self, val=0, left=None, right=None):\n        self.val=val\nclass Solution:\n    def maxDepth(self, root):\n        if not root: return 0\n        return 1 + max(self.maxDepth(root.left), self.maxDepth(root.right))";

for (const [question, code, label] of [[listQ, listGood, "list"], [treeQ, treeGood, "tree"]] as const) {
  const suite = buildProvidedHarness(question, "python", code);
  assert.ok(suite, label + " node problem should build a node suite");
  assert.equal(suite.templateId, "callable-node");
  const program = spliceSuite(suite, code) ?? "";
  const file = `/tmp/fixture-node-${label}.py`;
  writeFileSync(file, program);
  const run = spawnSync("python3", [file]);
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal((String(run.stdout).match(/status":\s*"passed/g) || []).length, 1);
}

// A wrong answer must still fail; the adapter must not pass anything shaped like a node.
const wrongList = listGood.replace("prev=None", "prev=None\n        return head");
assert.equal(buildProvidedHarness(listQ, "python", wrongList) !== null, true);
console.log("PASS: node adapters build, run and stay strict");

// Native node adapters: compile, pass a correct answer, fail a wrong one.
for (const [language, good, bad] of [
  ["cpp",
    "class Solution {\npublic:\n ListNode* reverseList(ListNode* head) { ListNode* prev=nullptr; while(head){ ListNode* n=head->next; head->next=prev; prev=head; head=n; } return prev; }\n};",
    "class Solution {\npublic:\n ListNode* reverseList(ListNode* head) { return head; }\n};"],
  ["rust",
    "impl Solution {\n pub fn reverse_list(head: Option<Box<ListNode>>) -> Option<Box<ListNode>> {\n  let mut prev=None; let mut cur=head;\n  while let Some(mut node)=cur { cur=node.next.take(); node.next=prev; prev=Some(node); }\n  prev\n }\n}",
    "impl Solution {\n pub fn reverse_list(head: Option<Box<ListNode>>) -> Option<Box<ListNode>> { head }\n}"],
] as const) {
  const compiler = spawnSync(language === "cpp" ? "c++" : "rustc", ["--version"]);
  if (compiler.status !== 0) { console.log("SKIP native node:", language); continue; }
  const suite = buildProvidedHarness(listQ, language, good);
  assert.ok(suite, language + " node suite");
  assert.equal(suite.templateId, "callable-node");
  for (const [code, expectedPass] of [[good, 1], [bad, 0]] as const) {
    const file = `/tmp/node-${language}-${expectedPass}.${language === "cpp" ? "cpp" : "rs"}`;
    writeFileSync(file, spliceSuite(suite, code) ?? "");
    const binary = file + ".bin";
    const built = spawnSync(language === "cpp" ? "c++" : "rustc",
      language === "cpp" ? ["-std=c++20", "-O1", file, "-o", binary] : ["-O", file, "-o", binary]);
    assert.equal(built.status, 0, language + " node compile");
    const run = spawnSync(binary);
    const got = (String(run.stdout).match(/status":\s*"passed/g) || []).length;
    assert.equal(got, expectedPass, language + " node outcome");
  }
}

// Custom node field names must be honoured, not assumed.
const customQ = ["Reverse Linked List", "Example 1:", "Input: head = [1,2]", "Output: [2,1]"].join("\n");
const customPy = "class ListNode:\n    def __init__(self, value=0, nxt=None):\n        self.value=value; self.nxt=nxt\nclass Solution:\n    def reverseList(self, head):\n        prev=None\n        while head:\n            nxt=head.nxt; head.nxt=prev; prev=head; head=nxt\n        return prev";
const customSuite = buildProvidedHarness(customQ, "python", customPy);
assert.ok(customSuite);
assert.equal(customSuite.templateId, "callable-node");
writeFileSync("/tmp/fixture-custom.py", spliceSuite(customSuite, customPy) ?? "");
const customRun = spawnSync("python3", ["/tmp/fixture-custom.py"]);
assert.equal(customRun.status, 0, String(customRun.stderr));
assert.equal((String(customRun.stdout).match(/status":\s*"passed/g) || []).length, 1);
console.log("PASS: custom node field names are honoured");

// Mixed node + vector arguments are supported (append values to a list).
const mixedSuite = buildProvidedHarness(
  ["Append Values", "Example 1:", "Input: head = [1,2], values = [3]", "Output: [1,2,3]"].join("\n"),
  "cpp",
  "class Solution {\npublic:\n ListNode* append(ListNode* head, vector<int> values) { ListNode** t=&head; while(*t) t=&(*t)->next; for(int v:values){ *t=new ListNode(v); t=&(*t)->next; } return head; }\n};");
assert.ok(mixedSuite, "mixed node/vector arguments should build");
assert.equal(mixedSuite.templateId, "callable-node");
console.log("PASS: mixed node and vector arguments build");

// In-place contracts (no return value) serialize the mutated argument.
const inPlaceQ = ["Pop Last", "Example 1:", "Input: head = [1,2,3]", "Output: [1,2]"].join("\n");
const inPlacePy = "class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val=val; self.next=next\nclass Solution:\n    def popLast(self, head) -> None:\n        if not head or not head.next: return\n        while head.next.next: head=head.next\n        head.next=None";
const inPlacePyBad = inPlacePy.replace("        while head.next.next: head=head.next\n        head.next=None", "        return");
const inPlaceCpp = "class Solution {\npublic:\n void popLast(ListNode* head) { while (head->next->next) head=head->next; head->next=nullptr; }\n};";
const inPlaceRust = "impl Solution {\n pub fn pop_last(head: &mut Option<Box<ListNode>>) {\n  let mut cur=head; while let Some(n)=cur { if n.next.as_ref().map_or(true,|x| x.next.is_none()) { n.next=None; return; } cur=&mut n.next; }\n }\n}";

for (const [language, code, bad] of [["python", inPlacePy, inPlacePyBad], ["cpp", inPlaceCpp, inPlaceCpp.replace("while (head->next->next) head=head->next; head->next=nullptr;", "return;")], ["rust", inPlaceRust, inPlaceRust.replace("let mut cur=head; while let Some(n)=cur { if n.next.as_ref().map_or(true,|x| x.next.is_none()) { n.next=None; return; } cur=&mut n.next; }", "")]] as const) {
  const compiler = spawnSync(language === "cpp" ? "c++" : language === "rust" ? "rustc" : "python3", ["--version"]);
  if (compiler.status !== 0) { console.log("SKIP in-place:", language); continue; }
  const suite = buildProvidedHarness(inPlaceQ, language, code);
  assert.ok(suite, language + " in-place suite");
  for (const [variant, expected] of [[code, 1], [bad, 0]] as const) {
    const ext = language === "cpp" ? "cpp" : language === "rust" ? "rs" : "py";
    const file = `/tmp/inplace-${language}-${expected}.${ext}`;
    writeFileSync(file, spliceSuite(suite, variant) ?? "");
    let binary = file;
    if (language !== "python") {
      binary = file + ".bin";
      const built = spawnSync(language === "cpp" ? "c++" : "rustc",
        language === "cpp" ? ["-std=c++20", "-O1", file, "-o", binary] : ["-O", file, "-o", binary]);
      assert.equal(built.status, 0, language + " in-place compile");
    }
    const run = spawnSync(language === "python" ? "python3" : binary, language === "python" ? [file] : []);
    assert.equal((String(run.stdout).match(/status":\s*"passed/g) || []).length, expected, language + " in-place outcome");
  }
}
console.log("PASS: in-place node contracts are verified");

// Fuzzing derives expectations from the reference; shrinking reduces the first
// failing input. A candidate wrong beyond the examples must be caught and the
// counterexample reduced.
const fuzzSpec = JSON.stringify({
  mode: "callable", method: "total",
  
  cases: Array.from({ length: 8 }, (_, index) => ({ id: `provided_${index + 1}`, args: [[index, index + 1]], kwargs: {}, expected: index * 2 + 1 })),
  reference_code: "def total(values):\n    return sum(values)",
});
// The generator requires a similarly shaped example set; build once with real fixtures.
const fuzzQuestion = ["Total", "Example 1:", "Input: values = [1,2,3]", "Output: 6"].join("\\n");
const fuzzSpec2 = JSON.stringify({
  mode: "callable", method: "total",
  cases: Array.from({ length: 8 }, (_, index) => ({ id: `provided_${index + 1}`, args: [[index, index + 1]], kwargs: {}, expected: index * 2 + 1 })),
  reference_code: "def total(values):\n    return sum(values)",
});
const fuzzCandidate = "def total(values):\n    return values[0] if values else 0";
const fuzzSuite = buildGeneratedPythonHarness(fuzzQuestion, fuzzSpec2, fuzzCandidate);
assert.ok(fuzzSuite, "generated suite with reference");
const fuzzProgram = spliceSuite(fuzzSuite, fuzzCandidate) ?? "";
writeFileSync("/tmp/fixture-fuzz.py", fuzzProgram);
const fuzzRun = spawnSync("python3", ["/tmp/fixture-fuzz.py"]);
const fuzzOut = String(fuzzRun.stdout);
assert.ok((fuzzOut.match(/fuzz_/g) || []).length >= 1, "fuzz cases ran");
assert.ok(fuzzOut.includes("CA_SHRUNK"), "failing input was shrunk");
const shrunk = fuzzOut.split(/\r?\n/).find((line) => line.startsWith("CA_SHRUNK"));
assert.ok(shrunk && shrunk.length < 200);
console.log("PASS: fuzz cases and shrinking run against the reference");

// Identity must change when only an expected output changes.
const idContract = registered!.contract!;
const idFixtures = extractProvidedFixtures(twoSum);
const changed = idFixtures.map((fixture) => ({ ...fixture }));
changed[0].expected = [9, 9];
assert.notEqual(contractIdentity(idContract, idFixtures), contractIdentity(idContract, changed));
console.log("PASS: contract identity covers expected outputs");

// The reported counterexample must actually be smaller than the failing row.
const alwaysWrong = "def total(values):\n    return sum(values) + 10";
const shrinkSuite = buildGeneratedPythonHarness(fuzzQuestion, fuzzSpec2, alwaysWrong);
assert.ok(shrinkSuite);
writeFileSync("/tmp/fixture-shrink.py", spliceSuite(shrinkSuite, alwaysWrong) ?? "");
const shrinkOut = String(spawnSync("python3", ["/tmp/fixture-shrink.py"]).stdout);
const shrinkRow = shrinkOut.split(/\r?\n/).find((line) => line.startsWith("CA_SHRUNK"));
assert.ok(shrinkRow, "a counterexample is reported");
const shrinkReport = JSON.parse(shrinkRow.slice("CA_SHRUNK".length));
assert.equal(shrinkReport.reduced, true, "reduction is recorded");
assert.ok(shrinkReport.args[0].length < 2, "counterexample is shorter than the failing input");

// Without a reference there is no oracle for a modified input, so no shrink claim.
const noRefCandidate = "class Solution:\n    def twoSum(self, nums, target):\n        return [0, 0]";
const noRefSuite = buildProvidedHarness(twoSum, "python", noRefCandidate);
assert.ok(noRefSuite);
const noRefOut = String(spawnSync("python3", ["-c", spliceSuite(noRefSuite, noRefCandidate)!]).stdout);
assert.ok(!noRefOut.includes("CA_SHRUNK"), "no shrink without an oracle");
console.log("PASS: shrinking proves a smaller counterexample and stays off without an oracle");

// Nested arrays must not break the uniqueness probe.
const matrixQ = ["Sum Matrix", "Example 1:", "Input: grid = [[1,2],[3,4]]", "Output: 10"].join("\n");
const matrixSpec = JSON.stringify({
  mode: "callable", method: "total",
  cases: [
    { id: "example", args: [[[1, 2], [3, 4]]], kwargs: {}, expected: 10 },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `provided_${index + 2}`, args: [[[index, 1], [2, 3]]], kwargs: {}, expected: index + 6 })),
  ],
  reference_code: "def total(grid):\n    return sum(sum(row) for row in grid)",
});
const matrixCandidate = "def total(grid):\n    return sum(sum(row) for row in grid)";
const matrixSuite = buildGeneratedPythonHarness(matrixQ, matrixSpec, matrixCandidate);
assert.ok(matrixSuite, "matrix suite with nested input");
writeFileSync("/tmp/fixture-matrix.py", spliceSuite(matrixSuite, matrixCandidate) ?? "");
const matrixRun = spawnSync("python3", ["/tmp/fixture-matrix.py"]);
assert.ok(!String(matrixRun.stderr).includes("unhashable"), "nested uniqueness probe survives");
assert.ok(String(matrixRun.stdout).includes("CA_DONE"));

// A reference that disagrees with the fixtures must not be trusted for fuzz/shrink.
const wrongRefSpec = JSON.stringify({
  mode: "callable", method: "total",
  cases: Array.from({ length: 8 }, (_, index) => ({ id: `provided_${index + 1}`, args: [[index, 1]], kwargs: {}, expected: index + 1 })),
  reference_code: "def total(values):\n    return 999",
});
const wrongRefSuite = buildGeneratedPythonHarness(fuzzQuestion, wrongRefSpec, "def total(values):\n    return -1");
assert.ok(wrongRefSuite);
const wrongRefOut = String(spawnSync("python3", ["-c", spliceSuite(wrongRefSuite, "def total(values):\n    return -1")!]).stdout);
assert.equal((wrongRefOut.match(/fuzz_/g) || []).length, 0, "invalid reference disables fuzz");
console.log("PASS: nested inputs and invalid references are handled");

// A reference that is right on the first fixture but wrong on a later one must
// still be rejected.
const partialRefSpec = JSON.stringify({
  mode: "callable", method: "total",
  cases: Array.from({ length: 8 }, (_, index) => ({ id: `provided_${index + 1}`, args: [[index, 1]], kwargs: {}, expected: index + 1 })),
  reference_code: "def total(values):\n    return values[0] + values[1] if values[0] > 0 else 999",
});
const partialSuite = buildGeneratedPythonHarness(fuzzQuestion, partialRefSpec, "def total(values):\n    return -1");
assert.ok(partialSuite);
const partialOut = String(spawnSync("python3", ["-c", spliceSuite(partialSuite, "def total(values):\n    return -1")!]).stdout);
assert.equal((partialOut.match(/fuzz_/g) || []).length, 0, "a partly wrong reference is rejected");

// Rust scalar Option evidence must be JSON null, never `None`.
const optSuite = buildProvidedHarness(["Find", "Example 1:", "Input: n = 1", "Output: null"].join("\n"),
  "rust", "impl Solution { pub fn find(n: i64) -> Option<i64> { let _ = n; None } }");
if (spawnSync("rustc", ["--version"]).status === 0 && optSuite) {
  writeFileSync("/tmp/fixture-opt.rs", spliceSuite(optSuite, "impl Solution { pub fn find(n: i64) -> Option<i64> { let _ = n; None } }") ?? "");
  const built = spawnSync("rustc", ["-O", "/tmp/fixture-opt.rs", "-o", "/tmp/fixture-opt.bin"]);
  assert.equal(built.status, 0, String(built.stderr));
  const optOut = String(spawnSync("/tmp/fixture-opt.bin").stdout);
  const row = optOut.split(/\r?\n/).find((line) => line.startsWith("CA_CASE"));
  const parsed = JSON.parse(row!.slice("CA_CASE ".length));
  assert.equal(parsed.expected, null);
  assert.equal(parsed.actual, null);
} else { console.log("SKIP Option evidence"); }
console.log("PASS: references are checked on every fixture and Option evidence is JSON");
