"use client";

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./bridge.ts";

/**
 * Session storage, as the UI sees it.
 *
 * Every call here reaches Postgres. Outside the desktop shell there is no bridge,
 * so the read calls degrade to empty rather than throwing: the app should still
 * render in a browser tab with an empty sidebar, not a stack trace.
 */

const NO_SHELL = "Sessions need the desktop shell. Launch with `npm run app:dev`.";

export interface Session {
  id: string;
  title: string;
  note: string;
  context: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  screenshotCount: number;
  runCount: number;
}

export interface StoredScreenshot {
  id: string;
  sessionId: string;
  position: number;
  localPath: string | null;
  storagePath: string | null;
  fileName: string;
  bytes: number;
  mime: string;
  capturedAt: string;
  /** The row survives, the image does not. History still reads correctly. */
  purged: boolean;
}

export interface NewScreenshot {
  sessionId: string;
  /** Where the bytes actually live, now that they are not on this machine. */
  storageBucket: string;
  storagePath: string;
  fileName: string;
  bytes: number;
  mime: string;
  width?: number | null;
  height?: number | null;
}

export interface ResponseIn {
  provider: string;
  model: string;
  attemptId: string;
  status: string;
  body: string;
  finalKind: string | null;
  finalLanguage: string | null;
  finalAnswer: string | null;
  finalCode: string | null;
  finalClaims: string[];
  complexity: string | null;
  confidence: number | null;
  wellFormed: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number | null;
  error: string | null;
}

export interface VerdictIn {
  verdict: string;
  headline: string | null;
  detail: string | null;
  reliability: string | null;
  camps: string[][];
  outliers: string[];
  representative: string | null;
  judgeProvider: string | null;
  judgeText: string | null;
}

export type SolveJobStatus =
  | "queued"
  | "running"
  | "needs_attention"
  | "failed"
  | "completed"
  | "cancelled";

export interface SolveJob {
  id: string;
  sessionId: string;
  mode: "council";
  status: SolveJobStatus;
  progressPhase: string;
  settingsSnapshot: Record<string, unknown>;
  error: string | null;
  resultSummary: string;
  createdAt: string;
  claimedAt: string;
  startedAt: string;
  finishedAt: string;
  updatedAt: string;
}

