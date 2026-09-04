"use client";

import { useCallback, useEffect, useState } from "react";
import * as bridge from "@/lib/bridge";
import { reason } from "@/lib/auth";

/**
 * Background capture, and the one credential this Mac keeps.
 *
 * The helper runs as a launch agent, so it works when the app is closed — which
 * is the whole point of it, and also why it cannot borrow the app's sign-in:
 * that lives in this process's memory and dies with it. It gets a session of its
 * own instead, thirty days long, revocable from the database, replaced rather
 * than added to each time this button is pressed.
 *
 * Saying all of that on the card matters. This is the only thing stored on the
 * machine now, and a credential nobody can see the terms of is one nobody
 * thinks about until it is a problem.
 */
export default function HelperCard() {
  const [auth, setAuth] = useState<bridge.HelperAuth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setAuth(await bridge.helperAuthStatus());
    } catch (err) {
      setError(reason(err));
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const authorise = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await bridge.helperAuthorize();
      setAuth(next);
      setNote("Background capture authorised. Any previous authorisation was revoked.");
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await bridge.helperDeauthorize();
      setNote("Removed from this Mac. The helper will stop when it next tries to sync.");
      await refresh();
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  };

  // Rendered as a date rather than "in 27 days" on purpose: a date is something
  // you can put in a calendar, and this is a thing that stops working silently.
  const expires = auth?.expiresAt
    ? new Date(auth.expiresAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  const daysLeft = auth?.expiresAt
    ? Math.ceil((new Date(auth.expiresAt).getTime() - now) / 86_400_000)
    : null;
  const expiringSoon = daysLeft !== null && daysLeft <= 7 && daysLeft > 0;

  return (
    <div className="provider-card">
      <div className="top">
        <span
          className="dot"
          style={{
            background: auth?.authorised
              ? expiringSoon
                ? "var(--warn)"
                : "var(--good)"
              : "var(--line)",
          }}
        />
        <span className="name">Background capture</span>
        <span className="vendor">
          {auth?.authorised
            ? expiringSoon
              ? `expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
              : `authorised until ${expires}`
            : "not authorised"}
        </span>
        <span className="spacer" />
        {auth?.authorised && (
          <button className="btn tiny ghost" disabled={busy} onClick={() => void revoke()}>
            Remove
          </button>
        )}
        <button className="btn tiny" disabled={busy} onClick={() => void authorise()}>
          {busy ? "Working…" : auth?.authorised ? "Renew" : "Authorise"}
        </button>
      </div>

      <p className="hint" style={{ margin: "8px 0 0" }}>
        The capture hotkeys work while Council Editor is closed, so the helper needs a sign-in of
        its own. It is a thirty-day session stored in the macOS Keychain — the only thing this app
        keeps on your Mac. Renewing replaces it; removing it here stops this machine, and revoking
        the session in the database stops it everywhere.
      </p>

      {error && (
        <p className="hint" style={{ margin: "6px 0 0", color: "var(--bad)" }}>
          {error}
        </p>
      )}
      {note && !error && (
        <p className="hint" style={{ margin: "6px 0 0", color: "var(--good)" }}>
          {note}
        </p>
      )}
    </div>
  );
}
