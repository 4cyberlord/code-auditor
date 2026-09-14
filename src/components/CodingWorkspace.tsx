"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "./Markdown";
import Splitter from "./Splitter";
import {
  CodingRunCancelled,
  buildCodingPlanContext,
  cancelCodingRun,
  cleanCodingError,
  codingRunMarkdown,
  createRunControl,
  humanizeList,
  humanizeSolution,
  humanizeValue,
  isActionablePlan,
  isResumable,
  loadCodingRuns,
  missingContext,
  runMode,
  stopReasonLabel,
  todoProgress,
  runCodingIntelligence,
  mergeTodoStringRows,
  runCodingPlan,
  saveCodingRuns,
  saveRunDocument,
  saveRunReportToServer,
  stripToolTags,
  titleForRun,
  type CodingActivity,
  type CodingAgentConfig,
  type CodingProgress,
  type CodingRun,
  type CodingRunControl,
  type CodingToolEvent,
} from "@/lib/codingIntelligence";
import { ALL_AGENTS, agentSpec } from "@/lib/models";
import { endpointForCouncilModel } from "@/lib/council";
import { routeFor, useStore, type Route } from "@/lib/store";

/** Hard ceiling on self-resumes for one Build, so it can never loop forever. */
const MAX_AUTO_CONTINUE = 8;

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

interface CodingModelChoice {
  key: string;
  id: string;
  label: string;
  route: Route | null;
  available: boolean;
  reason: string;
}

function supportsCodingTools(route: Route | null): boolean {
  return !!route && ["openai", "moonshot", "tokenrouter"].includes(route.provider);
}

