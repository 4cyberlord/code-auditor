"use client";

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as bridge from "./bridge";

/**
 * Mirrors the window's fullscreen state onto the document element as
 * `data-fullscreen`, so the stylesheet can react to it.
 *
 * The titlebar carries a fixed 82px inset on the left to clear the macOS
 * traffic lights, which sit over the content because the window is configured
 * `titleBarStyle: "Overlay"`. In fullscreen macOS takes those buttons away, and
 * the inset becomes a gap with the app name stranded to the right of nothing.
 *
 * There is no web signal for this: macOS fullscreen is a native window
 * transition, so `display-mode: fullscreen` never matches inside the webview.
 * The resize that accompanies the transition is what we have, and the window's
 * own fullscreen flag is already set by the time it arrives.
 */
export function useWindowChrome() {
  useEffect(() => {
    if (!bridge.inTauri()) return;

    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    const apply = async () => {
      try {
        const fullscreen = await getCurrentWindow().isFullscreen();
        if (disposed) return;
        document.documentElement.dataset.fullscreen = fullscreen ? "true" : "false";
      } catch {
        // A window that will not answer is not a reason to take the app down;
        // the titlebar just keeps its windowed spacing.
      }
    };

    void apply();

    void getCurrentWindow()
      .onResized(() => void apply())
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
      delete document.documentElement.dataset.fullscreen;
    };
  }, []);
}
