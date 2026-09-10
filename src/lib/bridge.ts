/**
 * Thin wrapper over the Rust commands and events.
 *
 * Everything here degrades gracefully when the app is opened in a plain browser
 * (`npm run dev` without Tauri), so the UI can be worked on without the shell.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { KeyId, TransportId } from "./models.ts";

export const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ImageInput {
  mime: string;
  /** base64, no data: prefix */
  data: string;
}

export interface RunRequest {
  runId: string;
  agentId: string;
  /**
   * Unique per launch, reruns of the same pane included. `runId` + `agentId`
   * repeats across reruns, so it cannot identify which attempt an event belongs
   * to; every stale-event guard on this side keys on `attemptId` instead.
   */
  attemptId: string;
  /**
   * The wire this request travels over, which is not necessarily the vendor
   * whose model answers it: with the gateway configured every pane's provider is
   * the router. `agentId` stays the pane's own id, and that is what routes the
   * streamed tokens back to the right column.
   */
  provider: TransportId;
  model: string;
  systemPrompt: string;
  userText: string;
  images: ImageInput[];
  maxTokens: number;
  temperature: number;
  baseUrl?: string | null;
  /**
   * "chat" (default) is the chat-completions wire. "responses" is the OpenAI
   * Responses API, for models that TokenRouter serves only there. Discovered
   * by the probe; settable per-seat in Council settings.
   */
  endpoint?: "chat" | "responses";
}

export interface DeltaEvent {
  runId: string;
  agentId: string;
  attemptId: string;
  delta: string;
}

export interface DoneEvent {
  runId: string;
  agentId: string;
  attemptId: string;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
}

export interface ErrorEvent {
  runId: string;
  agentId: string;
  attemptId: string;
  message: string;
}

const NOT_TAURI =
  "This build is running outside the desktop shell, so it cannot reach the model APIs. Launch it with `npm run app:dev`.";

export async function runAgent(req: RunRequest): Promise<void> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  await invoke("run_agent", { req });
}

export async function runOnce(req: RunRequest): Promise<string> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<string>("run_once", { req });
}

export interface LocalQwenRequest {
  model: string;
  /** Full chat-completions URL, for example http://127.0.0.1:8787/v1/chat/completions. */
  baseUrl: string;
  apiKey?: string;
  systemPrompt: string;
  userText: string;
  maxTokens: number;
  temperature: number;
  messages?: unknown[];
  tools?: unknown[];
  /** Tells the bridge whether this request is planning-only or execution. */
  mode?: "plan" | "execute";
  /**
   * Identifies the run to the bridge so `cancelLocalQwen` can stop it. Without
   * one the request still works; it just cannot be called off once sent.
   */
  runId?: string;
  /**
   * Per-request override for the model's reasoning pass. Omitted leaves the
   * bridge on its own `WIRO_ENABLE_THINKING` default; `true`/`false` turns
   * reasoning on or off for this call, so a UI toggle takes effect without a
   * bridge restart.
   */
  enableThinking?: boolean;
}

export interface LocalQwenInspectRequest {
  baseUrl: string;
  apiKey?: string;
}

export interface LocalQwenCancelRequest {
  /** Bridge root, e.g. http://127.0.0.1:8787/v1 (no /chat/completions). */
  baseUrl: string;
  runId: string;
  apiKey?: string;
}

export interface LocalQwenInspectResult {
  health: unknown;
  models: unknown;
}

export interface LocalQwenToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LocalQwenStepResponse {
  content: string;
  toolCalls: LocalQwenToolCall[];
  /** The model's reasoning for this turn, when the bridge exposes it. */
  reasoning: string;
  /** Upstream task id, elapsed time and cost for this turn, when the bridge reports them. */
  wiro?: {
    taskId?: string | null;
    elapsedSeconds?: number | null;
    totalCost?: number | null;
  } | null;
}

export interface CodingModelStepRequest {
  provider: TransportId;
  model: string;
  baseUrl?: string | null;
  maxTokens: number;
  temperature: number;
  messages: unknown[];
  tools?: unknown[];
}

export type CodingModelStepResponse = LocalQwenStepResponse;

