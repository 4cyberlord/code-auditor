import assert from "node:assert/strict";
import { planBackgroundIntelligence } from "../src/lib/backgroundIntelligence.ts";
const models = [
 { id:"unprobed", expertise:["tree"] as const, vision:true },
 { id:"probed", expertise:["tree"] as const, vision:true },
 { id:"text", expertise:["math"] as const, vision:false },
];
const empty = planBackgroundIntelligence({models,probes:{probed:{vision:true,ok:true}},hasImages:true,passesImages:true});
assert.deepEqual(empty.selection.selected.map(x=>x.id),["probed"]);
assert.equal(empty.safeTextOnly,false);
assert.equal(empty.route.path,"ambiguity_review");
const reading = {
 extraction:{kind:"problem",problemSummary:"Binary tree nodes",observations:[],code:"",confidence:0.96,ambiguities:[]},
 readerDetails:[{confidence:0.97,ambiguities:[]},{confidence:0.95,ambiguities:[]}],
 agreement:{agree:true},
};
const trusted=planBackgroundIntelligence({models,reading,hasImages:true,passesImages:false});
assert.equal(trusted.safeTextOnly,true);
assert.equal(trusted.route.families.includes("tree"),true);
assert.equal(trusted.selection.selected.length,3);
const disputed=planBackgroundIntelligence({models,reading:{...reading,agreement:{agree:false}},hasImages:true,passesImages:false});
assert.equal(disputed.safeTextOnly,false);
console.log("background intelligence routing: passed");
