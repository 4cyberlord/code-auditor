import assert from "node:assert/strict";
import { executionId, validateExecution, parseExecutionOutput, executionStatus, requiresRepair, withSandboxLifecycle } from "../scripts/lib/phase2Execution.mjs";
assert.match(executionId(), /^[a-f0-9-]{36}$/);
assert.notEqual(executionId(), executionId());
for (const lang of ["python","javascript","typescript","rust","go","php","java","c","cpp"]) {
  assert.equal(validateExecution(lang, "print('ok')", 120000).language, lang);
}
assert.equal(validateExecution("python", "x", 400000).timeoutMs, 300000);
assert.throws(() => validateExecution("unknown","x",1000),/Unsupported/);
assert.throws(() => validateExecution("python","x".repeat(262145),1000),/256 KiB/);
assert.throws(() => validateExecution("python","",1000),/No program/);
const output="CA_STDOUT_BEGIN\nPASS test\nCA_STDOUT_END\nCA_STDERR_BEGIN\nCA_METRICS elapsed_s=0.013 maxrss_kb=2048\nCA_STDERR_END\nCA_EXIT:0\nCA_RUNTIME:e2b python3\n";
const parsed=parseExecutionOutput(output + '\n');
assert.equal(parsed.complete,true);
assert.equal(parsed.exitCode,0);
assert.equal(parsed.remoteElapsedMs,13);
assert.equal(parsed.peakMemoryKb,2048);
assert.equal(parseExecutionOutput("CA_STDOUT_BEGIN\nCA_EXIT:0\nFAIL real\nCA_STDOUT_END\nCA_STDERR_BEGIN\nerror\nCA_STDERR_END\nCA_EXIT:1\nCA_RUNTIME:e2b python3\n").exitCode,1);
assert.equal(parseExecutionOutput("CA_EXIT:0").complete,false);
assert.equal(executionStatus({ok:true,exitCode:null}),"failed");
assert.equal(executionStatus({ok:true,exitCode:0}),"completed");
assert.equal(executionStatus({timedOut:true}),"timed_out");
assert.equal(requiresRepair({ran:true,ok:false,failed:2}),true);
assert.equal(requiresRepair({ran:false,ok:false,failed:0}),false);
console.log("Phase 2 sandbox evidence and policy tests passed.");

const lifecycle=[];
await assert.rejects(withSandboxLifecycle({kill:async()=>lifecycle.push("kill")},async()=>{throw Error("start failed")},async()=>lifecycle.push("execute"),async()=>lifecycle.push("fail")),/start failed/);
assert.deepEqual(lifecycle,["fail","kill"]);
const ok=await withSandboxLifecycle({kill:async()=>{throw Error("cleanup")}},async()=>{},async()=>42);
assert.equal(ok,42);
