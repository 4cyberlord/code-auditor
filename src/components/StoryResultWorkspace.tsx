"use client";

import { useState } from "react";
import { highlight } from "@/lib/highlight";
import { describeCodeLanguage } from "@/lib/solutionLanguage";
import { agentSpec, gatewayPreset } from "@/lib/models";
import { primaryModelLabel } from "@/lib/primaryModels";
import { useStore } from "@/lib/store";
import { agreedComplexityAudits, COUNCIL_SIZE, gateFor } from "@/lib/council";
import { PORT_LABELS, PORT_LANGUAGES } from "@/lib/review";
import { councilStageText, modelLamp } from "@/lib/storyProgress";
import { extractFunctionSignatures, selectStorySolution, selectVerifiedStorySolution } from "@/lib/storySolution";
import "./StoryResultWorkspace.css";

export default function StoryResultWorkspace() {
  const agents = useStore(s => s.agents);
  const runId = useStore(s => s.runId);
  const viewingRunId = useStore(s => s.viewingRunId);
  const historyQuestion = useStore(s => s.historyQuestion);
  const historyImages = useStore(s => s.historyImages);
  const sessionsError = useStore(s => s.sessionsError);
  const council = useStore(s => s.council);
  const review = useStore(s => s.review);
  const running = useStore(s => s.running);
  const preparing = useStore(s => s.preparing);
  const judge = useStore(s => s.judge);
  const consensus = useStore(s => s.consensus);
  const settings = useStore(s => s.settings);
  const gatewayKey = useStore(s => s.gatewayKey);
  const runReview = useStore(s => s.runReview);
  const start = useStore(s => s.start);
  const [language, setLanguage] = useState("original");
  // A new run can spend time in live model checks before it gets a new runId.
  // Never show the previous run's answer under that new run's progress text.
  // A solver's first answer is not the Council's choice. Keep the final-code
  // workspace empty until the full comparison settles (or explicitly fails).
  const awaitingCouncil = settings.councilEnabled && (preparing || running ||
    (council.phase !== "idle" && council.phase !== "done" && council.phase !== "error" && council.phase !== "cancelled"));
  const finalReviewPending = !viewingRunId && settings.councilEnabled && council.phase === "done" &&
    review.status !== "done" && review.status !== "error";
  const report = preparing || awaitingCouncil || finalReviewPending ? null : settings.councilEnabled
    ? selectVerifiedStorySolution(agents, council, consensus().representative)
    : selectStorySolution(agents, council, consensus().representative);
  const reviewData = report ? review.data : null;
  const reviewRunning = !preparing && review.status === "running";
  const reviewError = preparing ? null : review.error;
  const councilPhase = preparing ? "idle" : council.phase;
  const councilError = preparing ? null : council.error;
  const ports = PORT_LANGUAGES.filter(lang => !!reviewData?.ports[lang]);
  const sourceCode = language === "original" ? report?.code : reviewData?.ports[language as "cpp" | "rust" | "python"];
  const code = sourceCode || report?.code || "";
  const syntax = describeCodeLanguage(code, language === "original" ? report?.language : language);
  const tokens = highlight(code, syntax.id);
  const lineCount = code ? code.split("\n").length : 0;
  const functions = extractFunctionSignatures(code);
  // Keep the tested original's evidence visible when a port is selected,
  // while explicitly saying that the translated code itself is untested.
  const run = report?.benchmark ?? null;
  const complexityAudit = councilPhase === "done" && council.winner
    ? agreedComplexityAudits(council.dossier?.judges ?? [])[council.winner]
    : undefined;
  const gate = run ? gateFor(run) : "untested";
  const benchmarkNote = language !== "original" && run?.ran
    ? `These measurements belong to the tested original solution, not this ${PORT_LABELS[language as keyof typeof PORT_LABELS] ?? language} translation. This port has not been executed in E2B.`
    : awaitingCouncil
    ? "The Council is still testing and comparing candidates; no final measurement is available yet."
    : councilPhase === "error" ? `Verification stopped: ${councilError || "unknown reason"}`
    : !council.testSuites.length ? "No executable test suite was produced, so this solution has not been benchmarked."
    : run && !run.ran ? `Execution did not complete: ${run.note || "the runner returned no result"}.`
    : run?.ran && run.remoteElapsedMs == null && run.peakMemoryKb == null
      ? `Tests executed${run.provider ? ` via ${run.provider}` : ""}, but this runner did not report per-process runtime or peak-memory telemetry. E2B measurements are not available for this desktop run.`
      : run?.ran ? `${run.passed} passed / ${run.failed} failed` : "No execution measurements are available for this exact solution.";
  const active = !preparing && runId ? agents.filter(a => a.enabled) : [];
  const modelProgress = active.map(agent => ({ agent, lamp: modelLamp(agent) }));
  const readyCount = modelProgress.filter(item => item.lamp === "ready").length;
  const issueCount = modelProgress.filter(item => item.lamp === "issue").length;
  const allReady = active.length > 0 && readyCount === active.length;
  const councilCanStart = settings.councilEnabled && settings.useGateway && gatewayKey &&
    (readyCount >= COUNCIL_SIZE.solversMin || settings.councilModels.length > 0);
  const busyAgents = active.filter(a => ["queued","streaming"].includes(a.status));
  const failed = active.filter(a => a.status === "error");
  const actuallyWorking = active.filter(a => ["streaming", "done"].includes(a.status));
  const diagnostics = [
    ...Object.values(settings.routerModels).flatMap(model => {
      const probe = settings.probes[model];
      return settings.useGateway && probe && !probe.ok
        ? [{ label: `${settings.gatewayId}: ${model}`, message: probe.error || "Live gateway check failed." }]
        : [];
    }),
    ...failed.map(a => ({ label: a.model || a.provider, message: a.error || "Solver failed without a detailed response." })),
    ...modelProgress.filter(item => item.lamp === "issue" && item.agent.status === "done")
      .map(item => ({ label: item.agent.model, message: "The model finished but did not return a usable final answer." })),
    councilPhase === "error" && councilError ? { label: "Council", message: councilError } : null,
    !preparing && judge.status === "error" && judge.error ? { label: "Verdict", message: judge.error } : null,
    !preparing && review.status === "error" && reviewError ? { label: "Solution review", message: reviewError } : null,
  ].filter((entry): entry is { label: string; message: string } => Boolean(entry));
  const councilStage = councilStageText(councilPhase);
  const processText = preparing ? "Checking up to four approved models for live screenshot vision support." :
    active.length === 0 && running ? "Choosing verified models for this question." :
    councilStage ? councilStage :
    reviewRunning ? "Reviewing the selected code and its technical report." :
    busyAgents.length ? `${readyCount} of ${active.length} answers ready. Waiting for the remaining selected models.` :
    allReady && councilPhase === "idle" && councilCanStart ? "All selected answers are ready. Council verification is starting." :
    allReady && councilPhase === "idle" ? "All selected answers are ready. Council verification is not active for this run." :
    finalReviewPending ? "Council selected an E2B-tested solution. Finishing its technical report." :
    councilPhase === "done" && report ? "Council selected an E2B-tested solution. The final report is ready." :
    councilPhase === "done" && !report ? "Council finished without a verified coding solution. Check diagnostics." :
    councilPhase === "error" ? "Council verification needs attention; completed candidate answers remain visible." :
    issueCount ? `${issueCount} selected ${issueCount === 1 ? "model needs" : "models need"} attention. Open run diagnostics for details.` :
    report ? "A candidate answer is available while verification finishes." :
    "The solution will appear here when a selected model returns usable code.";
  const progress = preparing ? "Checking vision-capable models" :
    active.length === 0 && running ? "Selecting best agents" :
    busyAgents.length ? actuallyWorking.length ? "Solving your problem" : "Preparing solver models" :
    councilStage ? "Verifying and reviewing" :
    allReady && councilPhase === "idle" && councilCanStart ? "Starting council verification" :
    finalReviewPending || reviewRunning ? "Reviewing the solution" :
    councilPhase === "error" ? "Verification needs attention" :
    report ? language !== "original" ? "Translated port — testing pending" :
      report.provisional ? "Candidate ready — verification pending" : "Tested solution ready" :
    failed.length ? "Analysis needs attention" : running ? "Preparing analysis" : "Awaiting solution";

  return <main className="story-result" aria-label="Analysis results">
    <header className="story-result-status">
      <span className="story-result-indicator" data-busy={preparing || running || reviewRunning} />
      <div><strong>{progress}</strong><span>{active.length ? `${readyCount} of ${active.length} selected answers ready` : preparing ? "Checking API routes" : "The engine is preparing the problem"}</span></div>
      <span className="story-result-status-note">{active.length ? "Independent image analysis" : "Direct vision · no extraction"}</span>
    </header>
    <section className="story-agent-progress" aria-label="Selected API model progress">
      <div className="story-agent-progress-heading">
        <strong>Selected API agents</strong>
        <span>{active.length ? `${readyCount} / ${active.length} answers ready` : "Selection pending"}</span>
      </div>
      {modelProgress.length > 0 ? <ol className="story-agent-list">
        {modelProgress.map(({ agent, lamp }) => {
          const label = lamp === "ready" ? "Answer ready" : lamp === "issue" ? "Needs attention" :
            lamp === "cancelled" ? "Cancelled" : agent.status === "streaming" ? "Generating answer" :
            preparing ? "Verifying image access" : "Waiting for response";
          return <li className="story-agent-tile" data-lamp={lamp} key={agent.id}>
            <span className="story-agent-light" aria-hidden="true" />
            <div className="story-agent-identity">
              <strong>{primaryModelLabel(agent.model) ?? agentSpec(agent.provider).label}</strong>
              <span title={agent.model}>{agent.model}</span>
            </div>
            <div className="story-agent-route">
              <span>{agent.viaGateway ? `via ${gatewayPreset(settings.gatewayId).label}` : "Direct API"}</span>
              <b>{label}</b>
            </div>
          </li>;
        })}
      </ol> : <p className="story-agent-pending">{preparing ? "Checking available models and vision capability…" : "The selected models will appear here when assigned."}</p>}
      <p className="story-process-text" role="status"><span aria-hidden="true" />{processText}</p>
    </section>
    <div className="story-result-columns">
      <section className="story-code-column" aria-label="Final code solution">
        {viewingRunId && <section className="story-saved-question" aria-label="Saved question">
          <span className="story-eyebrow">SAVED QUESTION</span>
          {historyQuestion ? <pre>{historyQuestion}</pre> :
            <p>{historyImages.length ? "The original screenshots are saved below." : "No text reading or screenshot was retained for this older run."}</p>}
          {historyImages.length > 0 && <div className="story-saved-images">
            {historyImages.map((image, index) => <a key={`${image.name}-${index}`} href={image.dataUrl} target="_blank" rel="noreferrer" title={`Open ${image.name}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.dataUrl} alt={`Original question screenshot ${index + 1}`} />
            </a>)}
          </div>}
        </section>}
        <div className="story-section-heading">
          <div><span className="story-eyebrow">01 / SOLUTION</span><h1>Code solution</h1></div>
          {report && <span className="story-outcome" data-provisional={report.provisional || language !== "original"}>{language !== "original" ? "Port untested" : report.provisional ? "Provisional" : "Completed"}</span>}
        </div>
        {report && <div className="story-code-source">Selected solution <strong>{report.source}</strong></div>}
        <div className="story-code-window">
          <div className="story-code-toolbar">
            <div className="story-code-file"><span className="story-code-dot" /><span>{code ? syntax.label : "AWAITING CODE"}</span>{code && syntax.extension && <span className="story-code-extension">{syntax.extension}</span>}</div>
            <div className="story-code-tabs">
              <button className={language === "original" ? "active" : ""} onClick={() => setLanguage("original")}>Original</button>
              {ports.map(lang => <button key={lang} className={language === lang ? "active" : ""} onClick={() => setLanguage(lang)}>{PORT_LABELS[lang]}</button>)}
              {code && <button type="button" className="story-copy" onClick={() => void navigator.clipboard.writeText(code)} aria-label="Copy full solution code">Copy code</button>}
            </div>
          </div>
          <div className="story-code-content">
            {code ? <div className="story-code-editor" role="region" tabIndex={0} aria-label={syntax.label + " code solution"}>
              <div className="story-code-gutter" aria-hidden="true">
                {Array.from({length:lineCount},(_,i)=><span key={i}>{i+1}</span>)}
              </div>
              <pre className="story-code-pre"><code>{tokens.map((token,i)=>
                <span key={i} className={"story-token-" + token.kind}>{token.text}</span>
              )}</code></pre>
            </div> :
              <div className="story-code-empty"><div className="story-code-empty-icon">{"{ }"}</div><h2>{progress}</h2>
                <p>{councilError || (failed.length ? failed.map(a => a.error || a.model + " failed").join("; ") :
                  "The AI agents work in the background. Your finished code will appear here automatically.")}</p>
              </div>}
          </div>
        </div>
        {report?.answer && <div className="story-solution-summary"><span className="story-eyebrow">SOLUTION SUMMARY</span><p>{report.answer}</p></div>}
        {diagnostics.length > 0 && <details className="story-diagnostics" open={!report}>
          <summary>Run diagnostics ({diagnostics.length})</summary>
          {diagnostics.map((entry, index) => <p key={index}><strong>{entry.label}:</strong> {entry.message}</p>)}
          {!running && !preparing && !report && (failed.length > 0 || diagnostics.length > 0) &&
            <button type="button" className="story-subtle-button" onClick={() => void start({ adaptivePanels: true })}>
              Retry analysis and verification
            </button>}
        </details>}
      </section>
      <aside className="story-report-column" aria-label="Technical solution report">
        <div className="story-section-heading"><div><span className="story-eyebrow">02 / TECHNICAL REPORT</span><h2>Solution insights</h2></div></div>
        <section className="story-report-card story-report-intro">
          <div className="story-report-heading">Approach <span>{reviewData?.valid === true ? "Reviewed" : reviewRunning ? "Reviewing" : "Analysis"}</span></div>
          <h3>{reviewData?.approach.current || "Algorithm approach"}</h3>
          <p><b>Key idea</b> {reviewData?.approach.keyIdea || report?.answer || "A reviewed explanation will appear once the solver finishes."}</p>
          {reviewData?.approach.suggested && <p className="story-muted"><b>Suggested</b> {reviewData.approach.suggested}</p>}
        </section>
        <section className="story-report-card">
          <div className="story-report-heading">Efficiency <span>{complexityAudit ? "Two-judge code audit" : reviewData ? "Reviewed estimate" : "Analysis"}</span></div>
          <div className="story-report-metrics">
            <div><small>TIME COMPLEXITY</small><strong>{complexityAudit?.time || reviewData?.efficiency.currentTime || report?.complexity || "—"}</strong></div>
            <div><small>SPACE COMPLEXITY</small><strong>{complexityAudit?.space || reviewData?.efficiency.currentSpace || "—"}</strong></div>
          </div>
          {complexityAudit && <p className="story-muted">Audit basis: {complexityAudit.basis}</p>}
          <div className="story-compare"><span>Suggested time</span><b>{reviewData?.efficiency.suggestedTime || "Pending review"}</b></div>
          <div className="story-compare"><span>Suggested space</span><b>{reviewData?.efficiency.suggestedSpace || "Pending review"}</b></div>
          {reviewData?.efficiency.note && <p>{reviewData.efficiency.note}</p>}
        </section>
        <section className="story-report-card">
          <div className="story-report-heading">Functions used <span>{functions.length} found</span></div>
          {functions.length ? functions.map((fn, index) => <div className="story-function" key={`${fn.signature}-${index}`}><code>{fn.signature}</code><p>{reviewData?.functions?.[fn.name] || "Function-specific explanation pending review."}</p></div>)
            : <p className="story-muted">Function details appear when the generated code is available.</p>}
        </section>
        <section className="story-report-card">
          <div className="story-report-heading">Code style <span>{reviewData?.valid === true ? "Reviewed" : "Pending"}</span></div>
          <div className="story-compare"><span>Readability</span><b>{reviewData?.style.readability || "Not reviewed"}</b></div>
          <div className="story-compare"><span>Structure</span><b>{reviewData?.style.structure || "Not reviewed"}</b></div>
          {reviewData?.style.note && <p>{reviewData.style.note}</p>}
          {reviewError && <p className="story-warning">{reviewError}</p>}
          {report && !viewingRunId && !reviewRunning && !reviewData && <button className="story-subtle-button" onClick={() => void runReview()}>Review solution</button>}
        </section>
        <section className="story-report-card">
          <div className="story-report-heading">Benchmarks <span data-gate={gate}>{gate === "pass" ? language === "original" ? "Passed" : "Original passed" : gate === "fail" ? "Failed" : "Not measured"}</span></div>
          <div className="story-report-metrics">
            <div><small>TEST PROCESS WALL TIME</small><strong>{run?.ran && run.remoteElapsedMs != null ? (run.remoteElapsedMs === 0 ? "<1 ms" : run.remoteElapsedMs + " ms") : "—"}</strong></div>
            <div><small>PEAK PROCESS MEMORY</small><strong>{run?.ran && run.peakMemoryKb != null ? (run.peakMemoryKb >= 1024 ? (run.peakMemoryKb/1024).toFixed(1) + " MB" : Math.round(run.peakMemoryKb) + " KB") : "—"}</strong></div>
          </div>
          <p className="story-muted">{benchmarkNote}</p>
          {run?.ran && run.provider === "e2b" && <p className="story-muted">Measured inside E2B for this test program, including its harness and any compilation. It is not a claim about LeetCode runtime or the algorithm alone.</p>}
          {run?.ran && run.durationMs > 0 && run.remoteElapsedMs == null &&
            <p className="story-muted">Test-process wall time: {run.durationMs} ms (includes startup and possibly compilation; not the algorithm runtime).</p>}
        </section>
        {councilPhase === "error" && <p className="story-warning">{councilError}</p>}
        {sessionsError && <p className="story-warning">History save needs attention: {sessionsError}</p>}
        {!preparing && judge.status === "error" && <p className="story-warning">{judge.error}</p>}
      </aside>
    </div>
  </main>;
}
