"use client";

import { useEffect, useState } from "react";
import Markdown from "./Markdown";
import { useStore } from "@/lib/store";
import { gateFor } from "@/lib/council";
import { PORT_LABELS, PORT_LANGUAGES } from "@/lib/review";
import { extractFunctionSignatures, selectStorySolution } from "@/lib/storySolution";
import "./StoryResultWorkspace.css";

export default function StoryResultWorkspace() {
  const agents = useStore(s => s.agents);
  const council = useStore(s => s.council);
  const review = useStore(s => s.review);
  const extraction = useStore(s => s.extraction);
  const running = useStore(s => s.running);
  const runId = useStore(s => s.runId);
  const judge = useStore(s => s.judge);
  const consensus = useStore(s => s.consensus);
  const runReview = useStore(s => s.runReview);
  const [language, setLanguage] = useState("original");
  const report = selectStorySolution(agents, council, consensus().representative);
  const ports = PORT_LANGUAGES.filter(lang => !!review.data?.ports[lang]);
  const sourceCode = language === "original" ? report?.code : review.data?.ports[language as keyof typeof review.data.ports];
  const code = sourceCode || report?.code || "";
  const shownLang = language === "original" ? report?.language || "text" : language;
  const functions = extractFunctionSignatures(code);
  const run = report?.benchmark;
  const gate = run ? gateFor(run) : "untested";
  const busyAgents = agents.filter(a => a.enabled && ["queued","streaming"].includes(a.status));
  const failed = agents.filter(a => a.enabled && a.status === "error");
  const active = agents.filter(a => a.enabled);
  const progress = extraction.status === "running" ? "Reading screenshots" :
    active.length === 0 && running ? "Selecting best agents" :
    busyAgents.length ? "Solving your problem" :
    council.phase !== "idle" && council.phase !== "done" && council.phase !== "error" && council.phase !== "cancelled" ? "Verifying and reviewing" :
    review.status === "running" ? "Reviewing the solution" :
    report ? "Solution ready" : failed.length ? "Analysis needs attention" : running ? "Preparing analysis" : "Awaiting solution";
  useEffect(() => { setLanguage("original"); }, [runId]);

  return <main className="story-result" aria-label="Analysis results">
    <header className="story-result-status">
      <span className="story-result-indicator" data-busy={running || review.status === "running"} />
      <div><strong>{progress}</strong><span>{report ? report.source : active.length ? active.length + " agent(s) selected" : "The engine is preparing the problem"}</span></div>
      <span className="story-result-status-note">{extraction.status === "done" ? "Screenshot understood" : extraction.status === "error" ? "Reading needs attention" : ""}</span>
    </header>
    <div className="story-result-columns">
      <section className="story-code-column" aria-label="Final code solution">
        <div className="story-section-heading">
          <div><span className="story-eyebrow">01 / SOLUTION</span><h1>Code solution</h1></div>
          {report && <span className="story-outcome" data-provisional={report.provisional}>{report.provisional ? "Provisional" : "Completed"}</span>}
        </div>
        {report && <div className="story-code-source">Selected solution <strong>{report.source}</strong></div>}
        <div className="story-code-window">
          <div className="story-code-toolbar">
            <div className="story-code-file"><span className="story-code-dot" />{shownLang.toUpperCase()}</div>
            <div className="story-code-tabs">
              <button className={language === "original" ? "active" : ""} onClick={() => setLanguage("original")}>Original</button>
              {ports.map(lang => <button key={lang} className={language === lang ? "active" : ""} onClick={() => setLanguage(lang)}>{PORT_LABELS[lang]}</button>)}
              {code && <button className="story-copy" onClick={() => void navigator.clipboard.writeText(code)}>Copy code</button>}
            </div>
          </div>
          <div className="story-code-content">
            {code ? <Markdown text={"```" + shownLang + "\n" + code + "\n```"} /> :
              <div className="story-code-empty"><div className="story-code-empty-icon">{"{ }"}</div><h2>{progress}</h2>
                <p>{failed.length ? failed.map(a => a.error || a.model + " failed").join("; ") :
                  extraction.status === "error" ? extraction.error || "The screenshot could not be interpreted." :
                  "The AI agents work in the background. Your finished code will appear here automatically."}</p>
              </div>}
          </div>
        </div>
        {report?.answer && <div className="story-solution-summary"><span className="story-eyebrow">SOLUTION SUMMARY</span><p>{report.answer}</p></div>}
      </section>
      <aside className="story-report-column" aria-label="Technical solution report">
        <div className="story-section-heading"><div><span className="story-eyebrow">02 / TECHNICAL REPORT</span><h2>Solution insights</h2></div></div>
        <section className="story-report-card story-report-intro">
          <div className="story-report-heading">Approach <span>{review.data?.valid === true ? "Reviewed" : review.status === "running" ? "Reviewing" : "Analysis"}</span></div>
          <h3>{review.data?.approach.current || "Algorithm approach"}</h3>
          <p><b>Key idea</b> {review.data?.approach.keyIdea || report?.answer || "A reviewed explanation will appear once the solver finishes."}</p>
          {review.data?.approach.suggested && <p className="story-muted"><b>Suggested</b> {review.data.approach.suggested}</p>}
        </section>
        <section className="story-report-card">
          <div className="story-report-heading">Efficiency <span>{review.data ? "Reviewed estimate" : "Analysis"}</span></div>
          <div className="story-report-metrics">
            <div><small>TIME COMPLEXITY</small><strong>{review.data?.efficiency.currentTime || report?.complexity || "—"}</strong></div>
            <div><small>SPACE COMPLEXITY</small><strong>{review.data?.efficiency.currentSpace || "—"}</strong></div>
          </div>
          <div className="story-compare"><span>Suggested time</span><b>{review.data?.efficiency.suggestedTime || "Pending review"}</b></div>
          <div className="story-compare"><span>Suggested space</span><b>{review.data?.efficiency.suggestedSpace || "Pending review"}</b></div>
          {review.data?.efficiency.note && <p>{review.data.efficiency.note}</p>}
        </section>
        <section className="story-report-card">
          <div className="story-report-heading">Functions used <span>{functions.length} found</span></div>
          {functions.length ? functions.map(fn => <div className="story-function" key={fn.signature}><code>{fn.signature}</code><p>Function <b>{fn.name}</b> is declared here. Its behavior follows the implementation shown on the left.</p></div>)
            : <p className="story-muted">Function details appear when the generated code is available.</p>}
        </section>
        <section className="story-report-card">
          <div className="story-report-heading">Code style <span>{review.data?.valid === true ? "Reviewed" : "Pending"}</span></div>
          <div className="story-compare"><span>Readability</span><b>{review.data?.style.readability || "Not reviewed"}</b></div>
          <div className="story-compare"><span>Structure</span><b>{review.data?.style.structure || "Not reviewed"}</b></div>
          {review.data?.style.note && <p>{review.data.style.note}</p>}
          {review.error && <p className="story-warning">{review.error}</p>}
          {report && review.status !== "running" && !review.data && <button className="story-subtle-button" onClick={() => void runReview()}>Review solution</button>}
        </section>
        <section className="story-report-card">
          <div className="story-report-heading">Benchmarks <span data-gate={gate}>{gate === "pass" ? "Passed" : gate === "fail" ? "Failed" : "Not measured"}</span></div>
          <div className="story-report-metrics">
            <div><small>RUNTIME</small><strong>{run?.ran ? Math.round(run.remoteElapsedMs ?? run.durationMs) + " ms" : "—"}</strong></div>
            <div><small>MEMORY</small><strong>{run?.ran && run.peakMemoryKb != null ? (run.peakMemoryKb >= 1024 ? (run.peakMemoryKb/1024).toFixed(1) + " MB" : Math.round(run.peakMemoryKb) + " KB") : "—"}</strong></div>
          </div>
          <p className="story-muted">{run?.ran ? run.passed + " passed / " + run.failed + " failed" : "No execution measurements are available for this exact solution."}</p>
        </section>
        {council.phase === "error" && <p className="story-warning">{council.error}</p>}
        {judge.status === "error" && <p className="story-warning">{judge.error}</p>}
      </aside>
    </div>
  </main>;
}
