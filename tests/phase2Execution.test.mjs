import assert from "node:assert/strict";
import { executionId, validateExecution, parseExecutionOutput, executionStatus, requiresRepair, repairOutcome, withSandboxLifecycle } from "../scripts/lib/phase2Execution.mjs";
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
await assert.rejects(withSandboxLifecycle({kill:async()=>{throw Error("cleanup")}},async()=>{},async()=>42),/Sandbox cleanup failed/);
const ok=await withSandboxLifecycle({kill:async()=>{}},async()=>{},async()=>42);
assert.equal(ok,42);
const partial=parseExecutionOutput("CA_STDOUT_BEGIN\ntext\nCA_STDOUT_END\nCA_STDERR_BEGIN\nCA_METRICS elapsed_s=1 maxrss_kb=123\n");
assert.equal(partial.complete,false);
assert.equal(partial.remoteElapsedMs,null);
assert.equal(partial.peakMemoryKb,null);


// Fail-closed regression checks: malformed markers must not supply success evidence.
for (const malformed of [
  "CA_EXIT:0\nCA_RUNTIME:e2b python3\n",
  "CA_STDOUT_BEGIN\nOK\nCA_STDOUT_END\nCA_STDERR_BEGIN\nCA_METRICS elapsed_s=1 maxrss_kb=12\n",
  "CA_STDOUT_BEGIN\nOK\nCA_STDOUT_END\nCA_STDERR_BEGIN\nCA_STDERR_END\nCA_EXIT:not-a-number\nCA_RUNTIME:e2b python3\n",
]) {
  const result = parseExecutionOutput(malformed);
  assert.equal(result.complete, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.remoteElapsedMs, null);
  assert.equal(result.peakMemoryKb, null);
}
assert.equal(executionStatus({canceled:true,ok:true,exitCode:0}), "canceled");
assert.equal(executionStatus({timedOut:true,ok:true,exitCode:0}), "timed_out");
const order=[];
await assert.rejects(withSandboxLifecycle(
  { kill: async () => order.push("cleanup") },
  async () => order.push("started"),
  async () => { order.push("executed"); throw Error("execution failed"); },
  async () => order.push("failed"),
), /execution failed/);
assert.deepEqual(order, ["started","executed","failed","cleanup"]);

assert.equal(requiresRepair({ ran: true, ok: false, failed: 1, state: "canceled" }), false);
assert.equal(requiresRepair({ ran: true, ok: false, failed: 1, note: "the generated harness did not build or start" }), false);
assert.equal(requiresRepair({ ran: true, ok: false, failed: 1, timedOut: true }), true);
const failedRun = { ran: true, ok: false, passed: 1, failed: 1, state: "failed" };
const passingRun = { ran: true, ok: true, passed: 2, failed: 0, state: "completed" };
assert.equal(repairOutcome(failedRun, passingRun), "repaired");
assert.equal(repairOutcome(failedRun, failedRun), "still_failing");
assert.equal(repairOutcome(passingRun, failedRun), "regressed");
assert.equal(repairOutcome(passingRun, passingRun), "still_passing");
assert.equal(repairOutcome(failedRun, null), "unverified");
assert.equal(repairOutcome(failedRun, { ran: false, ok: true, passed: 0, failed: 0 }), "unverified");
assert.equal(repairOutcome(failedRun, { ...passingRun, timedOut: true }), "still_failing");
assert.equal(repairOutcome(failedRun, { ...passingRun, state: "canceled" }), "still_failing");
assert.equal(repairOutcome(failedRun, { ...passingRun, passed: 0 }), "still_failing");
console.log("Phase 4 repair evidence tests passed.");