export interface CodingToolRequest {
  name: string;
  root: string;
  args: Record<string, unknown>;
}

/**
 * Tool arguments arrive as a JSON string the model wrote, so malformed JSON is
 * an ordinary outcome rather than a bug. Throwing here would abort the whole
 * agent run; handing the raw text through lets the tool reject just that call.
 */
function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { raw };
  } catch {
    return { raw };
  }
}

export async function runLocalQwen(req: LocalQwenRequest): Promise<string> {
  if (!inTauri()) {
    const res = await fetch(req.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${req.apiKey?.trim() || "local"}`,
        ...(req.runId ? { "x-bridge-run-id": req.runId } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userText },
        ],
        ...(typeof req.enableThinking === "boolean"
          ? { enable_thinking: req.enableThinking }
          : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Qwen answered ${res.status}: ${text.slice(0, 600)}`);
    const body = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const out = body.choices?.[0]?.message?.content ?? "";
    if (!out.trim()) throw new Error("Qwen returned an empty response.");
    return out;
  }
  return invoke<string>("run_local_qwen", { req });
}

export async function runLocalQwenStep(req: LocalQwenRequest): Promise<LocalQwenStepResponse> {
  if (!inTauri()) {
    const res = await fetch(req.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${req.apiKey?.trim() || "local"}`,
        ...(req.runId ? { "x-bridge-run-id": req.runId } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        messages: req.messages ?? [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userText },
        ],
        tools: req.tools,
        tool_choice: req.tools?.length ? "auto" : undefined,
        ...(req.mode ? { metadata: { mode: req.mode } } : {}),
        ...(typeof req.enableThinking === "boolean"
          ? { enable_thinking: req.enableThinking }
          : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Qwen answered ${res.status}: ${text.slice(0, 600)}`);
    const body = JSON.parse(text) as {
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      wiro?: {
        taskId?: string | null;
        elapsedSeconds?: number | null;
        totalCost?: number | null;
      } | null;
    };
    const message = body.choices?.[0]?.message;
    return {
      content: message?.content ?? "",
      reasoning: message?.reasoning_content ?? message?.reasoning ?? "",
      toolCalls:
        message?.tool_calls?.map((call) => ({
          id: call.id ?? "tool-call",
          name: call.function?.name ?? "",
          arguments: parseToolArguments(call.function?.arguments),
        })) ?? [],
      wiro: body.wiro ?? null,
    };
  }
  return invoke<LocalQwenStepResponse>("run_local_qwen_step", { req });
}

export async function runCodingModelStep(
  req: CodingModelStepRequest
): Promise<CodingModelStepResponse> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<CodingModelStepResponse>("run_coding_model_step", { req });
}

/**
 * Asks the bridge to stop a run mid-flight, tearing down the upstream call
 * rather than waiting for it to finish. Returns whether anything was actually
 * still running — a run that had just completed is not an error to stop.
 */
export async function cancelLocalQwen(req: LocalQwenCancelRequest): Promise<boolean> {
  if (!inTauri()) {
    const res = await fetch(`${req.baseUrl.replace(/\/+$/, "")}/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${req.apiKey?.trim() || "local"}`,
        "x-bridge-run-id": req.runId,
      },
      body: JSON.stringify({ id: req.runId }),
    });
    if (res.status === 404) throw new Error("This bridge does not support stopping a run; update it.");
    const text = await res.text();
    if (!res.ok) throw new Error(`Cancel ${res.status}: ${text.slice(0, 300)}`);
    try {
      return (JSON.parse(text) as { stopped?: boolean }).stopped ?? true;
    } catch {
      return true;
    }
  }
  return invoke<boolean>("cancel_local_qwen", { req });
}

export async function executeCodingTool(req: CodingToolRequest): Promise<string> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<string>("coding_tool_execute", { req });
}

