"use client";

import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { gateFor } from "@/lib/council";
import { PORT_LABELS, PORT_LANGUAGES, isAlreadyOptimal, type PortLanguage } from "@/lib/review";
import Markdown from "./Markdown";

/**
 * The read-out on the answer, in one place.
 *
 * The panel says whether four models agreed, which is not the question anyone
 * has in front of a solution. This answers the four that people actually ask —
 * is it right, what is it doing, could it be faster, is it written well — and
 * offers the same algorithm in three languages, because reading them beside each
 * other is how you decide which one you want.
 *
 * Measured numbers and reviewed opinions are kept visibly apart. A runtime is a
 * fact only when something ran; everything else here is a model's read, however
 * confident it sounds, and the card never lets the two wear the same styling.
 */
export default function SolutionCard() {
  const review = useStore((s) => s.review);
  const runs = useStore((s) => s.council.runs);
  const rerun = useStore((s) => s.runReview);
  const setLanguage = useStore((s) => s.setReviewLanguage);
  const running = useStore((s) => s.running);
  const open = useStore((s) => s.settings.railPanel === "solution");
  const toggleRail = useStore((s) => s.toggleRailPanel);
  const toggle = () => toggleRail("solution");

  /**
   * What was actually measured, if anything.
   *
   * Only the Council executes code, so on a plain panel run there is no runtime
   * and no memory — and the honest thing to print is that nothing ran, not a
   * blank that reads like a zero.
   */
  const measured = useMemo(() => {
    const executed = Object.values(runs).filter((r) => r?.ran);
    if (!executed.length) return null;
    const passing = executed.filter((r) => gateFor(r) === "pass");
    const best = (passing.length ? passing : executed).sort((a, b) => a.durationMs - b.durationMs)[0];
    // Whoever ran it measured it. The sandbox reports elapsed time and peak
    // resident set from the same metrics script a GitHub runner uses, so a
    // remote number is only preferred when one was actually taken.
    const elapsed = best.remote?.remoteElapsedMs ?? best.remoteElapsedMs ?? best.durationMs;
    const peakKb = best.remote?.peakMemoryKb ?? best.peakMemoryKb ?? null;
    return {
      passed: passing.length > 0,
      cases: `${best.passed} passed${best.failed ? `, ${best.failed} failed` : ""}`,
      runtime: `${Math.round(elapsed)} ms`,
      memory:
        peakKb != null
          ? peakKb >= 1024
            ? `${(peakKb / 1024).toFixed(1)} MB`
            : `${Math.round(peakKb)} KB`
          : null,
      runtimeLabel: best.remote?.runtime || best.provider || best.runtime,
    };
  }, [runs]);

  const data = review.data;

  const optimal = data ? isAlreadyOptimal(data) : false;
  const ports = PORT_LANGUAGES.filter((l) => data?.ports[l]);
  const shown: PortLanguage = ports.includes(review.language) ? review.language : ports[0] ?? "cpp";

  return (
    <section className="solution-card" data-open={open}>
      {/* The whole header is the handle, the same as the other drawers — a
          chevron alone is a poor target and there is nothing else this row
          could mean. The status badge stays visible when collapsed, because
          "is it right" is the one thing worth seeing without opening it. */}
      <div
        className="side-head drawer-head solution-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        title={open ? "Collapse" : "Show the solution read-out"}
      >
        <span className="chev" aria-hidden="true">
          ▾
        </span>
        <h2>Solution</h2>
        {data?.valid === true && <span className="badge" data-tone="good">Valid solution</span>}
        {data?.valid === false && <span className="badge" data-tone="bad">Not correct</span>}
        {data?.valid == null && data && <span className="badge" data-tone="warn">Unclear</span>}
        <span className="spacer" />
        {review.status === "running" && <span className="hint">Reviewing…</span>}
        {open && review.status !== "running" && (
          <button
            className="btn tiny ghost"
            disabled={running}
            onClick={(e) => {
              e.stopPropagation();
              void rerun();
            }}
          >
            {data ? "Review again" : "Review"}
          </button>
        )}
      </div>

      {/* Nothing reviewed yet. The drawer is still here to be opened, the same
          as Cloud Jobs with no jobs — a control that appears only once it has
          something to show is a control nobody finds. */}
      {open && review.status === "idle" && !data && (
        <p className="hint solution-empty">
          Nothing reviewed yet. A read-out is written automatically when a run finishes, or press
          Review to grade whatever is on the panes now.
        </p>
      )}

      {open && review.error && <div className="pane-error">{review.error}</div>}
      {open && data?.validNote && <p className="solution-why">{data.validNote}</p>}

      {/* Measured, or plainly not. Never a blank that reads as a zero. */}
      {open && (data || review.status !== "idle") && (
      <div className="solution-measured" data-measured={Boolean(measured)}>
        {measured ? (
          <>
            <span><b>Runtime</b>{measured.runtime}</span>
            <span><b>Memory</b>{measured.memory ?? "not recorded"}</span>
            <span><b>Tests</b>{measured.cases}</span>
            <span className="solution-runtime-label">{measured.runtimeLabel}</span>
          </>
        ) : (
          <span className="hint">
            Nothing was executed for this run, so there is no measured runtime or memory. Turn the
            Council on to have candidates run against a generated harness.
          </span>
        )}
      </div>
      )}

      {open && data && (
        <div className="solution-facets">
          <div className="facet">
            <h4>Approach</h4>
            <dl>
              <dt>Current</dt>
              <dd>{data.approach.current || "—"}</dd>
              <dt>Suggested</dt>
              <dd data-same={optimal}>{data.approach.suggested || "—"}</dd>
            </dl>
            {data.approach.keyIdea && (
              <p><b>Key idea</b> {data.approach.keyIdea}</p>
            )}
          </div>

          <div className="facet">
            <h4>Efficiency</h4>
            <dl>
              <dt>Current</dt>
              <dd className="mono">
                {data.efficiency.currentTime || "—"} · {data.efficiency.currentSpace || "—"}
              </dd>
              <dt>Suggested</dt>
              <dd className="mono" data-same={optimal}>
                {data.efficiency.suggestedTime || "—"} · {data.efficiency.suggestedSpace || "—"}
              </dd>
            </dl>
            {data.efficiency.note && <p>{data.efficiency.note}</p>}
          </div>

          <div className="facet">
            <h4>Code style</h4>
            <dl>
              <dt>Readability</dt>
              <dd data-grade={data.style.readability}>{data.style.readability || "—"}</dd>
              <dt>Structure</dt>
              <dd data-grade={data.style.structure}>{data.style.structure || "—"}</dd>
            </dl>
            {data.style.note && <p>{data.style.note}</p>}
          </div>
        </div>
      )}

      {/* The same algorithm, three ways. The performance rule is deliberately
          not enforced across these — they are here to be compared, and which
          one to ship is the reader's call. */}
      {open && ports.length > 0 && (
        <div className="solution-ports">
          <div className="segmented">
            {ports.map((lang) => (
              <button key={lang} data-on={lang === shown} onClick={() => setLanguage(lang)}>
                {PORT_LABELS[lang]}
              </button>
            ))}
          </div>
          <Markdown text={"```" + shown + "\n" + (data?.ports[shown] ?? "") + "\n```"} />
        </div>
      )}
    </section>
  );
}
