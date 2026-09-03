import * as bridge from "./bridge.ts";

export const CODING_QWEN_MODEL = "qwen3.8-27b-uncensored";
export const CODING_QWEN_URL = "http://127.0.0.1:8787/v1/chat/completions";
export const CODING_QWEN_MAX_TOKENS = 8192;
export const CODING_BRIDGE_CONFIG_KEY = "code-auditor.coding-intelligence.bridge";
export const CODING_BRIDGE_CONFIG_EVENT = "coding-bridge-config";
export const CODING_RUN_HISTORY_KEY = "code-auditor.coding-intelligence.history";

export interface CodingBridgeConfig {
  url: string;
  model: string;
  maxTokens: number;
  temperature: number;
  projectRoot: string;
}

export interface CodingBridgeHealth {
  ok?: boolean;
  bridge?: string;
  model?: string;
  upstream?: string;
  manual_tool_translation?: boolean;
  mutation_completion_enforced?: boolean;
  verification_after_mutation?: boolean;
  allowed_tools?: string[];
  max_output_tokens?: number;
}

interface StoredBridgeConfig {
  url?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  projectRoot?: string;
}

export const DEFAULT_CODING_BRIDGE_CONFIG: CodingBridgeConfig = {
  url: CODING_QWEN_URL,
  model: CODING_QWEN_MODEL,
  maxTokens: CODING_QWEN_MAX_TOKENS,
  temperature: 0.2,
  projectRoot: "",
};

export interface CodingSolution {
  status?: "ready" | "needs_context" | "blocked" | string;
  summary?: string;
  understanding?: Record<string, unknown>;
  implementation_approach?: Array<{
    step?: number;
    title?: string;
    description?: string;
  }>;
  todos?: Array<{
    title?: string;
    status?: "done" | "working" | "pending" | "blocked" | string;
    detail?: string;
  }>;
  execution_log?: Array<{
    tool?: string;
    target?: string;
    result?: string;
  }>;
  affected_files?: Array<{
    path?: string;
    action?: string;
    reason?: string;
    changes?: string[];
  }>;
  new_files?: unknown[];
  code_changes?: Array<{
    path?: string;
    type?: string;
    target?: string;
    code?: string;
  }>;
  dependencies?: unknown[];
  database_changes?: unknown[];
  environment_changes?: unknown[];
  configuration_changes?: unknown[];
  commands?: unknown[];
  tests?: unknown[];
  edge_cases?: unknown[];
  security_considerations?: unknown[];
  risks?: unknown[];
  verification?: unknown[];
  additional_context_required?: Array<{
    path?: string;
    reason?: string;
  }>;
  architecture_memory?: string[];
  confidence?: number;
}

/** Why a run ended before the model said it was done. */
export type CodingStopReason = "stopped" | "timeout" | "turn_budget";

export interface CodingRun {
  id: string;
  task: string;
  raw: string;
  parsed: CodingSolution | null;
  events: CodingToolEvent[];
  createdAt: number;
  /**
   * Set when the run ended without a final report — stopped by hand, cut short
   * by a bridge timeout, or out of turns. Such a run has usually already
   * changed files, so it is kept rather than discarded, and can be continued.
   */
  stoppedReason?: CodingStopReason;
  /** The run this one resumed, so a continued chain stays traceable. */
  continuedFrom?: string;
  /**
   * Which phase produced this run. Continuing the two means different things:
   * an interrupted plan is re-planned, an interrupted execution is picked up
   * from its log. Absent on runs recorded before this field existed.
   */
  mode?: "plan" | "execute";
  /** Reasoning, tool calls and injected instructions, in order. */
  activity?: CodingActivity[];
}

export interface CodingToolEvent {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  result: string;
  createdAt: number;
}

/**
 * Shared between the caller and a run in flight. The caller flips `cancelled`
 * and tells the bridge the same thing: the flag stops our own loop between
 * turns, the bridge call tears down the model turn already running.
 */
export interface CodingRunControl {
  runId: string;
  cancelled: boolean;
}

export type CodingProgressPhase = "thinking" | "tool" | "stopping";

export interface CodingProgress {
  phase: CodingProgressPhase;
  /** 1-based, so it reads the way a person counts. */
  turn: number;
  detail: string;
}

/**
 * One entry in the account of what the agent did, in the order it happened.
 *
 * Tool events alone say what was touched but never why. The reasoning is what
 * makes a run reviewable rather than merely observable, so it is recorded
 * beside the calls it led to.
 */
export interface CodingActivity {
  id: string;
  kind: "thinking" | "tool" | "note" | "instruction";
  turn: number;
  text: string;
  /** Present on `tool` entries, pointing at the matching CodingToolEvent. */
  eventId?: string;
  createdAt: number;
}

export interface CodingRunOptions {
  control?: CodingRunControl;
  onEvent?: (event: CodingToolEvent) => void;
  onProgress?: (progress: CodingProgress) => void;
  onActivity?: (activity: CodingActivity) => void;
  planRun?: CodingRun | null;
  /** The interrupted run being picked up, when this is a continuation. */
  resumeOf?: string;
  /** Its execution log, so the model does not redo work already applied. */
  resumeFrom?: CodingRun | null;
  /**
   * Drained at each turn boundary for follow-ups typed while the run was
   * already going. Injected as user turns, so the model picks them up at its
   * next decision rather than after the whole run finishes.
   */
  takePending?: () => string[];
}

export class CodingRunCancelled extends Error {
  constructor() {
    super("Run stopped.");
    this.name = "CodingRunCancelled";
  }
}

