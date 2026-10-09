import { strict as assert } from "node:assert";
import { capabilitiesFromSignedBenchmark, attachSignedBenchmarkMetrics } from "../src/lib/authenticatedBenchmarkRouting.ts";
const keys = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
const outcomes=Array.from({length:20},(_,i)=>({
  model:"specialist",family:"graph",evaluationId:"fixture-"+i,correct:i<18,
  verified:true,provenance:"trusted_fixture_runner",
}));
const payload=JSON.stringify(outcomes);
const signature=Buffer.from(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,new TextEncoder().encode(payload))).toString("base64url");
const report={version:1 as const,payload,signature};
const metrics=await capabilitiesFromSignedBenchmark(report,keys.publicKey);
assert.equal(metrics?.[0].verifiedAccuracy,0.9);
assert.equal(metrics?.[0].evaluatedSamples,20);
assert.equal(await capabilitiesFromSignedBenchmark(report,null),null);
assert.equal(await capabilitiesFromSignedBenchmark({...report,payload:"[]"},keys.publicKey),null);
const result=attachSignedBenchmarkMetrics(
  [{id:"specialist",vision:false,verifiedVisual:false,verifiedAccuracy:1,evaluatedSamples:500},{id:"unknown",verifiedAccuracy:1,evaluatedSamples:500}],
  metrics ?? [],
);
assert.equal(result[0].verifiedAccuracy,0.9);
assert.equal(result[0].vision,false);
assert.equal(result[1].verifiedAccuracy,undefined);
console.log("PASS: authenticated reports alone supply historical routing accuracy");
