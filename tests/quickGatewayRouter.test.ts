import { strict as assert } from "node:assert";
import { resolveGatewayCandidates, selectGatewayGpt, parseGatewayRouterChoice, gatewayRouterPrompt } from "../src/lib/quickGatewayRouter.ts";

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
