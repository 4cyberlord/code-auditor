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

export interface Capture {
  /** PNG data URL, ready to hand to the downscale path. */
  dataUrl: string;
  /** Where the grab was saved on disk, under ~/Pictures/Code Auditor. */
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

export interface DbHealth {
  connected: boolean;
  /** Host and database only — never the user or password. */
  target: string;
  serverVersion: string;
  tablesFound: string[];
  tablesMissing: string[];
  sessionCount: number;
  /** Set when the connection works but the schema needs attention. */
  advice: string | null;
}

/**
 * The connection string carries the database password, so it is handled exactly
 * like an API key: written to the Keychain by Rust, never read back into here.
 */
export async function dbSaveUrl(url: string): Promise<void> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  await invoke("db_save_url", { url });
}

export async function dbClearUrl(): Promise<void> {
  if (!inTauri()) return;
  await invoke("db_clear_url");
}

export async function dbHasUrl(): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    return await invoke<boolean>("db_has_url");
  } catch {
    return false;
  }
}

/**
 * Connects and reports what is there. Connecting also creates any missing tables,
 * so this doubles as "set the database up".
 */
export async function dbTest(): Promise<DbHealth> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<DbHealth>("db_test");
}

/** Re-applies the schema, for when a table has been dropped by hand. */
export async function dbMigrate(): Promise<DbHealth> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<DbHealth>("db_migrate");
}

export async function settingsLoad<T>(key: string): Promise<T | null> {
  if (!inTauri()) return null;
  return invoke<T | null>("settings_load", { key });
}

export async function settingsSave(key: string, value: unknown): Promise<void> {
  if (!inTauri()) return;
  await invoke("settings_save", { key, value });
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

export interface CodespaceInfo {
  name: string;
  displayName: string;
  repository: string;
  machineName: string;
  state: string;
}

export interface CodespacesStatus {
  ghAvailable: boolean;
  authenticated: boolean;
  codespaces: CodespaceInfo[];
  error: string | null;
}

export interface CodespaceBenchmarkResult {
  ok: boolean;
  runtime: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  remoteElapsedMs: number | null;
  peakMemoryKb: number | null;
  timedOut: boolean;
  truncated: boolean;
  codespace: string;
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

export async function codespacesStatus(): Promise<CodespacesStatus> {
  if (!inTauri()) {
    return {
      ghAvailable: false,
      authenticated: false,
      codespaces: [],
      error: NOT_TAURI,
    };
  }
  return invoke<CodespacesStatus>("codespaces_status");
}

export async function codespaceBenchmark(args: {
  codespace: string;
  language: string;
  code: string;
  stdin?: string;
  timeoutMs?: number;
}): Promise<CodespaceBenchmarkResult> {
  if (!inTauri()) throw new Error(NOT_TAURI);
  return invoke<CodespaceBenchmarkResult>("codespace_benchmark", { req: args });
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