export async function inspectLocalQwen(req: LocalQwenInspectRequest): Promise<LocalQwenInspectResult> {
  if (!inTauri()) {
    const headers = req.apiKey?.trim() ? { authorization: `Bearer ${req.apiKey.trim()}` } : undefined;
    const [healthRes, modelsRes] = await Promise.all([
      fetch(`${req.baseUrl.replace(/\/+$/, "")}/health`, { headers }),
      fetch(`${req.baseUrl.replace(/\/+$/, "")}/models`, { headers }),
    ]);
    const healthText = await healthRes.text();
    const modelsText = await modelsRes.text();
    if (!healthRes.ok) throw new Error(`Health ${healthRes.status}: ${healthText.slice(0, 600)}`);
    if (!modelsRes.ok) throw new Error(`Models ${modelsRes.status}: ${modelsText.slice(0, 600)}`);
    return { health: JSON.parse(healthText), models: JSON.parse(modelsText) };
  }
  return invoke<LocalQwenInspectResult>("inspect_local_qwen", { req });
}


export interface Capture {
  /** PNG data URL, ready to hand to the downscale path. */
  dataUrl: string;
  /** Where the grab was saved on disk, under ~/Pictures/Code Editor. */
  path: string;
}

/**
 * Interactive region capture.
 *
 * Resolves to null when the user presses Escape during selection -- an ordinary
 * outcome, not a failure, so callers should treat it as "nothing to do". A real
 * problem (a refused Screen Recording permission, say) rejects instead.
 */
export async function captureSelection(): Promise<Capture[] | null> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<Capture[] | null>("capture_selection");
}

/**
 * Reads a previously saved capture back off disk.
 *
 * Resolves to null when the file is gone — purged on purpose, or moved. A session
 * whose images no longer exist should still open.
 */
export async function readCapture(path: string): Promise<Capture | null> {
  if (!inTauri()) return null;
  return invoke<Capture | null>("read_capture", { path });
}

/**
 * Whole-display capture, with no crosshair and nothing to aim. There is nothing
 * to cancel here, so a null result means the grab produced no bytes -- which in
 * practice is a permissions problem, and is reported as an error by the Rust side
 * rather than passed back as a quiet null.
 */
/**
 * Grabs every attached display, not just the main one.
 *
 * `screencapture` writes one file per screen. Returning only the first meant an
 * external monitor was captured, written to disk, and then ignored -- so the app
 * handed the models a perfectly sharp picture of the wrong screen.
 */
export async function captureScreen(): Promise<Capture[] | null> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<Capture[] | null>("capture_screen");
}

export async function cancelRun(runId: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("cancel_run", { runId });
}

export interface HelperAuth {
  authorised: boolean;
  /** ISO timestamp, or null when the helper has never been authorised. */
  expiresAt: string | null;
}

/**
 * Authorise the background capture helper, or renew it.
 *
 * The token itself never comes back across this bridge — Rust writes it straight
 * into the Keychain. All the UI needs is whether it worked and when it runs out.
 */
export async function helperAuthorize(): Promise<HelperAuth> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<HelperAuth>("helper_authorize");
}

/** Asks the server, not the Keychain: a stored token may already be revoked. */
export async function helperAuthStatus(): Promise<HelperAuth> {
  if (!inTauri()) return { authorised: false, expiresAt: null };
  return invoke<HelperAuth>("helper_auth_status");
}

export async function helperDeauthorize(): Promise<void> {
  if (!inTauri()) return;
  await invoke("helper_deauthorize");
}

export async function settingsLoad<T>(key: string): Promise<T | null> {
  if (!inTauri()) return null;
  return invoke<T | null>("settings_load", { key });
}

export async function settingsSave(key: string, value: unknown): Promise<void> {
  if (!inTauri()) return;
  await invoke("settings_save", { key, value });
}

/**
 * Ask a running worker to take one job now.
 *
 * The desktop cannot run the worker itself — it is a Node process with its own
 * credentials — but it can knock on the door of one, and knocking is the whole
 * difference between a queued job draining in seconds and sitting until someone
 * remembers to start something. Returns null when no worker is configured, which
 * is a fact the panel needs rather than an error it should raise.
 */
export async function pokeWorker(
  url: string,
  secret: string
): Promise<{ worked: boolean; durationMs: number } | null> {
  const endpoint = url.trim();
  if (!endpoint) return null;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret.trim() ? { authorization: `Bearer ${secret.trim()}` } : {}),
    },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(`The worker answered ${res.status} ${res.statusText}.`);
  }
  const body = (await res.json()) as { worked?: boolean; durationMs?: number };
  return { worked: Boolean(body.worked), durationMs: Number(body.durationMs ?? 0) };
}

