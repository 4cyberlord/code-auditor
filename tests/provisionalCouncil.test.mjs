import assert from "node:assert/strict";
import {
  simpleComplexityRank,screenProvisionalCandidate,createProvisionalRecord,buildSolutionHistory
} from "../scripts/lib/provisionalCouncil.mjs";

assert.equal(simpleComplexityRank("Time O(n) Space O(n)").bound,"O(n)");
assert.equal(simpleComplexityRank("O(n log n) time").rank,3);
assert.equal(simpleComplexityRank("O(n²)").rank,4);
assert.equal(simpleComplexityRank("O(V+E)"),null);
assert.equal(simpleComplexityRank("O(n!)").rank,8);
const final={kind:"code",language:"python",complexity:"Time O(n), space O(n)",
  code:"def solve(xs):\n    return len(xs)\n"};
const run={ran:true,ok:true,passed:12,failed:0};
const passing=screenProvisionalCandidate({final,run,contractComplexity:"O(n)"});
assert.equal(passing.eligible,true);
assert.ok(passing.disclaimer.includes("awaiting independent Council review"));
assert.equal(screenProvisionalCandidate({final,run:{...run,failed:1},contractComplexity:"O(n)"}).eligible,false);
assert.equal(screenProvisionalCandidate({final,run:{...run,ok:false},contractComplexity:"O(n)"}).eligible,false);
assert.equal(screenProvisionalCandidate({final,run:{...run,ran:false},contractComplexity:"O(n)"}).eligible,false);
assert.equal(screenProvisionalCandidate({final:{...final,complexity:"O(n^2)"},run,contractComplexity:"O(n)"}).eligible,false);
assert.equal(screenProvisionalCandidate({final:{...final,complexity:"unknown"},run,contractComplexity:"O(n)"}).eligible,false);
assert.equal(screenProvisionalCandidate({final:{...final,complexity:"O(V+E)"},run}).eligible,false);
assert.equal(screenProvisionalCandidate({final:{...final,code:""},run}).eligible,false);
const candidate={letter:"A",model:"model-a",final};
const provisional=createProvisionalRecord({candidate,run,language:"python",screened:passing,at:"2026-10-15T17:00:00Z"});
assert.equal(provisional.status,"provisional");
assert.equal(provisional.code,final.code);
assert.equal(provisional.passed,12);
const upgraded=buildSolutionHistory(provisional,{
 letter:"D",language:"python",code:"def solve(xs):\n    return sum(1 for _ in xs)\n",
 complexity:"O(n)",passed:12,at:"2026-10-15T17:01:00Z"
});
assert.deepEqual(upgraded.map(v=>v.version),["provisional","final"]);
assert.equal(upgraded[0].letter,"A");
assert.equal(upgraded[1].letter,"D");
assert.equal(upgraded[0].code,final.code);
assert.deepEqual(buildSolutionHistory(null,{letter:"B",code:"print(2)"}).map(v=>v.version),["final"]);
assert.equal(provisional.code,final.code,"Old version remains immutable");
console.log("PASS: provisional E2B/complexity screen, no premature verified claims, preserved upgrade history");