export function createRunControl(): CodingRunControl {
  return {
    runId: `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    cancelled: false,
  };
}

/**
 * Stops a run. The local flag is set first and unconditionally, so a bridge
 * that cannot be reached still ends the loop on our side rather than leaving
 * the UI stuck on a run nobody can stop.
 */
export async function cancelCodingRun(
  config: CodingBridgeConfig,
  control: CodingRunControl
): Promise<void> {
  control.cancelled = true;
  await bridge.cancelLocalQwen({
    baseUrl: codingBridgeBaseUrl(config.url),
    runId: control.runId,
  });
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `root_cause` / `rootCause` → `Root cause`. */
function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Fields that read as the point of an entry rather than a detail of it, so they
 * lead instead of being labelled. `{path, reason}` should read
 * "src/db.ts — the query is unbounded", not "Path: src/db.ts · Reason: …".
 */
const HEADLINE_KEYS = [
  "title",
  "name",
  "summary",
  "description",
  "command",
  "path",
  "file",
  "step",
  "text",
  "value",
];

/**
 * Turns one item of the model's JSON into a line a person can read.
 *
 * The schema asks for twenty-odd free-form arrays, and the model fills them
 * with whatever shape it likes — strings here, objects there. Rendering those
 * with JSON.stringify put braces and quotes in front of the user for no gain:
 * the information was already prose, just wearing punctuation.
 */
export function humanizeValue(value: unknown, depth = 0): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    return value
      .map((item) => humanizeValue(item, depth + 1))
      .filter(Boolean)
      .join("; ");
  }

  if (typeof value !== "object") return String(value);

  // Deeply nested objects stop being readable as one line; a compact dump is
  // the honest fallback rather than pretending it flattens.
  if (depth > 2) {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, raw]) => [key, humanizeValue(raw, depth + 1)] as const)
    .filter(([, text]) => text);

  if (!entries.length) return "";

  const headIndex = entries.findIndex(([key]) => HEADLINE_KEYS.includes(key.toLowerCase()));
  const head = headIndex >= 0 ? entries[headIndex] : null;
  const rest = entries.filter((entry) => entry !== head);

  const tail = rest.map(([key, text]) => `${humanizeKey(key)}: ${text}`).join(" · ");
  if (!head) return tail;
  return tail ? `${head[1]} — ${tail}` : head[1];
}

/** The same, for a list, with blanks dropped. */
export function humanizeList(value: unknown[] | undefined): string[] {
  return (value ?? []).map((item) => humanizeValue(item)).filter(Boolean);
}

export function cleanCodingError(err: unknown): string {
  const raw =
    String(err)
      .replace(/^Error:\s*/, "")
      .trim();
  const lower =
    raw.toLowerCase();

  if (
    lower.includes("concurrent task limit") ||
    lower.includes("code 96") ||
    lower.includes("up to 1 tasks")
  ) {
    return "Wiro already has one task running. Wait for that task to finish or stop it, then run this again. Your current Wiro balance allows 1 concurrent task.";
  }

  if (
    lower.includes("wiro sse disconnected") ||
    lower.includes("automatic replay is disabled")
  ) {
    return "Wiro disconnected after the task started. The bridge did not replay it to avoid duplicate billing. Use Continue once the current Wiro task is no longer running.";
  }

  return raw || "Coding run failed.";
}

export interface HumanSection {
  label: string;
  rows: string[];
}

/**
 * The response envelope as readable sections, in the order a person would want
 * them: what it understood, then what it would do, then the caveats.
 *
 * Empty fields are dropped rather than listed. The schema asks for twenty-odd
 * arrays and a thin answer fills three of them, so showing the rest as empty
 * headings buries the part that has content.
 */
export function humanizeSolution(solution: CodingSolution | null): HumanSection[] {
  if (!solution) return [];
  const out: HumanSection[] = [];
  const add = (label: string, rows: string[]) => {
    if (rows.length) out.push({ label, rows });
  };

  const summary = trimmed(solution.summary);
  if (summary) add("Summary", [summary]);

  // `understanding` is a fixed-key object, so its keys become the labels.
  const understanding = solution.understanding ?? {};
  for (const [key, value] of Object.entries(understanding)) {
    const text = humanizeValue(value);
    if (text) add(humanizeKey(key), [text]);
  }

  add(
    "Approach",
    (solution.implementation_approach ?? [])
      .map((step, i) => {
        const title = trimmed(step?.title);
        const description = trimmed(step?.description);
        const n = step?.step ?? i + 1;
        if (!title && !description) return "";
        return `${n}. ${[title, description].filter(Boolean).join(" — ")}`;
      })
      .filter(Boolean)
  );

  add(
    "Todos",
    (solution.todos ?? [])
      .map((todo) => {
        const title = trimmed(todo?.title);
        if (!title) return "";
        const status = trimmed(todo?.status);
        const detail = trimmed(todo?.detail);
        return [status ? `[${status}]` : "", title, detail ? `— ${detail}` : ""]
          .filter(Boolean)
          .join(" ");
      })
      .filter(Boolean)
  );

  add(
    "Files",
    (solution.affected_files ?? [])
      .filter((file) => trimmed(file?.path) && trimmed(file?.path).toLowerCase() !== "unknown")
      .map((file) =>
        [
          trimmed(file.path),
          trimmed(file.action) ? `(${trimmed(file.action)})` : "",
          trimmed(file.reason) ? `— ${trimmed(file.reason)}` : "",
        ]
          .filter(Boolean)
          .join(" ")
      )
  );

  add("Commands", humanizeList(solution.commands));
  add("Tests", humanizeList(solution.tests));
  add("Edge cases", humanizeList(solution.edge_cases));
  add("Risks", humanizeList(solution.risks));
  add("Security", humanizeList(solution.security_considerations));
  add("Verification", humanizeList(solution.verification));
  add("Dependencies", humanizeList(solution.dependencies));
  add("Still needs", missingContext(solution));
  add("Notes", humanizeList(solution.architecture_memory));

  if (typeof solution.confidence === "number") {
    add("Confidence", [`${Math.round(solution.confidence * 100)}%`]);
  }

  return out;
}

/**
 * Works out from a run's own text that it ended early.
 *
 * Two reasons this reads the text rather than only trusting a flag set at the
 * time. The bridge reports its own limits inside an otherwise ordinary
 * successful response — a `[Bridge note: …]` appended to the answer — so
 * nothing else marks those. And runs recorded before `stoppedReason` existed
 * carry no flag at all; without reading them, every unfinished run already in
 * History would stay unfinishable forever.
 */
const STOP_PATTERNS: Array<[CodingStopReason, RegExp]> = [
  // The bridge's own limits: stall, per-turn, whole-run deadline, hard backstop.
  ["timeout", /\[Bridge note:[^\]]*\b(?:stopped on turn|stopped after|no response within|abandoned)\b/i],
  ["timeout", /\bWiro turn ended early\b/i],
  // Upstream dropped the stream mid-generation. Not replayed (already billed),
  // so what came back is partial and the run is worth continuing.
  ["timeout", /\bclosed the connection mid-turn\b/i],
  ["timeout", /\bSSE disconnected after the task started\b/i],
  // Turn budget exhausted in this app's own loop. Both wordings, old and new.
  ["turn_budget", /\bCoding agent (?:stopped after|used all)\b[^.]*\bturns?\b/i],
  // Stopped by hand, from either side.
  ["stopped", /\bRun stopped\b/i],
];

export function inferStopReason(text: string): CodingStopReason | undefined {
  if (!text?.trim()) return undefined;
  for (const [reason, pattern] of STOP_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return undefined;
}

/**
 * Only an execution run carries a tool log, so a run with events was one. For
 * runs predating the `mode` field this is the best available signal, and it errs
 * towards "plan" — re-planning an interrupted run is harmless, whereas resuming
 * an execution that never happened would hand the model an empty log and tell
 * it to carry on from nothing.
 */
export function runMode(run: CodingRun): "plan" | "execute" {
  return run.mode ?? (run.events.length > 0 ? "execute" : "plan");
}

/** A run that ended before the model was done, and can be picked back up. */
export function isResumable(run: CodingRun | null): boolean {
  return Boolean(run?.stoppedReason);
}

export function stopReasonLabel(reason: CodingStopReason | undefined): string {
  if (reason === "stopped") return "You stopped this run.";
  if (reason === "timeout") return "The bridge cut this run short on one of its time limits.";
  if (reason === "turn_budget") return "This run used all of its turns before finishing.";
  return "";
}

/**
 * Whether the model produced a plan there is actually something to execute,
 * as opposed to an acknowledgement or a request for more detail.
 *
 * The distinction matters because the Implementation plan pane is a launchpad:
 * everything in it leads to Run Work. Showing a skeleton there — steps like
 * "ask the user what they want" against files listed as `unknown` — invites
 * someone to execute a plan that was never about their code.
 */
export function isActionablePlan(solution: CodingSolution | null): boolean {
  if (!solution) return false;
  if (solution.status && solution.status !== "ready") return false;

  const steps = (solution.implementation_approach ?? []).filter(
    (step) => trimmed(step?.title) || trimmed(step?.description)
  );
  const todos = (solution.todos ?? []).filter((todo) => trimmed(todo?.title));
  const files = (solution.affected_files ?? []).filter((file) => {
    const path = trimmed(file?.path);
    return path && path.toLowerCase() !== "unknown";
  });
  const changes = (solution.code_changes ?? []).filter((change) => trimmed(change?.code));

  // A real plan names work AND names where it lands. Steps alone are what a
  // generic skeleton produces.
  return (steps.length > 0 || todos.length > 0) && (files.length > 0 || changes.length > 0);
}

/** What the model still needs, with the empty placeholder rows dropped. */
export function missingContext(solution: CodingSolution | null): string[] {
  return (solution?.additional_context_required ?? [])
    .map((item) => {
      const path = trimmed(item?.path);
      const reason = trimmed(item?.reason);
      if (path && path.toLowerCase() !== "unknown" && reason) return `${path} — ${reason}`;
      return reason || (path.toLowerCase() === "unknown" ? "" : path);
    })
    .filter(Boolean);
}

export const CODING_SYSTEM_PROMPT = `
You are the Intensive Coding Intelligence Engine for a professional software-development system.

You are functioning as:
- senior software architect
- senior software engineer
- debugging specialist
- code reviewer
- refactoring specialist
- security reviewer
- testing strategist

You can directly inspect and modify the configured project by calling the available tools.
Your responsibility is to complete the requested coding work, verify it when possible, then produce a structured implementation report.

Rules:
1. Never assume a file exists unless it appears in the supplied project context.
2. Never claim code has been changed unless a tool call actually changed it.
3. Distinguish clearly between current implementation, required implementation, and recommended implementation.
4. Reuse existing project architecture whenever possible.
5. Avoid unnecessary new abstractions.
6. Identify every file that should change.
7. Explain why each file changes.
8. Provide exact implementation details.
9. When useful, provide complete replacement functions, configuration sections, or unified diffs.
10. Consider correctness, architecture, security, concurrency, performance, error handling, edge cases, compatibility, tests, and deployment.
11. Do not waste tokens repeating supplied source code.
12. If context is insufficient, explicitly specify the exact additional files needed.
13. Prefer real implementation over general advice.
14. Use tools when the user asks to edit, create, delete, rename, move, or verify files/folders.
15. After tool work is complete, return only the JSON object below.

Return only a JSON object with this envelope:
{
  "status": "ready | needs_context | blocked",
  "summary": "...",
  "understanding": {
    "current_architecture": "...",
    "problem": "...",
    "root_cause": "...",
    "goal": "..."
  },
  "implementation_approach": [
    { "step": 1, "title": "...", "description": "..." }
  ],
  "todos": [
    { "title": "...", "status": "done | working | pending | blocked", "detail": "..." }
  ],
  "execution_log": [
    { "tool": "...", "target": "...", "result": "..." }
  ],
  "affected_files": [
    { "path": "...", "action": "modify | add | remove", "reason": "...", "changes": ["..."] }
  ],
  "new_files": [],
  "code_changes": [
    { "path": "...", "type": "replacement | patch | addition", "target": "...", "code": "..." }
  ],
  "dependencies": [],
  "database_changes": [],
  "environment_changes": [],
  "configuration_changes": [],
  "commands": [],
  "tests": [],
  "edge_cases": [],
  "security_considerations": [],
  "risks": [],
  "verification": [],
  "additional_context_required": [],
  "architecture_memory": [],
  "confidence": 0.0
}
`.trim();

export const CODING_PLAN_SYSTEM_PROMPT = `
You are the Intensive Coding Intelligence Engine for a professional software-development system.

You are functioning as:
- senior software architect
- senior software engineer
- debugging specialist
- code reviewer
- refactoring specialist
- security reviewer
- testing strategist

You are in planning mode. Do not modify files, do not claim files were modified, and do not emit tool calls.
Your responsibility is to analyze the task and produce a strong implementation plan with todos.

Return only a JSON object with this envelope:
{
  "status": "ready | needs_context | blocked",
  "summary": "...",
  "understanding": {
    "current_architecture": "...",
    "problem": "...",
    "root_cause": "...",
    "goal": "..."
  },
  "implementation_approach": [
    { "step": 1, "title": "...", "description": "..." }
  ],
  "todos": [
    { "title": "...", "status": "pending", "detail": "..." }
  ],
  "execution_log": [],
  "affected_files": [
    { "path": "...", "action": "modify | add | remove", "reason": "...", "changes": ["..."] }
  ],
  "new_files": [],
  "code_changes": [],
  "dependencies": [],
  "database_changes": [],
  "environment_changes": [],
  "configuration_changes": [],
  "commands": [],
  "tests": [],
  "edge_cases": [],
  "security_considerations": [],
  "risks": [],
  "verification": [],
  "additional_context_required": [],
  "architecture_memory": [],
  "confidence": 0.0
}
`.trim();

export function buildCodingContext(task: string): string {
  return `
PROJECT

Council Editor / Code Auditor

PROJECT ARCHITECTURE

Desktop application built with Tauri and a Next.js React frontend.
The existing product runs a multi-model council workflow for coding/problem solving.
React components live under src/components.
Client state is held in Zustand under src/lib/store.ts.
Tauri commands and native desktop functionality live under src-tauri/src.
Supabase is used elsewhere in the app for sessions, storage, history, and auth.

CURRENT FEATURE AREA

This is the new Coding Intelligence workspace.
The intended workflow is:
1. User enters a coding task.
2. The local app owns repository context and memory.
3. The Qwen bridge performs reasoning only.
4. The app renders the implementation plan, files, code changes, tests, risks, commands, and memory notes.

CURRENT IMPLEMENTATION LEVEL

The local app exposes file, folder, search, and bash tools for the configured project root.
Use those tools to inspect and apply requested coding changes.

CURRENT TASK

${task}

REQUEST

Complete this task as a senior software engineer.
Inspect the project, apply the necessary changes with tools, verify when possible, then return the final JSON report.
`.trim();
}

export function buildCodingPlanContext(task: string): string {
  return `
PROJECT

Council Editor / Code Auditor

CURRENT TASK

${task}

REQUEST

Prepare the implementation plan and todos for this coding task.
Do not edit files in planning mode.
Make the plan specific enough that the Execute Plan runner can apply it later.
`.trim();
}

export function buildCodingExecutionContext(task: string, planRun?: CodingRun | null): string {
  const plan = planRun?.parsed ?? null;
  const planText = planRun ? codingRunMarkdown(planRun) || planRun.raw : "";
  return `
PROJECT

Council Editor / Code Auditor

CURRENT TASK

${task}

APPROVED IMPLEMENTATION PLAN

${planText || "(no prior plan supplied)"}

TODOS

${JSON.stringify(plan?.todos ?? plan?.implementation_approach ?? [], null, 2)}

REQUEST

Execute the approved implementation plan now.
Use the available tools to inspect, edit, create, delete, move, copy, and verify files/folders as needed.
Keep the final JSON report aligned to the plan and todos, marking completed work as done.

The approved plan is also written to ${CODING_PLAN_DOC} in the project root. Read it
if you need the full detail — it is the same plan, not a newer one. Do not edit that
file yourself; it is regenerated from your final report when this run finishes.
`.trim();
}

/**
 * Context for picking up an interrupted run.
 *
 * The point of the execution log here is that the previous attempt already
 * wrote to disk. Without it the model starts from the plan again and re-applies
 * edits that landed, which on a `write` is harmless and on anything sequential
 * is not. Files are re-read rather than trusted, because a tool call that was
 * cut off mid-flight may have half-landed.
 */
export function buildCodingResumeContext(
  task: string,
  planRun: CodingRun | null | undefined,
  previous: CodingRun
): string {
  const applied = previous.events.filter((event) => event.status === "ok");
  const failed = previous.events.filter((event) => event.status === "error");
  const line = (event: CodingToolEvent) =>
    `- ${event.tool} ${eventSummary(event)} → ${event.result.slice(0, 200).replace(/\s+/g, " ")}`;

  return `
${buildCodingExecutionContext(task, planRun)}

============================================================

THIS IS A CONTINUATION

A previous attempt at this same task was interrupted: ${
    stopReasonLabel(previous.stoppedReason) || "it ended before finishing."
  }

ALREADY APPLIED (${applied.length})

${applied.length ? applied.map(line).join("\n") : "(nothing was applied)"}

${failed.length ? `FAILED LAST TIME (${failed.length})\n\n${failed.map(line).join("\n")}\n` : ""}
HOW TO CONTINUE

Do not repeat work listed as already applied.
Read any file you intend to change before changing it — the previous attempt may
have been cut off partway through a write, so do not assume its state.
Carry on from where it stopped and finish the task.
`.trim();
}

/**
 * Writes the run's document into the project.
 *
 * Never throws. Failing to save a summary must not turn a run that actually did
 * the work into a failed one — the document is a convenience, the edits on disk
 * are the result. A write that fails is reported back and shown, not raised.
 */
export async function saveRunDocument(
  run: CodingRun,
  config: CodingBridgeConfig,
  previous?: CodingRun | null
): Promise<{ path: string } | { error: string }> {
  if (!config.projectRoot.trim()) return { error: "No project root is set." };
  try {
    await bridge.executeCodingTool({
      name: "write",
      root: config.projectRoot,
      args: { path: CODING_PLAN_DOC, content: buildRunDocument(run, previous) },
    });
    return { path: CODING_PLAN_DOC };
  } catch (err) {
    return { error: String(err).replace(/^Error:\s*/, "") };
  }
}

export function loadCodingBridgeConfig(): CodingBridgeConfig {
  if (typeof window === "undefined") return DEFAULT_CODING_BRIDGE_CONFIG;
  try {
    const parsed = JSON.parse(
      localStorage.getItem(CODING_BRIDGE_CONFIG_KEY) || "{}"
    ) as StoredBridgeConfig;
    return {
      ...DEFAULT_CODING_BRIDGE_CONFIG,
      url: parsed.url?.trim() || DEFAULT_CODING_BRIDGE_CONFIG.url,
      model: parsed.model?.trim() || DEFAULT_CODING_BRIDGE_CONFIG.model,
      maxTokens: Number.isFinite(parsed.maxTokens)
        ? Number(parsed.maxTokens)
        : DEFAULT_CODING_BRIDGE_CONFIG.maxTokens,
      temperature: Number.isFinite(parsed.temperature)
        ? Number(parsed.temperature)
        : DEFAULT_CODING_BRIDGE_CONFIG.temperature,
      projectRoot: parsed.projectRoot?.trim() || DEFAULT_CODING_BRIDGE_CONFIG.projectRoot,
    };
  } catch {
    return DEFAULT_CODING_BRIDGE_CONFIG;
  }
}

export function saveCodingBridgeConfig(config: CodingBridgeConfig) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    CODING_BRIDGE_CONFIG_KEY,
    JSON.stringify({
      url: config.url,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      projectRoot: config.projectRoot,
    })
  );
  window.dispatchEvent(new CustomEvent(CODING_BRIDGE_CONFIG_EVENT, { detail: config }));
}

const stringSchema = { type: "string" };

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

export const CODING_TOOLS = [
  tool("read", "Read a UTF-8 text file inside the configured project root.", { path: stringSchema }, ["path"]),
  tool("glob", "List files and folders under a directory inside the configured project root.", { path: stringSchema }, ["path"]),
  tool("grep", "Search text files for a literal pattern inside the configured project root.", { path: stringSchema, pattern: stringSchema }, ["pattern"]),
  tool("bash", "Run a shell command from the configured project root.", { command: stringSchema }, ["command"]),
  tool("edit", "Replace the first exact oldString occurrence in a file.", {
    path: stringSchema,
    oldString: stringSchema,
    newString: stringSchema,
  }, ["path", "oldString", "newString"]),
  tool("replace_in_file", "Replace the first exact oldString occurrence in a file.", {
    path: stringSchema,
    oldString: stringSchema,
    newString: stringSchema,
  }, ["path", "oldString", "newString"]),
  tool("write", "Write complete file contents, creating parent folders if needed.", { path: stringSchema, content: stringSchema }, ["path", "content"]),
  tool("write_to_file", "Write complete file contents, creating parent folders if needed.", { path: stringSchema, content: stringSchema }, ["path", "content"]),
  tool("create_file", "Create or overwrite a file with complete contents.", { path: stringSchema, content: stringSchema }, ["path", "content"]),
  tool("delete_file", "Delete a file inside the configured project root.", { path: stringSchema }, ["path"]),
  tool("rename_file", "Rename or move a file.", { source: stringSchema, destination: stringSchema }, ["source", "destination"]),
  tool("move_file", "Move a file.", { source: stringSchema, destination: stringSchema }, ["source", "destination"]),
  tool("copy_file", "Copy a file.", { source: stringSchema, destination: stringSchema }, ["source", "destination"]),
  tool("create_folder", "Create a folder and any missing parent folders.", { path: stringSchema }, ["path"]),
  tool("create_directory", "Create a directory and any missing parent directories.", { path: stringSchema }, ["path"]),
  tool("delete_folder", "Delete a folder recursively.", { path: stringSchema }, ["path"]),
  tool("delete_directory", "Delete a directory recursively.", { path: stringSchema }, ["path"]),
  tool("rename_folder", "Rename or move a folder.", { source: stringSchema, destination: stringSchema }, ["source", "destination"]),
  tool("move_folder", "Move a folder.", { source: stringSchema, destination: stringSchema }, ["source", "destination"]),
  tool("copy_folder", "Copy a folder recursively.", { source: stringSchema, destination: stringSchema }, ["source", "destination"]),
];

export function codingBridgeBaseUrl(chatUrl: string): string {
  return chatUrl
    .trim()
    .replace(/\/chat\/completions\/?$/, "")
    .replace(/\/+$/, "");
}

export async function fetchCodingBridgeJson<T>(
  url: string,
  apiKey: string
): Promise<T> {
  const res = await fetch(url, {
    headers: apiKey.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text) as T;
}

export async function inspectCodingBridge(
  config: CodingBridgeConfig,
  apiKey: string
): Promise<{ health: CodingBridgeHealth; config: CodingBridgeConfig }> {
  const root = codingBridgeBaseUrl(config.url);
  const inspected = await bridge.inspectLocalQwen({ baseUrl: root, apiKey });
  const health = inspected.health as CodingBridgeHealth;
  const models = inspected.models as { data?: Array<{ id?: string }> };
  const model = models.data?.find((m) => m.id)?.id;
  return {
    health,
    config: {
      ...config,
      model: model || health.model || config.model,
      maxTokens: health.max_output_tokens || config.maxTokens,
    },
  };
}

function jsonSlice(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

export function parseCodingSolution(text: string): CodingSolution | null {
  try {
    return JSON.parse(jsonSlice(text)) as CodingSolution;
  } catch {
    return null;
  }
}

export async function loadCodingRuns(): Promise<CodingRun[]> {
  if (typeof window === "undefined") return [];
  const fromLocal = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(CODING_RUN_HISTORY_KEY) || "[]") as CodingRun[];
      return Array.isArray(parsed) ? parsed.slice(0, 30).map(normalizeRun) : [];
    } catch {
      return [];
    }
  };

  try {
    const remote = await bridge.settingsLoad<CodingRun[]>(CODING_RUN_HISTORY_KEY);
    if (Array.isArray(remote)) {
      const runs = remote.slice(0, 30).map(normalizeRun);
      localStorage.setItem(CODING_RUN_HISTORY_KEY, JSON.stringify(runs));
      return runs;
    }
  } catch {}

  return fromLocal();
}

export async function saveCodingRuns(runs: CodingRun[]): Promise<void> {
  if (typeof window === "undefined") return;
  const trimmed = runs.slice(0, 30).map(normalizeRun);
  localStorage.setItem(CODING_RUN_HISTORY_KEY, JSON.stringify(trimmed));
  try {
    await bridge.settingsSave(CODING_RUN_HISTORY_KEY, trimmed);
  } catch {}
}

function normalizeRun(run: CodingRun): CodingRun {
  const events = Array.isArray(run.events) ? run.events : [];
  // Backfilled on load, so runs recorded before stoppedReason existed still
  // offer Continue. An explicit flag always wins over what the text implies.
  const stoppedReason = run.stoppedReason ?? inferStopReason(run.raw ?? "");
  return {
    ...run,
    events,
    activity: Array.isArray(run.activity) ? run.activity : [],
    ...(stoppedReason ? { stoppedReason } : {}),
  };
}

export async function runCodingIntelligence(
  task: string,
  config: CodingBridgeConfig,
  options: CodingRunOptions = {}
): Promise<CodingRun> {
  const { control, onEvent, onProgress, onActivity, planRun, resumeFrom, takePending } = options;
  if (!config.projectRoot.trim()) {
    throw new Error("Set a project root in Bridge settings before running coding tools.");
  }

  // Built once and reused for both the seed message and userText, so a
  // continuation cannot end up describing itself two different ways.
  const userText = resumeFrom
    ? buildCodingResumeContext(task, planRun, resumeFrom)
    : buildCodingExecutionContext(task, planRun);

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: CODING_SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];
  let raw = "";
  let lastContent = "";
  let finished = false;
  const events: CodingToolEvent[] = [];
  const activity: CodingActivity[] = [];

  const note = (
    kind: CodingActivity["kind"],
    turn: number,
    text: string,
    eventId?: string
  ) => {
    const clean = text.trim();
    if (!clean) return;
    const entry: CodingActivity = {
      id: `${kind}-${turn}-${activity.length}`,
      kind,
      turn,
      text: clean,
      ...(eventId ? { eventId } : {}),
      createdAt: Date.now(),
    };
    activity.push(entry);
    onActivity?.(entry);
  };

  for (let turn = 0; turn < 18; turn += 1) {
    if (control?.cancelled) break;

    // Follow-ups typed while this was running. Injected at the turn boundary so
    // the model sees them before choosing its next move, rather than after the
    // run has finished and the moment has passed.
    for (const extra of takePending?.() ?? []) {
      const clean = extra.trim();
      if (!clean) continue;
      messages.push({
        role: "user",
        content: `ADDITIONAL INSTRUCTION FROM THE USER (sent while you were working)\n\n${clean}\n\nFold this into the work in progress. Finish what is already underway unless this contradicts it.`,
      });
      note("instruction", turn + 1, clean);
    }

    onProgress?.({
      phase: "thinking",
      turn: turn + 1,
      detail: turn === 0 ? "Reading the plan and the project" : "Deciding the next step",
    });

    const step = await bridge.runLocalQwenStep({
      model: config.model,
      baseUrl: config.url,
      systemPrompt: CODING_SYSTEM_PROMPT,
      userText,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      messages,
      tools: CODING_TOOLS,
      runId: control?.runId,
    });

    // The bridge answers a stop promptly rather than erroring, so whatever came
    // back is the tail of a run the user already called off.
    if (control?.cancelled) break;

    // Recorded before the tool calls it produced, so the log reads as the
    // reasoning and then what it led to.
    note("thinking", turn + 1, step.reasoning);
    if (step.toolCalls.length && step.content.trim()) {
      note("note", turn + 1, step.content);
    }

    if (step.content.trim()) lastContent = step.content;

    if (!step.toolCalls.length) {
      raw = step.content;
      finished = true;
      break;
    }

    messages.push({
      role: "assistant",
      content: step.content || "",
      tool_calls: step.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      })),
    });

    for (const call of step.toolCalls) {
      // Checked per call, not per turn: one turn can carry several edits, and a
      // stop should not sit through the rest of them.
      if (control?.cancelled) break;

      onProgress?.({
        phase: "tool",
        turn: turn + 1,
        detail: `${call.name}${toolTarget(call.arguments) ? ` ${toolTarget(call.arguments)}` : ""}`,
      });

      const event: CodingToolEvent = {
        id: call.id,
        tool: call.name,
        args: call.arguments ?? {},
        status: "running",
        result: "",
        createdAt: Date.now(),
      };
      events.push(event);
      onEvent?.(event);
      note(
        "tool",
        turn + 1,
        `${call.name}${toolTarget(call.arguments) ? ` ${toolTarget(call.arguments)}` : ""}`,
        event.id
      );

      let content: string;
      try {
        content = await bridge.executeCodingTool({
          name: call.name,
          root: config.projectRoot,
          args: call.arguments ?? {},
        });
        event.status = "ok";
        event.result = content;
      } catch (err) {
        content = `Error: ${String(err).replace(/^Error:\s*/, "")}`;
        event.status = "error";
        event.result = content;
      }
      onEvent?.({ ...event });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content,
      });
    }
  }

  // Why the loop ended decides whether this run can be picked back up. All
  // three cases have usually already changed files, so none of them throw the
  // work away — they record it and stay resumable.
  const stoppedReason: CodingStopReason | undefined = control?.cancelled
    ? "stopped"
    : !finished
      ? "turn_budget"
      : inferStopReason(raw);

  if (stoppedReason && stoppedReason !== "timeout") {
    const applied = events.filter((event) => event.status === "ok");
    raw = [
      stoppedReason === "stopped"
        ? "Run stopped before the agent reported back."
        : "Coding agent used all 18 turns without a final report.",
      "",
      applied.length
        ? `${applied.length} tool call(s) succeeded first, so the project may already be partially changed. Review the execution log below, then Continue to pick up from here.`
        : "No tool call succeeded, so the project should be unchanged.",
      "",
      "## Execution log",
      "",
      ...(events.length
        ? events.map(
            (event) => `- ${event.status.toUpperCase()} \`${event.tool}\` ${eventSummary(event)}`
          )
        : ["- nothing ran"]),
      ...(lastContent.trim() ? ["", "## Last model message", "", lastContent.trim()] : []),
    ].join("\n");
  }

  if (!raw.trim()) {
    throw new Error("Coding agent stopped before returning a final report.");
  }

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    task,
    raw,
    parsed: parseCodingSolution(raw),
    events,
    activity,
    createdAt: Date.now(),
    mode: "execute",
    ...(stoppedReason ? { stoppedReason } : {}),
    ...(options.resumeOf ? { continuedFrom: options.resumeOf } : {}),
  };
}