export interface BackgroundHelperStatus {
  installed: boolean;
  plistPath: string;
  loaded: boolean;
  problem: string | null;
  appPath: string;
  helperPath: string;
}

export async function backgroundHelperStatus(): Promise<BackgroundHelperStatus> {
  if (!inTauri()) {
    return {
      installed: false,
      plistPath: "",
      loaded: false,
      problem: null,
      appPath: "",
      helperPath: "",
    };
  }
  return invoke<BackgroundHelperStatus>("background_helper_status");
}

export async function installBackgroundHelper(): Promise<BackgroundHelperStatus> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<BackgroundHelperStatus>("background_helper_install");
}

export async function uninstallBackgroundHelper(): Promise<BackgroundHelperStatus> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<BackgroundHelperStatus>("background_helper_uninstall");
}

export async function setApiKey(provider: KeyId, key: string): Promise<void> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  await invoke("set_api_key", { provider, key });
}

export async function deleteApiKey(provider: KeyId): Promise<void> {
  if (!inTauri()) return;
  await invoke("delete_api_key", { provider });
}

export async function hasApiKey(provider: KeyId): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    return await invoke<boolean>("has_api_key", { provider });
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ running

export interface RunCodeResult {
  /** What actually executed it, so the UI can say "node" rather than imply. */
  runtime: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  /** Exited zero and was not cut short. */
  ok: boolean;
}

/**
 * Executes a block of model-written code in a bounded scratch directory.
 *
 * Only ever called from a button press. Nothing in the app runs an answer on its
 * own, however unanimous the panel was about it -- this is generated code on the
 * user's own machine, and the person deciding to run it has to be a person.
 */
export async function runCode(args: {
  language: string;
  code: string;
  stdin?: string;
  timeoutMs?: number;
}): Promise<RunCodeResult> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<RunCodeResult>("run_code", { req: args });
}

/** Languages with an interpreter actually installed on this machine. */
export async function runnableLanguages(): Promise<string[]> {
  if (!inTauri()) return [];
  try {
    return await invoke<string[]>("runnable_languages");
  } catch {
    return [];
  }
}

/**
 * The model ids this gateway key can actually reach.
 *
 * Asked of the router rather than remembered here: enabling a model on the
 * account happens outside this app, so a hard-coded list can only ever be a
 * guess about somebody else's billing page.
 */
export async function listGatewayModels(baseUrl?: string | null): Promise<string[]> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<string[]>("list_gateway_models", { baseUrl: baseUrl ?? null });
}

export interface ProbeResult {
  model: string;
  ok: boolean;
  ms: number;
  error: string | null;
  reply: string | null;
  /** Whether it could actually read an attached image. Null when not tested. */
  vision: boolean | null;
  visionNote: string | null;
}

/**
 * Asks each model something trivial and reports what actually came back.
 *
 * The listing endpoint answers "is this key entitled to that model", which is a
 * different question from "will it answer" -- a model can be listed and still
 * refuse every request for want of credit, or because the vendor behind it is
 * down. This spends a few tokens to replace an inference with evidence.
 */
export async function probeModels(
  models: string[],
  baseUrl?: string | null,
  testVision = false,
  // Which wire each model speaks when it is not chat. Passed through to the
  // probe so it does not mark a Responses-API model broken for being one.
  endpointByModel?: Record<string, "chat" | "responses">
): Promise<ProbeResult[]> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<ProbeResult[]>("probe_models", {
    models,
    baseUrl: baseUrl ?? null,
    testVision,
    endpointByModel: endpointByModel ?? null,
  });
}

/**
 * Writes the Markdown reading of a screenshot to disk, beside the screenshot.
 *
 * `near` is the capture's own path; Rust refuses anything that is not a file
 * sitting directly in the capture directory, so a wrong value costs a duller
 * file name rather than a write where it should not be. Returns where it landed.
 */
export async function saveReading(markdown: string, near?: string | null): Promise<string> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<string>("save_reading", { markdown, near: near ?? null });
}