export default function CodingWorkspace() {
  const [task, setTask] = useState("");
  const [runs, setRuns] = useState<CodingRun[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMode, setBusyMode] = useState<"planning" | "executing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [liveEvents, setLiveEvents] = useState<CodingToolEvent[]>([]);
  const [progress, setProgress] = useState<CodingProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [liveActivity, setLiveActivity] = useState<CodingActivity[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  const [docPath, setDocPath] = useState<string | null>(null);
  const controlRef = useRef<CodingRunControl | null>(null);
  const settings = useStore((s) => s.settings);
  const keys = useStore((s) => s.keys);
  const gatewayKey = useStore((s) => s.gatewayKey);

  const modelChoices = useMemo<CodingModelChoice[]>(
    () =>
      ALL_AGENTS.filter((id) => settings.enabled[id]).map((id) => {
        const spec = agentSpec(id);
        const route = routeFor(id, settings, keys, gatewayKey);
        const endpoint = route ? endpointForCouncilModel(settings.councilModels, route.model) : "chat";
        const unsupportedEndpoint = endpoint !== "chat";
        const unsupportedProvider = !supportsCodingTools(route);
        const available = !!route && !unsupportedEndpoint && !unsupportedProvider;
        const reason = !route
          ? "Setup needed"
          : unsupportedEndpoint || unsupportedProvider
            ? "Unavailable"
            : "Ready";
        return {
          key: `${route?.provider ?? "missing"}-${id}`,
          id: route?.model ?? id,
          label: `${spec.label} · ${route?.model ?? "not configured"}`,
          route,
          available,
          reason,
        };
      }),
    [gatewayKey, keys, settings]
  );

  const selectedChoice =
    modelChoices.find((choice) => choice.available && choice.id === settings.codingModel) ??
    modelChoices.find((choice) => choice.available) ??
    null;

  const config: CodingAgentConfig | null = selectedChoice?.route
    ? {
        provider: selectedChoice.route.provider,
        model: selectedChoice.route.model,
        baseUrl: selectedChoice.route.baseUrl,
        maxTokens: settings.codingMaxTokens,
        temperature: settings.codingTemperature,
        projectRoot: settings.codingProjectRoot,
        reasoning: settings.codingReasoning,
      }
    : null;

  // Auto-continue to completion: a Build run resumes itself while it keeps
  // completing todos, so a full README finishes end to end without manual
  // clicks. Bounded and progress-gated so it can never loop forever.
  const autoContinueRef = useRef(0);
  const prevDoneRef = useRef(0);

  // Live token stream from the bridge (ChatGPT-style typing). Purely a display
  // channel: it fills in while a turn runs and is cleared when the turn's real
  // result lands. If it never connects, nothing shows and the run is unaffected.
  const [live, setLive] = useState<{ thinking: string; answer: string; status: string }>({
    thinking: "",
    answer: "",
    status: "",
  });
  const streamRef = useRef<EventSource | null>(null);

  const closeStream = () => {
    try {
      streamRef.current?.close();
    } catch {}
    streamRef.current = null;
  };

  const openStream = (runId: string) => {
    closeStream();
    setLive({ thinking: "", answer: "", status: "" });
    void runId;
  };

  // The task of the run currently in flight. Until it is saved there is no
  // CodingRun to read it from, and the chat thread still needs its first
  // bubble.
  const [busyTask, setBusyTask] = useState("");

  // New Conversation sets this: without it the `?? runs[0]` fallback below
  // resurrects the latest run and the view never actually clears.
  const [cleared, setCleared] = useState(true);

  // The center pane shows results only after the user opens them from the
  // conversation — a fresh plan does not jump into the Implementation section
  // uninvited.
  const [resultsOpen, setResultsOpen] = useState(false);

  // New Conversation asks for a name first; it lands on the next saved run.
  const [namingOpen, setNamingOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [pendingTitle, setPendingTitle] = useState("");

  // A pending `question` tool call: the run loop is blocked awaiting this
  // resolver, so the composer becomes the answer box while one is set.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const questionResolverRef = useRef<((answer: string) => void) | null>(null);
  const [openDetail, setOpenDetail] = useState<string | null>("Todos");

  const settleQuestion = (answer: string) => {
    const resolver = questionResolverRef.current;
    questionResolverRef.current = null;
    setPendingQuestion(null);
    resolver?.(answer);
  };

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
      setActiveId(null);
      setCleared(true);
    });
    return () => {
      closeStream();
    };
  }, []);

  const active = cleared || !activeId
    ? null
    : (runs.find((r) => r.id === activeId) ?? null);
  const markdown = useMemo(() => codingRunMarkdown(active), [active]);
  // The chat thread already shows the task as the user's own bubble, so the
  // card markdown leaves it out; Copy keeps the full document with the task.
  const chatMarkdown = useMemo(
    () => codingRunMarkdown(active, { includeTask: false }),
    [active]
  );
  const chatTask = busy ? busyTask : (active?.task ?? "");
  const parsed = active?.parsed ?? null;
  const actionable = useMemo(() => isActionablePlan(parsed), [parsed]);

  // When an execution run's own report is thin, the plan it was built on is the
  // real structured report (what the app writes to IMPLEMENTATION_PLAN.md). Find
  // it so the card and the Build-details rail still show Goal / Todos / Files.
  const planRun = useMemo(() => {
    if (!active) return null;
    if (isActionablePlan(active.parsed)) return active;
    const sameTask = (r: CodingRun) => r.task.trim() === active.task.trim();
    return (
      runs.find((r) => r.id === active.continuedFrom && isActionablePlan(r.parsed)) ??
      runs.find(
        (r) => r.id !== active.id && runMode(r) === "plan" && isActionablePlan(r.parsed) && sameTask(r)
      ) ??
      runs.find((r) => r.id !== active.id && isActionablePlan(r.parsed) && sameTask(r)) ??
      null
    );
  }, [active, runs]);
  // The parsed report the rail reads from: the run's own if it has one, else the
  // linked plan's.
  const railParsed = isActionablePlan(parsed) ? parsed : (planRun?.parsed ?? parsed);
  // The card shows the run's own report, or the linked plan's when it has none.
  const cardMarkdown = useMemo(() => {
    if (chatMarkdown.trim()) return chatMarkdown;
    if (planRun && planRun !== active) return codingRunMarkdown(planRun, { includeTask: false });
    return "";
  }, [chatMarkdown, planRun, active]);
  const resumable = isResumable(active);
  const executionEvents = useMemo(
    () => (busyMode === "executing" && liveEvents.length ? liveEvents : active?.events ?? []),
    [busyMode, liveEvents, active]
  );
  // The plan's target files, tagged done/working/next/pending from the live
  // (or saved) execution log — the traffic-light rail.
  const fileRows = useMemo(
    () => computeFileRows(railParsed?.affected_files ?? [], executionEvents, busy || resumable),
    [railParsed, executionEvents, busy, resumable]
  );
  // Every todo the run has had, merged across all todowrite calls so DONE items
  // stay on the list even after a later call drops them. Falls back to the
  // plan's approach steps when the model never sent a todo list.
  const todoRows = useMemo(() => {
    const merged = mergeTodoStringRows(executionEvents, railParsed);
    if (merged.length) return merged;
    return (railParsed?.implementation_approach ?? []).map(
      (step, index) => `pending - ${step.title ?? `Step ${step.step ?? index + 1}`}: ${step.description ?? ""}`
    );
  }, [executionEvents, railParsed]);

  // The conversation's moving parts: the live run while one is in flight, the
  // selected run otherwise.
  const chatEntries = busy ? liveActivity : (active?.activity ?? []);
  const chatEvents = busy ? liveEvents : (active?.events ?? []);
  const resultsPending = !busy && !!active && !resultsOpen;

  // Execution detail (reasoning and tool calls) belongs under Execute Plan;
  // the conversation keeps the messages, the model's answers, and questions.
  // During planning there is no execution, so the plan's own thinking stays in
  // the conversation where it belongs.
  const executeContext = busy
    ? busyMode === "executing"
    : !!active && runMode(active) === "execute";
  const chatThreadEntries = executeContext
    ? chatEntries.filter((entry) => entry.kind !== "thinking" && entry.kind !== "tool")
    : chatEntries;
  const processEntries = executeContext
    ? chatEntries.filter((entry) => entry.kind === "thinking" || entry.kind === "tool")
    : [];

  const saveRun = async (run: CodingRun, previous?: CodingRun | null) => {
    // A name given at New Conversation lands on the first run saved after it.
    const titled = pendingTitle.trim() ? { ...run, title: pendingTitle.trim() } : run;
    if (pendingTitle.trim()) setPendingTitle("");
    const next = [titled, ...runs.filter((item) => item.id !== titled.id)].slice(0, 30);
    setRuns(next);
    await saveCodingRuns(next);
    setActiveId(titled.id);
    setCleared(false);

    // The document is the deliverable: one file in the project stating the
    // task, the plan and what was done. Written for every run that produced
    // something, so the execution phase can read it back and anything outside
    // this app can pick it up without going through the UI.
    const worthSaving = isActionablePlan(titled.parsed) || titled.events.length > 0;
    if (!worthSaving) return;

    // Persist the structured report to the server (Supabase) as its own record,
    // independent of the local project file — this is the durable, retrievable
    // copy of the plan/README.
    void saveRunReportToServer(titled, previous);

    if (!config) {
      setError("Run finished, but no Coding model route is selected for saving the plan document.");
      return;
    }
    const result = await saveRunDocument(titled, config, previous);
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
    // A new run must not inherit a question its predecessor was waiting on.
    settleQuestion("");
    // Subscribe to the live token stream for this run.
    openStream(control.runId);
    return control;
  };

  const endRun = () => {
    controlRef.current = null;
    closeStream();
    setLive({ thinking: "", answer: "", status: "" });
    setBusy(false);
    setBusyMode(null);
    setStopping(false);
    setProgress(null);
    // If the run ended while a question was outstanding, unblock the loop
    // rather than leaving its promise dangling.
    settleQuestion("");
  };

  // A stop the user asked for is an outcome, not a failure, so it is reported
  // as a plain note rather than an error.
  const finishWith = (err: unknown) => {
    if (err instanceof CodingRunCancelled) {
      setError("Run stopped.");
      return;
    }
    setError(cleanCodingError(err));
  };

  const stopRun = async () => {
    const control = controlRef.current;
    // Guard on an in-flight cancel, not on the flag: a failed bridge call is
    // exactly the case where the button must stay usable for a retry.
    if (!control || stopping) return;
    setStopping(true);
    setProgress({ phase: "stopping", turn: 0, detail: "Stopping the model" });
    try {
      if (config) await cancelCodingRun(config, control);
      else control.cancelled = true;
    } catch (err) {
      // The local flag is already set, so the loop ends regardless; the user
      // only needs to know the bridge did not confirm it — and to be able to
      // press Stop again.
      setError(`Stop requested, but the bridge did not confirm: ${cleanCodingError(err)}`);
      setStopping(false);
    }
    // A run blocked on a question would otherwise sit waiting for an answer
    // that is no longer coming.
    settleQuestion("");
  };

  // A changed message over an existing plan is a revision request, not a new
  // topic: the model revises its previous plan with the feedback folded in.
  const refinementPrompt = (feedback: string, previous: CodingRun): string =>
    buildCodingPlanContext(
      `${previous.task}\n\nREVISION REQUEST\n\nThe previous plan was reviewed and needs these changes:\n${feedback}\n\nPREVIOUS PLAN TO REVISE\n\n${codingRunMarkdown(previous, { includeTask: false }) || previous.raw}`
    );

  const preparePlan = async (text?: string) => {
    const clean = (text ?? task).trim();
    if (!clean) return;
    if (!config) {
      setError("Choose a reachable TokenRouter, OpenAI, or Moonshot chat model before researching.");
      return;
    }
    const refineOf =
      active && runMode(active) === "plan" && clean !== (active.task || "").trim()
        ? active
        : null;
    const control = beginRun("planning");
    setBusyTask(refineOf ? refineOf.task : clean);
    setResultsOpen(false);
    if (refineOf) {
      // The follow-up belongs in the chat immediately, not only after the run.
      setLiveActivity([
        {
          id: `instruction-live-${Date.now()}`,
          kind: "instruction",
          turn: 1,
          text: clean,
          createdAt: Date.now(),
        },
      ]);
    }
    try {
      const run = await runCodingPlan(refineOf ? refineOf.task : clean, config, {
        control,
        onProgress: setProgress,
        ...(refineOf ? { promptOverride: refinementPrompt(clean, refineOf) } : {}),
      });
      const seeded = refineOf
        ? {
            ...run,
            activity: [
              {
                id: `instruction-1-${Date.now()}`,
                kind: "instruction" as const,
                turn: 1,
                text: clean,
                createdAt: Date.now(),
              },
              ...(run.activity ?? []),
            ],
          }
        : run;
      await saveRun(seeded);
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
    if (!config) {
      setError("Choose a reachable TokenRouter, OpenAI, or Moonshot chat model before building.");
      return;
    }
    const planBase = resume
      ? (runs.find((r) => r.id === resume.continuedFrom) ?? resume)
      : base;
    const control = beginRun("executing");
    setBusyTask(clean);
    setResultsOpen(true);
    try {
      const run = await runCodingIntelligence(clean, config, {
        control,
        planRun: planBase,
        onProgress: setProgress,
        onEvent: trackEvent,
        onActivity: (entry) => setLiveActivity((current) => [...current, entry]),
        onQuestion: (question) =>
          new Promise<string>((resolve) => {
            questionResolverRef.current = resolve;
            setPendingQuestion(question);
          }),
        takePending,
        ...(resume ? { resumeOf: resume.id, resumeFrom: resume } : {}),
      });
      await saveRun(run, resume);

      // Auto-continue while it keeps finishing todos and more remain — so the
      // whole README gets built to the end. Only continues on real progress
      // (the done count went up) and within a hard bound, so a stuck model
      // stops and hands back rather than looping. A hand stop ends it too.
      const doneNow = todoProgress(run).done;
      if (
        !run.stoppedReason &&
        isResumable(run) &&
        doneNow > prevDoneRef.current &&
        autoContinueRef.current < MAX_AUTO_CONTINUE
      ) {
        prevDoneRef.current = doneNow;
        autoContinueRef.current += 1;
        await execute(run); // the inner call owns endRun/stream from here
        return;
      }
    } catch (err) {
      finishWith(err);
    } finally {
      endRun();
    }
  };

  const executePlan = () => {
    autoContinueRef.current = 0;
    prevDoneRef.current = active ? todoProgress(active).done : 0;
    return execute(null);
  };

  // Continuing a plan and continuing an execution are different jobs: a
  // truncated plan has nothing to resume from, so it is simply re-planned.
  const continueRun = async () => {
    if (!active) return;
    if (!config) {
      setError("Choose a reachable TokenRouter, OpenAI, or Moonshot chat model before continuing.");
      return;
    }
    if (runMode(active) === "plan") {
      const clean = (active.task || task).trim();
      if (!clean) return;
      const control = beginRun("planning");
      setBusyTask(clean);
      setResultsOpen(false);
      try {
        await saveRun(await runCodingPlan(clean, config, { control, onProgress: setProgress }));
      } catch (err) {
        finishWith(err);
      } finally {
        endRun();
      }
      return;
    }
    autoContinueRef.current = 0;
    prevDoneRef.current = todoProgress(active).done;
    await execute(active);
  };

  const newConversation = () => {
    queueRef.current = [];
    setTask("");
    setActiveId(null);
    setCleared(true);
    setResultsOpen(false);
    setError(null);
    setCopied(false);
    setLiveEvents([]);
    setLiveActivity([]);
    setProgress(null);
    setElapsed(0);
    setQueued([]);
    setDocPath(null);
    setBusyTask("");
    settleQuestion("");
  };

  /**
   * One composer, three meanings.
   *
   * While the agent is waiting on a `question` call, a message answers it and
   * the run continues immediately. Idle, a message starts the analysis.
   * Mid-run it joins a queue the agent drains at its next turn boundary — so
   * a correction spotted at step 3 is acted on at step 4, instead of waiting
   * for a run that is now going the wrong way to finish.
   */
  // During a Build (execution) the composer is locked — no new instructions can
  // be submitted until it finishes or is paused — except to answer a question
  // the agent itself asked.
  const composerLocked = busyMode === "executing" && pendingQuestion === null;

  const submitMessage = () => {
    const clean = task.trim();
    if (!clean) return;
    if (questionResolverRef.current) {
      setTask("");
      settleQuestion(clean);
      return;
    }
    if (composerLocked) return;
    if (busy) {
      queueRef.current = [...queueRef.current, clean];
      setQueued(queueRef.current);
      setTask("");
      return;
    }
    // The box empties once the message is sent — it lives in the chat now.
    setTask("");
    void preparePlan(clean);
  };

  const dropQueued = (index: number) => {
    queueRef.current = queueRef.current.filter((_, i) => i !== index);
    setQueued(queueRef.current);
  };

  // Opening a run from History switches the view to it. The task is already
  // shown as the user's own chat bubble, so the composer is left empty rather
  // than pre-filled with a copy of it — otherwise the same text appears twice.
  const pickRun = (id: string) => {
    setActiveId(id);
    setCleared(false);
    setResultsOpen(true);
    if (busy) return;
    const run = runs.find((item) => item.id === id);
    if (!run) return;
    setTask("");
    setError(null);
    setCopied(false);
  };

  const confirmNew = (name: string) => {
    setPendingTitle(name.trim());
    setNamingOpen(false);
    newConversation();
  };

  // Discard the selected plan: it leaves History and the view resets, so a
  // rejected approach does not get executed by accident later.
  const discardRun = () => {
    if (!active) return;
    const next = runs.filter((r) => r.id !== active.id);
    setRuns(next);
    void saveCodingRuns(next);
    newConversation();
  };

  const renameRun = async (id: string, title: string) => {
    const clean = title.trim();
    const next = runs.map((run) => {
      if (run.id !== id) return run;
      const updated = { ...run };
      if (clean) updated.title = clean;
      else delete updated.title;
      return updated;
    });
    setRuns(next);
    await saveCodingRuns(next);
  };

  const copyPlan = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(markdown || active.raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      setError(`Could not copy plan: ${cleanCodingError(err)}`);
    }
  };

  const selectedStatus = selectedChoice?.available ? "Ready" : "Setup needed";
  const canResearch = !!config && !!task.trim() && !composerLocked;
  const projectName =
    settings.codingProjectName ||
    settings.codingProjectRoot.split(/[\\/]/).filter(Boolean).at(-1) ||
    "No project selected";
  const freshComposer =
    !busy &&
    !chatTask &&
    chatThreadEntries.length === 0 &&
    pendingQuestion === null &&
    queued.length === 0 &&
    !error;

  return (
    <div className="coding-workspace">
      <section className="coding-task">
        <div className="pane-head">
          <span className="dot" style={{ background: "var(--accent)" }} />
          <div>
            <div className="pane-title">
              {busy && busyTask
                ? busyTask.split("\n")[0].slice(0, 60)
                : active
                  ? titleForRun(active)
                  : "Conversation"}
            </div>
            <div className="pane-model">{config?.model ?? "choose a model"}</div>
          </div>
          <span className="spacer" />
          <span className="badge" data-tone={busy ? "live" : selectedChoice?.available ? "good" : "warn"}>
            {busyMode ?? selectedStatus}
          </span>
          <button
            className="btn tiny"
            onClick={() => {
              setNameDraft("");
              setNamingOpen(true);
            }}
            disabled={busy}
          >
            New Conversation
          </button>
        </div>

        <div className="coding-task-body" data-fresh={freshComposer}>
          {/* The conversation: the request on the right, the model's thinking
              and answers on the left, as it happens. Results stay out of here
              — they open in the Implementation plan section when asked for. */}
          {(chatTask || chatThreadEntries.length > 0 || busy) && (
            <div className="chat-thread coding-chat">
              {chatTask && (
                <div className="chat-row user">
                  <div className="chat-bubble user">
                    <span className="chat-meta">You</span>
                    {chatTask}
                  </div>
                </div>
              )}

              {/* The run's pulse belongs to the message it's answering. */}
              {busy && (
                <RunStatus
                  mode={busyMode}
                  progress={progress}
                  elapsed={elapsed}
                  stopping={stopping}
                  waiting={pendingQuestion !== null}
                />
              )}

              <ChatTimeline entries={chatThreadEntries} events={chatEvents} live={busy} />

              {!busy && active && runMode(active) === "execute" && !active.stoppedReason && (
                <CompletionBanner run={active} />
              )}

              {/* While planning, the model's live output belongs in the
                  conversation. While executing, it belongs under Execute Plan
                  with the file work — see the ProcessTimeline section. */}
              {busy && busyMode !== "executing" && (live.thinking || live.answer) && (
                <StreamingBubble
                  thinking={live.thinking}
                  answer={live.answer}
                  status={live.status}
                />
              )}

              {busy && busyMode !== "executing" && !chatThreadEntries.length && !live.thinking && !live.answer && (
                <TypingBubble label="Thinking" />
              )}

              {resultsPending && active && (
                <div className="chat-row">
                  <div className="chat-card">
                    <strong>Results ready</strong>
                    <p className="hint">
                      {runMode(active) === "plan"
                        ? "The implementation plan is ready. Open it to review, approve or discard it — or send a follow-up here to revise it."
                        : "The run report is ready to review."}
                    </p>
                    <div className="chat-card-actions">
                      <button className="btn primary tiny" onClick={() => setResultsOpen(true)}>
                        View results
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {pendingQuestion !== null && (
            <div className="coding-resume">
              <strong>The agent is asking</strong>
              <p>{pendingQuestion}</p>
            </div>
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

          <div className="coding-composer">
            <textarea
              className="coding-composer-input"
              placeholder={
                composerLocked
                  ? "Building..."
                  : pendingQuestion !== null
                    ? "Answer the agent"
                    : busy
                      ? "Ask for follow-up changes"
                      : "Ask for code changes"
              }
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submitMessage();
                }
              }}
              // Locked during a Build so the implementation runs undisturbed to the
              // end; open while planning (the queue) and to answer a question.
              disabled={composerLocked}
              // Task descriptions are mostly paths, identifiers and code fragments,
              // so macOS flags nearly every word; spellcheck off stops the
              // NSSpellServer console spam.
              spellCheck={false}
              autoCapitalize="off"
            />
            <div className="coding-composer-bar">
              <button className="composer-icon" type="button" disabled title="Attach context">
                +
              </button>
              <span className="composer-access">Full access</span>
              <span className="spacer" />
              <span className="composer-model" title={config?.model ?? "Choose a model in Settings"}>
                {config?.model ?? "No model"}
              </span>
              {busy && pendingQuestion === null && task.trim() && !composerLocked && (
                <button
                  className="composer-submit"
                  type="button"
                  onClick={submitMessage}
                  disabled={pendingQuestion === null ? !canResearch : false}
                >
                  Queue
                </button>
              )}
              <button
                className={busy ? "composer-stop" : "composer-submit"}
                type="button"
                onClick={busy ? () => void stopRun() : submitMessage}
                disabled={busy ? stopping : pendingQuestion === null ? !canResearch : false}
                title={busy ? "Stop current run" : "Send instruction"}
              >
                {busy
                  ? stopping
                    ? "..."
                    : "Stop"
                  : pendingQuestion !== null
                    ? "Answer"
                    : "Research"}
              </button>
            </div>
          </div>

          <div className="coding-local-row">
            <span className="local-icon" aria-hidden="true" />
            <span>Work locally</span>
            <strong>{projectName}</strong>
          </div>

          {error && <div className="pane-error wrap">{error}</div>}
          {!busy && (
            <div className="coding-actions compact">
              {resumable ? (
                <button className="btn" onClick={() => void continueRun()}>
                  Continue
                </button>
              ) : (
                <button className="btn ghost" onClick={() => setTask("")} disabled={!task}>
                  Clear
                </button>
              )}
            </div>
          )}

          {resumable && !busy && active && (
            <div className="coding-resume">
              <strong>Run unfinished</strong>
              <p>
                {stopReasonLabel(active.stoppedReason) ||
                  (() => {
                    const { done, total } = todoProgress(active);
                    return total
                      ? `This run reported back with ${done} of ${total} todos done.`
                      : "This run has work left to do.";
                  })()}{" "}
                {runMode(active) === "plan"
                  ? "Continue runs the analysis again."
                  : "Continue reads what it already did, then picks up from the first unfinished todo — no starting over."}
              </p>
            </div>
          )}

          {docPath && (
            <>
              <div className="section-label">Plan Document</div>
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
                  ? `${busyMode === "planning" ? "researching" : "building"} · ${clock(elapsed)}`
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
              {resultsOpen && active ? (
                <div className="chat-card">
                  {runMode(active) === "plan" && !actionable ? (
                    <NeedsDetail run={active} />
                  ) : cardMarkdown.trim() ? (
                    <Markdown text={cardMarkdown} />
                  ) : (
                    <RunReconstruction run={active} />
                  )}
                  {runMode(active) === "plan" && actionable && (
                    <div className="chat-card-actions">
                      {busy ? (
                        /* Approved and running: the approval becomes the off switch. */
                        <button
                          className="btn danger tiny"
                          onClick={() => void stopRun()}
                          disabled={stopping}
                        >
                          {busyMode === "executing"
                            ? stopping
                              ? "Pausing…"
                              : "Pause Build"
                            : stopping
                              ? "Stopping…"
                              : "Cancel Run"}
                        </button>
                      ) : !resumable ? (
                        <>
                          <button className="btn primary tiny" onClick={() => void executePlan()}>
                            Approve plan — run it
                          </button>
                          <button className="btn danger tiny" onClick={discardRun}>
                            Discard
                          </button>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty">
                  {busy
                    ? "The model is working — watch the conversation on the left."
                    : active
                      ? "Results are ready — open them from the conversation on the left."
                      : "The plan and its results appear here once the model has answered."}
                </div>
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
                      {busyMode === "executing"
                        ? stopping
                          ? "Pausing…"
                          : "Pause"
                        : stopping
                          ? "Stopping..."
                          : "Stop"}
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
                      Build Plan
                    </button>
                  )}
                </div>
                {/* The model's live output during execution — its reasoning
                    about what to edit — belongs here with the file work, not in
                    the conversation. */}
                {busy && busyMode === "executing" && (live.thinking || live.answer) && (
                  <StreamingBubble
                    thinking={live.thinking}
                    answer={live.answer}
                    status={live.status}
                  />
                )}
                {busy && busyMode === "executing" && !live.thinking && !live.answer && !processEntries.length && (
                  <TypingBubble label="Working through the plan" />
                )}
                {processEntries.length ? (
                  <ProcessTimeline
                    entries={processEntries}
                    events={executionEvents}
                    live={busy && busyMode === "executing"}
                  />
                ) : !busy ? (
                  <div className="empty compact">
                    The agent&rsquo;s steps appear here while it works — what it reasoned, what it
                    read, and every change it makes, as code you can open up.
                  </div>
                ) : null}
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
            <Detail
              title="Goal"
              openKey={openDetail}
              onOpenKey={setOpenDetail}
              rows={
                railParsed?.understanding?.goal
                  ? [humanizeValue(railParsed.understanding.goal)]
                  : []
              }
            />
            <Detail title="Todos" rows={todoRows} openKey={openDetail} onOpenKey={setOpenDetail} />
            <FileStatus rows={fileRows} openKey={openDetail} onOpenKey={setOpenDetail} />
            <Detail title="Commands" rows={items(railParsed?.commands)} mono openKey={openDetail} onOpenKey={setOpenDetail} />
            <Detail title="Tests" rows={items(railParsed?.tests)} openKey={openDetail} onOpenKey={setOpenDetail} />
            <Detail title="Security" rows={items(railParsed?.security_considerations)} openKey={openDetail} onOpenKey={setOpenDetail} />
            <Detail title="Memory" rows={railParsed?.architecture_memory ?? []} openKey={openDetail} onOpenKey={setOpenDetail} />
            <Detail title="More Context" rows={missingContext(railParsed)} openKey={openDetail} onOpenKey={setOpenDetail} />
            <History
              runs={runs}
              activeId={active?.id ?? null}
              onPick={pickRun}
              onRename={(id, title) => void renameRun(id, title)}
              openKey={openDetail}
              onOpenKey={setOpenDetail}
            />
          </div>
        </div>
      </section>

      {namingOpen && (
        <div
          className="scrim"
          onMouseDown={(e) => e.target === e.currentTarget && setNamingOpen(false)}
        >
          <div className="modal compact" role="dialog" aria-modal="true" aria-label="New Conversation">
            <header>
              <h2>New Conversation</h2>
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setNamingOpen(false)}>
                Cancel
              </button>
            </header>
            <div className="content">
              <p className="hint">
                Name it so you can find it in History later — skip it and the conversation takes its
                name from the task.
              </p>
              <input
                className="coding-rename-input"
                placeholder="e.g. Stealth dock refactor"
                value={nameDraft}
                autoFocus
                spellCheck={false}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    confirmNew(nameDraft);
                  }
                  if (e.key === "Escape") setNamingOpen(false);
                }}
              />
            </div>
            <footer>
              <button className="btn primary" onClick={() => confirmNew(nameDraft)}>
                Start conversation
              </button>
              <button className="btn ghost" onClick={() => confirmNew("")}>
                Skip naming
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The run as a conversation: your messages on the right, the model's answers
 * and questions on the left, its thinking folded into expandable rows, and
 * tool calls as compact log lines. Reasoning lands per turn rather than per
 * token because the bridge is not streamed — the thread fills in step by
 * step, which is exactly how the agent actually worked through the task.
 */
function ChatTimeline({
  entries,
  events,
  live = false,
}: {
  entries: CodingActivity[];
  events: CodingToolEvent[];
  live?: boolean;
}) {
  const byEvent = useMemo(
    () => new Map(events.map((event) => [event.id, event])),
    [events]
  );
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length, live]);

  return (
    <>
      {entries.map((entry) => {
        const event = entry.eventId ? byEvent.get(entry.eventId) : undefined;

        if (entry.kind === "instruction") {
          return (
            <div key={entry.id} className="chat-row user">
              <div className="chat-bubble user">
                <span className="chat-meta">You added</span>
                {entry.text}
              </div>
            </div>
          );
        }

        if (entry.kind === "question") {
          const answer =
            event && event.status === "ok"
              ? event.result.replace(/^User answer:\s*/i, "")
              : "";
          return (
            <div key={entry.id} className="chat-qa">
              <div className="chat-row">
                <div className="chat-bubble assistant">
                  <span className="chat-meta">Question from the agent</span>
                  {entry.text}
                </div>
              </div>
              {answer && (
                <div className="chat-row user">
                  <div className="chat-bubble user">
                    <span className="chat-meta">Your answer</span>
                    {answer}
                  </div>
                </div>
              )}
            </div>
          );
        }

        if (entry.kind === "thinking") {
          return (
            <details key={entry.id} className="chat-think" {...(live ? { open: true } : {})}>
              <summary>Thinking · step {entry.turn}</summary>
              <div className="chat-think-body">{entry.text}</div>
            </details>
          );
        }

        if (entry.kind === "tool") {
          return (
            <details key={entry.id} className="chat-tool" data-status={event?.status ?? "ok"}>
              <summary>
                <code>{entry.text}</code>
                <span className="spacer" />
                <span className="chat-tool-status">
                  {event ? (event.status === "running" ? "running…" : event.status) : "done"}
                </span>
              </summary>
              {event && event.result ? <pre>{event.result}</pre> : null}
            </details>
          );
        }

        // Provider metadata is not part of the conversation.
        if (entry.kind === "meta") {
          return null;
        }

        return (
          <div key={entry.id} className="chat-row">
            <div className="chat-bubble assistant">
              <span className="chat-meta">Assistant</span>
              {entry.text}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </>
  );
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** Tools that change the project — their payload is the change itself. */
const MUTATION_TOOL_NAMES = new Set([
  "edit",
  "replace_in_file",
  "apply_patch",
  "apply_diff",
  "patch",
  "write",
  "write_to_file",
  "create_file",
  "delete_file",
  "rename_file",
  "move_file",
  "copy_file",
  "create_folder",
  "create_directory",
  "delete_folder",
  "delete_directory",
  "rename_folder",
  "move_folder",
  "copy_folder",
]);

/** The lifecycle of a file the plan says it will touch. */
type FileState = "done" | "active" | "next" | "pending";

interface FileRow {
  path: string;
  reason: string;
  state: FileState;
}

const FILE_STATE_META: Record<FileState, { icon: string; label: string }> = {
  done: { icon: "✓", label: "done" },
  active: { icon: "◐", label: "working" },
  next: { icon: "→", label: "next" },
  pending: { icon: "○", label: "pending" },
};

/** Which path a tool call acted on, across the arg-name variants models use. */
function eventTouchedPath(event: CodingToolEvent): string {
  const v =
    event.args?.path ??
    event.args?.filePath ??
    event.args?.file_path ??
    event.args?.source ??
    event.args?.destination ??
    "";
  return typeof v === "string" ? v.trim() : "";
}

/** Suffix-tolerant match, so "src/a.ts" lines up with "./src/a.ts". */
function pathsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = a.replace(/^\.\//, "").replace(/^\/+/, "");
  const nb = b.replace(/^\.\//, "").replace(/^\/+/, "");
  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

/**
 * The plan's target files, each tagged with where it stands: a file a mutation
 * tool successfully touched is done (green), one being written right now is
 * working (yellow), the next one queued is next (yellow arrow), the rest are
 * pending (gray) — the traffic-light rail the user asked for.
 */
function computeFileRows(
  files: Array<{ path?: string; reason?: string; action?: string }>,
  events: CodingToolEvent[],
  running: boolean
): FileRow[] {
  const rows: FileRow[] = files
    .map((f) => ({
      path: (f.path ?? "").trim(),
      reason: (f.reason ?? f.action ?? "").trim(),
      state: "pending" as FileState,
    }))
    .filter((f) => f.path && f.path.toLowerCase() !== "unknown")
    .map((f) => {
      for (const ev of events) {
        if (!MUTATION_TOOL_NAMES.has(ev.tool.trim().toLowerCase())) continue;
        if (!pathsMatch(f.path, eventTouchedPath(ev))) continue;
        if (ev.status === "ok") return { ...f, state: "done" };
        if (ev.status === "running") f.state = "active";
      }
      return f;
    });

  // With work in flight and nothing mid-write, the first pending file is next.
  if (running && !rows.some((r) => r.state === "active")) {
    const next = rows.find((r) => r.state === "pending");
    if (next) next.state = "next";
  }
  return rows;
}

/* Long payloads (a whole file read, a big write) are clipped in the card; the
   full text is in the saved run's event log either way. */
const PROC_CODE_CAP = 6000;

function clipCode(text: string): string {
  return text.length > PROC_CODE_CAP
    ? `${text.slice(0, PROC_CODE_CAP)}\n… (${text.length - PROC_CODE_CAP} more characters)`
    : text;
}

/** A tool card's body, typed by how it should render. */
type ToolPayload =
  | { kind: "diff"; label: string; removed: string; added: string }
  | { kind: "added"; label: string; added: string }
  | { kind: "result"; label: string; code: string };

/** What a tool card shows as its body, in order of usefulness. */
function toolPayload(event: CodingToolEvent): ToolPayload | null {
  const a = event.args ?? {};
  const name = event.tool.trim().toLowerCase();
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  // Edits show a red/green before → after diff, GitHub-review style.
  if (["edit", "replace_in_file", "apply_patch", "apply_diff", "patch"].includes(name)) {
    const before = str(a.oldString ?? a.old_string);
    const after = str(a.newString ?? a.new_string ?? a.content);
    if (before || after) return { kind: "diff", label: "Change", removed: before, added: after };
  }
  // Writes/creates: the whole file is new, so every line reads as an addition.
  if (["write", "write_to_file", "create_file"].includes(name)) {
    const content = str(a.content);
    if (content) return { kind: "added", label: "Contents Written", added: content };
  }
  // Reads, searches, commands: the payload is what came back.
  if (event.result.trim()) return { kind: "result", label: "Result", code: event.result };
  return null;
}

/**
 * A GitHub-style two-tone diff: removed lines in red, added lines in green,
 * each with its own gutter sign. Both sides are clipped so a whole-file write
 * does not blow the card open.
 */
function DiffBlock({ removed, added }: { removed?: string; added?: string }) {
  const rows: Array<{ sign: "-" | "+"; text: string }> = [];
  if (removed?.trim())
    for (const line of clipCode(removed).split("\n")) rows.push({ sign: "-", text: line });
  if (added?.trim())
    for (const line of clipCode(added).split("\n")) rows.push({ sign: "+", text: line });
  if (!rows.length) return null;
  return (
    <pre className="diff-block">
      {rows.map((row, i) => (
        <div key={i} className={row.sign === "+" ? "diff-line diff-add" : "diff-line diff-del"}>
          <span className="diff-gutter">{row.sign}</span>
          <span className="diff-text">{row.text || " "}</span>
        </div>
      ))}
    </pre>
  );
}

/**
 * The execution process under Execute Plan: what the model reasoned and every
 * tool it ran, in order. Reads stay folded until opened; edits and writes sit
 * open so the change itself is visible as it lands.
 */
function ProcessTimeline({
  entries,
  events,
  live = false,
}: {
  entries: CodingActivity[];
  events: CodingToolEvent[];
  live?: boolean;
}) {
  const byEvent = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length, live]);

  return (
    <div className="proc-list">
      {entries.map((entry) => {
        if (entry.kind === "thinking") {
          return (
            <details key={entry.id} className="chat-think" {...(live ? { open: true } : {})}>
              <summary>Thinking · step {entry.turn}</summary>
              <div className="chat-think-body">{entry.text}</div>
            </details>
          );
        }
        if (entry.kind !== "tool") return null;
        const event = entry.eventId ? byEvent.get(entry.eventId) : undefined;
        if (!event) return null;
        return <ToolCard key={entry.id} event={event} />;
      })}
      <div ref={endRef} />
    </div>
  );
}

function ToolCard({ event }: { event: CodingToolEvent }) {
  const payload = toolPayload(event);
  const opens = MUTATION_TOOL_NAMES.has(event.tool.trim().toLowerCase());

  return (
    <details className="proc-tool" data-status={event.status} open={opens || undefined}>
      <summary>
        <strong>{event.tool}</strong>
        <span className="proc-target">{eventTarget(event)}</span>
        <span className="spacer" />
        <span className="chat-tool-status">
          {event.status === "running" ? "running…" : event.status}
        </span>
      </summary>
      {payload ? (
        <div className="proc-code">
          <div className="proc-code-label">{payload.label}</div>
          {payload.kind === "diff" ? (
            <DiffBlock removed={payload.removed} added={payload.added} />
          ) : payload.kind === "added" ? (
            <DiffBlock added={payload.added} />
          ) : (
            <pre>{clipCode(payload.code)}</pre>
          )}
        </div>
      ) : (
        <p className="proc-outcome">
          {event.status === "running" ? "Running…" : event.result || "(no output)"}
        </p>
      )}
    </details>
  );
}

/** Remove model-written tool blocks from the live prose stream. */
function stripLiveToolBlocks(text: string): string {
  return String(text ?? "")
    .replace(/<function\s*=[^>]*>[\s\S]*?<\/function>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_code>[\s\S]*?<\/tool_code>/gi, "")
    .replace(/<parameter\s*=[^>]*>[\s\S]*?<\/parameter>/gi, "")
    // During streaming the closing tag may not have arrived yet. Hide the
    // partial block too; the parsed tool card appears in the timeline after the
    // bridge receives the complete turn.
    .replace(/<(?:function\s*=|parameter\s*=|tool_call|tool_code)\b[\s\S]*$/gi, "");
}

/**
 * Make a live token slice readable: turn escaped "\n"/"\t" into real breaks and
 * strip machine plumbing. Tool calls are hidden from the prose stream because
 * otherwise their arguments leak as orphan text like `package.json`.
 */
function cleanStreamText(text: string): string {
  return stripToolTags(stripLiveToolBlocks(text))
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, '"')
    .replace(/^\s*\.\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** True when the streamed text is the raw JSON report envelope being written. */
function looksLikeEnvelope(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("{") && /"(status|summary|implementation_approach|todos|understanding)"/.test(t);
}

/** How a raw task-stage token reads to a person: "task_preprocess_end" → "preprocess". */
function prettyStage(status: string): string {
  const s = status.replace(/^task_/, "").replace(/_/g, " ").trim();
  if (!s) return "";
  if (s.startsWith("queue")) return "queued";
  if (s.startsWith("accept")) return "accepted";
  if (s.startsWith("start")) return "generating";
  if (s.startsWith("output")) return "generating";
  if (s.startsWith("end")) return "finishing";
  return s;
}

/**
 * The model's turn as it streams in — thinking folded above, the answer typing
 * out below with a blinking caret, ChatGPT-style. Fed by the bridge's live
 * side-channel; replaced by the real result the moment the turn lands.
 */
function StreamingBubble({
  thinking,
  answer,
  status,
}: {
  thinking: string;
  answer: string;
  status: string;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [thinking, answer]);

  const stage = prettyStage(status);
  const cleanThinking = cleanStreamText(thinking).trim();
  const rawAnswer = cleanStreamText(answer).trim();
  // Once the model starts emitting the JSON report, show a friendly note rather
  // than raw braces — the structured card renders it properly when the turn ends.
  const cleanAnswer = looksLikeEnvelope(rawAnswer) ? "Composing the structured report…" : rawAnswer;

  return (
    <div className="chat-row">
      <div className="chat-bubble assistant streaming">
        <span className="chat-meta">{stage ? `Model · ${stage}` : "Model"}</span>
        {cleanThinking && (
          <details className="chat-think inline" open>
            <summary>Thinking…</summary>
            <div className="chat-think-body">{cleanThinking}</div>
          </details>
        )}
        {cleanAnswer ? (
          <div className="streaming-text">
            {cleanAnswer}
            <span className="stream-caret" aria-hidden />
          </div>
        ) : (
          <span className="typing-dots" aria-label="working">
            <span />
            <span />
            <span />
          </span>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/** A WhatsApp/ChatGPT-style three-dot pulse while the model works between turns. */
function TypingBubble({ label }: { label: string }) {
  return (
    <div className="chat-row">
      <div className="chat-bubble assistant typing">
        <span className="chat-meta">{label}</span>
        <span className="typing-dots" aria-label="working">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

/**
 * The end-of-run verdict. Once an execution finishes with the plan carried out,
 * this states it plainly — "Implementation successful" — and lists each change
 * with a green check for what landed and a red cross for what failed, the
 * green-field/red-x summary the user asked for.
 */
function CompletionBanner({ run }: { run: CodingRun }) {
  const mutations = run.events.filter((e) =>
    MUTATION_TOOL_NAMES.has(e.tool.trim().toLowerCase())
  );
  if (!mutations.length) return null; // nothing was changed — not a success story
  const ok = mutations.filter((e) => e.status === "ok");
  const failed = mutations.filter((e) => e.status === "error");
  const mixed = failed.length > 0;
  // Verification = a successful shell/test command run after the edits. Only a
  // verified, all-green run earns "Implementation successful"; without a passing
  // test we say the changes are applied but unverified.
  const verified = run.events.some(
    (e) => e.tool.trim().toLowerCase() === "bash" && e.status === "ok"
  );
  const tone = mixed ? "mixed" : verified ? "ok" : "unverified";
  const headline = mixed
    ? "Implementation finished with issues"
    : verified
      ? "Implementation successful"
      : "Changes applied — not yet verified";

  return (
    <div className="chat-row">
      <div className="completion-banner" data-tone={tone}>
        <div className="completion-head">
          <span className="completion-badge" aria-hidden>
            {mixed ? "◑" : verified ? "✓" : "•"}
          </span>
          <strong>{headline}</strong>
          <span className="spacer" />
          <span className="completion-count">
            {ok.length} applied{mixed ? ` · ${failed.length} failed` : ""}
            {verified ? " · verified" : ""}
          </span>
        </div>
        <div className="completion-list">
          {mutations.map((e) => (
            <div key={e.id} className="completion-item" data-ok={e.status === "ok"}>
              <span className="completion-item-icon" aria-hidden>
                {e.status === "ok" ? "✓" : "✗"}
              </span>
              <span className="completion-item-tool">{e.tool}</span>
              <span className="completion-item-path">{eventTarget(e)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The plan's target files as a traffic-light rail: a green check for what has
 * been changed, a yellow marker for what is being worked on or is next, gray
 * for what is still pending. Done rows are struck through so completion reads
 * at a glance.
 */
function RailDetails({
  title,
  chip,
  openKey,
  onOpenKey,
  children,
}: {
  title: string;
  chip?: string | number;
  openKey: string | null;
  onOpenKey: (key: string | null) => void;
  children: ReactNode;
}) {
  const open = openKey === title;
  return (
    <details className="rail-details" open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          onOpenKey(open ? null : title);
        }}
      >
        <strong>{title}</strong>
        {chip != null && <span className="chip">{chip}</span>}
      </summary>
      {children}
    </details>
  );
}

function FileStatus({
  rows,
  openKey,
  onOpenKey,
}: {
  rows: FileRow[];
  openKey: string | null;
  onOpenKey: (key: string | null) => void;
}) {
  const done = rows.filter((r) => r.state === "done").length;
  return (
    <RailDetails
      title="Files"
      chip={rows.length ? `${done}/${rows.length}` : rows.length}
      openKey={openKey}
      onOpenKey={onOpenKey}
    >
      {rows.length ? (
        <div className="file-status-list">
          {rows.map((row, i) => (
            <div key={`${row.path}-${i}`} className="file-status-row" data-state={row.state}>
              <span className="file-status-icon" aria-hidden>
                {FILE_STATE_META[row.state].icon}
              </span>
              <span className="file-status-body">
                <span className="file-status-path">{row.path}</span>
                {row.reason && <span className="file-status-reason">{row.reason}</span>}
              </span>
              <span className="file-status-tag">{FILE_STATE_META[row.state].label}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">No target files yet — they appear once the plan names them.</p>
      )}
    </RailDetails>
  );
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
  waiting = false,
}: {
  mode: "planning" | "executing" | null;
  progress: CodingProgress | null;
  elapsed: number;
  stopping: boolean;
  waiting?: boolean;
}) {
  const headline = stopping
    ? "Stopping"
    : waiting
      ? "Waiting for your answer"
      : mode === "planning"
        ? "Researching the codebase"
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
          : waiting
            ? "The agent asked a question below — answer it and the run continues."
            : (progress?.detail ?? "Sending the task to the model")}
      </p>
      {!stopping && !waiting && (
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
/**
 * Shown when a run saved no readable final report (its output was tool markup
 * or an empty answer). Rather than a blank card, this reconstructs what the run
 * actually did from its own log — the todo plan (done items kept), the files it
 * targeted, what it inspected (its research), and what it changed — so the plan
 * the user remembers is still there.
 */
function RunReconstruction({ run }: { run: CodingRun }) {
  const inspected = run.events.filter(
    (e) => ["read", "glob", "grep"].includes(e.tool.trim().toLowerCase()) && e.status === "ok"
  );
  const changed = run.events.filter((e) => MUTATION_TOOL_NAMES.has(e.tool.trim().toLowerCase()));

  return (
    <section className="coding-needs-detail">
      <div className="section-label">No Structured Report</div>
      <p>
        This run didn&rsquo;t save a structured report, and no plan was found for it. Its todos and
        files are in the Build-details rail; its raw steps are below.
      </p>

      {inspected.length > 0 && (
        <>
          <div className="section-label">Inspected (Research)</div>
          <ul className="coding-needs-list">
            {inspected.map((e) => (
              <li key={e.id}>
                <code>{e.tool}</code> {eventTarget(e)}
              </li>
            ))}
          </ul>
        </>
      )}

      {changed.length > 0 && (
        <>
          <div className="section-label">Changes Applied</div>
          <ul className="coding-needs-list">
            {changed.map((e) => (
              <li key={e.id} data-ok={e.status === "ok"}>
                <code>{e.tool}</code> {eventTarget(e)} — {e.status}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="hint">Use Continue to finish the remaining todos.</p>
    </section>
  );
}

function NeedsDetail({ run }: { run: CodingRun }) {
  const parsed = run.parsed;
  const asks = missingContext(parsed);
  const summary = parsed?.summary?.trim();

  return (
    <section className="coding-needs-detail">
      <div className="section-label">No Plan Yet</div>
      <p>
        {summary ||
          "The model answered, but did not produce a plan naming the work and the files it touches."}
      </p>
      {asks.length > 0 && (
        <>
          <div className="section-label">It Still Needs</div>
          <ul className="coding-needs-list">
            {asks.map((ask, i) => (
              <li key={i}>{ask}</li>
            ))}
          </ul>
        </>
      )}
      <p className="hint">
        Describe the change against this project — the file or area to touch, and what should be
        different afterwards — then run Research again.
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

function Detail({
  title,
  rows,
  mono = false,
  openKey,
  onOpenKey,
}: {
  title: string;
  rows: string[];
  mono?: boolean;
  openKey: string | null;
  onOpenKey: (key: string | null) => void;
}) {
  return (
    <RailDetails title={title} chip={rows.length} openKey={openKey} onOpenKey={onOpenKey}>
      {rows.length ? (
        <div className={mono ? "coding-detail-rows mono" : "coding-detail-rows"}>
          {rows.map((row, i) => (
            <div key={`${title}-${i}`}>{row}</div>
          ))}
        </div>
      ) : (
        <p className="hint">Nothing reported yet.</p>
      )}
    </RailDetails>
  );
}

function History({
  runs,
  activeId,
  onPick,
  onRename,
  openKey,
  onOpenKey,
}: {
  runs: CodingRun[];
  activeId: string | null;
  onPick: (id: string) => void;
  onRename: (id: string, title: string) => void;
  openKey: string | null;
  onOpenKey: (key: string | null) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (run: CodingRun) => {
    setEditingId(run.id);
    setDraft(run.title ?? titleForRun(run));
  };

  const commit = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  return (
    <RailDetails title="History" chip={runs.length} openKey={openKey} onOpenKey={onOpenKey}>
      {runs.length ? (
        <div className="coding-history-list">
          {runs.map((run) =>
            editingId === run.id ? (
              <input
                key={run.id}
                className="coding-rename-input"
                value={draft}
                autoFocus
                spellCheck={false}
                placeholder="Name this conversation"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit();
                  }
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <div key={run.id} className="coding-history-row">
                <button
                  className="coding-history-item"
                  data-on={run.id === activeId}
                  onClick={() => onPick(run.id)}
                >
                  <span>
                    {new Date(run.createdAt).toLocaleString()}
                    {run.stoppedReason ? " · unfinished" : ""}
                  </span>
                  <strong>{titleForRun(run)}</strong>
                </button>
                <button
                  className="btn tiny ghost coding-history-edit"
                  title="Rename this conversation"
                  onClick={() => startEdit(run)}
                >
                  ✎
                </button>
              </div>
            )
          )}
        </div>
      ) : (
        <p className="hint">No coding history yet.</p>
      )}
    </RailDetails>
  );
}
