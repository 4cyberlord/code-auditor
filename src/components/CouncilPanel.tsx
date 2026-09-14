"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Markdown from "./Markdown";
import {
  buildPresentation,
  candidateLanguage,
  councilMarkdown,
  executionDigest,
  gateFor,
  type CouncilPhase,
  type CouncilReport,
} from "@/lib/council";
import { useStore } from "@/lib/store";

const PHASE_LABEL: Record<string, string> = {
  idle: "",
  contracting: "Agreeing what the problem asks",
  solving: "Solving independently",
  speccing: "Writing the test harness",
  verifying: "Executing round 1",
  reviewing: "Cross-reviewing candidates",
  revising: "Revising after review",
  reverifying: "Executing revisions",
  judging: "Judges are deliberating",
  synthesizing: "Writing final judgement",
  done: "Final judgement ready",
  error: "Stopped with an error",
  cancelled: "Cancelled",
};

/**
 * The bench's pipeline, in the order a run walks it.
 *
 * The header used to say only which phase was current — "Writing the test
 * harness..." — which tells you what is happening and nothing about where that
 * is in a run that takes ten minutes. Nine segments say both: the label names
 * the step, the rail says how much of the bench is behind it. It is also the
 * only place the new contract and revision rounds are visible as work rather
 * than as a delay.
 */
const STAGES: { phase: CouncilPhase; label: string }[] = [
  { phase: "contracting", label: "Contract" },
  { phase: "solving", label: "Solve" },
  { phase: "speccing", label: "Harness" },
  { phase: "verifying", label: "Run" },
  { phase: "reviewing", label: "Review" },
  { phase: "revising", label: "Revise" },
  { phase: "reverifying", label: "Re-run" },
  { phase: "judging", label: "Judge" },
  { phase: "synthesizing", label: "Decide" },
];

const STANDING_LABEL = {
  verified: "verified",
  unverified: "unverified",
  unexecuted: "not executed",
} as const;

const STANDING_TONE = {
  verified: "good",
  unverified: "bad",
  unexecuted: "warn",
} as const;

type CouncilTab = "summary" | "decision" | "evidence" | "chat" | "reading";
type ChatScope = "all" | "solvers" | "judges" | "selected";

const LABELS: Record<CouncilTab | ChatScope, string> = {
  summary: "Summary",
  decision: "Final",
  evidence: "Evidence",
  chat: "Chat",
  reading: "Reading",
  all: "All",
  solvers: "Solvers",
  judges: "Judges",
  selected: "Selected",
};

function extractLine(text: string, label: string): string {
  const m = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im"));
  return m?.[1]?.trim() ?? "";
}

function unique(xs: string[]): string[] {
  return Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean)));
}

