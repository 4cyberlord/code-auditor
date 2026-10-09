import { strict as assert } from "node:assert";
import { webcrypto } from "node:crypto";
import { verifySignedBenchmarkReport } from "../src/lib/signedBenchmark.ts";

const keys = await webcrypto.subtle.generateKey(
  { name:"ECDSA", namedCurve:"P-256" }, true, ["sign","verify"],
);
const record = { model:"verified-model", family:"graph", evaluationId:"fixture-001", correct:true, verified:true, provenance:"trusted_fixture_runner" };
const payload = JSON.stringify([record]);
const sig = await webcrypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,new TextEncoder().encode(payload));
const signature = Buffer.from(sig).toString("base64url");
const report = { version:1 as const, payload, signature };
assert.equal((await verifySignedBenchmarkReport(report,keys.publicKey))?.[0].model,"verified-model");
assert.equal(await verifySignedBenchmarkReport({...report,payload:JSON.stringify([{...record,correct:false}])},keys.publicKey),null);
const other = await webcrypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
assert.equal(await verifySignedBenchmarkReport(report,other.publicKey),null);
assert.equal(await verifySignedBenchmarkReport(report,null),null);
assert.equal(await verifySignedBenchmarkReport({...report,signature:"not valid"},keys.publicKey),null);
const invalidPayload=JSON.stringify([{...record,provenance:"self_reported"}]);
const invalidSig=Buffer.from(await webcrypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,new TextEncoder().encode(invalidPayload))).toString("base64url");
assert.equal(await verifySignedBenchmarkReport({version:1,payload:invalidPayload,signature:invalidSig},keys.publicKey),null);
console.log("PASS: signed benchmark key pinning, tampering and schema checks");
