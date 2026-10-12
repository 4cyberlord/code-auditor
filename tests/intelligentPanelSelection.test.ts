import { strict as assert } from "node:assert";
import { planIntelligentPanels } from "../src/lib/intelligentPanelSelection.ts";
import { routeProblem, routeUnparsedProblem } from "../src/lib/problemRouting.ts";
const graph=routeProblem({problemSummary:"Shortest path graph with Dijkstra",observations:[],ambiguities:[],confidence:0.98,code:"",kind:"code"});
const array=routeProblem({problemSummary:"Find the prefix sum of an array",observations:[],ambiguities:[],confidence:0.98,code:"",kind:"code"});
const candidates=[
  {id:"a",model:"generic",canSeeImages:true},
  {id:"b",model:"graph",canSeeImages:true},
  {id:"c",model:"fallback",canSeeImages:false},
  {id:"d",model:"other",canSeeImages:true},
];
const now=Date.now();
const probes={
  generic:{ok:true,at:now,ms:5000,vision:true},
  graph:{ok:true,at:now,ms:2000,vision:true},
  fallback:{ok:true,at:now,ms:1000,vision:false},
  other:{ok:true,at:now,ms:3000,vision:false},
};
const trusted=[{id:"graph",families:["graph"] as const,verifiedAccuracy:.92,evaluatedSamples:80},{id:"generic",verifiedAccuracy:.8,evaluatedSamples:50}];
const decision=planIntelligentPanels({candidates,route:graph,hasImages:true,safeTextOnly:false,probes,trustedMetrics:trusted,now});
assert.deepEqual(decision.selected,["b","a"]);
assert.equal(decision.requiredImageAccess,true);
assert.equal(decision.confidence,"verified");
const plain=planIntelligentPanels({candidates,route:array,hasImages:true,safeTextOnly:true,probes,trustedMetrics:trusted,now});
assert.equal(plain.selected.length,2);
assert.ok(plain.selected.includes("c") || plain.selected.includes("a"));
const unseen=planIntelligentPanels({candidates,route:graph,hasImages:true,safeTextOnly:false,probes:{},trustedMetrics:trusted,now});
assert.equal(unseen.selected.length,0,"no invented vision capability");
const stale=planIntelligentPanels({candidates,route:graph,hasImages:true,safeTextOnly:false,
  probes:{graph:{ok:true,at:now-2*24*60*60*1000,ms:1,vision:true}},trustedMetrics:[],now});
assert.equal(stale.selected.length,0,"stale vision probes cannot authorize screenshot bytes");
const unknown=planIntelligentPanels({candidates,route:routeUnparsedProblem("",true),hasImages:true,safeTextOnly:false,probes,trustedMetrics:[],now});
assert.equal(unknown.selected.length,2,"unverified image routes remain excluded");
assert.equal(unknown.confidence,"limited");
const disabled=planIntelligentPanels({candidates:candidates.slice(0,1),route:array,hasImages:false,safeTextOnly:false,probes:{},trustedMetrics:[],now});
assert.deepEqual(disabled.selected,["a"]);
console.log("PASS: evidence-based intelligent panel selection, fail-closed vision, complexity, and fallbacks");
