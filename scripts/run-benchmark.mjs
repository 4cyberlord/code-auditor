#!/usr/bin/env node
/**
 * Independent benchmark fixture runner. Executes a candidate's JavaScript
 * implementation in an isolated child process with a hard timeout. This CLI
 * is an operator tool, NOT a sandbox for hostile submissions: run it inside
 * the existing isolated benchmark environment with no network or secrets.
 *
 * Input JSON: { fixtures:[{id,family,input,expected}], candidate:{model,script} }
 * Script must export a CommonJS function via module.exports = function(input).
 * Fixtures and expected outputs MUST come from a trusted, pre-reviewed source.
 */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const [inputPath,outputPath]=process.argv.slice(2);
if (!inputPath || !outputPath) { console.error("Usage: node scripts/run-benchmark.mjs input.json outcomes.json");process.exit(2); }
const allowed=new Set(["array","string","tree","graph","dynamic_programming","linked_list","heap","math","geometry","database","concurrency","greedy","backtracking","other"]);
try {
 if (process.env.COUNCIL_TRUSTED_BENCHMARK_ENV !== "isolated-operator") throw Error("Refusing to execute outside a designated isolated benchmark environment");
 const spec=JSON.parse(await readFile(inputPath,"utf8"));
 if (!spec || !Array.isArray(spec.fixtures) || !spec.fixtures.length || spec.fixtures.length>2000 ||
     typeof spec.candidate?.model!=="string" || !spec.candidate.model.trim() ||
     typeof spec.candidate.script!=="string" || !spec.candidate.script.trim()) throw Error("Invalid benchmark manifest");
 const ids=new Set();
 for(const f of spec.fixtures) {
   if(typeof f.id!=="string" || !f.id.trim() || ids.has(f.id) || !allowed.has(f.family) ||
      !Object.hasOwn(f,"expected") || !Object.hasOwn(f,"input"))throw Error("Invalid or duplicate fixture");
   ids.add(f.id);
 }
 // Child process is bounded but not an OS security sandbox. Never execute
 // untrusted code outside a dedicated container/VM with network blocked.
 // A path within the reviewed benchmark workspace is necessary, but not a
 // substitute for OS/container isolation of untrusted candidate code.
 const childScript=resolve(spec.candidate.script);
 const benchmarkRoot=resolve(process.env.COUNCIL_BENCHMARK_ROOT || process.cwd());
 const { relative, isAbsolute } = await import("node:path");
 const candidateRelative=relative(benchmarkRoot,childScript);
 if (!candidateRelative || candidateRelative===".." || candidateRelative.startsWith("../") ||
     isAbsolute(candidateRelative)) throw Error("Candidate is outside benchmark workspace");
 const { lstat, realpath } = await import("node:fs/promises");
 const actualRoot = await realpath(benchmarkRoot);
 const actualCandidate = await realpath(childScript);
 const actualRelative = relative(actualRoot, actualCandidate);
 if (!actualRelative || actualRelative === ".." || actualRelative.startsWith("../") ||
     isAbsolute(actualRelative)) throw Error("Candidate resolves outside benchmark workspace");
 const entry = await lstat(childScript);
 if (entry.isSymbolicLink()) throw Error("Symlinked candidate entry point is not allowed");
 if (!entry.isFile()) throw Error("Candidate must be a regular file");
 // Reject scripts capable of traversing arbitrarily large input/output payloads
 // before spawning any candidate process. Execution still requires OS isolation.
 const manifestBytes=Buffer.byteLength(JSON.stringify(spec));
 if (manifestBytes>2_000_000) throw Error("Benchmark manifest exceeds 2 MB");
 const timeoutMs=1500;
 const outcomes=[];
 for(const fixture of spec.fixtures) {
   const begin=Date.now();
   const output=await new Promise((done)=>{
     const child=spawn(process.execPath,["-e",`
       const f=require(process.argv[1]);let input="";
       process.stdin.setEncoding("utf8");
       process.stdin.on("data",x=>input+=x);
       process.stdin.on("end",async()=>{try {
         const fn=typeof f==="function"?f:f.solve;
         if(typeof fn!=="function")throw Error("Missing solve()");
         const result=await fn(JSON.parse(input));
         process.stdout.write(JSON.stringify({ok:true,result}));
       }catch {process.stdout.write(JSON.stringify({ok:false}));}});
     `,childScript],{stdio:["pipe","pipe","ignore"],env:{PATH:process.env.PATH??"",HOME:"/nonexistent"},cwd:process.cwd()});
     let data="",finished=false;
     const settle=(v)=>{if(finished)return;finished=true;clearTimeout(timer);done(v);};
     const timer=setTimeout(()=>{child.kill("SIGKILL");settle({ok:false});},timeoutMs);
     child.stdout.on("data",buf=>{data+=buf.toString();if(data.length>65536){child.kill("SIGKILL");settle({ok:false});}});
     child.on("error",()=>settle({ok:false}));
     child.stdin.on("error",()=>settle({ok:false}));
     child.on("close",()=>{try{settle(JSON.parse(data));}catch{settle({ok:false});}});
     child.stdin.end(JSON.stringify(fixture.input));
   });
   outcomes.push({model:spec.candidate.model,family:fixture.family,evaluationId:fixture.id,
     verified:false,provenance:"unreviewed_execution",
     correct:output?.ok===true && JSON.stringify(output.result)===JSON.stringify(fixture.expected),
     latencyMs:Date.now()-begin});
 }
 await writeFile(outputPath,JSON.stringify(outcomes,null,2)+"\n",{flag:"wx",mode:0o600});
 console.log("Executed",outcomes.length,"fixtures; results REQUIRE independent operator review before signing");
} catch(error) {console.error(error instanceof Error?error.message:"Benchmark failed");process.exitCode=1;}
