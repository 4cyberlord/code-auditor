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
 * grab a second region or type a note before spending four API calls.
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
  /** R for Region: drag a box. */
  capture: "Control+Alt+R",
  /** L / R for the automatic halves of the display containing the app. */
  captureLeft: "Control+Alt+Shift+L",
  captureRight: "Control+Alt+Shift+R",
  /** A for Audit: hand it to the agents. */
  solve: "Control+Alt+A",
} as const;

/** How those read on a Mac keyboard. */
export const SHORTCUT_LABELS = {
  captureScreen: "⌃⌥S",
  capture: "⌃⌥R",
  captureLeft: "⌃⌥⇧L",
  captureRight: "⌃⌥⇧R",
  solve: "⌃⌥A",
} as const;

type CaptureKind = "region" | "screen" | "left" | "right";

async function captureIntoApp(kind: CaptureKind) {
  const store = useStore.getState();
  try {
    const captures =
      kind === "screen"
        ? await bridge.captureScreen()
        : kind === "left"
          ? await bridge.captureLeftHalf()
          : kind === "right"
            ? await bridge.captureRightHalf()
            : await bridge.captureSelection();
    // Null means Escape during selection. Nothing to report.
    if (!captures || captures.length === 0) return;

    // Each display, through the same path a drop or a paste takes. One keypress
    // can therefore produce several images: one per screen, and each screen cut
    // into overlapping tiles rather than shrunk -- because shrinking is exactly
    // what makes the code inside a screenshot unreadable.
    const assets = [];
    for (const capture of captures) {
      const blob = await (await fetch(capture.dataUrl)).blob();
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

function solveNow() {
  const store = useStore.getState();
  if (store.running) return;
  void store.start();
}

export function useGlobalShortcuts() {
  useEffect(() => {
    if (!bridge.inTauri()) return;

    let disposed = false;
    const listeners: UnlistenFn[] = [];

    // Both the hotkeys and the tray menu items emit these, so there is one code
    // path whichever way the user asked.
    void Promise.all([
      listen("shortcut://capture", () => void captureIntoApp("region")),
      listen("shortcut://capture-screen", () => void captureIntoApp("screen")),
      listen("shortcut://capture-left", () => void captureIntoApp("left")),
      listen("shortcut://capture-right", () => void captureIntoApp("right")),
      listen("shortcut://solve", solveNow),
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
