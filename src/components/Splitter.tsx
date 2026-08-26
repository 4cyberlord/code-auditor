"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * A drag handle between two panes.
 *
 * Writes a CSS custom property on a parent element rather than moving anything
 * itself, so the layout stays entirely in CSS grid and this only has to know a
 * number. That keeps the drag cheap -- no React state changes while the mouse
 * moves, which is what makes hand-rolled splitters feel sticky.
 */

interface Props {
  /** "col" drags left/right, "row" drags up/down. */
  axis: "col" | "row";
  /** The custom property to write, e.g. "--rail-w". */
  variable: string;
  /** Where to write it. Defaults to the document root. */
  target?: () => HTMLElement | null;
  min: number;
  max: number;
  /** Restores this width when the handle is double-clicked. */
  reset: number;
  /** Persisted so a layout survives a restart. */
  storageKey: string;
  /** Dragging right/down makes the measured pane smaller. */
  invert?: boolean;
}

export default function Splitter({
  axis,
  variable,
  target,
  min,
  max,
  reset,
  storageKey,
  invert = false,
}: Props) {
  const dragging = useRef(false);
  const start = useRef(0);
  const startSize = useRef(0);

  const el = useCallback(
    () => target?.() ?? document.documentElement,
    [target]
  );

  const apply = useCallback(
    (px: number, remember: boolean) => {
      const clamped = Math.round(Math.min(max, Math.max(min, px)));
      el()?.style.setProperty(variable, `${clamped}px`);
      if (remember) {
        try {
          window.localStorage.setItem(storageKey, String(clamped));
        } catch {
          /* private mode: the layout just will not persist */
        }
      }
    },
    [el, max, min, storageKey, variable]
  );

  // Restore on mount, before the first paint the user notices.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) apply(Number(saved), false);
    } catch {
      /* nothing saved, or storage unavailable */
    }
  }, [apply, storageKey]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      const delta = (axis === "col" ? e.clientX : e.clientY) - start.current;
      apply(startSize.current + (invert ? -delta : delta), false);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.removeAttribute("data-dragging");
      // Written once, at the end. Touching localStorage on every pointer move
      // is a synchronous write per frame.
      const now = el()?.style.getPropertyValue(variable);
      if (now) apply(parseFloat(now), true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [apply, axis, el, invert, variable]);

  const down = (e: React.PointerEvent) => {
    const current = el()?.style.getPropertyValue(variable);
    const measured = current ? parseFloat(current) : reset;
    dragging.current = true;
    start.current = axis === "col" ? e.clientX : e.clientY;
    startSize.current = measured;
    // Stops the cursor flickering between resize and text-select mid-drag.
    document.body.setAttribute("data-dragging", axis);
  };

  return (
    <div
      className="splitter"
      data-axis={axis}
      role="separator"
      aria-orientation={axis === "col" ? "vertical" : "horizontal"}
      title="Drag to resize · double-click to reset"
      onPointerDown={down}
      onDoubleClick={() => apply(reset, true)}
    />
  );
}
