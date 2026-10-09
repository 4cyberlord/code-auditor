import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { verifySignedBenchmarkReport } from "../src/lib/signedBenchmark.ts";

const dir = await mkdtemp(join(tmpdir(),"council-benchmark-"));
try {
  const pair = await webcrypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  const privateJwk = await webcrypto.subtle.exportKey("jwk",pair.privateKey);
  const run = (input: string, output: string) => spawnSync(process.execPath,
    ["scripts/sign-benchmark.mjs",input,output],
    {encoding:"utf8",env:{...process.env,BENCHMARK_SIGNING_PRIVATE_JWK:JSON.stringify(privateJwk)}});
  const input = join(dir,"fixture.json"), output = join(dir,"signed.json");
  const record = {model:"runner",family:"graph",evaluationId:"fixture-1",correct:true,verified:true,provenance:"trusted_fixture_runner"};
  await writeFile(input,JSON.stringify([record]));
  assert.equal(run(input,output).status,0);
  const signed = JSON.parse(await readFile(output,"utf8"));
  const publicJwk=await webcrypto.subtle.exportKey("jwk",pair.publicKey);
  const key = await crypto.subtle.importKey("jwk",publicJwk,{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  assert.equal((await verifySignedBenchmarkReport(signed,key))?.length,1);
  assert.notEqual(run(input,output).status,0,"must not overwrite signed report");
  await writeFile(input,JSON.stringify([record,{...record,family:"tree"}]));
  assert.notEqual(run(input,join(dir,"duplicates.json")).status,0);
  await writeFile(input,JSON.stringify([{...record,verified:false}]));
  assert.notEqual(run(input,join(dir,"unverified.json")).status,0);
  console.log("PASS: signer interoperability, anti-overwrite, duplicate and trust checks");
} finally { await rm(dir,{recursive:true,force:true}); }
