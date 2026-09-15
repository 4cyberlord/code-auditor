"use client";

import { useState } from "react";
import {
  PIN_LENGTH,
  authChangePin,
  pinProblem,
  reason,
  sanitizePin,
  useAuth,
} from "@/lib/auth";

/**
 * The signed-in account, and the two things you can do to it.
 *
 * Changing the PIN needs to be here for a reason that is easy to miss: without
 * it the only way to rotate the credential is to delete a row in the Supabase SQL
 * editor and set the whole thing up again. A credential with no rotation path is
 * one people never rotate.
 */
export default function AccountCard() {
  const status = useAuth((s) => s.status);
  const signOut = useAuth((s) => s.signOut);

  const [open, setOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [nextPin, setNextPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reset = () => {
    setCurrentPin("");
    setNextPin("");
    setConfirm("");
    setError(null);
  };

  const change = async () => {
    setError(null);
    setNote(null);

    // Checked here so a typo never reaches the account's failure counter.
    const bad = pinProblem(nextPin);
    if (bad) {
      setError(bad);
      return;
    }
    if (nextPin !== confirm) {
      setError("The two new PINs are not the same.");
      return;
    }

    setBusy(true);
    try {
      await authChangePin(currentPin, nextPin, confirm);
      reset();
      setOpen(false);
      setNote("PIN changed. Every remembered sign-in was signed out.");
    } catch (err) {
      setError(reason(err));
      setCurrentPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-card">
      <div className="top">
        <span className="dot" style={{ background: "var(--good)" }} />
        <span className="name">{status?.username ?? "Account"}</span>
        <span className="vendor">signed in on this Mac</span>
        <span className="spacer" />
        <button className="btn tiny ghost" onClick={() => void signOut()}>
          Sign out
        </button>
        <button
          className="btn tiny"
          onClick={() => {
            reset();
            setNote(null);
            setOpen((v) => !v);
          }}
        >
          {open ? "Cancel" : "Change PIN"}
        </button>
      </div>

      {open && (
        <>
          <div className="row">
            <label htmlFor="pin-now">Current PIN</label>
            <input
              id="pin-now"
              className="field mono"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={PIN_LENGTH}
              value={currentPin}
              onChange={(e) => setCurrentPin(sanitizePin(e.target.value))}
            />
          </div>

          <div className="row">
            <label htmlFor="pin-new">New PIN</label>
            <input
              id="pin-new"
              className="field mono"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={PIN_LENGTH}
              value={nextPin}
              onChange={(e) => setNextPin(sanitizePin(e.target.value))}
            />
          </div>

          <div className="row">
            <label htmlFor="pin-again">Confirm</label>
            <div className="with-btn">
              <input
                id="pin-again"
                className="field mono"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={PIN_LENGTH}
                value={confirm}
                onChange={(e) => setConfirm(sanitizePin(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void change();
                }}
              />
              <button
                className="btn"
                onClick={() => void change()}
                disabled={busy || currentPin.length !== PIN_LENGTH || nextPin.length !== PIN_LENGTH}
              >
                {busy ? "Changing…" : "Change"}
              </button>
            </div>
          </div>
        </>
      )}

      {error && (
        <p className="hint" style={{ margin: "0 0 6px", color: "var(--bad)" }}>
          {error}
        </p>
      )}

      {note && (
        <p className="hint" style={{ margin: "0 0 6px", color: "var(--good)" }}>
          {note}
        </p>
      )}

      <p className="hint" style={{ margin: 0 }}>
        Your PIN is checked on the server against a peppered hash. Five wrong tries trigger a
        longer lockout, and this Mac only keeps the current session in memory. There is no recovery:
        if you forget it, ask the workspace administrator to set a new one.
      </p>
    </div>
  );
}
