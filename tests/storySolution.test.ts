import { strict as assert } from "node:assert";
import { extractFunctionSignatures, selectStorySolution } from "../src/lib/storySolution.ts";
import type { AgentFinal } from "../src/lib/parse.ts";
const final=(code:string):AgentFinal=>({kind:"code",language:"python",answer:"Use a map",complexity:"O(n)",confidence:0.9,claims:[],code,raw:"",wellFormed:true});
const agents=[
  {id:"a",model:"model A",enabled:true,status:"done" as const,final:final("def f():\n return 1")},
  {id:"b",model:"model B",enabled:true,status:"done" as const,final:final("def solve(nums):\n return nums")},
];
const council={phase:"idle",winner:"",candidates:[],runs:{},revisedRuns:{},error:null};
assert.equal(selectStorySolution(agents,council,"b")?.source,"model B");
assert.equal(selectStorySolution(agents,council,"b")?.benchmark,null);
assert.equal(selectStorySolution(agents,council,"b")?.provisional,true,"pane code is not a measured final answer");
assert.equal(selectStorySolution([{...agents[0],status:"queued" as const,final:null}],council),null);
const victory={...council,phase:"done",winner:"B",candidates:[{letter:"B",model:"validated",final:final("def winner():\n return 2"),text:"",error:null}],runs:{},revisedRuns:{}};
assert.equal(selectStorySolution(agents,victory,"a")?.source,"validated");
assert.equal(selectStorySolution(agents,victory,"a")?.provisional,true,"unmeasured council code remains provisional");
const measured={...victory,runs:{B:{letter:"B",ran:true,ok:true,passed:12,failed:0,durationMs:7,remoteElapsedMs:5,note:"",runtime:"python"}}};
assert.equal(selectStorySolution(agents,measured,"a")?.provisional,false,"only passing execution completes a code solution");
assert.equal(selectStorySolution(agents,measured,"a")?.benchmark?.remoteElapsedMs,5);
assert.deepEqual(extractFunctionSignatures("def solve(nums):\n pass\nfunction verify(x) {\n}\nfn evaluate(v: i32) {}").map(x=>x.name),["solve","verify","evaluate"]);
console.log("PASS: solution display prefers verified winner; no benchmark attribution without evidence");
