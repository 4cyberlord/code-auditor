"use client";

import { useState } from "react";
import { highlight } from "@/lib/highlight";
import { describeCodeLanguage } from "@/lib/solutionLanguage";
import { agentSpec, gatewayPreset } from "@/lib/models";
import { primaryModelLabel } from "@/lib/primaryModels";
import { useStore } from "@/lib/store";
import { agreedComplexityAudits, COUNCIL_SIZE, gateFor, splitComplexityClaim } from "@/lib/council";
import { PORT_LABELS, PORT_LANGUAGES } from "@/lib/review";
import { councilStageText, modelLamp } from "@/lib/storyProgress";
import { extractFunctionSignatures, selectVerifiedStorySolution } from "@/lib/storySolution";
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
  const primaryWinnerReady = council.phase === "porting" && Boolean(council.winner);
  const awaitingCouncil = settings.councilEnabled && !primaryWinnerReady && (preparing || running ||
    (council.phase !== "idle" && council.phase !== "done" && council.phase !== "error" && council.phase !== "cancelled"));
  const finalReviewPending = !viewingRunId && settings.councilEnabled && council.phase === "done" &&
    review.status !== "done" && review.status !== "error";
  const report = preparing || awaitingCouncil || finalReviewPending || !settings.councilEnabled
    ? null : selectVerifiedStorySolution(agents, council, consensus().representative);
  const reviewData = report ? review.data : null;
  const reviewRunning = !preparing && review.status === "running";
  const councilPhase = preparing ? "idle" : council.phase;
  const verifiedPorts = council.ports.filter(port => port.status === "verified");
  const chosenPort = language === "original" ? null : verifiedPorts.find(port => port.language === language) ?? null;
  const ports = verifiedPorts.map(port => port.language as keyof typeof PORT_LABELS);
  const code = chosenPort?.code || report?.code || "";
  const syntax = describeCodeLanguage(code, language === "original" ? report?.language : language);
  const tokens = highlight(code, syntax.id);
  const lineCount = code ? code.split("\n").length : 0;
  const functions = extractFunctionSignatures(code);
  // Keep the tested original's evidence visible when a port is selected,
  // while explicitly saying that the translated code itself is untested.
  const run = chosenPort?.run ?? report?.benchmark ?? null;
  const complexityAudit = (councilPhase === "done" || councilPhase === "porting") && council.winner
    ? agreedComplexityAudits(council.dossier?.judges ?? [])[council.winner]
    : undefined;
  const reportedComplexity = splitComplexityClaim(report?.complexity || "");
  const displayedTime = complexityAudit?.time || reviewData?.efficiency.currentTime || reportedComplexity.time || "—";
  const displayedSpace = complexityAudit?.space || reviewData?.efficiency.currentSpace || reportedComplexity.space || "—";
  // Once a tested winner is available, no card should remain permanently
  // "Pending" merely because the optional technical reviewer has not replied.
  // We do not invent a lower bound: the fallback says that none is verified.
  const suggestedTime = reviewData?.efficiency.suggestedTime ||
    (displayedTime !== "—" ? `No lower verified bound (${displayedTime})` : reviewRunning ? "Reviewing" : report ? "Not separately reviewed" : "Pending review");
  const suggestedSpace = reviewData?.efficiency.suggestedSpace ||
    (displayedSpace !== "—" ? `No lower verified bound (${displayedSpace})` : reviewRunning ? "Reviewing" : report ? "Not separately reviewed" : "Pending review");
  const gate = run ? gateFor(run) : "untested";
  const benchmarkNote = chosenPort?.run?.ran
    ? `${chosenPort.run.passed} passed / ${chosenPort.run.failed} failed for this ${chosenPort.language} implementation in E2B.`
    : awaitingCouncil
    ? "The Council is still testing and comparing candidates; no final measurement is available yet."
    : councilPhase === "error" ? "Council verification did not finish successfully. Start a fresh analysis to try again."
    : !council.testSuites.length ? "No executable test suite was produced, so this solution has not been benchmarked."
    : run && !run.ran ? "The execution environment is preparing another verification attempt."
    : run?.ran && run.remoteElapsedMs == null && run.peakMemoryKb == null
      ? `Tests executed${run.provider ? ` via ${run.provider}` : ""}, but this runner did not report per-process runtime or peak-memory telemetry. E2B measurements are not available for this desktop run.`
      : run?.ran ? `${run.passed} passed / ${run.failed} failed` : "No execution measurements are available for this exact solution.";
  // `buildAgents` begins with the user's enabled roster. That is not an
  // assignment: do not show every enabled model as selected while the
  // coordinator is still choosing the (at most four) actual solver seats.
  const active = runId ? agents.filter(a => a.enabled) : [];
  const modelProgress = active.map(agent => ({ agent, lamp: modelLamp(agent) }));
  const readyCount = modelProgress.filter(item => item.lamp === "ready").length;
  const issueCount = modelProgress.filter(item => item.lamp === "issue").length;
  const allReady = active.length > 0 && readyCount === active.length;
  const councilCanStart = settings.councilEnabled && settings.useGateway && gatewayKey &&
    (readyCount >= COUNCIL_SIZE.solversMin || settings.councilModels.length > 0);
  const busyAgents = active.filter(a => ["queued","streaming"].includes(a.status));
  const failed = active.filter(a => a.status === "error");
  const actuallyWorking = active.filter(a => ["streaming", "done"].includes(a.status));
  const councilStage = councilStageText(councilPhase);
  const processText = preparing ? "Uploading screenshots to Azure and selecting the best approved agents." :
    active.length === 0 && running ? "Choosing verified models for this question." :
    councilStage ? councilStage :
    reviewRunning ? "Reviewing the selected code and its technical report." :
    busyAgents.length ? `${readyCount} of ${active.length} answers ready. Waiting for the remaining selected models.` :
    allReady && councilPhase === "idle" && councilCanStart ? "All selected answers are ready. Council verification is starting." :
    allReady && councilPhase === "idle" ? "All selected answers are ready. Council verification is not active for this run." :
    finalReviewPending ? "Council selected an E2B-tested solution. Finishing its technical report." :
    councilPhase === "done" && report ? "Council selected an E2B-tested solution. The final report is ready." :
    councilPhase === "done" && !report ? "Council completed its checks; no verified solution is ready yet." :
    councilPhase === "error" ? "Council could not complete verification. You can start a fresh analysis to try again." :
    issueCount ? "Council is checking the responses that need another pass." :
    report ? "The fully verified solution is ready." :
    "The working solution will appear only after Council verification succeeds.";
  const progress = preparing ? "Checking vision-capable models" :
    active.length === 0 && running ? "Selecting best agents" :
    busyAgents.length ? actuallyWorking.length ? "Solving your problem" : "Preparing solver models" :
    councilStage ? "Verifying and reviewing" :
    allReady && councilPhase === "idle" && councilCanStart ? "Starting council verification" :
    finalReviewPending || reviewRunning ? "Reviewing the solution" :
    councilPhase === "error" ? "Verification could not be completed" :
    report ? language !== "original" ? "Translated port — testing pending" :
      report.provisional ? "Candidate ready — verification pending" : "Tested solution ready" :
    failed.length ? "Analysis needs attention" : running ? "Preparing analysis" : "Awaiting solution";

  return <main className="story-result" aria-label="Analysis results">
    <header className="story-result-status">
      <span className="story-result-indicator" data-busy={preparing || running || reviewRunning} />
      <div><strong>{progress}</strong><span>{active.length ? `${readyCount} of ${active.length} selected answers ready` : preparing ? "Selecting from your approved roster" : "The engine is preparing the problem"}</span></div>
      <span className="story-result-status-note">{active.length ? "Independent image analysis" : "Direct vision · no extraction"}</span>
    </header>
    <section className="story-agent-progress" aria-label="Selected API model progress">
      <div className="story-agent-progress-heading">
        <strong>Selected API agents</strong>
        <span>{active.length ? `${readyCount} / ${active.length} answers ready` : "Selection pending"}</span>
      </div>
      {modelProgress.length > 0 ? <ol className="story-agent-list">
        {modelProgress.map(({ agent, lamp }) => {
          const evidenceStage = agent.status === "done" && councilPhase === "speccing"
            ? "harness" : agent.status === "done" && (councilPhase === "verifying" || councilPhase === "reverifying")
              ? "e2b" : agent.status === "done" && ["contracting", "reviewing", "revising", "judging", "synthesizing", "porting"].includes(councilPhase)
                ? "council" : lamp;
          const label = evidenceStage === "harness" ? "Preparing E2B tests" : evidenceStage === "e2b" ? "E2B testing" : evidenceStage === "council" ? "Council review" :
            lamp === "ready" ? "Answer ready" : lamp === "issue" ? "Needs attention" :
            lamp === "cancelled" ? "Cancelled" : agent.status === "streaming" ? "Generating answer" :
            preparing ? "Verifying image access" : "Waiting for response";
          return <li className="story-agent-tile" data-lamp={evidenceStage} key={agent.id}>
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
      </ol> : <p className="story-agent-pending">{preparing ? "Your screenshots are being stored privately in Azure. Selected agents will appear here as soon as assignment finishes." : "The selected models will appear here when assigned."}</p>}
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
                <p>{councilPhase === "error"
                  ? "Council could not complete verification. Start a fresh analysis to try again."
                  : councilPhase === "done"
                    ? "Council completed its checks; a verified solution is not available for this run."
                    : "The AI agents are working in the background. Your verified solution will appear here when ready."}</p>
                {!running && !preparing && (failed.length > 0 || councilPhase === "error" || councilPhase === "done") &&
                  <button type="button" className="story-subtle-button" onClick={() => void start({ adaptivePanels: true })}>
                    Try this question again
                  </button>}
              </div>}
          </div>
        </div>
        {report?.answer && <div className="story-solution-summary"><span className="story-eyebrow">SOLUTION SUMMARY</span><p>{report.answer}</p></div>}
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
            <div><small>TIME COMPLEXITY</small><strong>{displayedTime}</strong></div>
            <div><small>SPACE COMPLEXITY</small><strong>{displayedSpace}</strong></div>
          </div>
          {complexityAudit && <p className="story-muted">Audit basis: {complexityAudit.basis}</p>}
          <div className="story-compare"><span>Suggested time</span><b>{suggestedTime}</b></div>
          <div className="story-compare"><span>Suggested space</span><b>{suggestedSpace}</b></div>
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
          {review.status === "error" && <p className="story-muted">Technical review will be available after a later retry.</p>}
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
        {councilPhase === "error" && <p className="story-muted">Council could not complete verification for this run.</p>}
        {sessionsError && <p className="story-muted">This run could not be saved to history yet.</p>}
        {!preparing && judge.status === "error" && <p className="story-muted">Council is repeating its final review.</p>}
      </aside>
    </div>
  </main>;
}
