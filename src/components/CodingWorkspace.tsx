"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown";
import Splitter from "./Splitter";
import {
  CODING_BRIDGE_CONFIG_EVENT,
  CodingRunCancelled,
  cancelCodingRun,
  codingRunMarkdown,
  createRunControl,
  humanizeList,
  humanizeSolution,
  humanizeValue,
  isActionablePlan,
  isResumable,
  loadCodingBridgeConfig,
  loadCodingRuns,
  missingContext,
  runMode,
  stopReasonLabel,
  runCodingIntelligence,
  runCodingPlan,
  saveCodingRuns,
  saveRunDocument,
  type CodingActivity,
  type CodingBridgeConfig,
  type CodingProgress,
  type CodingRun,
  type CodingRunControl,
  type CodingToolEvent,
} from "@/lib/codingIntelligence";

function items(value: unknown[] | undefined): string[] {
  return humanizeList(value);
}

function eventTarget(event: CodingToolEvent): string {
  const value =
    event.args.path ??
    event.args.filePath ??
    event.args.file_path ??
    event.args.source ??
    event.args.destination ??
    event.args.directory ??
    event.args.folder ??
    event.args.command ??
    "";
  return humanizeValue(value);
}

export default function CodingWorkspace() {
  const [task, setTask] = useState("");
  const [runs, setRuns] = useState<CodingRun[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMode, setBusyMode] = useState<"planning" | "executing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<CodingBridgeConfig>(() => loadCodingBridgeConfig());
  const [copied, setCopied] = useState(false);
  const [liveEvents, setLiveEvents] = useState<CodingToolEvent[]>([]);
  const [progress, setProgress] = useState<CodingProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [liveActivity, setLiveActivity] = useState<CodingActivity[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  const [docPath, setDocPath] = useState<string | null>(null);
  const controlRef = useRef<CodingRunControl | null>(null);

  // The queue is read from inside the run loop, which closed over its own
  // render. A ref is what lets that loop see follow-ups added after it started.
  const queueRef = useRef<string[]>([]);
  const takePending = () => {
    const pending = queueRef.current;
    queueRef.current = [];
    if (pending.length) setQueued([]);
    return pending;
  };

  // The model can think for a long while with nothing to show for it. A running
  // clock is the difference between "working" and "hung" for whoever is waiting.
  //
  // The reset lives in beginRun rather than here: setting state in an effect
  // body costs a second render pass on every start, and the run beginning is an
  // event, so it can be zeroed where it happens.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.round((Date.now() - started) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    void loadCodingRuns().then((stored) => {
      setRuns(stored);
      setActiveId(stored[0]?.id ?? null);
    });
    const onConfig = () => setConfig(loadCodingBridgeConfig());
    window.addEventListener(CODING_BRIDGE_CONFIG_EVENT, onConfig);
    window.addEventListener("storage", onConfig);
    return () => {
      window.removeEventListener(CODING_BRIDGE_CONFIG_EVENT, onConfig);
      window.removeEventListener("storage", onConfig);
    };
  }, []);

  const active = runs.find((r) => r.id === activeId) ?? runs[0] ?? null;
  const markdown = useMemo(() => codingRunMarkdown(active), [active]);
  const parsed = active?.parsed ?? null;
  const actionable = useMemo(() => isActionablePlan(parsed), [parsed]);
  const resumable = isResumable(active);
  const executionEvents = busyMode === "executing" && liveEvents.length ? liveEvents : active?.events ?? [];
  // Mirrors the main pane: a skeleton is not a to-do list, and listing it here
  // would put the same unexecutable steps back in front of the user.
  const todoRows = !actionable
    ? []
    : [
        ...(parsed?.todos ?? []).map((todo) => `${todo.status ?? "pending"} - ${todo.title ?? "Task"}${todo.detail ? `: ${todo.detail}` : ""}`),
        ...(parsed?.implementation_approach ?? []).map((step, index) => `pending - ${step.title ?? `Step ${step.step ?? index + 1}`}: ${step.description ?? ""}`),
      ];

  const saveRun = async (run: CodingRun, previous?: CodingRun | null) => {
    const next = [run, ...runs.filter((item) => item.id !== run.id)].slice(0, 30);
    setRuns(next);
    await saveCodingRuns(next);
    setActiveId(run.id);

    // The document is the deliverable: one file in the project stating the
    // task, the plan and what was done. Written for every run that produced
    // something, so the execution phase can read it back and anything outside
    // this app can pick it up without going through the UI.
    const worthSaving = isActionablePlan(run.parsed) || run.events.length > 0;
    if (!worthSaving) return;
    const result = await saveRunDocument(run, config, previous);
    setDocPath("error" in result ? null : result.path);
    if ("error" in result) setError(`Run finished, but the plan file could not be written: ${result.error}`);
  };

  const beginRun = (mode: "planning" | "executing") => {
    const control = createRunControl();
    controlRef.current = control;
    setBusy(true);
    setBusyMode(mode);
    setError(null);
    setStopping(false);
    setProgress(null);
    setLiveEvents([]);
    setLiveActivity([]);
    setElapsed(0);
    return control;
  };

  const endRun = () => {
    controlRef.current = null;
    setBusy(false);
    setBusyMode(null);
    setStopping(false);
    setProgress(null);
  };

  // A stop the user asked for is an outcome, not a failure, so it is reported
  // as a plain note rather than an error.
  const finishWith = (err: unknown) => {
    if (err instanceof CodingRunCancelled) {
      setError("Run stopped.");
      return;
    }
    setError(String(err).replace(/^Error:\s*/, ""));
  };

  const stopRun = async () => {
    const control = controlRef.current;
    if (!control || control.cancelled) return;
    setStopping(true);
    setProgress({ phase: "stopping", turn: 0, detail: "Stopping the model" });
    try {
      await cancelCodingRun(config, control);
    } catch (err) {
      // The local flag is already set, so the loop ends regardless; the user
      // only needs to know the bridge did not confirm it.
      setError(`Stop requested, but the bridge did not confirm: ${String(err).replace(/^Error:\s*/, "")}`);
    }
  };

  const preparePlan = async () => {
    const clean = task.trim();
    if (!clean) return;
    const control = beginRun("planning");
    try {
      const run = await runCodingPlan(clean, config, { control, onProgress: setProgress });
      await saveRun(run);
    } catch (err) {
      finishWith(err);
    } finally {
      endRun();
    }
  };

  const trackEvent = (event: CodingToolEvent) =>
    setLiveEvents((current) => {
      const index = current.findIndex((item) => item.id === event.id);
      if (index < 0) return [...current, event];
      const next = [...current];
      next[index] = event;
      return next;
    });

  // `resume` carries the interrupted run whose work this one picks up. Its plan
  // comes from that run's own chain, so continuing a continuation still points
  // back at the plan the whole thing started from.
  const execute = async (resume?: CodingRun | null) => {
    const base = resume ?? active;
    const clean = (base?.task || task).trim();
    if (!clean) return;
    const planBase = resume
      ? (runs.find((r) => r.id === resume.continuedFrom) ?? resume)
      : base;
    const control = beginRun("executing");
    try {
      const run = await runCodingIntelligence(clean, config, {
        control,
        planRun: planBase,
        onProgress: setProgress,
        onEvent: trackEvent,
        onActivity: (entry) => setLiveActivity((current) => [...current, entry]),
        takePending,
        ...(resume ? { resumeOf: resume.id, resumeFrom: resume } : {}),
      });
      await saveRun(run, resume);
    } catch (err) {
      finishWith(err);
    } finally {
      endRun();
    }
  };

  const executePlan = () => execute(null);

  // Continuing a plan and continuing an execution are different jobs: a
  // truncated plan has nothing to resume from, so it is simply re-planned.
  const continueRun = async () => {
    if (!active) return;
    if (runMode(active) === "plan") {
      const clean = (active.task || task).trim();
      if (!clean) return;
      const control = beginRun("planning");
      try {
        await saveRun(await runCodingPlan(clean, config, { control, onProgress: setProgress }));
      } catch (err) {
        finishWith(err);
      } finally {
        endRun();
      }
      return;
    }
    await execute(active);
  };

  const newConversation = () => {
    queueRef.current = [];
    setTask("");
    setActiveId(null);
    setError(null);
    setCopied(false);
    setLiveEvents([]);
    setLiveActivity([]);
    setProgress(null);
    setElapsed(0);
    setQueued([]);
    setDocPath(null);
  };

  /**
   * One composer, two meanings.
   *
   * Idle, a message starts the analysis. Mid-run it joins a queue the agent
   * drains at its next turn boundary — so a correction spotted at step 3 is
   * acted on at step 4, instead of waiting for a run that is now going the
   * wrong way to finish.
   */
  const submitMessage = () => {
    const clean = task.trim();
    if (!clean) return;
    if (busy) {
      queueRef.current = [...queueRef.current, clean];
      setQueued(queueRef.current);
      setTask("");
      return;
    }
    void preparePlan();
  };

  const dropQueued = (index: number) => {
    queueRef.current = queueRef.current.filter((_, i) => i !== index);
    setQueued(queueRef.current);
  };

  const copyPlan = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(markdown || active.raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      setError(`Could not copy plan: ${String(err).replace(/^Error:\s*/, "")}`);
    }
  };

  return (
    <div className="coding-workspace">
      <section className="coding-task">
        <div className="pane-head">
          <span className="dot" style={{ background: "var(--accent)" }} />
          <div>
            <div className="pane-title">What to build</div>
            <div className="pane-model">{config.model}</div>
          </div>
          <span className="spacer" />
          <span className="badge" data-tone={busy ? "live" : "good"}>
            {busyMode ?? "local"}
          </span>
          <button className="btn tiny ghost" onClick={newConversation} disabled={busy}>
            New
          </button>
        </div>

        <div className="coding-task-body">
          {busy && (
            <RunStatus mode={busyMode} progress={progress} elapsed={elapsed} stopping={stopping} />
          )}

          {queued.length > 0 && (
            <div className="coding-queue">
              <div className="section-label">Queued ({queued.length})</div>
              {queued.map((item, i) => (
                <div key={i} className="coding-queue-item">
                  <span>{item}</span>
                  <button
                    className="btn tiny ghost"
                    onClick={() => dropQueued(i)}
                    title="Remove from the queue"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <p className="hint">Picked up at the agent&rsquo;s next step.</p>
            </div>
          )}

          <textarea
            className="field coding-task-input"
            placeholder={
              busy
                ? "Add a follow-up — it joins the queue and is picked up at the next step. ⌘↵ to send."
                : "Describe the change, bug, refactor, or feature you want the coding agent to implement. ⌘↵ to analyze."
            }
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submitMessage();
              }
            }}
            // Deliberately never disabled: the whole point of the queue is that
            // you can keep typing while the agent works.
            // Task descriptions are mostly paths, identifiers and code
            // fragments, so macOS flags nearly every word and its spell daemon
            // logs timeouts trying. InputBar made the same call.
            spellCheck={false}
          />

          {error && <div className="pane-error wrap">{error}</div>}
          <div className="coding-actions">
            <button className="btn primary" onClick={submitMessage} disabled={!task.trim()}>
              {busy ? "Queue follow-up" : busyMode === "planning" ? "Analyzing..." : "Analyze Plan"}
            </button>
            {busy ? (
              <button className="btn danger" onClick={() => void stopRun()} disabled={stopping}>
                {stopping ? "Stopping..." : "Stop"}
              </button>
            ) : resumable ? (
              <button className="btn" onClick={() => void continueRun()}>
                Continue
              </button>
            ) : (
              <button className="btn ghost" onClick={() => setTask("")} disabled={!task}>
                Clear
              </button>
            )}
          </div>

          {resumable && !busy && (
            <div className="coding-resume">
              <strong>Run unfinished</strong>
              <p>
                {stopReasonLabel(active?.stoppedReason)}{" "}
                {active && runMode(active) === "plan"
                  ? "Continue runs the analysis again."
                  : "Continue picks up from the execution log without redoing what already applied."}
              </p>
            </div>
          )}

          <div className="section-label">Project</div>
          <div className="coding-root-readout">{config.projectRoot || "Set the editable project root in Bridge settings."}</div>
          {docPath && (
            <>
              <div className="section-label">Plan document</div>
              <div className="coding-root-readout">{docPath}</div>
            </>
          )}
        </div>
      </section>

      <Splitter
        axis="col"
        variable="--coding-task-w"
        min={280}
        max={760}
        reset={420}
        storageKey="code-auditor.layout.coding-task"
      />

      <section className="coding-output">
        <div className="coding-output-main">
          <div className="pane-head">
            <span className="dot" style={{ background: "#14a085" }} />
            <div>
              <div className="pane-title">Implementation plan</div>
              <div className="pane-model">
                {busy
                  ? `${busyMode === "planning" ? "analyzing" : "running"} · ${clock(elapsed)}`
                  : !active
                    ? "waiting"
                    : actionable
                      ? `${parsed?.status ?? "ready"}${
                          typeof parsed?.confidence === "number"
                            ? ` · ${Math.round(parsed.confidence * 100)}%`
                            : ""
                        }`
                      : "needs detail"}
              </div>
            </div>
            <span className="spacer" />
            <button className="btn tiny ghost" onClick={() => void copyPlan()} disabled={!active}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="pane-body">
            <div className="coding-plan-stack">
              {busy ? (
                <ActivityFeed entries={liveActivity} events={liveEvents} live />
              ) : !active ? (
                <div className="empty">Write a task on the left and the plan appears here.</div>
              ) : actionable ? (
                <>
                  <Markdown text={markdown} />
                  <ActivityFeed entries={active.activity ?? []} events={active.events} />
                </>
              ) : (
                <>
                  <NeedsDetail run={active} />
                  <ActivityFeed entries={active.activity ?? []} events={active.events} />
                </>
              )}
              <section className="coding-execute-plan">
                <div className="coding-execute-head">
                  <div>
                    <div className="section-label">Execute Plan</div>
                    <p>
                      {resumable && !busy
                        ? "This run stopped early. Continue resumes it from the log below."
                        : actionable || busy
                          ? "Runs the selected implementation plan and todos against the configured project."
                          : "Available once a plan names both the work and the files it touches."}
                    </p>
                  </div>
                  {busy ? (
                    <button className="btn danger tiny" onClick={() => void stopRun()} disabled={stopping}>
                      {stopping ? "Stopping..." : "Stop"}
                    </button>
                  ) : resumable ? (
                    <button className="btn primary tiny" onClick={() => void continueRun()}>
                      Continue
                    </button>
                  ) : (
                    <button
                      className="btn primary tiny"
                      onClick={() => void executePlan()}
                      disabled={!actionable}
                    >
                      Run Work
                    </button>
                  )}
                </div>
                {executionEvents.length ? (
                  <div className="coding-event-list">
                    {executionEvents.map((event) => (
                      <div key={event.id} className="coding-event" data-status={event.status}>
                        <div>
                          <strong>{event.tool}</strong>
                          <span>{eventTarget(event)}</span>
                        </div>
                        <p>{event.result || "Running..."}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty compact">File and folder updates appear here while the agent works.</div>
                )}
              </section>
            </div>
          </div>
        </div>

        <Splitter
          axis="col"
          variable="--coding-detail-w"
          min={240}
          max={560}
          reset={340}
          storageKey="code-auditor.layout.coding-detail"
          invert
        />

        <div className="coding-output-side">
          <div className="pane-head">
            <span className="dot" style={{ background: "#d29922" }} />
            <div>
              <div className="pane-title">Build details</div>
              <div className="pane-model">todos, files, tests, commands, memory</div>
            </div>
          </div>
          <div className="coding-detail-scroll">
            <Detail title="Todos" rows={todoRows} />
            <Detail
              title="Files"
              rows={(parsed?.affected_files ?? [])
                .filter((f) => f.path && f.path.toLowerCase() !== "unknown")
                .map((f) => `${f.path} - ${f.reason ?? ""}`)}
            />
            <Detail title="Commands" rows={items(parsed?.commands)} mono />
            <Detail title="Tests" rows={items(parsed?.tests)} />
            <Detail title="Security" rows={items(parsed?.security_considerations)} />
            <Detail title="Memory" rows={parsed?.architecture_memory ?? []} />
            <Detail title="More Context" rows={missingContext(parsed)} />
            <History runs={runs} activeId={active?.id ?? null} onPick={setActiveId} />
          </div>
        </div>
      </section>
    </div>
  );
}

const ACTIVITY_LABEL: Record<CodingActivity["kind"], string> = {
  thinking: "Thinking",
  tool: "Tool",
  note: "Said",
  instruction: "You added",
};

/**
 * The run as it happened: what the model reasoned, what it ran, what it got
 * back, and any follow-up dropped in mid-flight — in order.
 *
 * Reasoning arrives per turn rather than per token, because the app talks to
 * the bridge without streaming; a turn's thinking lands when that turn resolves.
 * So this fills in step by step, not word by word.
 */
function ActivityFeed({
  entries,
  events,
  live = false,
}: {
  entries: CodingActivity[];
  events: CodingToolEvent[];
  live?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const byEvent = useMemo(
    () => new Map(events.map((event) => [event.id, event])),
    [events]
  );

  useEffect(() => {
    if (live && open) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length, live, open]);

  if (!entries.length) {
    return live ? (
      <div className="empty compact">The agent&rsquo;s reasoning and tool calls appear here.</div>
    ) : null;
  }

  return (
    <section className="coding-activity">
      <button className="coding-activity-head" onClick={() => setOpen((v) => !v)}>
        <strong>{live ? "Working" : "How it worked"}</strong>
        <span className="chip">{entries.length}</span>
        <span className="spacer" />
        <span className="hint">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <div className="coding-activity-list">
          {entries.map((entry) => {
            const event = entry.eventId ? byEvent.get(entry.eventId) : undefined;
            return (
              <div key={entry.id} className="coding-activity-row" data-kind={entry.kind}>
                <div className="coding-activity-meta">
                  <span className="coding-activity-kind">{ACTIVITY_LABEL[entry.kind]}</span>
                  <span className="coding-activity-turn">step {entry.turn}</span>
                </div>
                <div className="coding-activity-text">{entry.text}</div>
                {event && (
                  <div className="coding-activity-result" data-status={event.status}>
                    {event.status === "running" ? "running…" : event.result || "(no output)"}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}
    </section>
  );
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/**
 * Shown for the whole time a run is in flight.
 *
 * The model is remote and can think for a minute or more before it says
 * anything, so an idle pane reads as a hang. This says what is happening, how
 * long it has been happening, and stays honest that a slow answer is normal
 * here rather than implying progress that is not being measured.
 */
function RunStatus({
  mode,
  progress,
  elapsed,
  stopping,
}: {
  mode: "planning" | "executing" | null;
  progress: CodingProgress | null;
  elapsed: number;
  stopping: boolean;
}) {
  const headline = stopping
    ? "Stopping"
    : mode === "planning"
      ? "Analyzing the task"
      : "Working through the plan";

  return (
    <section className="coding-status" data-stopping={stopping || undefined}>
      <div className="coding-status-head">
        <span className="coding-status-pulse" aria-hidden />
        <strong>{headline}</strong>
        <span className="spacer" />
        <span className="coding-status-clock">{clock(elapsed)}</span>
      </div>
      <p className="coding-status-detail">
        {stopping
          ? "Releasing this run. The model call is dropped here, but a task already accepted upstream finishes on its own."
          : (progress?.detail ?? "Sending the task to the model")}
      </p>
      {!stopping && (
        <p className="hint">
          {progress?.phase === "tool"
            ? `Step ${progress.turn} — running tools against the project.`
            : elapsed > 25
              ? "The model is hosted remotely and thinks before answering, so a first response can take a while. Stop is always available."
              : "The model thinks before it answers; the first response is the slowest part."}
        </p>
      )}
    </section>
  );
}

/**
 * The model answered, but with a skeleton rather than a plan — typically
 * because the task did not describe any actual work. Kept visually distinct
 * from a real plan so nobody executes an outline about their own project.
 */
function NeedsDetail({ run }: { run: CodingRun }) {
  const parsed = run.parsed;
  const asks = missingContext(parsed);
  const summary = parsed?.summary?.trim();

  return (
    <section className="coding-needs-detail">
      <div className="section-label">No plan yet</div>
      <p>
        {summary ||
          "The model answered, but did not produce a plan naming the work and the files it touches."}
      </p>
      {asks.length > 0 && (
        <>
          <div className="section-label">It still needs</div>
          <ul className="coding-needs-list">
            {asks.map((ask, i) => (
              <li key={i}>{ask}</li>
            ))}
          </ul>
        </>
      )}
      <p className="hint">
        Describe the change against this project — the file or area to touch, and what should be
        different afterwards — then run Analyze Plan again.
      </p>
      <ModelResponse run={run} />
    </section>
  );
}

/**
 * What the model actually said, in prose.
 *
 * The model answers with a twenty-odd field JSON envelope. Printing that
 * verbatim showed braces and quotes to someone who only wanted to know what it
 * thought — and the fields it left empty, which is most of them on a thin
 * answer, took up as much room as the ones it filled.
 *
 * The JSON is still one click away, because when the parse is the thing you are
 * debugging, the prose version is exactly what you cannot trust.
 */
function ModelResponse({ run }: { run: CodingRun }) {
  const sections = useMemo(() => humanizeSolution(run.parsed), [run.parsed]);

  // Nothing parsed, so the raw text is the only honest thing to show.
  if (!run.parsed) {
    return (
      <details className="rail-details">
        <summary>
          <strong>Model response</strong>
          <span className="chip">unparsed</span>
        </summary>
        <div className="coding-detail-rows mono">
          <div>{run.raw}</div>
        </div>
      </details>
    );
  }

  return (
    <>
      {sections.length > 0 && (
        <details className="rail-details" open>
          <summary>
            <strong>What the model said</strong>
            <span className="chip">{sections.length}</span>
          </summary>
          <div className="coding-said">
            {sections.map((section) => (
              <div key={section.label}>
                <div className="section-label">{section.label}</div>
                {section.rows.length === 1 ? (
                  <p>{section.rows[0]}</p>
                ) : (
                  <ul>
                    {section.rows.map((row, i) => (
                      <li key={i}>{row}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      <details className="rail-details">
        <summary>
          <strong>Raw JSON</strong>
        </summary>
        <div className="coding-detail-rows mono">
          <div>{run.raw}</div>
        </div>
      </details>
    </>
  );
}

function Detail({ title, rows, mono = false }: { title: string; rows: string[]; mono?: boolean }) {
  return (
    <details className="rail-details" open={title === "Todos" || title === "Files"}>
      <summary>
        <strong>{title}</strong>
        <span className="chip">{rows.length}</span>
      </summary>
      {rows.length ? (
        <div className={mono ? "coding-detail-rows mono" : "coding-detail-rows"}>
          {rows.map((row, i) => (
            <div key={`${title}-${i}`}>{row}</div>
          ))}
        </div>
      ) : (
        <p className="hint">Nothing reported yet.</p>
      )}
    </details>
  );
}

function History({
  runs,
  activeId,
  onPick,
}: {
  runs: CodingRun[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <details className="rail-details" open>
      <summary>
        <strong>History</strong>
        <span className="chip">{runs.length}</span>
      </summary>
      {runs.length ? (
        <div className="coding-history-list">
          {runs.map((run) => (
            <button
              key={run.id}
              className="coding-history-item"
              data-on={run.id === activeId}
              onClick={() => onPick(run.id)}
            >
              <span>
                {new Date(run.createdAt).toLocaleString()}
                {run.stoppedReason ? " · unfinished" : ""}
              </span>
              <strong>{run.task}</strong>
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">No coding history yet.</p>
      )}
    </details>
  );
}
