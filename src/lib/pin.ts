/**
 * The rules a PIN and a username have to satisfy, and the arithmetic behind the
 * lockout countdown.
 *
 * Its own module, with no imports, for two reasons. It is the half of the login
 * that can be tested without a database, a Keychain or a running desktop shell --
 * `tests/auth.test.ts` imports exactly this file. And every rule here is a copy
 * of one in `src-tauri/src/auth.rs`, where the real check happens; keeping the
 * copy in one small file makes it obvious what has to be kept in step.
 *
 * Nothing here is a security boundary. It exists so a field can go red while you
 * are still typing, and so an obviously-malformed PIN never costs one of the
 * five tries before a lockout.
 */

export const PIN_LENGTH = 4;

/** Digits only, and never longer than the PIN. Applied as you type. */
export function sanitizePin(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, PIN_LENGTH);
}

/**
 * The same rules Rust enforces, for the same reason it enforces them: with four
 * digits and five tries before the first lockout, the handful of PINs everyone
 * picks are a materially better than random guess.
 *
 * Returns the complaint, or null when the PIN is fine.
 */
export function pinProblem(pin: string): string | null {
  if (pin.length !== PIN_LENGTH || !/^\d+$/.test(pin)) {
    return `The PIN has to be exactly ${PIN_LENGTH} digits.`;
  }

  const d = [...pin].map(Number);

  if (d.every((x) => x === d[0])) {
    return "That PIN is all one digit. Pick something less guessable.";
  }

  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) {
    return "That PIN is a run of consecutive digits. Pick something less guessable.";
  }

  if (d[0] === d[2] && d[1] === d[3]) {
    return "That PIN repeats a two-digit pattern. Pick something less guessable.";
  }

  const COMMON = ["1004", "2000", "2001", "2020", "1980", "1990", "1991", "1992", "1122", "5150"];
  if (COMMON.includes(pin)) {
    return "That PIN is one of the most commonly chosen. Pick something else.";
  }

  return null;
}

/** Returns the complaint, or null when the username is fine. */
export function usernameProblem(name: string): string | null {
  const n = name.trim();
  if (n.length < 3 || n.length > 32) {
    return "The username has to be between 3 and 32 characters.";
  }
  if (!/^[A-Za-z0-9._-]+$/.test(n)) {
    return "The username can use letters, digits, dot, dash and underscore.";
  }
  return null;
}

/**
 * Seconds left on a lockout, or 0. Clamped at zero rather than going negative,
 * because the countdown keeps ticking after the window closes and a "-3s"
 * on screen is how a UI tells you it stopped paying attention.
 */
export function lockSecondsLeft(lockedUntil: string | null, now = Date.now()): number {
  if (!lockedUntil) return 0;
  const t = Date.parse(lockedUntil);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

/** "4 minutes", "45 seconds" -- for the one sentence under a locked field. */
export function humanSeconds(secs: number): string {
  if (secs >= 3600) {
    const h = Math.ceil(secs / 3600);
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  if (secs >= 60) {
    const m = Math.ceil(secs / 60);
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  return `${secs} ${secs === 1 ? "second" : "seconds"}`;
}
