import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir=await mkdtemp(join(tmpdir(),"council-runner-"));
try {
 const candidate=join(dir,"candidate.cjs"), manifest=join(dir,"manifest.json"), output=join(dir,"out.json");
 await writeFile(candidate,"module.exports = (x) => x + 1;\n");
 await writeFile(manifest,JSON.stringify({candidate:{model:"fixture-test",script:candidate},fixtures:[{id:"f1",family:"math",input:2,expected:3}]}));
 const invoke=(env:Record<string,string>)=>spawnSync(process.execPath,["scripts/run-benchmark.mjs",manifest,output],{env:{...process.env,COUNCIL_BENCHMARK_ROOT:dir,...env},encoding:"utf8"});
 assert.notEqual(invoke({COUNCIL_TRUSTED_BENCHMARK_ENV:""}).status,0);
 assert.equal(invoke({COUNCIL_TRUSTED_BENCHMARK_ENV:"isolated-operator"}).status,0);
 const rows=JSON.parse(await readFile(output,"utf8"));
 assert.equal(rows[0].correct,true);
 assert.equal(rows[0].verified,false);
 assert.equal(rows[0].provenance,"unreviewed_execution");
 const outside=spawnSync(process.execPath,["scripts/run-benchmark.mjs",manifest,join(dir,"outside.json")],
   {env:{...process.env,COUNCIL_TRUSTED_BENCHMARK_ENV:"isolated-operator",COUNCIL_BENCHMARK_ROOT:join(dir,"missing")},encoding:"utf8"});
 assert.notEqual(outside.status,0,"candidate outside approved workspace must fail");
 const root = join(dir,"approved");
 const outsideDir = join(dir,"unapproved");
 await mkdir(root);
 await mkdir(outsideDir);
 const externalCandidate = join(outsideDir,"external.cjs");
 await writeFile(externalCandidate,"module.exports=(x)=>x+1;");
 await symlink(outsideDir,join(root,"linked"));
 const linkedManifest = join(dir,"linked.json");
 await writeFile(linkedManifest,JSON.stringify({
   candidate:{model:"fixture-test",script:join(root,"linked","external.cjs")},
   fixtures:[{id:"f1",family:"math",input:2,expected:3}],
 }));
 const linkedRun=spawnSync(process.execPath,["scripts/run-benchmark.mjs",linkedManifest,join(dir,"linked-out.json")],
   {env:{...process.env,COUNCIL_TRUSTED_BENCHMARK_ENV:"isolated-operator",COUNCIL_BENCHMARK_ROOT:root},encoding:"utf8"});
 assert.notEqual(linkedRun.status,0,"symlinked parent escape must fail");
 console.log("PASS: independent execution runner refuses non-isolated runs and cannot self-attest results");
} finally {await rm(dir,{recursive:true,force:true});}
