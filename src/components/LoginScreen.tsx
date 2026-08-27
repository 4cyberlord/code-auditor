"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dbSaveUrl, dbTest } from "@/lib/bridge";
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
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState(status?.username ?? "");
  const [pin, setPin] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
  const urlField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    (gate === "connect" ? urlField : pinField).current?.focus();
  }, [gate]);

  // Rust knows the owner's name; the field should show it rather than making
  // someone type their own name at their own laptop every morning.
  useEffect(() => {
    if (status?.username && !username) setUsername(status.username);
  }, [status?.username, username]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await dbSaveUrl(url);
      const health = await dbTest();
      if (health.tablesMissing.length) {
        setError(health.advice ?? `Connected, but ${health.tablesMissing.join(", ")} are missing.`);
        return;
      }
      setNote(`Connected to ${health.target}.`);
      // Re-asked rather than patched locally: connecting is also what creates the
      // tables and provisions the owner, and only Rust knows the name it used.
      onChanged(await authStatus());
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  }, [url, onChanged]);

  const signIn = useCallback(async () => {
    setError(null);
    // Shape is checked here so an obviously-wrong PIN never costs one of the five
    // tries. Rust checks it again; this only saves the attempt.
    if (pin.length !== PIN_LENGTH) {
      setError(`The PIN is ${PIN_LENGTH} digits.`);
      return;
    }

    setBusy(true);
    try {
      onChanged(await authLogin(username.trim(), pin, remember));
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
  }, [username, pin, remember, onChanged]);

  // Four digits is the whole credential, so asking for a button press afterwards
  // is a keystroke that carries no information.
  const onPin = (raw: string) => {
    const next = sanitizePin(raw);
    setPin(next);
    if (next.length === PIN_LENGTH && !busy && !locked) {
      queueMicrotask(() => void signIn());
    }
  };

  const message = locked
    ? { tone: "bad", text: `Too many wrong PINs. Try again in ${humanSeconds(left)}.` }
    : error
      ? { tone: "bad", text: error }
      : note
        ? { tone: "good", text: note }
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

          <h1 className="auth-wordmark">Code Editor</h1>
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
            void (gate === "connect" ? connect() : signIn());
          }}
        >
          {gate === "connect" ? (
            <>
              <h2>Connect your database</h2>
              <p className="auth-sub">
                Your account lives in your own Postgres, so this comes first. The string is kept
                in the macOS Keychain and never reaches the app.
              </p>

              <label className="auth-field">
                <span>Connection string</span>
                <input
                  ref={urlField}
                  className="field mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="postgresql://postgres.<ref>:PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <h2>Unlock workbench</h2>
              <p className="auth-sub">Enter the owner PIN for this Mac.</p>
              <p className="auth-test">
                Testing login: <span className="mono">nimo</span> / <span className="mono">3313</span>
              </p>

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

              <label className="auth-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  disabled={locked}
                />
                <span>Keep me signed in on this Mac for 30 days</span>
              </label>
            </>
          )}

          {message && (
            <p className="auth-msg" data-tone={message.tone}>
              {message.text}
            </p>
          )}

          <button className="btn primary auth-go" type="submit" disabled={busy || locked}>
            {busy ? "Working…" : gate === "connect" ? "Connect" : "Unlock"}
          </button>

          {gate === "login" && (
            <p className="auth-hint">
              Forgotten the PIN? It cannot be recovered. Run{" "}
              <span className="mono">delete from app_users;</span> in the Supabase SQL editor and
              the next launch provisions a fresh one.
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
