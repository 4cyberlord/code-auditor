import { randomUUID } from "node:crypto";

/** Independent Phase 2 policy helpers, testable without cloud credentials. */
export const MAX_SOURCE_BYTES = 262_144;
export const MAX_EXECUTION_MS = 300_000;
export function executionId() { return randomUUID(); }
export function validateExecution(language, code, timeoutMs) {
  const name = String(language || "").trim().toLowerCase();
  const supported = ["python","python3","py","py3","javascript","js","node","nodejs","mjs","cjs",
    "typescript","ts","rust","rs","go","golang","php","java","cpp","c++","cc","cxx",
    "bash","sh","shell","ruby","rb"];
  if (!supported.includes(name)) throw new Error("Unsupported execution language: " + (name || "unknown"));
  if (typeof code !== "string" || !code.trim()) throw new Error("No program to execute.");
  if (Buffer.byteLength(code, "utf8") > MAX_SOURCE_BYTES) throw new Error("Program exceeds 256 KiB execution limit.");
  const requested = Number(timeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Invalid sandbox execution timeout.");
  return { language: name, timeoutMs: Math.min(Math.max(Math.round(requested), 1000), MAX_EXECUTION_MS) };
}

/**
 * E2B throws CommandExitError for a non-zero command exit. In the installed
 * JavaScript SDK its exitCode/stdout/stderr are getters on the error itself,
 * not an enumerable `result` property. Preserve that evidence for Council
 * repair while allowing network, quota and sandbox errors to still throw.
 */
export function e2bCommandFailure(error) {
  const result = error?.result && typeof error.result === "object" ? error.result : error;
  if (error?.name !== "CommandExitError" ||
      !Number.isSafeInteger(result?.exitCode) || result.exitCode === 0 ||
      typeof result.stdout !== "string" || typeof result.stderr !== "string") return null;
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: typeof result.error === "string" ? result.error : undefined,
  };
}

/** Map common Python/JS/compiler diagnostics back into the inserted solution. */
export function mapCandidateFailureLocation(stderr, sourceMap) {
  if (!sourceMap || !Number.isSafeInteger(sourceMap.startLine) || !Number.isSafeInteger(sourceMap.endLine)) return null;
  const text = String(stderr || "");
  const found = [];
  const patterns = [
    /File ["'](?:\.\/)?(?:main|Main)\.(?:py|mjs|js|ts|cpp|cc|rs|go|java|php|rb|sh)["'], line (\d+)/gi,
    /(?:^|[\s(])(?:\.\/)?(?:main|Main)\.(?:py|mjs|js|ts|cpp|cc|rs|go|java|php|rb|sh):(\d+)(?::\d+)?/gim,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const line = Number(match[1]);
      if (Number.isSafeInteger(line) && line > 0) found.push(line);
    }
  }
  // Tracebacks place the failing frame last; diagnostics from compilers also
  // tend to list the primary source location after any include/context lines.
  const harnessLine = found.reverse().find(line => line >= sourceMap.startLine && line <= sourceMap.endLine);
  return harnessLine == null ? null : { harnessLine, sourceLine: harnessLine - sourceMap.startLine + 1 };
}

/**
 * Classify execution outcomes so code defects go to the solver, not users.
 * @param {{run?: {ran?: boolean, timedOut?: boolean, failed?: number, exitVerified?: boolean, ok?: boolean, exitCode?: number|null, passed?: number, stderr?: string}, sourceMap?: {startLine: number, endLine: number}, harnessPreflightFailed?: boolean}} options
 * @returns {"infrastructure"|"timeout"|"candidate"|"harness"|"unknown"|undefined}
 */
export function classifyExecutionFailure({ run, sourceMap, harnessPreflightFailed = false } = {}) {
  if (!run?.ran) return "infrastructure";
  if (run.timedOut) return "timeout";
  if (run.failed > 0) return "candidate";
  if (harnessPreflightFailed || run.exitVerified === false) return "harness";
  if (run.ok && run.exitCode === 0) return undefined;
  if (mapCandidateFailureLocation(run.stderr, sourceMap)) return "candidate";
  if (!run.passed && run.exitCode !== 0) return "harness";
  return "unknown";
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
  const metrics = {}, programMetrics = {};
  for (const line of (complete ? stderr : "").split("\n")) {
    const prefix = line.startsWith("CA_PROGRAM_METRICS ") ? "CA_PROGRAM_METRICS "
      : line.startsWith("CA_METRICS ") ? "CA_METRICS " : null;
    if (!prefix) continue;
    const target = prefix === "CA_PROGRAM_METRICS " ? programMetrics : metrics;
    for (const pair of line.slice(prefix.length).split(/\s+/)) {
      const [key,value] = pair.split("=");
      if (key) target[key] = value;
    }
  }
  const metric = (x) => x != null && x !== "" && Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null;
  const seconds = metric(metrics.elapsed_s);
  const totalElapsedMs = complete ? (seconds != null ? Math.round(seconds*1000) : metric(metrics.elapsed_ms)) : null;
  const programSeconds = metric(programMetrics.elapsed_s);
  const programElapsedMs = complete && programSeconds != null ? Math.round(programSeconds*1000) : null;
  return {
    complete, stdout, stderr,
    exitCode: complete && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null,
    runtime: complete ? match[2].trim() : "remote",
    // For compiled C++/Rust prefer the nested timed program itself rather than
    // claiming compiler startup is algorithm execution. Keep total separately.
    remoteElapsedMs: programElapsedMs ?? totalElapsedMs,
    peakMemoryKb: complete ? (metric(programMetrics.maxrss_kb) ?? metric(metrics.maxrss_kb)) : null,
    totalElapsedMs,
    totalPeakMemoryKb: complete ? metric(metrics.maxrss_kb) : null,
    programElapsedMs,
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
  if (!run?.ran || run.exitVerified === false || run.failureKind === "harness" ||
      run.failureKind === "infrastructure" ||
      run.canceled || run.state === "canceled" || run.note === "the generated harness did not build or start") return false;
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
  if (!revised || !revised.ran || !original?.ran) return "unverified";
  if (verified(revised)) return verified(original) ? "still_passing" : "repaired";
  if (verified(original)) return "regressed";
  return "still_failing";
}