/**
 * Tells Rust how many requests a minute this gateway key allows.
 *
 * The governor lives in Rust because that is where the requests are, and it has
 * to hold across a webview reload -- a limit the frontend forgets on refresh is
 * a limit that gets exceeded on the next run.
 */
export async function setGatewayRate(perMinute: number): Promise<void> {
  if (!inTauri()) return;
  await invoke("set_gateway_rate", { perMinute });
}

/** One screenshot as the on-device transcriber read it. */
export interface OcrPage {
  /** The transcription, lines in reading order, indentation rebuilt. */
  text: string;
  /** Words the engine itself was unsure of, already worded for printing. */
  unsure: string[];
  /** Mean word confidence, 0 when nothing was found. */
  confidence: number;
  /** How many words were found at all. Zero means "not a picture of text". */
  words: number;
}

/**
 * Transcribes screenshots with Apple's Vision framework, entirely on-device.
 *
 * No key, no quota, no network: the same engine Live Text uses, so it works
 * offline, and every image in a single call really is free -- the expensive
 * step in reading a screenshot stopped being one when the transcriber stopped
 * being a hosted API. A picture that is not text comes back as an empty page,
 * which is the signal the fall-back to a vision model already listens for.
 */
export async function ocrImages(
  images: { mime: string; data: string }[]
): Promise<OcrPage[]> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  const out = await invoke<{ pages: OcrPage[] }>("ocr_images", { images });
  return out.pages;
}

/** Where a screenshot landed in Supabase Storage. */
export interface Uploaded {
  bucket: string;
  path: string;
  bytes: number;
}

/**
 * Puts one screenshot in the project and returns its address.
 *
 * You paste one credential — the `service_role` key. The project URL is derived
 * in Rust from the connection string already in the Keychain, which is also why
 * that string is not a parameter here: it carries the database password and the
 * webview has never held it.
 */
export async function uploadScreenshot(args: {
  sessionId: string;
  fileName: string;
  mime: string;
  data: string;
}): Promise<Uploaded> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  // Spelled out rather than spread: tests/bridge.test.ts reads the argument
  // object at this call site and matches it against the Rust signature, and it
  // cannot see through a variable.
  return invoke<Uploaded>("storage_upload", {
    sessionId: args.sessionId,
    fileName: args.fileName,
    mime: args.mime,
    data: args.data,
  });
}

/**
 * A time-limited URL for a stored screenshot.
 *
 * The bucket is private, so this is how an image is shown again once the local
 * file is gone — and how an iPad app will fetch one without holding a key that
 * can write.
 */
export async function signedUrl(path: string, seconds = 3600): Promise<string> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<string>("storage_signed_url", { path, seconds });
}

/** Deletes a stored screenshot, so "delete" in the app means deleted. */
export async function removeStored(path: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("storage_remove", { path });
}

/**
 * Deletes the local staging file once the bytes are safely elsewhere.
 *
 * Separate from the upload on purpose: a delete that happens as a side effect of
 * a network call is a delete that happens when the network call only half
 * worked.
 */
export async function forgetLocalFile(path: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("forget_local_file", { path });
}

export function onDelta(fn: (e: DeltaEvent) => void): Promise<UnlistenFn> {
  return listen<DeltaEvent>("agent://delta", (e) => fn(e.payload));
}

export function onDone(fn: (e: DoneEvent) => void): Promise<UnlistenFn> {
  return listen<DoneEvent>("agent://done", (e) => fn(e.payload));
}

export function onError(fn: (e: ErrorEvent) => void): Promise<UnlistenFn> {
  return listen<ErrorEvent>("agent://error", (e) => fn(e.payload));
}

/** One model's probe result, emitted as it lands rather than in one batch at
 *  the end — a five-per-minute governor makes "all thirteen" a two-minute wait,
 *  and waiting blind is where "is this working?" comes from. */
export function onProbeResult(fn: (r: ProbeResult) => void): Promise<UnlistenFn> {
  return listen<ProbeResult>("probe://result", (e) => fn(e.payload));
}

/** Structural type for the teardown functions returned by the event listeners. */
export type UnlistenLike = () => void;
