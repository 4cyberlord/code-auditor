import { strict as assert } from "node:assert";
import { resolveGatewayCandidates, verifyGatewayCandidates, selectGatewayGpt, parseGatewayRouterChoice, gatewayRouterPrompt } from "../src/lib/quickGatewayRouter.ts";

const now=Date.now();
const choices=["openai/gpt-5-6-sol","claude/opus-5","google/gemini-2.5-flash","openai/gpt-5-mini"];
const candidates=[
  {id:"openai",model:"openai/gpt-5-6-sol"},
  {id:"moonshot",model:"moonshotai/kimi-k3"},
  {id:"anthropic",model:"claude/opus-5"},
  {id:"gemini",model:"google/gemini-3.7-flash"},
] as const;
const resolved=resolveGatewayCandidates({configured:candidates,catalogue:choices,now,deniedModels:["moonshotai/kimi-k3"]});
assert.deepEqual(resolved.map(c=>c.id),["openai","anthropic","gemini"]);
assert.equal(resolved.find(c=>c.id==="gemini")?.model,"google/gemini-2.5-flash");
assert.equal(resolved.find(c=>c.id==="gemini")?.unchanged,false);
assert.equal(selectGatewayGpt(choices,{},now),"openai/gpt-5-mini");
assert.equal(selectGatewayGpt(["claude/opus-5"],{},now),null);
assert.equal(selectGatewayGpt(["openai/gpt-5-mini"],{
  "openai/gpt-5-mini":{ok:false,error:"Model id is not available",at:now}
},now),null);
const response='{\"selected\":[\"anthropic\",\"moonshot\",\"gemini\",\"anthropic\"],\"reason\":\"graph reviewers\",\"family\":\"graph\"}';
assert.deepEqual(parseGatewayRouterChoice(response,["openai","anthropic","gemini"])?.selected,["anthropic","gemini"]);
assert.equal(parseGatewayRouterChoice('bad',["anthropic"]),null);
assert.equal(parseGatewayRouterChoice('{\"selected\":[\"invalid\"]}',["anthropic"]),null);
assert.equal(parseGatewayRouterChoice('{\"selected\":[\"anthropic\"]}',["anthropic"],1)?.selected[0],"anthropic");
const prompt=gatewayRouterPrompt("Solve this graph",resolved,["openai","anthropic"]);
assert.ok(prompt.systemPrompt.includes("untrusted"));
assert.ok(prompt.userText.includes("openai/gpt-5-6-sol"));
console.log("PASS: live gateway catalogue, GPT fast choice, fail-closed ID validation");

const probeLog:string[][]=[];
const recovered = await verifyGatewayCandidates({
  configured:candidates, catalogue:[], deniedModels:["moonshotai/kimi-k3"],
  requireVision:false,
  probe:async(models)=>{probeLog.push(models);return models.map(model=>({
    model,ok:["openai/gpt-5-6-sol","claude/opus-5"].includes(model),
    ms:20,error:null,vision:null,
  }));},
});
assert.deepEqual(recovered.routes.map(c=>c.id),["openai","anthropic"],
  "broken catalogue must retain every configured route that passes an actual live probe");
assert.deepEqual(recovered.routes.map(c=>c.model),["openai/gpt-5-6-sol","claude/opus-5"]);
assert.equal(recovered.routes.some(c=>c.id==="moonshot"),false,"blocked Wiro model must not be selected");
assert.equal(recovered.routes.some(c=>c.id==="gemini"),false,"failed model must not be selected");
assert.ok(probeLog[0].includes("openai/gpt-5-6-sol"));
const alternatives=await verifyGatewayCandidates({
  configured:candidates.slice(2),catalogue:choices,requireVision:false,
  probe:async(models)=>models.map(model=>({
    model,ok:model!=="google/gemini-3.7-flash",ms:10,
    error:model==="google/gemini-3.7-flash"?"Model id is not available":null,vision:null,
  })),
});
assert.equal(alternatives.routes.find(r=>r.id==="gemini")?.model,"google/gemini-2.5-flash","fallback requires its own successful real probe");
const unavailable=await verifyGatewayCandidates({
  configured:candidates.slice(0,1),catalogue:choices,requireVision:false,
  probe:async(models)=>models.map(model=>({model,ok:false,ms:9,error:"unauthorized",vision:null})),
});
assert.equal(unavailable.routes.length,0,"failed models cannot be dispatched");
const noVision=await verifyGatewayCandidates({
  configured:candidates.slice(0,1),catalogue:choices,requireVision:true,
  probe:async(models)=>models.map(model=>({model,ok:true,ms:9,error:null,vision:false})),
});
assert.equal(noVision.routes.length,0,"screenshot calls require a real vision probe");
console.log("PASS: fail-closed live gateway preflight and fallback");
