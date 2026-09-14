"use client";

import { useMemo, useState } from "react";
import Markdown from "./Markdown";
import { PROVIDERS, PROVIDER_ORDER, agentSpec, type AgentId, type ProviderId } from "@/lib/models";
import { highlights, parseVerdict } from "@/lib/verdict";
import { routeFor, useStore } from "@/lib/store";

export default function ConsensusPanel() {
  const agents = useStore((s) => s.agents);
  const threshold = useStore((s) => s.settings.threshold);
  const judgeProvider = useStore((s) => s.settings.judgeProvider);
  const judge = useStore((s) => s.judge);
  const autoJudge = useStore((s) => s.settings.autoJudge);
  const keys = useStore((s) => s.keys);
  const gatewayKey = useStore((s) => s.gatewayKey);
  const settings = useStore((s) => s.settings);
  const running = useStore((s) => s.running);
  const patch = useStore((s) => s.patchSettings);
  const open = useStore((s) => s.settings.railPanel === "consensus");
  const toggleRail = useStore((s) => s.toggleRailPanel);
  const runJudge = useStore((s) => s.runJudge);
  const consensus = useStore((s) => s.consensus);
  const [answersOpen, setAnswersOpen] = useState(false);

  // Recompute whenever an agent finishes or the threshold moves.
  const result = useMemo(
    () => consensus(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, threshold]
  );

  const finished = agents.filter((a) => a.enabled && a.final);

  // Parsed once per reply rather than on every render: the judge streams, and
  // this runs on each chunk that lands.
  const marks = useMemo(
    () => (judge.status === "done" ? highlights(parseVerdict(judge.text)) : []),
    [judge.status, judge.text]
  );
  const nameOf = (id: string) => agentSpec(id as AgentId).label;
  const accentOf = (id: string) => agentSpec(id as AgentId).accent;

  const scoreFor = (a: string, b: string) =>
    result.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))?.score ?? null;

  const ids = finished.map((a) => a.id);

  /**
   * Every pair, in a sentence.
   *
   * The score is still the same number the matrix showed; what changes is that
   * it is spent on a plain reading rather than printed raw. "Said the same
   * thing" and "went different ways" are the two things the number means, and
   * the band in between is worth naming honestly as partial rather than
   * rounding it to one or the other.
   */
  const pairSentences = ids.flatMap((a, i) =>
    ids.slice(i + 1).map((b) => {
      const score = scoreFor(a, b);
      const agree = score != null && score >= threshold;
      const said =
        score == null
          ? "could not be compared"
          : agree
            ? score >= threshold + 0.15
              ? "said the same thing"
              : "broadly agreed"
            : score >= threshold - 0.15
              ? "partly overlapped, but not enough to count as agreeing"
              : "went different ways";
      return { key: `${a}-${b}`, a: nameOf(a), b: nameOf(b), agree, said };
    })
  );

  const answeredLabel = `${finished.length}/${agents.filter((a) => a.enabled).length} answered`;

  return (
    <aside className="side" data-open={open}>
      {/* The whole row is the handle, matching every other drawer. The answered
          count stays on it when collapsed — it is the one thing worth seeing
          without opening the box. */}
      <div
        className="side-head drawer-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => toggleRail("consensus")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleRail("consensus");
          }
        }}
        title={open ? "Collapse" : "Show the solution box"}
      >
        <span className="chev" aria-hidden="true">
          ▾
        </span>
        <h2>Solution Box</h2>
        <span className="spacer" />
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{answeredLabel}</span>
      </div>

      {open && (
      <div className="side-body">
        <div className="verdict" data-v={result.verdict}>
          <h3>{result.headline}</h3>
          <p>{result.detail}</p>
          {result.advisory && (
            <p style={{ marginTop: 8, color: "var(--text-faint)" }}>{result.advisory}</p>
          )}
        </div>

        {result.groups.length > 1 && (
          <>
            <p className="section-label">Agreement Groups</p>
            {result.groups.map((g, i) => (
              <div className="group-row" key={`g${i}`}>
                {g.map((id) => (
                  <span
                    className="chip"
                    key={id}
                    style={{ borderColor: accentOf(id), color: accentOf(id) }}
                  >
                    <span className="dot" style={{ background: accentOf(id) }} />
                    {nameOf(id)}
                  </span>
                ))}
                <span className="spacer" />
                <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>
                  {i === 0 ? "Primary cluster" : "Different answer"}
                </span>
              </div>
            ))}
          </>
        )}

        {ids.length > 1 && (
          <>
            <p className="section-label" style={{ marginTop: 16 }}>
              Who Agreed with Whom
            </p>

            {/* This was a grid of pair scores to two decimal places, which is
                the right shape for tuning a threshold and the wrong shape for
                the question people actually have: did these two say the same
                thing? A sentence per pair, in words, answers that without
                anyone having to learn what 0.63 means. */}
            <ul className="pairings">
              {pairSentences.map((p) => (
                <li key={p.key} data-agree={p.agree}>
                  <span className="pair-mark" aria-hidden="true">{p.agree ? "=" : "\u2260"}</span>
                  <span className="pair-who">
                    <b>{p.a}</b> and <b>{p.b}</b>
                  </span>
                  <span className="pair-said">{p.said}</span>
                </li>
              ))}
            </ul>

            <details className="pair-detail">
              <summary>Show the Numbers</summary>
              <div style={{ overflowX: "auto" }}>
                <table className="matrix">
                  <thead>
                    <tr>
                      <th />
                      {ids.map((id) => (
                        <th key={id}>{nameOf(id).slice(0, 6)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ids.map((a) => (
                      <tr key={a}>
                        <th>{nameOf(a).slice(0, 6)}</th>
                        {ids.map((b) => {
                          if (a === b) {
                            return <td key={b} style={{ color: "var(--text-faint)" }}>{"\u2014"}</td>;
                          }
                          const sc = scoreFor(a, b);
                          return (
                            <td key={b} data-agree={sc != null && sc >= threshold}>
                              {sc == null ? "-" : sc.toFixed(2)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, marginBottom: 10 }}>
                <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>Match at</span>
                <input
                  type="range"
                  min={0.2}
                  max={0.9}
                  step={0.01}
                  value={threshold}
                  onChange={(e) => patch({ threshold: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: "var(--accent)" }}
                />
                <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
                  {threshold.toFixed(2)}
                </span>
              </div>
            </details>
          </>
        )}

        {finished.length > 0 && (
          <details className="rail-details" open={answersOpen} onToggle={(e) => setAnswersOpen(e.currentTarget.open)}>
            <summary className="section-label" style={{ marginTop: 18 }}>
              Submitted Answers
            </summary>
            {finished.map((a) => (
              <div className="answer-card" key={a.id}>
                <div className="who" style={{ color: accentOf(a.id) }}>
                  <span className="dot" style={{ background: accentOf(a.id) }} />
                  {agentSpec(a.provider).label}
                  {result.representative === a.id && (
                    <span className="badge" data-tone="good">
                      Representative
                    </span>
                  )}
                  {result.outliers.includes(a.id) && (
                    <span className="badge" data-tone="warn">
                      Outlier
                    </span>
                  )}
                  <span className="spacer" />
                  {a.final?.confidence != null && (
                    <span style={{ fontSize: 10, color: "var(--text-faint)", fontWeight: 400 }}>
                      {(a.final.confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                <div className="txt">{a.final?.answer || "(no answer line returned)"}</div>
                {a.final?.claims.length ? (
                  <ul style={{ margin: "7px 0 0", paddingLeft: 16, fontSize: 11, color: "var(--text-faint)" }}>
                    {a.final.claims.slice(0, 3).map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </details>
        )}

        {!settings.councilEnabled && (
          <>
            <p className="section-label" style={{ marginTop: 18 }}>
              Single-Model Adjudication
            </p>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <select
                className="field"
                style={{ width: 120 }}
                value={judgeProvider}
                onChange={(e) => patch({ judgeProvider: e.target.value as ProviderId })}
              >
                {PROVIDER_ORDER.map((p) => {
                  const reachable = routeFor(p, settings, keys, gatewayKey) !== null;
                  return (
                    <option key={p} value={p} disabled={!reachable}>
                      {PROVIDERS[p].label}
                      {reachable ? "" : " (no route)"}
                    </option>
                  );
                })}
              </select>
              <button
                className="btn"
                onClick={() => void runJudge()}
                disabled={judge.status === "running" || running || finished.length < 2}
                title={
                  finished.length < 2
                    ? "Two finished answers are needed before there is anything to judge"
                    : "Send every FINAL block to one model and ask it to decide who is right"
                }
              >
                {judge.status === "running" ? "Judging..." : "Run Judge"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)", flex: "none" }}>Run it</span>
              <div className="segmented" style={{ flex: 1 }}>
                {(["off", "prose", "always"] as const).map((v) => (
                  <button
                    key={v}
                    data-on={autoJudge === v}
                    style={{ flex: 1 }}
                    onClick={() => patch({ autoJudge: v })}
                    title={
                      v === "off"
                        ? "Only when you press the button"
                        : v === "prose"
                          ? "Automatically when there is no code to compare, which is where the word-overlap check is weakest"
                          : "Automatically after every run"
                    }
                  >
                    {v === "off" ? "Manually" : v === "prose" ? "When Prose" : "Always"}
                  </button>
                ))}
              </div>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Agreement is not correctness. The judge re-checks the reasoning instead of counting votes.
            </p>

            {judge.status === "error" && <div className="pane-error">{judge.error}</div>}
            {judge.status === "done" && (
              <div className="judge-out">
                {marks.length > 0 && (
                  <div className="marks">
                    {marks.map((m) => (
                      <div className="mark" key={m.key}>
                        <div className="mark-label">{m.label}</div>
                        <div className="mark-body">
                          <Markdown text={m.body} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <Markdown text={judge.text} />
              </div>
            )}
          </>
        )}
      </div>
      )}
    </aside>
  );
}
