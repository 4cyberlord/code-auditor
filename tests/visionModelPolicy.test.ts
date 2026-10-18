import assert from "node:assert/strict";
import { isVerifiedImageProbe, preferredVisionModels, verifiedImageProbes } from "../src/lib/visionModelPolicy.ts";

const genuine={ok:true,vision:true,ms:230,visionNote:'Read the test image correctly ("red").'};
assert.equal(isVerifiedImageProbe(genuine),true);
assert.equal(isVerifiedImageProbe({...genuine,ms:0}),false);
assert.equal(isVerifiedImageProbe({...genuine,visionNote:"Approved Clean API roster route; the real solver request validates this submission's Azure URLs."}),false);
assert.equal(isVerifiedImageProbe({...genuine,ok:false}),false);
assert.equal(isVerifiedImageProbe({...genuine,vision:null}),false);
assert.deepEqual(preferredVisionModels([
  "gpt-5.6-sol","kimi-k3","claude/opus-5-5","google/gemini-3-1-pro",
]),["google/gemini-3-1-pro","claude/opus-5-5","gpt-5.6-sol"]);
assert.deepEqual(preferredVisionModels(["gemini-4-argon","gpt-5.6-sol"]),["gpt-5.6-sol"]);
assert.deepEqual(Object.keys(verifiedImageProbes({a:genuine,b:{...genuine,ms:0}})),["a"]);
console.log("PASS: approved CleanAPI specialist ranking and genuine image transport");
