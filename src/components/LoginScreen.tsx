"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PIN_LENGTH,
  authLogin,
  authStatus,
  humanSeconds,
  lockSecondsLeft,
  reason,
  sanitizePin,
  type AuthGate,
  type AuthStatus,
} from "@/lib/auth";

/**
 * The door.
 *
 * Two screens, not three: there is no sign-up. Rust provisions the owner the
 * first time it sees an empty `app_users`, so the only questions this can ask
 * are "which database?" and "what is the PIN?".
 *
 * The layout is a split -- the product on the left, the form on the right --
 * because the window is 1080px wide at its narrowest and a 380px card floating
 * in the middle of that reads as a dialog that lost its parent. The left half is
 * built from the app icon's own four quadrant colours, so the door looks like
 * the thing behind it.
 *
 * The PIN is four digits, which is only defensible because the Rust side locks
 * the account after five wrong ones. That makes the countdown below not a
 * decoration but the security control itself, so it gets the loudest line on the
 * panel rather than a toast that scrolls away.
 */
export default function LoginScreen({
  gate,
  status,
  onChanged,
}: {
  gate: AuthGate;
  status: AuthStatus | null;
  onChanged: (next: AuthStatus) => void;
}) {
  const [username, setUsername] = useState(status?.username ?? "");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ticks only while a lockout is open, so an idle login screen is not holding a
  // timer open for the life of the app.
  const [left, setLeft] = useState(() => lockSecondsLeft(status?.lockedUntil ?? null));
  useEffect(() => {
    setLeft(lockSecondsLeft(status?.lockedUntil ?? null));
    if (!status?.lockedUntil) return;
    const id = setInterval(() => setLeft(lockSecondsLeft(status.lockedUntil)), 1000);
    return () => clearInterval(id);
  }, [status?.lockedUntil]);

  const locked = left > 0;

  const pinField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    pinField.current?.focus();
  }, [gate]);

  // Rust knows the owner's name; the field should show it rather than making
  // someone type their own name at their own laptop every morning.
  useEffect(() => {
    if (status?.username && !username) setUsername(status.username);
  }, [status?.username, username]);

  /**
   * `candidate` exists because of a bug worth remembering.
   *
   * `onPin` submits the instant the fourth digit lands, but the `signIn` it can
   * see was built during the previous render — when `pin` still held three
   * digits. So a perfectly correct PIN failed its own length check and reported
   * "The PIN is 4 digits", every time, before any attempt was made. Reading the
   * digits from the caller rather than from state is what makes the check see
   * what the person actually typed.
   */
  const signIn = useCallback(async (candidate?: string) => {
    const entered = candidate ?? pin;
    setError(null);
    // Shape is checked here so an obviously-wrong PIN never costs one of the five
    // tries. Rust checks it again; this only saves the attempt.
    if (entered.length !== PIN_LENGTH) {
      setError(`The PIN is ${PIN_LENGTH} digits.`);
      return;
    }

    setBusy(true);
    try {
      // Nothing is remembered: the session token lives in memory for the life
      // of the process, so quitting signs you out. The old "keep me signed in"
      // checkbox stored a thirty-day token on this Mac, which is exactly the
      // thing that made a copy of the laptop a copy of the account.
      onChanged(await authLogin(username.trim(), entered, false));
    } catch (err) {
      setError(reason(err));
      setPin("");
      pinField.current?.focus();
      // A wrong PIN may have opened a lockout window, and only Rust knows. Ask,
      // so the countdown starts and the form disables itself -- otherwise the
      // screen keeps accepting tries the database will refuse.
      void authStatus().then(onChanged).catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [username, pin, onChanged]);

  // Four digits is the whole credential, so asking for a button press afterwards
  // is a keystroke that carries no information.
  const onPin = (raw: string) => {
    const next = sanitizePin(raw);
    setPin(next);
    if (next.length === PIN_LENGTH && !busy && !locked) {
      // Hand the digits over rather than waiting for state to catch up.
      queueMicrotask(() => void signIn(next));
    }
  };

  const message = locked
    ? { tone: "bad", text: `Too many wrong PINs. Try again in ${humanSeconds(left)}.` }
    : error
      ? { tone: "bad", text: error }
      : status?.problem
          ? { tone: "warn", text: status.problem }
          : gate === "login" &&
              status?.attemptsRemaining != null &&
              status.attemptsRemaining <= 2
            ? {
                tone: "warn",
                text: `${status.attemptsRemaining} ${
                  status.attemptsRemaining === 1 ? "try" : "tries"
                } left before the account locks.`,
              }
            : null;

  return (
    <div className="auth">
      {/* The titlebar spans both halves so the window can still be dragged and
          still looks like itself while locked. */}
      <div className="auth-drag" data-tauri-drag-region />

      <aside className="auth-brand" aria-hidden="true">
        <div className="auth-glow" />
        <div className="auth-grid" />

        <div className="auth-brand-body">
          <div className="auth-icon">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/app-icon.png" alt="" width={76} height={76} />
          </div>

          <h1 className="auth-wordmark">Council Editor</h1>
          <p className="auth-tagline">
            Private solving workspace, locked to this Mac.
          </p>

          <div className="auth-status-strip" aria-hidden="true">
            <span>Local Keychain</span>
            <span>Supabase</span>
            <span>Council</span>
          </div>

          <ul className="auth-points">
            <li data-q="a">Capture the question in front of you</li>
            <li data-q="b">Read screenshots before reasoning from them</li>
            <li data-q="c">Run and benchmark code before trusting it</li>
            <li data-q="d">Keep every result in your own history</li>
          </ul>
        </div>

        <p className="auth-foot-note">
          Your keys, your database, your machine.
        </p>
      </aside>

      <main className="auth-panel">
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || locked) return;
            void signIn();
          }}
        >
          <h2>Unlock workbench</h2>
          <p className="auth-sub">Enter your username and PIN.</p>

          <label className="auth-field">
            <span>Username</span>
            <input
              className="field"
              autoComplete="username"
              spellCheck={false}
              autoCapitalize="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={locked}
            />
          </label>

          <label className="auth-field">
            <span>PIN</span>
            {/* One input, four cells. The boxes are painted underneath and the
                real field sits on top with a transparent face, so there is
                exactly one thing to focus and paste into -- four separate
                inputs look the same and behave badly for both. */}
            <span className="pin" data-locked={locked}>
              <input
                ref={pinField}
                className="pin-input"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                maxLength={PIN_LENGTH}
                value={pin}
                onChange={(e) => onPin(e.target.value)}
                disabled={locked}
                aria-label="PIN"
              />
              <span className="pin-cells" aria-hidden="true">
                {Array.from({ length: PIN_LENGTH }, (_, i) => (
                  <i key={i} data-on={i < pin.length} data-next={i === pin.length && !locked} />
                ))}
              </span>
            </span>
          </label>

          {message && (
            <p className="auth-msg" data-tone={message.tone}>
              {message.text}
            </p>
          )}

          <button className="btn primary auth-go" type="submit" disabled={busy || locked}>
            {busy ? "Working…" : "Unlock"}
          </button>

          <p className="auth-hint">
            Forgotten the PIN? It cannot be recovered from this Mac — nothing about the account
            is stored here. Ask whoever administers the workspace to set a new one.
          </p>
        </form>
      </main>
    </div>
  );
}
