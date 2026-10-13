import { strict as assert } from "node:assert";
import { resolveGatewayCandidates, resolveListedGatewayModel, verifyGatewayCandidates, selectGatewayGpt, parseGatewayRouterChoice, gatewayRouterPrompt } from "../src/lib/quickGatewayRouter.ts";

const now=Date.now();
const choices=["openai/gpt-5-6-sol","claude/opus-5-5","google/gemini-3-1-pro","openai/gpt-5-6-terra"];
const candidates=[
  {id:"openai",model:"openai/gpt-5-6-sol"},
  {id:"moonshot",model:"moonshotai/kimi-k3"},
  {id:"anthropic",model:"claude/opus-5-5"},
  {id:"gemini",model:"google/gemini-3.1-pro"},
] as const;
const resolved=resolveGatewayCandidates({configured:candidates,catalogue:choices,now,deniedModels:["moonshotai/kimi-k3"]});
assert.deepEqual(resolved.map(c=>c.id),["openai","anthropic","gemini"]);
assert.equal(resolved.find(c=>c.id==="gemini")?.model,"google/gemini-3-1-pro");
assert.equal(resolved.find(c=>c.id==="gemini")?.unchanged,false);
assert.equal(selectGatewayGpt(choices,{},now),"openai/gpt-5-6-sol");
assert.equal(selectGatewayGpt(["claude/opus-5-5"],{},now),null);
assert.equal(selectGatewayGpt(["openai/gpt-5-6-sol"],{
  "openai/gpt-5-6-sol":{ok:false,error:"Model id is not available",at:now}
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
    model,ok:["openai/gpt-5-6-sol","claude/opus-5-5"].includes(model),
    ms:20,error:null,vision:null,
  }));},
});
assert.deepEqual(recovered.routes.map(c=>c.id),["openai","anthropic"],
  "broken catalogue must retain every configured route that passes an actual live probe");
assert.deepEqual(recovered.routes.map(c=>c.model),["openai/gpt-5-6-sol","claude/opus-5-5"]);
assert.equal(recovered.routes.some(c=>c.id==="moonshot"),false,"blocked Wiro model must not be selected");
assert.equal(recovered.routes.some(c=>c.id==="gemini"),false,"failed model must not be selected");
assert.ok(probeLog[0].includes("openai/gpt-5-6-sol"));
const alternatives=await verifyGatewayCandidates({
  configured:candidates.slice(2),catalogue:choices,requireVision:false,
  probe:async(models)=>models.map(model=>({
    model,ok:!model.includes("gemini"),ms:10,
    error:model.includes("gemini")?"Model id is not available":null,vision:null,
  })),
});
assert.equal(alternatives.routes.find(r=>r.id==="gemini"),undefined,
  "an unapproved Gemini version must never replace the sole approved Gemini model");
const wiroAlias = await verifyGatewayCandidates({
  configured:[{id:"gemini",model:"google/gemini-3.1-pro"}],
  catalogue:["google/gemini-3-7-flash","google/gemini-3-1-pro"],
  requireVision:false,
  probe:async(models)=>models.map(model=>({
    model,ok:model==="google/gemini-3-1-pro",ms:10,error:null,vision:null,
  })),
});
assert.deepEqual(wiroAlias.probes.map(p=>p.model),["google/gemini-3-1-pro"],
  "Wiro's listed spelling should be probed before the saved TokenRouter spelling");
assert.equal(wiroAlias.routes[0]?.model,"google/gemini-3-1-pro");
assert.equal(resolveGatewayCandidates({
  configured:[{id:"gemini",model:"google/gemini-3.1-pro"}],
  catalogue:["google/gemini-3-7-flash","google/gemini-3-1-pro"],now,
})[0]?.model,"google/gemini-3-1-pro");
assert.equal(resolveListedGatewayModel("anthropic/claude-opus-5.5",["claude/opus-5-5"]),"claude/opus-5-5");
assert.equal(resolveListedGatewayModel("openai/gpt-5.6-sol",["openai/gpt-5-6-sol"]),"openai/gpt-5-6-sol");
assert.equal(resolveListedGatewayModel("moonshotai/kimi-k3",["claude/opus-5"]),null);
assert.deepEqual(resolveGatewayCandidates({
  configured:[{id:"gemini",model:"google/gemini-3.7-flash"}],
  catalogue:["google/gemini-3-7-flash"],now,
}),[],"an old configured model outside the fixed roster is rejected");
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
const newlyAvailableKimi=await verifyGatewayCandidates({
  configured:[{id:"moonshot",model:"moonshotai/kimi-k3"}],
  catalogue:["moonshotai/kimi-k3"],requireVision:false,
  probe:async(models)=>models.map(model=>({model,ok:true,ms:11,error:null,vision:null})),
});
assert.equal(newlyAvailableKimi.routes[0]?.model,"moonshotai/kimi-k3",
  "Kimi becomes eligible automatically when the gateway lists and verifies it");
const exactSlot = await verifyGatewayCandidates({
  configured:[{id:"fable",model:"claude-fable-5.1"}],
  catalogue:["claude-fable-5.1","claude-opus-5.5"], requireVision:false,
  allowFamilyAlternatives:false,
  probe:async(models)=>models.map(model=>({model,ok:false,ms:1,error:"no access",vision:null})),
});
assert.deepEqual(exactSlot.probes.map(probe=>probe.model),["claude-fable-5.1"],
  "a named roster slot never turns into another model or spends a second probe on an alias");
assert.equal(selectGatewayGpt(["gpt-5.6-sol","gpt-5-mini"]),"gpt-5.6-sol",
  "Clean API's plain GPT ID participates in routing while unapproved variants are excluded");
console.log("PASS: fail-closed live gateway preflight and fallback");
