"use client";

import { useEffect } from "react";
import { useStore } from "@/lib/store";

/**
 * Takes the boot screen down once there is something behind it.
 *
 * The overlay is server-rendered markup, so it is on screen before React
 * exists. Removing it is the only part that needs the app — and "the app is
 * ready" is not "React mounted": settings are read from disk asynchronously, so
 * mounting only means the window can now show an empty shell. Waiting for
 * settings means the first thing anyone sees is the real interface rather than
 * a flash of defaults being corrected.
 *
 * It fades rather than cutting, because a hard swap at this size reads as a
 * flicker — and it is skipped entirely for anyone who asked for less motion.
 */
export default function BootScreen() {
  const ready = useStore((s) => s.hydrated);

  useEffect(() => {
    if (!ready) return;
    const el = document.getElementById("boot");
    if (!el) return;

    // One frame, so the browser has painted the app underneath before the
    // overlay starts to go. Without it the fade races the first paint and you
    // see the empty shell through it.
    const raf = requestAnimationFrame(() => {
      el.setAttribute("data-done", "true");
      window.setTimeout(() => el.remove(), 400);
    });
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  return null;
}
