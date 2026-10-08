import { randomUUID } from "node:crypto";

/** Independent Phase 2 policy helpers, testable without cloud credentials. */
export const MAX_SOURCE_BYTES = 262_144;
export const MAX_EXECUTION_MS = 300_000;
export function executionId() { return randomUUID(); }
export function validateExecution(language, code, timeoutMs) {
  const name = String(language || "").trim().toLowerCase();
  const supported = ["python","python3","py","py3","javascript","js","node","nodejs","mjs","cjs",
    "typescript","ts","rust","rs","go","golang","php","java","c","cpp","c++","cc","cxx",
    "bash","sh","shell","ruby","rb"];
  if (!supported.includes(name)) throw new Error("Unsupported execution language: " + (name || "unknown"));
  if (typeof code !== "string" || !code.trim()) throw new Error("No program to execute.");
  if (Buffer.byteLength(code, "utf8") > MAX_SOURCE_BYTES) throw new Error("Program exceeds 256 KiB execution limit.");
  const requested = Number(timeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Invalid sandbox execution timeout.");
  return { language: name, timeoutMs: Math.min(Math.max(Math.round(requested), 1000), MAX_EXECUTION_MS) };
}

export function parseExecutionOutput(raw) {
  const text = String(raw || "");
  const stdoutBegin = text.indexOf("CA_STDOUT_BEGIN\n");
  const stdoutEnd = text.indexOf("\nCA_STDOUT_END\n", stdoutBegin < 0 ? 0 : stdoutBegin);
  const stderrBegin = text.indexOf("CA_STDERR_BEGIN\n", stdoutEnd < 0 ? 0 : stdoutEnd);
  const stderrEnd = text.lastIndexOf("\nCA_STDERR_END\n");
  const footer = stderrEnd >= 0 ? text.slice(stderrEnd + "\nCA_STDERR_END\n".length) : "";
  // stdout can contain forged CA_EXIT lines. Accept only the final trailer.
  const match = /^CA_EXIT:(-?\d+)\nCA_RUNTIME:([^\n]+)\s*$/.exec(footer);
  const complete = Boolean(match && stdoutBegin >= 0 && stdoutEnd > stdoutBegin && stderrBegin > stdoutEnd && stderrEnd > stderrBegin);
  const stdout = complete ? text.slice(stdoutBegin + "CA_STDOUT_BEGIN\n".length, stdoutEnd) : "";
  const stderr = complete ? text.slice(stderrBegin + "CA_STDERR_BEGIN\n".length, stderrEnd) : "";
  const metrics = {};
  for (const line of (complete ? stderr : "").split("\n")) {
    if (!line.startsWith("CA_METRICS ")) continue;
    for (const pair of line.slice("CA_METRICS ".length).split(/\s+/)) {
      const [key, value] = pair.split("=");
      if (key) metrics[key] = value;
    }
  }
  const metric = (x) => x != null && x !== "" && Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null;
  const seconds = metric(metrics.elapsed_s);
  return {
    complete, stdout, stderr,
    exitCode: complete && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null,
    runtime: complete ? match[2].trim() : "remote",
    remoteElapsedMs: complete ? (seconds != null ? Math.round(seconds * 1000) : metric(metrics.elapsed_ms)) : null,
    peakMemoryKb: complete ? metric(metrics.maxrss_kb) : null,
  };
}
export function executionStatus(result) {
  if (result?.timedOut) return "timed_out";
  if (result?.canceled) return "canceled";
  return result?.ok && result?.exitCode === 0 ? "completed" : "failed";
}
export function requiresRepair(run) {
  // Missing or invalid harnesses should be diagnosed, not attributed to bad code.
  // A user-canceled execution or broken harness is not a code defect.
  if (!run?.ran || run.canceled || run.state === "canceled" || run.note === "the generated harness did not build or start") return false;
  return run.ok === false || run.failed > 0;
}

export async function withSandboxLifecycle(sandbox, onStart, execute, onFailure) {
  let failed = false;
  try {
    await onStart?.();
    return await execute();
  } catch (error) {
    failed = true;
    try { await onFailure?.(error); } catch { /* retain original error */ }
    throw error;
  } finally {
    try { await sandbox.kill(); } catch (error) { 
      // Failure to dispose a sandbox is a security-relevant error. A caller must
      // not report successful execution while its isolated workspace persists.
      if (!failed) throw new Error("Sandbox cleanup failed", { cause: error });
    }
  }
}

/**
 * Evidence gate for the one bounded repair attempt. A revision is not a
 * successful repair merely because an agent produced new code.
 */
export function repairOutcome(original, revised) {
  const verified = (run) => Boolean(
    run?.ran && run.ok === true && run.passed > 0 && run.failed === 0 &&
    !run.timedOut && !run.canceled && run.state !== "canceled" &&
    run.state !== "timed_out"
  );
  if (!revised || !revised.ran) return "unverified";
  if (verified(revised)) return verified(original) ? "still_passing" : "repaired";
  if (verified(original)) return "regressed";
  return "still_failing";
}