function toolTarget(args: Record<string, unknown> | undefined): string {
  const target = args?.path ?? args?.filePath ?? args?.source ?? args?.command ?? "";
  return typeof target === "string" ? target : "";
}

function eventSummary(event: CodingToolEvent): string {
  const label = toolTarget(event.args);
  return label ? `— ${label}` : "";
}

export async function runCodingPlan(
  task: string,
  config: CodingBridgeConfig,
  options: Pick<CodingRunOptions, "control" | "onProgress"> = {}
): Promise<CodingRun> {
  const { control, onProgress } = options;
  onProgress?.({ phase: "thinking", turn: 1, detail: "Analyzing the task" });

  const raw = await bridge.runLocalQwen({
    model: config.model,
    baseUrl: config.url,
    systemPrompt: CODING_PLAN_SYSTEM_PROMPT,
    userText: buildCodingPlanContext(task),
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    runId: control?.runId,
  });

  if (control?.cancelled) throw new CodingRunCancelled();

  // A plan cut short by one of the bridge's limits still comes back as an
  // ordinary response. Marking it lets Continue offer to re-plan rather than
  // leaving a truncated plan sitting there looking finished.
  const stoppedReason = inferStopReason(raw);

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    task,
    raw,
    parsed: parseCodingSolution(raw),
    events: [],
    createdAt: Date.now(),
    mode: "plan",
    ...(stoppedReason ? { stoppedReason } : {}),
  };
}

