import assert from "node:assert/strict";
import {
 preferredLanguages,requiredProblemLanguage,contractSupportsEarlyHarness,
 evidenceStatus,isVerified,rankedPortTiming,createBoundedExecutor
} from "../scripts/lib/specFirstDelivery.mjs";

assert.deepEqual(preferredLanguages(["Python","Rust","C++"]),["python","rust","cpp"]);
assert.deepEqual(preferredLanguages(["cpp","C++","python3","other"]),["cpp","python"]);
assert.deepEqual(preferredLanguages(),["python","rust","cpp"]);
assert.equal(requiredProblemLanguage("Required language: C++"),"cpp");
assert.equal(requiredProblemLanguage("Implement the solution in Rust"),"rust");
assert.equal(requiredProblemLanguage("Write in Python"),"python");
assert.equal(requiredProblemLanguage("class Solution { public: int solve(int x); }"),"cpp");
assert.equal(requiredProblemLanguage("def solve(nums):"),"python");
assert.equal(requiredProblemLanguage("No language specified"),"");
assert.equal(contractSupportsEarlyHarness("def solve(nums):","code"),true);
assert.equal(contractSupportsEarlyHarness("fn solve(x: usize) -> usize","code"),true);
assert.equal(contractSupportsEarlyHarness("Find the best route","code"),false);
assert.equal(contractSupportsEarlyHarness("def solve(nums):","research"),false);
assert.equal(evidenceStatus({ran:true,ok:true,passed:5,failed:0}),"verified");
assert.equal(evidenceStatus({ran:true,ok:false,passed:4,failed:1}),"rejected");
assert.equal(evidenceStatus({ran:true,ok:true,passed:0,failed:0}),"untested");
assert.equal(evidenceStatus({ran:false,ok:true,passed:5,failed:0}),"untested");
assert.equal(isVerified({ran:true,ok:true,passed:2,failed:0}),true);
assert.equal(isVerified({ran:true,ok:false,passed:0,failed:3}),false);
// Cross-language measurements must NEVER be ranked as the same environment.
assert.deepEqual(rankedPortTiming([
 {language:"python",status:"verified",sourceLetter:"A",
  run:{runtime:"python3.15",remoteElapsedMs:5}},
 {language:"rust",status:"verified",sourceLetter:"A",
  run:{runtime:"rustc",remoteElapsedMs:2}},
]),[]);
assert.deepEqual(rankedPortTiming([
 {language:"python",status:"verified",sourceLetter:"A",
  run:{runtime:"python3.15",remoteElapsedMs:15}},
 {language:"python",status:"verified",sourceLetter:"B",
  run:{runtime:"python3.15",remoteElapsedMs:9}},
])[0]?.fastest,"B");

let running=0,maximum=0;
const enqueue=createBoundedExecutor(2);
const result=await Promise.all(Array.from({length:7},(_,i)=>enqueue(async()=>{
 running++;maximum=Math.max(maximum,running);
 await new Promise(resolve=>setTimeout(resolve,2));
 running--;return i;
})));
assert.deepEqual(result,[0,1,2,3,4,5,6]);
assert.equal(maximum,2);
await assert.rejects(enqueue(()=>{throw Error("intentional")}),/intentional/);
assert.equal(await enqueue(()=>13),13);
console.log("PASS: spec-first preparation, verified-only delivery, no false cross-language fastest claims and bounded E2B queue");