export interface SolveJobEvent {
  id: string;
  jobId: string;
  level: "info" | "warn" | "error";
  phase: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SolveJobImage {
  id: string;
  jobId: string;
  sessionId: string;
  position: number;
  storageBucket: string;
  storagePath: string;
  fileName: string;
  bytes: number;
  mime: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface CouncilReportSummary {
  id: string;
  jobId: string;
  sessionId: string;
  winner: string | null;
  synthesis: string;
  markdown: string;
  report: Record<string, unknown>;
  createdAt: string;
}

export interface NewSolveJobImage {
  storageBucket: string;
  storagePath: string;
  fileName: string;
  bytes: number;
  mime: string;
  width?: number | null;
  height?: number | null;
}

// ------------------------------------------------------------------ sessions

export async function listSessions(status: "active" | "archived"): Promise<Session[]> {
  if (!inTauri()) return [];
  return invoke<Session[]>("session_list", { status });
}

export async function createSession(title = ""): Promise<string> {
  if (!inTauri()) throw new Error(NO_SHELL);
  return invoke<string>("session_create", { title });
}

/** `field` is validated in Rust against a fixed list of columns. */
export async function updateSession(
  id: string,
  field: "title" | "note" | "context",
  value: string
): Promise<void> {
  if (!inTauri()) throw new Error(NO_SHELL);
  await invoke("session_update", { id, field, value });
}

export async function setSessionStatus(
  id: string,
  status: "active" | "archived"
): Promise<void> {
  if (!inTauri()) throw new Error(NO_SHELL);
  await invoke("session_set_status", { id, status });
}

/**
 * Deletes the session and everything under it. Resolves to the local paths of
 * its screenshots so the caller can decide whether to delete the files too --
 * losing the record and losing the pictures are separate choices.
 */
export async function deleteSession(id: string): Promise<string[]> {
  if (!inTauri()) throw new Error(NO_SHELL);
  return invoke<string[]>("session_delete", { id });
}

// --------------------------------------------------------------- screenshots

export async function listScreenshots(sessionId: string): Promise<StoredScreenshot[]> {
  if (!inTauri()) return [];
  return invoke<StoredScreenshot[]>("screenshot_list", { sessionId });
}

export async function addScreenshot(shot: NewScreenshot): Promise<string> {
  if (!inTauri()) throw new Error(NO_SHELL);
  return invoke<string>("screenshot_add", { shot });
}

export async function removeScreenshot(id: string): Promise<void> {
  if (!inTauri()) throw new Error(NO_SHELL);
  await invoke("screenshot_remove", { id });
}

export async function reorderScreenshots(
  sessionId: string,
  orderedIds: string[]
): Promise<void> {
  if (!inTauri()) throw new Error(NO_SHELL);
  await invoke("screenshot_reorder", { sessionId, orderedIds });
}

/** Destroys the images, keeps the rows. Returns the paths that were cleared. */
export async function purgeScreenshots(sessionId: string): Promise<string[]> {
  if (!inTauri()) throw new Error(NO_SHELL);
  return invoke<string[]>("screenshots_purge", { sessionId });
}

// ---------------------------------------------------------------------- runs

export async function saveRun(args: {
  sessionId: string;
  mode: string;
  asked: string;
  /** How the agents were given the problem: images | extract | both. */
  contextMode: string;
  /** The cross-checked reading they worked from, when there was one. */
  extractedContext: string;
  /** Null when no vision pass ran; false when the two readers disagreed. */
  extractionAgreed: boolean | null;
  responses: ResponseIn[];
  verdict: VerdictIn | null;
}): Promise<string> {
  if (!inTauri()) throw new Error(NO_SHELL);
  return invoke<string>("run_save", args);
}

// ------------------------------------------------------------- solve jobs

// ------------------------------------------------------------------ history

/** One past run, as the sidebar lists it. */
export interface RunSummary {
  id: string;
  sessionId: string;
  mode: string;
  /** The note as it stood when the run was launched, not as the session reads now. */
  asked: string;
  startedAt: string;
  finishedAt: string;
  answered: number;
  verdict: string | null;
  reliability: string | null;
}

/** What one model said, read back out of the run it said it in. */
export interface StoredResponse {
  id: string;
  provider: string;
  model: string;
  attemptId: string;
  status: string;
  body: string;
  finalKind: string | null;
  finalLanguage: string | null;
  finalAnswer: string | null;
  finalCode: string | null;
  finalClaims: string[];
  complexity: string | null;
  confidence: number | null;
  wellFormed: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number | null;
  error: string | null;
}

export interface StoredVerdict {
  verdict: string;
  headline: string | null;
  detail: string | null;
  reliability: string | null;
  outliers: string[];
  representative: string | null;
  judgeProvider: string | null;
  judgeText: string | null;
}

export interface RunDetail {
  run: RunSummary;
  responses: StoredResponse[];
  verdict: StoredVerdict | null;
}

/** Every finished run in this session, newest first. */
export async function listRuns(sessionId: string): Promise<RunSummary[]> {
  return invoke<RunSummary[]>("run_list", { sessionId });
}

/** One run in full — every model's answer as it was stored. */
export async function getRun(runId: string): Promise<RunDetail> {
  return invoke<RunDetail>("run_get", { runId });
}

export async function createSolveJob(job: {
  sessionId: string;
  settingsSnapshot: Record<string, unknown>;
  images: NewSolveJobImage[];
}): Promise<string> {
  if (!inTauri()) throw new Error(NO_SHELL);
  return invoke<string>("solve_job_create", { job });
}

export async function listSolveJobs(
  status: SolveJobStatus | "all" = "all"
): Promise<SolveJob[]> {
  if (!inTauri()) return [];
  return invoke<SolveJob[]>("solve_job_list", { status });
}

export async function listSolveJobEvents(jobId: string): Promise<SolveJobEvent[]> {
  if (!inTauri()) return [];
  return invoke<SolveJobEvent[]>("solve_job_event_list", { jobId });
}

export async function listSolveJobImages(jobId: string): Promise<SolveJobImage[]> {
  if (!inTauri()) return [];
  return invoke<SolveJobImage[]>("solve_job_image_list", { jobId });
}

export async function getCouncilReport(
  jobId: string
): Promise<CouncilReportSummary | null> {
  if (!inTauri()) return null;
  return invoke<CouncilReportSummary | null>("council_report_get", { jobId });
}
