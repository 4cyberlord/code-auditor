"use client";

import { useEffect, useState } from "react";
import { PROVIDERS } from "@/lib/models";
import { useStore } from "@/lib/store";

/**
 * What the screenshot says, before anyone reasons about it.
 *
 * This strip exists because the vision pass introduces a failure the panel of
 * four agents was specifically designed to avoid: a single transcription that
 * everyone downstream treats as fact. Four models each misreading an `l` as a `1`
 * independently is unlikely; four models reasoning from one model's misread `1`
 * is certain.
 *
 * It stays one line high. The first version expanded itself whenever the readers
 * disagreed, on the logic that a disagreement is the most important thing on
 * screen -- but it pushed the panes clean off the bottom, so the moment you most
 * needed to compare the reading against the answers was the moment you could no
 * longer see them. One line, a count, and a control that opens it is better: the
 * warning is still unmissable, and the evidence is one click away rather than in
 * the way.
 */

export default function ReadingPanel() {
  const extraction = useStore((s) => s.extraction);
  const contextMode = useStore((s) => s.settings.contextMode);
  const extractors = useStore((s) => s.settings.extractors);
  const [open, setOpen] = useState(false);

  const status = extraction.status;

  // A new reading is a new thing to judge, so it starts closed rather than
  // inheriting whatever the last one was left at.
  useEffect(() => {
    if (status === "running" || status === "idle") setOpen(false);
  }, [status]);

  // Nothing to say before a run, and nothing to say at all in the mode where
  // every agent reads the picture itself.
  if (contextMode === "images" && status === "idle") return null;

  const names = extractors.map((p) => PROVIDERS[p].label);

  if (status === "idle") {
    return (
      <div className="reading" data-tone="idle">
        <span className="section-label">Reading</span>
        <span className="reading-line">
          {names.join(" and ")} will read the screenshot first; the panel reasons from
          what they agree on.
        </span>
        {/* When the transcriber saw the picture first and bounced it (a
            diagram, a chart), say which path the reading is about to take,
            so "why is a model reading this" has an answer on screen. */}
        {extraction.ocrNote && (
          <span
            className="chip"
            data-tone="warn"
            title={extraction.ocrNote}
            style={{ color: "var(--warn)" }}
          >
            vision: {extraction.ocrNote}
          </span>
        )}
      </div>
    );
  }

  if (status === "running") {
    return (
      <div className="reading" data-tone="busy">
        <span className="section-label">Reading</span>
        <span className="badge" data-tone="live">
          {names.join(" + ")}
        </span>
        <span className="reading-line">
          Transcribing the screenshot. The agents are waiting on this, not on a model.
        </span>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="reading" data-tone="bad">
        <span className="section-label">Reading</span>
        <span className="reading-line" style={{ color: "var(--bad)" }}>
          {extraction.error}
        </span>
        {/* When the transcriber failed on the way to this error, say so here:
            the user can tell "the readers both failed" from "Vision couldn't
            decode the image" only if it's visible which one it was. */}
        {extraction.ocrNote && (
          <span
            className="chip"
            data-tone="warn"
            title={extraction.ocrNote}
            style={{ color: "var(--warn)" }}
          >
            vision: {extraction.ocrNote}
          </span>
        )}
      </div>
    );
  }

  const { agreement, readings, context } = extraction;
  if (!agreement) return null;

  const crossChecked = readings.length >= 2;
  // An OCR reading (single, no model readers listed) is provenance, not
  // agreement: it was read on the device with Apple Vision, not cross-checked
  // by two models, and the chip below names it so the user can tell which
  // happened. `readings` is empty precisely in that case.
  const ocrRead = readings.length === 0;
  const tone = !agreement.agree ? "bad" : crossChecked ? "good" : ocrRead ? "good" : "warn";
  const label = !agreement.agree
    ? "readings disagree"
    : crossChecked
      ? "cross-checked"
      : ocrRead
        ? "on-device"
        : "unchecked";

  const high = agreement.conflicts.filter((c) => c.severity === "high");
  const low = agreement.conflicts.filter((c) => c.severity === "low");
  const doubts = agreement.merged.ambiguities;

  const detail =
    high.length > 0
      ? `${high.length} ${high.length === 1 ? "conflict" : "conflicts"}`
      : doubts.length > 0
        ? `${doubts.length} ${doubts.length === 1 ? "doubt" : "doubts"}`
        : "reading";

  return (
    <div className="reading" data-tone={tone} data-open={open}>
      <div className="reading-head">
        <span className="section-label">Reading</span>
        <span className="badge" data-tone={tone}>
          {label}
        </span>
        {readings.map((r) => (
          <span key={r.provider} className="chip" title={`Read by ${PROVIDERS[r.provider].vendor}`}>
            {PROVIDERS[r.provider].label}
          </span>
        ))}
        {/* The on-device path has no model key in `readings`, but it still
            *read* the screenshot. A chip names it so provenance is legible. */}
        {ocrRead && (
          <span className="chip" title="Transcribed on-device with Apple Vision">
            Apple Vision
          </span>
        )}
        <span className="chip" title="How far the merged reading trusts itself">
          {Math.round(agreement.merged.confidence * 100)}%
        </span>
        <span className="reading-line">{agreement.summary}</span>
        {/* Where the document went. Worth a chip rather than a hidden detail:
            when a model answers the wrong question, this file is how you tell
            whether the reader or the reasoner got it wrong, and you cannot check
            a file you do not know the name of. */}
        {extraction.path && (
          <span
            className="chip"
            title={`The reading was saved to ${extraction.path}`}
            style={{ cursor: "default" }}
          >
            {extraction.path.split("/").pop()}
          </span>
        )}
        <button className="btn tiny ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : `Show ${detail}`}
        </button>
      </div>

      {open && (
        <div className="reading-detail">
          {high.map((c) => (
            <div key={c.field} className="reading-conflict">
              <div className="section-label">{c.field}</div>
              <div className="reading-sides">
                <pre>
                  <b>{PROVIDERS[readings[0].provider].label}</b>
                  {"\n"}
                  {c.a || "(nothing)"}
                </pre>
                <pre>
                  <b>{readings[1] ? PROVIDERS[readings[1].provider].label : "Other"}</b>
                  {"\n"}
                  {c.b || "(nothing)"}
                </pre>
              </div>
            </div>
          ))}

          {low.length > 0 && (
            <p className="hint" style={{ margin: 0 }}>
              Minor differences: {low.map((c) => c.field).join(", ")}.
            </p>
          )}

          {/* The doubts the readers admitted to. These reach every agent inside the
              prompt, but a person looking at the screenshot can settle in two
              seconds what a model can only flag. */}
          {doubts.length > 0 && (
            <>
              <div className="section-label">Uncertain in the image</div>
              <ul className="reading-doubts">
                {doubts.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}

          <div className="section-label">What the agents were given</div>
          <pre className="reading-full">{context || "(the reading rendered to nothing)"}</pre>
        </div>
      )}
    </div>
  );
}