export default function CouncilPanel() {
  const council = useStore((s) => s.council);
  const settings = useStore((s) => s.settings);
  const extraction = useStore((s) => s.extraction);
  const patch = useStore((s) => s.patchSettings);
  const cancel = useStore((s) => s.cancel);
  const sendCouncilMessage = useStore((s) => s.sendCouncilMessage);
  const [tab, setTab] = useState<CouncilTab>("summary");
  const [chatText, setChatText] = useState("");
  const [chatScope, setChatScope] = useState<ChatScope>("all");
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());

  const active =
    council.phase !== "idle" &&
    !["done", "error", "cancelled"].includes(council.phase);

  const solvers = useMemo(() => unique(council.candidates.map((c) => c.model)), [council.candidates]);
  const judges = useMemo(() => unique(council.judges.map((j) => j.model)), [council.judges]);
  const chatModels = useMemo(() => unique([...solvers, ...judges]), [solvers, judges]);

  useEffect(() => {
    if (chatModels.length && selectedModels.size === 0) {
      queueMicrotask(() => setSelectedModels(new Set(chatModels)));
    }
  }, [chatModels, selectedModels.size]);

  // One record, two readers: the markdown the Evidence tab prints, and the
  // presentation every tile below is filled from. Built once so the panel and
  // the overlay can never describe the same run differently.
  const record = useMemo<CouncilReport>(
    () => ({
      candidates: council.candidates,
      suites: council.testSuites,
      runs: council.runs,
      revisedRuns: council.revisedRuns,
      reviews: council.reviews,
      judges: council.judges,
      synthesis: council.synthesis,
      winner: council.winner,
      dossier: council.dossier,
      contract: council.contract,
      contractAgreement: council.contractAgreement,
      oracles: council.oracles,
    }),
    [council]
  );
  const report = useMemo(() => councilMarkdown(record), [record]);
  const presentation = useMemo(() => buildPresentation(record), [record]);

  const winner = council.candidates.find((c) => c.letter === council.winner);
  const winnerFinal = winner?.revised ?? winner?.final ?? null;
  const winnerRun = winner
    ? winner.revised
      ? council.revisedRuns[winner.letter]
      : council.runs[winner.letter]
    : undefined;
  const settled = council.phase === "done";
  const stageIndex = STAGES.findIndex((x) => x.phase === council.phase);
  const stageDone = settled ? STAGES.length : stageIndex < 0 ? 0 : stageIndex;
  const approach =
    presentation.approach || extractLine(council.synthesis, "APPROACH") || winnerFinal?.answer || "Pending final synthesis.";
  const verdict = extractLine(council.synthesis, "VERDICT") || (council.winner ? `Ship Candidate ${council.winner}.` : "No final winner yet.");
  const rejected = extractLine(council.synthesis, "REJECTED");
  const selectedForSend =
    chatScope === "all"
      ? chatModels
      : chatScope === "solvers"
        ? solvers
        : chatScope === "judges"
          ? judges
          : chatModels.filter((m) => selectedModels.has(m));

  const submitChat = (e: FormEvent) => {
    e.preventDefault();
    const msg = chatText.trim();
    if (!msg || council.chatSending || selectedForSend.length === 0) return;
    setChatText("");
    void sendCouncilMessage(msg, selectedForSend);
  };

  if (!settings.councilEnabled) return null;

  return (
    <div className="council result-panel">
      <div className="council-head">
        <span className="council-mark">Council</span>
        <span className="council-phase" data-live={active}>
          {PHASE_LABEL[council.phase] || (settled ? "Final judgement ready" : "Idle")}
          {active ? "…" : ""}
        </span>
        {active && stageIndex >= 0 && (
          <span className="council-step" title={`${STAGES[stageIndex].label} — step ${stageIndex + 1} of ${STAGES.length}`}>
            {stageIndex + 1}/{STAGES.length}
          </span>
        )}
        {active && (
          <button className="btn tiny ghost" onClick={() => void cancel()}>
            Stop
          </button>
        )}
        {(council.phase === "done" || council.phase === "error") && (
          <button
            className="btn tiny ghost"
            onClick={() => patch({ councilEnabled: false })}
            title="Back to the plain panel on the next run"
          >
            Stand Down
          </button>
        )}
      </div>

      {/* Where the run is, across the whole width the rail actually has. Each
          segment is one round of the bench; the live one breathes so a long
          phase reads as working rather than stuck. */}
      {council.phase !== "idle" && (
        <div className="council-rail" role="progressbar" aria-valuemin={0} aria-valuemax={STAGES.length} aria-valuenow={stageDone}>
          {STAGES.map((stage, i) => (
            <span
              key={stage.phase}
              className="council-rail-seg"
              data-state={i < stageDone ? "done" : i === stageIndex ? "live" : "todo"}
              title={stage.label}
            />
          ))}
        </div>
      )}

      {council.slots.length > 0 && (
        <div className="council-seats">
          {council.slots.map((s) => (
            <span
              key={s.id}
              className="chip"
              data-tone={
                s.status === "done"
                  ? "good"
                  : s.status === "error"
                    ? "bad"
                    : s.status === "cancelled"
                      ? "warn"
                      : undefined
              }
              data-kind={s.kind}
              title={`${s.kind} · ${s.model}${s.emphasis ? ` (${s.emphasis})` : ""}${s.error ? ` - ${s.error}` : ""}`}
            >
              {/* The model, not the round. Every chip in a round carried the
                  same word — five seats all reading "solve" — which doubled the
                  width of the row and told you what the phase line above had
                  already said. The round is a coloured dot and a tooltip now,
                  and the chips fit two to a line instead of one. */}
              {s.model.split("/").pop()}
              {s.emphasis ? `/${s.emphasis.slice(0, 4)}` : ""}
              {s.status === "streaming" ? "…" : ""}
            </span>
          ))}
        </div>
      )}

      {council.phase === "error" && council.error && <div className="pane-error">{council.error}</div>}

      <div className="council-tabs">
        {(["summary", "decision", "evidence", "chat", "reading"] as CouncilTab[]).map((name) => (
          <button key={name} data-on={tab === name} onClick={() => setTab(name)}>
            {LABELS[name]}
          </button>
        ))}
      </div>

      <div className="council-view">
        {tab === "summary" && (
          <>
            {/* The standing is the first thing on the card because it is the
                first question: is there anything behind this answer. A verdict
                sentence with no provenance beside it is how a rejected
                candidate gets pasted into an editor. */}
            <div className="council-verdict" data-standing={settled ? presentation.standing : "pending"}>
              <div className="council-verdict-top">
                <span
                  className="badge"
                  data-tone={settled ? STANDING_TONE[presentation.standing] : undefined}
                  title={settled ? presentation.standingReason : "The bench is still sitting."}
                >
                  {settled ? STANDING_LABEL[presentation.standing] : "in progress"}
                </span>
                {settled && presentation.provenance && (
                  <span className="council-prov" title={`Shipped from ${presentation.provenance}`}>
                    {presentation.provenance}
                  </span>
                )}
                {settled && presentation.winnerSource === "judges" && (
                  <span className="badge" data-tone="warn" title={council.dossier?.disagreement || "The judges' count decided this, not the synthesis."}>
                    judge count
                  </span>
                )}
              </div>
              <h3>{verdict}</h3>
              <p>
                {settled
                  ? presentation.standingReason
                  : rejected || "Evidence lands here as each round finishes."}
              </p>
            </div>
            <div className="insight-grid">
              <div>
                <span>Approach</span>
                <strong>{approach}</strong>
              </div>
              <div>
                <span>Complexity</span>
                <strong>{presentation.complexity || winnerFinal?.complexity || "Not stated"}</strong>
              </div>
              <div>
                <span>Execution</span>
                <strong>
                  {winnerRun?.ran
                    ? `${winnerRun.passed} passed, ${winnerRun.failed} failed in ${winnerRun.durationMs}ms`
                    : winnerRun?.note || "Not executed"}
                </strong>
              </div>
              <div>
                <span>Bench</span>
                <strong>
                  {council.dossier?.tally?.length
                    ? council.dossier.tally
                        .filter((t) => t.points > 0)
                        .map((t) => `${t.letter} ${t.points}`)
                        .join(" · ") || "No judge ranked the field"
                    : winnerFinal?.claims?.[0] ||
                      (winnerFinal?.kind === "code"
                        ? `${candidateLanguage(winnerFinal)} implementation`
                        : "See final judgement")}
                </strong>
              </div>
            </div>
            {Object.keys(council.runs).length > 0 && (
              <div className="council-gates">
                {council.candidates.map((c) => {
                  const g1 = gateFor(council.runs[c.letter]);
                  const g2 = c.revised ? gateFor(council.revisedRuns[c.letter]) : null;
                  return (
                    <span
                      key={c.letter}
                      className="badge"
                      data-tone={g2 === "pass" || (!g2 && g1 === "pass") ? "good" : g1 === "fail" || g2 === "fail" ? "bad" : "warn"}
                      title={c.model}
                    >
                      {c.letter} {g1}
                      {g2 ? ` → ${g2}` : ""}
                    </span>
                  );
                })}
              </div>
            )}

            {/* What the bench did not agree about. A council that only ever
                publishes its conclusion is indistinguishable from one model
                with a bigger bill; the disagreements are the part that shows
                the work was real. */}
            {(presentation.dissent.length > 0 ||
              presentation.harnessSuspect ||
              presentation.contractDisputes.length > 0) && (
              <ul className="council-notes">
                {presentation.contractDisputes.slice(0, 1).map((d) => (
                  <li key="contract" data-kind="contract" title={d}>
                    The readers disagreed about what the problem asks.
                  </li>
                ))}
                {presentation.harnessSuspect && (
                  <li data-kind="harness" title={presentation.harnessSuspect}>
                    The generated harness is suspect — read the evidence before believing a failure.
                  </li>
                )}
                {presentation.dissent.slice(0, 2).map((d) => (
                  <li key={d} data-kind="dissent" title={d}>
                    {d}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {tab === "decision" && (
          <div className="judge-out contained">
            {council.synthesis ? <Markdown text={council.synthesis} /> : <div className="empty compact">No final judgement yet.</div>}
          </div>
        )}

        {tab === "evidence" && (
          <div className="evidence-stack">
            <details open>
              <summary>Submitted Answers</summary>
              {council.candidates.map((c) => {
                const f = c.revised ?? c.final;
                return (
                  <div className="answer-card compact" key={c.letter}>
                    <div className="who">
                      Candidate {c.letter}
                      <span className="badge">{c.model.split("/").pop()}</span>
                      {c.letter === council.winner && <span className="badge" data-tone="good">Winner</span>}
                    </div>
                    <div className="txt">{f?.answer || c.error || "(no answer line returned)"}</div>
                  </div>
                );
              })}
            </details>
            <details>
              <summary>Execution Results</summary>
              <pre>{executionDigest(council.candidates, council.runs) || "No execution results."}</pre>
              {Object.keys(council.revisedRuns).length > 0 && (
                <pre>{executionDigest(council.candidates, council.revisedRuns, { revised: true })}</pre>
              )}
            </details>
            <details>
              <summary>Judge Reports</summary>
              {council.judges.map((j, i) => (
                <div className="answer-card compact" key={`${j.model}-${i}`}>
                  <div className="who">
                    {j.model}
                    <span className="badge">{j.emphasis}</span>
                  </div>
                  <div className="txt">{j.error || j.text.slice(0, 700) || "(no report)"}</div>
                </div>
              ))}
            </details>
            <details>
              <summary>Full Record</summary>
              <Markdown text={report} />
            </details>
          </div>
        )}

        {tab === "chat" && (
          <div className="council-chat">
            <div className="chat-log">
              {council.chat.length === 0 ? (
                <div className="empty compact">Ask a follow-up after the final judgement.</div>
              ) : (
                council.chat.map((m) => (
                  <div className="chat-msg" data-role={m.role} key={m.id}>
                    <div className="who">{m.role === "user" ? "You" : m.model}</div>
                    {m.error ? <div className="pane-error">{m.error}</div> : <Markdown text={m.text} />}
                  </div>
                ))
              )}
            </div>
            <div className="chat-targets">
              <div className="segmented">
                {(["all", "solvers", "judges", "selected"] as ChatScope[]).map((scope) => (
                  <button key={scope} data-on={chatScope === scope} onClick={() => setChatScope(scope)}>
                    {LABELS[scope]}
                  </button>
                ))}
              </div>
              {chatScope === "selected" && (
                <div className="model-checks">
                  {chatModels.map((m) => (
                    <label key={m}>
                      <input
                        type="checkbox"
                        checked={selectedModels.has(m)}
                        onChange={(e) => {
                          const next = new Set(selectedModels);
                          if (e.target.checked) next.add(m);
                          else next.delete(m);
                          setSelectedModels(next);
                        }}
                      />
                      {m}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <form className="chat-form" onSubmit={submitChat}>
              <textarea
                className="field"
                rows={3}
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                disabled={council.chatSending || !council.synthesis}
                placeholder="Ask the council a follow-up..."
              />
              <button className="btn primary" disabled={council.chatSending || !chatText.trim() || selectedForSend.length === 0 || !council.synthesis}>
                {council.chatSending ? "Sending..." : `Send to ${selectedForSend.length}`}
              </button>
            </form>
          </div>
        )}

        {tab === "reading" && (
          <div className="evidence-stack">
            <div className="answer-card compact">
              <div className="who">Image reading health</div>
              <div className="txt">
                {extraction.status === "done"
                  ? extraction.agreement?.agree
                    ? "Two readings agreed on the extracted problem text."
                    : "The image reading had disagreements or OCR uncertainty; compare the text below with the original screenshot."
                  : extraction.status === "error"
                    ? extraction.error
                    : "No structured image reading is attached to this run."}
              </div>
            </div>
            <details open>
              <summary>What the Agents Were Given</summary>
              <pre>{extraction.context || "The agents were given the original images and any typed note directly."}</pre>
            </details>
            {extraction.path && (
              <div className="hint">Reading saved at {extraction.path}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
