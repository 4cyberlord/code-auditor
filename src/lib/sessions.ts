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
