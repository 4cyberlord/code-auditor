/**
 * The lock, on this side of the bridge.
 *
 * Nothing here decides anything. Every credential check happens in Rust against
 * Postgres -- see `src-tauri/src/auth.rs` -- and this module only carries the
 * question across and renders the answer. The validators below are duplicated
 * from that file on purpose: they exist so the field can go red while you are
 * still typing, not to be trusted. Rust re-checks all of it, and Rust is the one
 * whose answer counts.
 */

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./bridge";
import { devLog } from "./devLog";

export interface AuthStatus {
  /** A connection string is saved. Until it is, there is nowhere for an account to live. */
  dbConfigured: boolean;
  /** An account exists. Read from the Keychain, so it survives the database being down. */
  claimed: boolean;
  username: string | null;
  authenticated: boolean;
  /** RFC3339, set only while a lockout window is open. */
  lockedUntil: string | null;
  /** Wrong PINs left before the next lockout. */
  attemptsRemaining: number | null;
  /** Why the answer is incomplete -- an unreachable database, a refused Keychain. */
  problem: string | null;
}

/**
 * What the UI shows. Four states, and no way past them that is not a sign-in:
 * `loading` before Rust has answered once, `connect` when there is no database
 * to hold an account, `login` otherwise, and `in`.
 */
export type AuthGate = "loading" | "connect" | "login" | "in";

/**
 * Order matters here, and the reason is hydration rather than logic.
 *
 * `inTauri()` reads `window`, so it answers false during the static prerender and
 * true in the shell. Asking it first made the prerendered HTML the whole
 * workbench and the browser's first render a blank -- two different trees for
 * the same state, which is the hydration mismatch React reports as
 * "the server rendered HTML didn't match the client".
 *
 * `ready` is false in both places until an effect has run, so testing it first
 * gives the server and the client's first paint the same answer. Everything that
 * depends on `window` is then only reached on a render that the server never
 * performed.
 */
export function gateFor(status: AuthStatus | null, ready: boolean): AuthGate {
  if (!ready || !status) return "loading";
  // Deliberately no browser-preview exemption. An earlier version let a build
  // running outside the desktop shell straight through on the grounds that it
  // could not make a model call anyway -- but "the lock is off in one of the two
  // ways this app runs" is not a lock, and it is the version anyone would hit
  // first with `npm run dev`. The one escape is explicit, build-time and named,
  // so it cannot happen by accident:
  //
  //   NEXT_PUBLIC_UNLOCK=1 npm run dev
  //
  // and it moves nothing but the UI. `auth::require()` still guards the Rust
  // side, so an unlocked frontend can still not reach a key, a capture or the
  // database.
  if (process.env.NEXT_PUBLIC_UNLOCK === "1") return "in";
  if (status.authenticated) return "in";
  // There is no sign-up state. Rust provisions the owner account the first time
  // it reaches a database with an empty `app_users`, so by the time the gate is
  // asked, the only two answers are "point me at a database" and "PIN, please".
  return status.dbConfigured ? "login" : "connect";
}

const OFFLINE: AuthStatus = {
  dbConfigured: false,
  claimed: false,
  username: null,
  authenticated: false,
  lockedUntil: null,
  attemptsRemaining: null,
  problem: null,
};

export async function authStatus(): Promise<AuthStatus> {
  if (!inTauri()) {
    devLog("auth", "status skipped outside Tauri");
    return OFFLINE;
  }
  const status = await invoke<AuthStatus>("auth_status");
  devLog("auth", "status loaded", {
    dbConfigured: status.dbConfigured,
    claimed: status.claimed,
    authenticated: status.authenticated,
    problem: status.problem,
  });
  return status;
}

export async function authLogin(
  username: string,
  pin: string,
  rememberMe: boolean
): Promise<AuthStatus> {
  devLog("auth", "login attempt", { username, rememberMe });
  const status = await invoke<AuthStatus>("auth_login", { username, pin, rememberMe });
  devLog("auth", "login result", {
    username: status.username,
    authenticated: status.authenticated,
    attemptsRemaining: status.attemptsRemaining,
    problem: status.problem,
  });
  return status;
}

export async function authLogout(): Promise<AuthStatus> {
  if (!inTauri()) return OFFLINE;
  devLog("auth", "logout");
  return invoke<AuthStatus>("auth_logout");
}

export async function authChangePin(
  currentPin: string,
  nextPin: string,
  confirm: string
): Promise<void> {
  await invoke("auth_change_pin", { currentPin, nextPin, confirm });
}

export {
  PIN_LENGTH,
  sanitizePin,
  pinProblem,
  usernameProblem,
  lockSecondsLeft,
  humanSeconds,
} from "./pin";

/** Tauri hands errors across as strings; anything else is a bug worth showing. */
export function reason(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------- store

/**
 * Deliberately its own store rather than a slice of the main one.
 *
 * Everything in `lib/store.ts` describes a signed-in session -- agents, runs,
 * settings loaded from Postgres -- and all of it is unreachable while the app is
 * locked. Keeping the lock separate means the gate can render before any of that
 * exists, and signing out can drop the lot without unpicking a slice.
 */
import { create } from "zustand";

interface AuthState {
  status: AuthStatus | null;
  /** False only for the first moment, before Rust has answered once. */
  ready: boolean;
  refresh: () => Promise<void>;
  apply: (next: AuthStatus) => void;
  signOut: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  status: null,
  ready: false,

  refresh: async () => {
    try {
      devLog("auth", "refresh started");
      set({ status: await authStatus(), ready: true });
      devLog("auth", "refresh completed");
    } catch (err) {
      // A status call that throws still has to leave a renderable screen, so the
      // failure becomes a problem on an otherwise-empty status rather than a
      // permanent loading state.
      set({ status: { ...OFFLINE, problem: reason(err) }, ready: true });
      devLog("auth", "refresh failed", { error: reason(err) });
    }
  },

  apply: (next) => set({ status: next, ready: true }),

  signOut: async () => {
    const next = await authLogout();
    set({ status: next, ready: true });
    // The page reloads rather than unmounting the workbench in place. Half this
    // app's state is streams, listeners and in-flight requests started while
    // signed in; tearing that down correctly by hand is a long list of things to
    // forget, and a reload is the one teardown that cannot be incomplete.
    if (typeof window !== "undefined") window.location.reload();
  },
}));
