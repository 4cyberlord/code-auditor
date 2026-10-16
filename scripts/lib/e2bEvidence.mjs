/** Report the tested facts separately from model confidence and Big-O claims. */
export function assessHarnessTrust(suites = [], oracles = []) {
  const missingReference = suites.filter(s => !String(s?.referenceCode || "").trim())
    .map(s => String(s.language || "unknown"));
  const mutationSurvived = oracles.filter(o => o?.kind === "mutation" && o.survived === true)
    .map(o => String(o.letter || "?"));
  const mutationCaught = oracles.filter(o => o?.kind === "mutation" && o.ran && !o.survived).length;
  const risks = [
    ...missingReference.map(language => "Missing independent reference in " + language),
    ...mutationSurvived.map(letter => "Deliberately corrupted candidate " + letter + " passed its harness"),
  ];
  return {referencePreflight:missingReference.length === 0 && suites.length > 0,
    mutationCaught, mutationSurvived, risks};
}
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function compactRun(run) {
  if (!run) return {status:"untested",passed:0,failed:0};
  const verified=run.ran === true && run.ok === true && run.passed > 0 &&
    run.failed === 0 && run.timedOut !== true && run.state !== "canceled";
  return {
    status:verified?"passed":run.ran?"failed":"untested",
    passed:finite(run.passed) ?? 0, failed:finite(run.failed) ?? 0,
    provider:run.provider || null, sandboxId:run.sandboxId || null,
    executionId:run.executionId || null, exitVerified:run.exitVerified === true,
    runtimeMs:finite(run.remoteElapsedMs),
    peakMemoryKb:finite(run.peakMemoryKb), sandboxBootMs:finite(run.bootMs),
    prewarmed:run.prewarmed === true,
    warmIdleMs:finite(run.warmIdleMs),
    // This is a measured run; Big-O claims require independent analysis.
  };
}
export function buildE2BEvidenceSummary({runs={},suites=[],oracles=[],ports=[]}={}) {
  const trust=assessHarnessTrust(suites,oracles);
  return {
    runner:"e2b", benchmarkPolicy:"evidence-not-proof-of-hidden-cases",
    harness:trust,
    candidates:Object.fromEntries(Object.entries(runs).map(([letter,run])=>[letter,compactRun(run)])),
    ports:(ports||[]).map(port=>({
      language:port.language, status:port.status,
      sourceLetter:port.sourceLetter || null, execution:compactRun(port.run),
      differential:port.differential || {status:"unavailable",sharedCases:0,mismatches:[]},
    })),
  };
}
/** Explicit canary flag; no silent change to existing publication policy. */
export function requireTrustedHarness(trust, strict=false) {
  if (strict && trust.risks.length)
    throw new Error("E2B harness trust gate rejected verification: " + trust.risks.join("; "));
  return trust.risks.length === 0;
}

/** Overlay-ready, bounded, provenance-labelled solution explanation.
 * Claims are separate from measured test results; no new model call.
 */
export function buildAlgorithmEvidence(blueprint, run) {
  if (!blueprint || !run?.ran) return null;
  const names = String(run.stdout || "").split(/\r?\n/)
    .filter(line => /^\s*PASS\b/.test(line)).map(line =>
      line.replace(/^\s*PASS\s*/, "").trim().slice(0,100))
    .filter(Boolean).slice(0,12);
  return {
    source:"verified-primary-source-and-e2b-run",
    approach:blueprint.explanation || "",
    dataStructures:blueprint.structure?.dataStructures || [],
    controlFlow:blueprint.structure?.controlFlow || [],
    complexityClaim:blueprint.complexityClaim || null,
    complexityIndependentlyProved:false,
    testedCaseNames:names,
    passed:finite(run.passed) ?? 0,
    failed:finite(run.failed) ?? 0,
    measuredRuntimeMs:finite(run.remoteElapsedMs),
    measuredPeakMemoryKb:finite(run.peakMemoryKb),
  };
}
