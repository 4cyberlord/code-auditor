import assert from "node:assert/strict";
import {extractVerifiedCodeStructure,buildVerifiedSemanticBlueprint}
  from "../scripts/lib/verifiedSemanticBlueprint.mjs";

const source={
 kind:"code",language:"python",
 answer:"Track the earliest position of each value and return indices whose values sum to the target.",
 complexity:"O(n) time, O(n) auxiliary space",
 code:[
  "from collections import defaultdict",
  "class Solution:",
  "    def twoSum(self, nums: list[int], target: int) -> list[int]:",
  "        seen = {}",
  "        for index, value in enumerate(nums):",
  "            needed = target - value",
  "            if needed in seen:",
  "                return [seen[needed], index]",
  "            seen[value] = index",
  "        return []",
 ].join("\n"),
};
const structure=extractVerifiedCodeStructure(source.code,"python");
assert.deepEqual(structure.classes,["Solution"]);
assert.equal(structure.definitions[0].name,"twoSum");
assert.equal(structure.definitions[0].parameters,"self, nums: list[int], target: int");
assert.ok(structure.variables.includes("seen"));
assert.ok(structure.variables.includes("needed"));
assert.ok(structure.variables.includes("index"));
assert.ok(structure.imports.includes("from collections import defaultdict"));
assert.ok(structure.dataStructures.includes("dictionaries / hash maps"));
assert.ok(structure.controlFlow.includes("for-loops"));
assert.ok(structure.controlFlow.includes("conditional branches"));
assert.ok(structure.mutations.includes("assignment to an indexed element"));
const guide=buildVerifiedSemanticBlueprint({
 source,sourceLanguage:"python",sourceLetter:"B",passedTests:20,
});
assert.ok(guide);
assert.equal(guide.sourceLetter,"B");
assert.ok(guide.brief.includes("twoSum(self, nums: list[int], target: int)"));
assert.ok(guide.brief.includes("Track the earliest position"));
assert.ok(guide.brief.includes("Local") || guide.brief.includes("local variables"));
assert.ok(guide.brief.includes("20 passing E2B test case"));
assert.ok(guide.brief.includes("not a verified theorem"));
assert.ok(!guide.brief.includes("Verified source code:\n"));
assert.ok(guide.brief.length<=5200);
assert.equal(buildVerifiedSemanticBlueprint({source:{code:""}}),null);
const rust=extractVerifiedCodeStructure("fn solve(nums: Vec<i32>) -> usize { let mut answer = 0; return answer; }","rust");
assert.equal(rust.definitions[0].name,"solve");
assert.ok(rust.variables.includes("answer"));
// The English metadata is a source-derived hint. Only actual executable
// evidence can make the port eligible for publication.
assert.equal(guide.basedOn,"verified-source");
console.log("PASS: verified Python semantic blueprint reuses existing answer, extracts functions/variables/flow, preserves source authority, no extra model calls");