/** Where the finished plan is written, relative to the project root. */
export const CODING_PLAN_DOC = "IMPLEMENTATION_PLAN.md";

/**
 * The run as a standalone document.
 *
 * This is the artefact the whole flow exists to produce: one file that states
 * the task, the plan, what was actually done and how to verify it. Written into
 * the project so the execution phase can read it back, anything else can pick it
 * up without going through this UI, and there is a record after the app is
 * closed.
 *
 * Deliberately plain Markdown with stable headings — it is meant to be read by
 * a person and parsed by a program, and both are better served by structure
 * that does not move around.
 */
export function buildRunDocument(run: CodingRun, previous?: CodingRun | null): string {
  const when = new Date(run.createdAt).toISOString();
  const sections = humanizeSolution(run.parsed);
  const applied = run.events.filter((event) => event.status === "ok");
  const failed = run.events.filter((event) => event.status === "error");

  const lines: string[] = [
    `# Implementation plan`,
    "",
    `> Generated by Council Editor on ${when}.`,
    `> Task: ${run.task.trim() || "(none given)"}`,
    "",
    `**Status:** ${
      run.stoppedReason
        ? `unfinished — ${stopReasonLabel(run.stoppedReason)}`
        : run.parsed?.status
          ? run.parsed.status
          : "complete"
    }`,
  ];

  if (typeof run.parsed?.confidence === "number") {
    lines.push(`**Confidence:** ${Math.round(run.parsed.confidence * 100)}%`);
  }

  for (const section of sections) {
    if (section.label === "Confidence") continue; // already stated above
    lines.push("", `## ${section.label}`, "");
    lines.push(
      section.rows.length === 1 ? section.rows[0] : section.rows.map((r) => `- ${r}`).join("\n")
    );
  }

  const changes = run.parsed?.code_changes?.filter((c) => trimmed(c?.code)) ?? [];
  if (changes.length) {
    lines.push("", "## Code changes", "");
    for (const change of changes) {
      lines.push(`### ${trimmed(change.path) || "unknown"}`, "", "```", change.code ?? "", "```", "");
    }
  }

  if (run.events.length) {
    lines.push("", "## What was done", "");
    lines.push(`${applied.length} applied, ${failed.length} failed.`, "");
    for (const event of run.events) {
      lines.push(
        `- \`${event.tool}\` ${eventSummary(event)} — ${event.status}${
          event.status === "error" ? `: ${event.result.slice(0, 200)}` : ""
        }`
      );
    }
  }

  if (previous?.events.length) {
    lines.push(
      "",
      "## Carried over from the previous attempt",
      "",
      `${previous.events.filter((e) => e.status === "ok").length} tool call(s) had already been applied before this run continued it.`
    );
  }

  lines.push("", "---", "", `_Run id: ${run.id}_`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function codingRunMarkdown(run: CodingRun | null): string {
  if (!run) return "";
  const p = run.parsed;
  if (!p) return run.raw;

  const lines: string[] = [];
  if (p.summary) lines.push(`## Summary\n\n${p.summary}`);
  if (p.implementation_approach?.length) {
    lines.push(
      "## Implementation Strategy\n\n" +
        p.implementation_approach
          .map((s, i) => `${s.step ?? i + 1}. **${s.title ?? "Step"}**\n${s.description ?? ""}`)
          .join("\n\n")
    );
  }
  if (p.affected_files?.length) {
    lines.push(
      "## Files To Modify\n\n" +
        p.affected_files
          .map((f) => `- \`${f.path ?? "unknown"}\` ${f.action ? `(${f.action})` : ""}: ${f.reason ?? ""}`)
          .join("\n")
    );
  }
  if (p.code_changes?.length) {
    lines.push(
      "## Code Changes\n\n" +
        p.code_changes
          .map((c) => {
            const head = `### ${c.path ?? "unknown"}${c.target ? ` - ${c.target}` : ""}`;
            return c.code ? `${head}\n\n\`\`\`\n${c.code}\n\`\`\`` : `${head}\n\n${c.type ?? ""}`;
          })
          .join("\n\n")
    );
  }
  // `String(x)` on an object gives "[object Object]", so commands go through
  // the same formatter as everything else.
  const commands = humanizeList(p.commands);
  if (commands.length) lines.push(`## Commands\n\n\`\`\`\n${commands.join("\n")}\n\`\`\``);

  const section = (title: string, rows: string[]) => {
    if (rows.length) lines.push(`## ${title}\n\n` + rows.map((r) => `- ${r}`).join("\n"));
  };
  section("Tests", humanizeList(p.tests));
  section("Edge Cases", humanizeList(p.edge_cases));
  section("Risks", humanizeList(p.risks));
  section("Security", humanizeList(p.security_considerations));
  section("Verification", humanizeList(p.verification));
  section("Dependencies", humanizeList(p.dependencies));
  if (p.additional_context_required?.length) {
    lines.push(
      "## Additional Context Needed\n\n" +
        p.additional_context_required
          .map((x) => `- \`${x.path ?? "unknown"}\`: ${x.reason ?? ""}`)
          .join("\n")
    );
  }
  return lines.join("\n\n");
}
