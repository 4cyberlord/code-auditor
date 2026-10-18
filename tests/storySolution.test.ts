import { strict as assert } from "node:assert";
import { extractFunctionSignatures, selectStorySolution, selectVerifiedStorySolution } from "../src/lib/storySolution.ts";
import type { AgentFinal } from "../src/lib/parse.ts";
import { harnessPreflightDiagnostics, missingSuiteLanguages, testSpecSystemPrompt, testSpecUserPrompt } from "../src/lib/council.ts";
const final=(code:string):AgentFinal=>({kind:"code",language:"python",answer:"Use a map",complexity:"O(n)",confidence:0.9,claims:[],code,raw:"",wellFormed:true});
const agents=[
  {id:"a",model:"model A",enabled:true,status:"done" as const,final:final("def f():\n return 1")},
  {id:"b",model:"model B",enabled:true,status:"done" as const,final:final("def solve(nums):\n return nums")},
];
const council={phase:"idle",winner:"",candidates:[],runs:{},revisedRuns:{},error:null};
assert.equal(selectStorySolution(agents,council,"b"),null,"unverified solver answers stay hidden");
assert.equal(selectVerifiedStorySolution(agents,council,"b"),null,"no code is published during Council handoff");
assert.equal(selectStorySolution([{...agents[0],status:"queued" as const,final:null}],council),null);
assert.deepEqual(harnessPreflightDiagnostics("python", "x = [2 if i % 2 == 0 else -1 for _ in range(2000)]\n<<<SOLUTION>>>"), ["comprehension references 'i' but iterates '_'"]);
assert.deepEqual(harnessPreflightDiagnostics("python", "x = [2 if i % 2 == 0 else -1 for i in range(2000)]\n<<<SOLUTION>>>"), []);
const victory={...council,phase:"done",winner:"B",candidates:[{letter:"B",model:"validated",final:final("def winner():\n return 2"),text:"",error:null}],runs:{},revisedRuns:{}};
assert.equal(selectStorySolution(agents,victory,"a"),null,"done without passing evidence stays hidden");
assert.equal(selectVerifiedStorySolution(agents,victory,"a"),null,"no code is published without E2B tests");
const measured={...victory,runs:{B:{letter:"B",ran:true,ok:true,passed:12,failed:0,durationMs:7,remoteElapsedMs:5,note:"",runtime:"python"}}};
assert.equal(selectStorySolution(agents,measured,"a")?.provisional,false,"only passing execution completes a code solution");
assert.equal(selectStorySolution(agents,measured,"a")?.benchmark?.remoteElapsedMs,5);
assert.equal(selectVerifiedStorySolution(agents,measured,"a")?.source,"validated");
const porting={...measured,phase:"porting"};
assert.equal(selectVerifiedStorySolution(agents,porting,"a")?.source,"validated",
  "the verified primary answer stays visible while optional language ports run");
assert.deepEqual(missingSuiteLanguages(["c++20", "python3"], [{language:"cpp",harness:"<<<SOLUTION>>>"}]), ["python"],
  "partial harness output cannot verify an untested language");
const specInstructions=testSpecSystemPrompt();
assert.match(specInstructions,/reproduce ALL valid supplied cases as executable assertions/i);
assert.match(specInstructions,/When examples do not exist, derive a small test battery/i);
assert.match(specInstructions,/Never invent expected outputs/i);
assert.match(specInstructions,/independent REFERENCE implementation/i);
assert.match(testSpecUserPrompt({question:"Example 1: input [1, 2], output 3",docket:"Candidate A",languages:["python"]}),/Example 1: input \[1, 2\], output 3/);
assert.deepEqual(extractFunctionSignatures("def solve(nums):\n pass\nfunction verify(x) {\n}\nfn evaluate(v: i32) {}").map(x=>x.name),["solve","verify","evaluate"]);
console.log("PASS: solution display prefers verified winner; no benchmark attribution without evidence");
