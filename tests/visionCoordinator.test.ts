import assert from "node:assert/strict";
import { coordinatorCandidates, coordinatorPrompt, verifyCoordinatorAssignment, coordinateAndVerify } from "../src/lib/visionCoordinator.ts";

const approved = [
  {id:"kimi",model:"moonshotai/kimi-k3"},
  {id:"gpt",model:"openai/gpt-5-6-sol"},
  {id:"claude",model:"claude/opus-5-5"},
  {id:"gpt-copy",model:"gpt-5.6-sol"},
  {id:"alien",model:"other/model"},
  {id:"gemini",model:"google/gemini-3-1-pro"},
] as const;
assert.deepEqual(coordinatorCandidates(approved).map(x=>x.id),["gpt","claude","gemini"]);
assert.deepEqual(coordinatorCandidates([{id:"kimi",model:"moonshotai/kimi-k3"}]).map(x=>x.id),["kimi"]);
const prompt=coordinatorPrompt("Regex matching task",approved,5);
assert.ok(prompt.systemPrompt.includes("Do not transcribe"));
assert.ok(prompt.systemPrompt.includes("attached screenshots"));
assert.ok(prompt.userText.includes("screenshotCount"));
assert.equal(verifyCoordinatorAssignment('{"selected":["gpt","claude","alien"],"family":"string","reason":"Regex matching"}',approved)?.selected.length,2);
assert.equal(verifyCoordinatorAssignment('{"selected":["alien"]}',approved),null);
assert.equal(verifyCoordinatorAssignment("not-json",approved),null);
console.log("PASS: fixed-roster visual coordinator priority, no extraction, and strict agent ID validation");

const models=[
  {id:"gpt",model:"openai/gpt-5-6-sol"},
  {id:"claude",model:"claude/opus-5-5"},
  {id:"gemini",model:"google/gemini-3-1-pro"},
  {id:"kimi",model:"moonshotai/kimi-k3"},
] as const;
const received:{model:string;images:number}[]=[];
const outcome=await coordinateAndVerify({
  candidates:models,catalogue:[],note:"Regex problem",screenshotCount:3,
  fallbackOrder:["gpt","claude","gemini","kimi"],
  probe:async (names,vision)=>names.map(model=>({
    model,ok:model!=="openai/gpt-5-6-sol",ms:11,
    error:model==="openai/gpt-5-6-sol"?"not available":null,
    vision:vision&&model!=="moonshotai/kimi-k3",
  })),
  ask:async (model,prompt)=>{
    received.push({model,images:JSON.parse(prompt.userText).screenshotCount});
    return '{"selected":["gemini","claude","kimi"],"family":"string","reason":"complementary reasoning"}';
  },
});
assert.deepEqual(received,[{model:"claude/opus-5-5",images:3}],
  "the first live-verified vision model coordinates using the screenshot metadata");
assert.deepEqual(outcome.routes.map(c=>c.id),["gemini","claude"],
  "only independently vision-verified assigned agents can solve");
assert.equal(outcome.routes.some(c=>c.id==="gpt"||c.id==="kimi"),false);
const fallback=await coordinateAndVerify({
  candidates:models.slice(0,2),catalogue:[],note:"",screenshotCount:1,
  fallbackOrder:["claude","gpt"],
  probe:async names=>names.map(model=>({model,ok:true,ms:2,error:null,vision:true})),
  ask:async()=>{throw Error("simulated coordinator failure");},
});
assert.deepEqual(fallback.routes.map(c=>c.id),["claude","gpt"],
  "coordinator failure must not strand independently verified solvers");
console.log("PASS: coordinator vision preflight, bounded assignment and safe fallback");
