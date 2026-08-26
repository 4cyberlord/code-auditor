"use client";

import { useEffect } from "react";
import * as bridge from "./bridge.ts";
import { useStore, type DeltaBatchEntry } from "./store.ts";

/**
 * Wires the Rust event stream into the store.
 *
 * Deltas arrive token by token from four sources at once. Writing each one
 * straight into React state would mean thousands of renders a minute, so they
 * are buffered and flushed on the next animation frame instead.
 *
 * The buffer and the frame handle live inside the effect rather than in refs.
 * Nothing outside the subscription ever reads them, the effect runs once, and a
 * ref read from a cleanup function is the exact shape that goes stale when the
 * surrounding code later changes -- which is what `react-hooks/exhaustive-deps`
 * warns about.
 */
export function useAgentEvents() {
  useEffect(() => {
    let disposed = false;
    let frame: number | null = null;
    const unlisteners: bridge.UnlistenLike[] = [];

    // Keyed by attempt, not by agent: a rerun of the same pane is a different
    // attempt, and its tokens must never be concatenated onto its predecessor's.
    const pending = new Map<string, DeltaBatchEntry>();

    const flush = () => {
      frame = null;
      const batch = [...pending.values()];
      pending.clear();
      if (batch.length) useStore.getState().appendDeltas(batch);
    };

    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(flush);
    };

    (async () => {
      const [d, done, err, probe] = await Promise.all([
        bridge.onDelta((e) => {
          const buffered = pending.get(e.attemptId);
          if (buffered) buffered.delta += e.delta;
          else
            pending.set(e.attemptId, {
              agentId: e.agentId,
              attemptId: e.attemptId,
              delta: e.delta,
            });
          schedule();
        }),
        bridge.onDone((e) => {
          flush();
          useStore.getState().finishAgent(e);
        }),
        bridge.onError((e) => {
          flush();
          useStore.getState().failAgent(e);
        }),
        bridge.onProbeResult((r) => {
          useStore.getState().recordProbe(r);
        }),
      ]);
      if (disposed) {
        d();
        done();
        err();
        probe();
        return;
      }
      unlisteners.push(d, done, err, probe);
    })().catch(() => {
      // Outside the Tauri shell there is no event bus; the UI still renders.
    });

    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      pending.clear();
      unlisteners.forEach((u) => u());
    };
  }, []);
}
