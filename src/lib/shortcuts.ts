"use client";

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as bridge from "./bridge.ts";
import { assetsFromBlob } from "./image.ts";
import { useStore } from "./store.ts";

/**
 * System-wide shortcuts, so a problem goes from "on screen somewhere" to "four
 * agents working on it" without the app needing focus first.
 *
 * Capture and solve are two keys rather than one on purpose: it leaves room to
 * grab a second screenshot or type a note before spending four API calls.
 *
 * The accelerators are claimed in Rust (`src-tauri/src/lib.rs`), not here. This
 * side only listens for the resulting event. Registering from the webview meant
 * the hotkey lived and died with a React effect: Strict Mode mounts every effect
 * twice, and the first pass's cleanup unregisters by accelerator name, which is
 * global -- so it could tear down the registration the second pass had just
 * made, leaving both keys dead with nothing logged. A reload of the dev server
 * could do the same. Rust registers once per process and cannot lose the race.
 */
export const SHORTCUTS = {
  /** S for Screen: grab the whole display, no aiming. */
  captureScreen: "Control+Alt+S",
  /** L / R for the automatic halves of the display containing the app. */
  captureLeft: "Control+Alt+Shift+L",
  captureRight: "Control+Alt+Shift+R",
  /** A for Audit: hand it to the agents. */
  solve: "Control+Alt+A",
} as const;

/** How those read on a Mac keyboard. */
export const SHORTCUT_LABELS = {
  captureScreen: "⌃⌥S",
  captureLeft: "⌃⌥⇧L",
  captureRight: "⌃⌥⇧R",
  solve: "⌃⌥A",
} as const;

type CaptureKind = "screen" | "left" | "right";

/**
 * Turn the Rust-side data URL into a Blob without asking WKWebView to fetch a
 * `data:` URL. WebKit can reject those loads with the unhelpful "Load failed"
 * error even though `screencapture` has already written a perfectly good PNG.
 */
function captureBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error("Council Editor received an invalid captured image.");

  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw new Error("Council Editor could not decode the captured image.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: match[1] });
}

/**
 * Capture through the same ingestion path used by global shortcuts. Exported so
 * the visible capture controls can remain useful when macOS declines a global
 * shortcut or another utility has already claimed it.
 */
export async function captureIntoApp(kind: CaptureKind) {
  const store = useStore.getState();
  try {
    const captures =
      kind === "screen"
        ? await bridge.captureScreen()
        : kind === "left"
          ? await bridge.captureLeftHalf()
          : await bridge.captureRightHalf();
    // No capture means there was no valid image to stage.
    if (!captures || captures.length === 0) return;

    // Each display, through the same path a drop or a paste takes. One keypress
    // can therefore produce several images: one per screen, and each screen cut
    // into overlapping tiles rather than shrunk -- because shrinking is exactly
    // what makes the code inside a screenshot unreadable.
    const assets = [];
    for (const capture of captures) {
      const blob = captureBlob(capture.dataUrl);
      // Named after the file on disk, so what is on screen and what is in
      // ~/Library/Application Support/.com.apple.mds/cache/captures can be matched up by eye.
      const name = capture.path.split("/").pop() || "capture.png";
      // A left/right shortcut already names the exact visual unit to send. Do
      // not tile it again: the two halves must remain two complete attachments.
      // The normal whole-screen shortcut keeps the legibility-preserving tiles.
      const pieces = await assetsFromBlob(blob, name, { tile: kind !== "left" && kind !== "right" });
      assets.push(...pieces.map((a) => ({ ...a, localPath: capture.path })));
    }
    store.addImages(assets);

    // Only if asked. A global capture shortcut exists so you can grab something
    // without leaving what you are looking at; stealing focus afterwards undoes
    // the one thing it was for. The image is in the app either way.
    if (store.settings.raiseOnCapture) {
      const win = getCurrentWindow();
      await win.show();
      await win.unminimize();
      await win.setFocus();
    }
  } catch (err) {
    store.setShortcutError(`Screen capture failed: ${String(err)}`);
  }
}

export function useGlobalShortcuts() {
  useEffect(() => {
    if (!bridge.inTauri()) return;

    let disposed = false;
    const listeners: UnlistenFn[] = [];

    // Both the hotkeys and the tray menu items emit these, so there is one code
    // path whichever way the user asked.
    void Promise.all([
      listen("shortcut://capture-screen", () => void captureIntoApp("screen")),
      listen("shortcut://capture-left", () => void captureIntoApp("left")),
      listen("shortcut://capture-right", () => void captureIntoApp("right")),
    ])
      .then((fns) => {
        if (disposed) fns.forEach((f) => f());
        else listeners.push(...fns);
      })
      .catch(() => {
        /* no event bus outside the shell */
      });

    return () => {
      disposed = true;
      listeners.forEach((f) => f());
    };
  }, []);
}
