import { strict as assert } from "node:assert";
import { verifySignedBenchmarkReport } from "../src/lib/signedBenchmark.ts";

const keys = await crypto.subtle.generateKey(
  { name:"ECDSA", namedCurve:"P-256" }, true, ["sign","verify"],
);
const record = { model:"verified-model", family:"graph", evaluationId:"fixture-001", correct:true, verified:true, provenance:"trusted_fixture_runner" };
const payload = JSON.stringify([record]);
const sig = await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,new TextEncoder().encode(payload));
const signature = Buffer.from(sig).toString("base64url");
const report = { version:1 as const, payload, signature };
assert.equal((await verifySignedBenchmarkReport(report,keys.publicKey))?.[0].model,"verified-model");
assert.equal(await verifySignedBenchmarkReport({...report,payload:JSON.stringify([{...record,correct:false}])},keys.publicKey),null);
const other = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
assert.equal(await verifySignedBenchmarkReport(report,other.publicKey),null);
assert.equal(await verifySignedBenchmarkReport(report,null),null);
assert.equal(await verifySignedBenchmarkReport({...report,signature:"not valid"},keys.publicKey),null);
const invalidPayload=JSON.stringify([{...record,provenance:"self_reported"}]);
const invalidSig=Buffer.from(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,new TextEncoder().encode(invalidPayload))).toString("base64url");
assert.equal(await verifySignedBenchmarkReport({version:1,payload:invalidPayload,signature:invalidSig},keys.publicKey),null);
console.log("PASS: signed benchmark key pinning, tampering and schema checks");

async function signFixture(records: unknown[]) {
  const payload=JSON.stringify(records);
  const signature=Buffer.from(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,new TextEncoder().encode(payload))).toString("base64url");
  return {version:1 as const,payload,signature};
}
assert.equal(await verifySignedBenchmarkReport(await signFixture([{...record,family:"fake_family"}]),keys.publicKey),null);
assert.equal(await verifySignedBenchmarkReport(await signFixture([record,record]),keys.publicKey),null);
console.log("PASS: malformed signed benchmark fixtures rejected");

assert.equal(await verifySignedBenchmarkReport(
  await signFixture([record,{...record,family:"tree"}]),keys.publicKey
),null);
console.log("PASS: fixture IDs cannot be reused across problem categories");
