"use client";

import { useStore } from "@/lib/store";

/**
 * The notification tray.
 *
 * Sits top-centre under the titlebar rather than in a corner: it is the app's
 * own status voice and should be visible at a glance, but never in the way of
 * the panes. Errors stick until dismissed — a failed model check is exactly
 * the message you do NOT want evaporating while you read another pane.
 */
export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (!toasts.length) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind}>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            <div className="toast-text">{t.body}</div>
          </div>
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
