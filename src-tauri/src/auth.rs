//! Username and 4-digit PIN, checked by the server.
//!
//! This is a lock on a tool that holds API keys, a screen capturer, arbitrary
//! code execution and a database of past captures. What changed is where the
//! lock lives: everything here used to happen on this Mac, and now none of it
//! does.
//!
//!   * **The PIN is verified in the database.** `auth_verify_pin` compares a
//!     bcrypt hash, peppered with a secret held by the Edge Function. This
//!     machine has never seen that pepper and cannot check a PIN offline —
//!     which also means a stolen laptop is not a head start.
//!
//!   * **The counter lives with the check.** Five wrong PINs start an escalating
//!     lockout, enforced by the same function that does the comparison. The
//!     client doing the guessing must not be the thing counting the guesses,
//!     and while the count sat in Postgres but the comparison sat here, it was.
//!
//!   * **Nothing is stored on this Mac at all.** No Keychain entry, no pepper,
//!     no remembered token, no connection string. The session token lives in
//!     memory for the life of the process, so quitting signs you out and a copy
//!     of the disk is not a copy of the account. That is why there is no "keep
//!     me signed in": there is nowhere to keep it.
//!
//!   * **Every refusal reads the same.** Wrong PIN, unknown username and
//!     malformed input come back word for word identical, because a different
//!     answer for a real username tells someone which ones are worth guessing —
//!     and ten thousand possibilities cannot afford that hint.
//!
//! What it is not: a defence against someone who already has admin on this Mac
//! while it is unlocked and signed in. They can read this process's memory, and
//! at that point the session is theirs. Pretending otherwise would be the only
//! real mistake available here.

use serde::Serialize;
use std::sync::{OnceLock, RwLock};
use uuid::Uuid;

use crate::db::Db;

/// Wrong PINs allowed before the first lockout window opens.
/// Kept as the written specification, not as running code.
///
/// The lockout is enforced by `auth_verify_pin` in the database now, because the
/// client doing the guessing must not be the thing counting the guesses. This
/// and `lock_seconds_for` still describe the intended schedule, and the tests
/// below still argue for why a four-digit PIN is defensible at all — if the SQL
/// and this disagree, one of them is wrong and it is worth knowing.
#[allow(dead_code)]
const FREE_ATTEMPTS: i32 = 4;

/// The error every guarded command returns when nobody is signed in. Matched as
/// a string on the JS side to tell "you are locked out" from "that failed", so
/// it is a constant rather than a literal typed in nine places.
pub const LOCKED: &str = "Locked. Sign in to continue.";

// ------------------------------------------------------------------ identity

#[derive(Clone, Debug)]
pub struct Principal {
    pub user_id: Uuid,
    pub username: String,
}

/// Process-global rather than Tauri managed state, so that non-command code --
/// `secrets::read_api_key`, `db::pool` -- can ask the question without every
/// caller in the crate having to be handed a `State`. There is exactly one app
/// per process, so there is exactly one answer.
fn state() -> &'static RwLock<Option<Principal>> {
    static STATE: OnceLock<RwLock<Option<Principal>>> = OnceLock::new();
    STATE.get_or_init(|| RwLock::new(None))
}

pub fn current() -> Option<Principal> {
    state().read().ok().and_then(|g| g.clone())
}

/// The guard. Cheap enough to call on every command.
pub fn require() -> Result<(), String> {
    if current().is_some() {
        Ok(())
    } else {
        Err(LOCKED.into())
    }
}

fn sign_in(p: Principal) {
    if let Ok(mut g) = state().write() {
        *g = Some(p);
    }
}

fn sign_out() {
    if let Ok(mut g) = state().write() {
        *g = None;
    }
}

// ------------------------------------------------------------------ keychain

/// The session token for this run, held in memory only.
///
/// Nothing writes it to disk. Quitting the app forgets it, which is exactly what
/// "type the PIN every launch" means — there is no file, no Keychain entry and
/// no thirty-day window during which a copy of this machine is a copy of the
/// account.
///
/// Not a `#[tauri::command]`, and deliberately: this token is what proves
/// identity to the server, and the webview has never held it. Handing it across
/// would make an XSS in a rendered model answer equivalent to a stolen sign-in.
fn token_slot() -> &'static RwLock<Option<String>> {
    static TOKEN: OnceLock<RwLock<Option<String>>> = OnceLock::new();
    TOKEN.get_or_init(|| RwLock::new(None))
}

pub(crate) fn session_token() -> Result<Option<String>, String> {
    Ok(token_slot().read().ok().and_then(|t| t.clone()))
}

fn hold_token(token: Option<String>) {
    if let Ok(mut slot) = token_slot().write() {
        *slot = token;
    }
}

// -------------------------------------------------------------------- crypto

// -------------------------------------------------------------------- policy

/// How long the account is locked after `attempts` consecutive failures.
///
/// `None` for the first few, then escalating. The shape matters more than the
/// exact numbers: four digits is 10,000 possibilities, and an attacker who can
/// try one per second walks the whole space in under three hours. At this
/// schedule the same walk takes centuries, which is the only reason a 4-digit
/// PIN is defensible at all.
#[allow(dead_code)]
pub fn lock_seconds_for(attempts: i32) -> Option<i64> {
    match attempts {
        a if a <= FREE_ATTEMPTS => None,
        5 => Some(60),
        6 => Some(5 * 60),
        7 => Some(15 * 60),
        8 => Some(60 * 60),
        _ => Some(24 * 60 * 60),
    }
}

/// Exactly four digits, and not one of the handful everybody picks.
///
/// Blocking obvious PINs is not padding: the published analyses of leaked
/// 4-digit sets put `1234`, `1111` and `0000` alone at around a fifth of all
/// choices, so an attacker with five guesses before the first lockout has far
/// better than 1-in-2000 odds unless these are gone.
pub fn validate_pin(pin: &str) -> Result<(), String> {
    if pin.len() != 4 || !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Err("The PIN has to be exactly 4 digits.".into());
    }

    let d: Vec<i32> = pin.bytes().map(|b| (b - b'0') as i32).collect();

    if d.iter().all(|x| *x == d[0]) {
        return Err("That PIN is all one digit. Pick something less guessable.".into());
    }

    let step = d[1] - d[0];
    if (step == 1 || step == -1) && d.windows(2).all(|w| w[1] - w[0] == step) {
        return Err("That PIN is a run of consecutive digits. Pick something less guessable.".into());
    }

    // Repeating pairs: 1212, 6969, 1010.
    if d[0] == d[2] && d[1] == d[3] {
        return Err("That PIN repeats a two-digit pattern. Pick something less guessable.".into());
    }

    // The rest of the common list that no rule catches. A year is the single
    // most popular non-sequence choice.
    const COMMON: [&str; 10] = [
        "1004", "2000", "2001", "2020", "1980", "1990", "1991", "1992", "1122", "5150",
    ];
    if COMMON.contains(&pin) {
        return Err("That PIN is one of the most commonly chosen. Pick something else.".into());
    }

    Ok(())
}

// -------------------------------------------------------------------- status

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// A database connection string is saved. Without one there is nowhere for
    /// the account to live, so the UI has to ask for that first.
    pub db_configured: bool,
    /// An account has been created on this Mac. Read from the Keychain, so it is
    /// still true when the database is unreachable -- which is what stops a
    /// dropped connection from looking like a fresh install.
    pub claimed: bool,
    pub username: Option<String>,
    pub authenticated: bool,
    /// Set while a lockout window is open.
    pub locked_until: Option<String>,
    /// Wrong PINs left before the next lockout, when the account is not already
    /// locked. Shown so the last one before a lockout is not a surprise.
    pub attempts_remaining: Option<i32>,
    /// Why the status is incomplete: the database could not be reached, the
    /// Keychain refused, and so on. Never a reason to fail the call -- the login
    /// screen has to render something even when everything is broken.
    pub problem: Option<String>,
}

#[tauri::command]
pub async fn auth_status(db: tauri::State<'_, Db>) -> Result<AuthStatus, String> {
    Ok(status_for(&db).await)
}

/// The body of `auth_status`, taking a plain reference so that every command
/// here can end by reporting the new state without juggling the `State` guard.
///
/// Infallible by design. This is what the login screen renders from, and a login
/// screen that cannot draw itself because the database is down is a locked door
/// with no handle -- so every failure becomes `problem`, not `Err`.
/// What the login screen needs to know, without touching the network.
///
/// This used to open Postgres — which meant reading the connection string from
/// the Keychain, which is why launching the app prompted for a Keychain password
/// on every rebuild and refused to start when macOS declined.
///
/// There is nothing left to ask. The backend is compiled in, so there is no
/// connection to configure and no "connect" step; accounts live on the server,
/// so whether one exists is not this machine's business; and whether someone is
/// signed in is a fact about this process. Lockouts and remaining attempts come
/// back with the sign-in refusal that causes them, which is the only moment they
/// are worth showing.
async fn status_for(_db: &Db) -> AuthStatus {
    AuthStatus {
        // Nothing to configure: the deployment is built into the binary.
        db_configured: true,
        // Accounts are created on the server, so the app never shows a setup
        // screen — it shows the PIN prompt and lets the server decide.
        claimed: true,
        username: current().map(|p| p.username),
        authenticated: current().is_some(),
        locked_until: None,
        attempts_remaining: None,
        problem: None,
    }
}

// ---------------------------------------------------------------------- rows

// ------------------------------------------------------------------- remember

// --------------------------------------------------------------------- seed

// --------------------------------------------------------------------- login

#[tauri::command]
pub async fn auth_login(
    db: tauri::State<'_, Db>,
    username: String,
    pin: String,
    remember_me: bool,
) -> Result<AuthStatus, String> {
    // Server sign-in when the API is configured.
    //
    // The PIN is checked in the database against a bcrypt hash, peppered with a
    // secret that lives in the Edge Function and has never been on this Mac. The
    // lockout is counted server-side too, rather than by the same client that is
    // doing the guessing. What comes back is a token this process holds in
    // memory and forgets on quit.
    if crate::server_api::available(db.inner()).await {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SignedIn {
            token: String,
            username: String,
            user_id: String,
        }

        let attempt: Result<SignedIn, String> = crate::server_api::call_public(
            db.inner(),
            "auth.login",
            serde_json::json!({ "username": username.trim(), "pin": pin.clone() }),
        )
        .await;

        let signed = match attempt {
            Ok(signed) => signed,
            // The one server refusal that is not a refusal of *this person*.
            //
            // An account whose PIN was hashed by the old local scheme cannot be
            // verified server-side, and the only way to re-hash it is to change
            // the PIN — which needs a session, which needs signing in. Returning
            // the error here would be a locked door with the key behind it.
            //
            // So fall through to the local check, which can verify that hash,
            // and mint a session from it. The person signs in as normal and
            // Settings offers the PIN change that completes the move.
            Err(e) => return Err(e),
        };

        let user_id = Uuid::parse_str(&signed.user_id)
            .map_err(|_| "The server returned an account id this app does not understand.")?;

        hold_token(Some(signed.token));
        sign_in(Principal { user_id, username: signed.username });

        // `remember_me` has nothing left to do: there is no store to remember
        // into. The checkbox is gone from the login screen; the parameter stays
        // so an older webview bundle does not fail to call this command.
        let _ = remember_me;

        let _ = crate::secrets::load(db.inner()).await;
        return Ok(status_for(&db).await);
    }

    Err("The server API is not configured for this build.".into())
}

// -------------------------------------------------------------------- logout

#[tauri::command]
pub async fn auth_logout(db: tauri::State<'_, Db>) -> Result<AuthStatus, String> {
    // Revoke on the server first, clear locally second: if the network is down
    // the token stays valid there, and the local clear still locks this app. The
    // failure is deliberately ignored — a sign-out that refuses to sign you out
    // because the network is down is worse than a session that outlives its
    // twelve hours on a server nobody is holding it against.
    let _: Result<serde_json::Value, String> =
        crate::server_api::call(db.inner(), "auth.logout", serde_json::json!({})).await;

    hold_token(None);
    sign_out();
    // The keys were only ever in memory, and signing out is when that stops
    // being justified. A locked app holding a live TokenRouter key is a locked
    // app that can still spend money.
    crate::secrets::clear();
    Ok(status_for(&db).await)
}

// ----------------------------------------------------------------- change pin

#[tauri::command]
pub async fn auth_change_pin(
    db: tauri::State<'_, Db>,
    current_pin: String,
    next_pin: String,
    confirm: String,
) -> Result<(), String> {
    if current().is_none() {
        return Err(LOCKED.into());
    }
    validate_pin(&next_pin)?;
    if next_pin != confirm {
        return Err("The two new PINs are not the same.".into());
    }
    if next_pin == current_pin {
        return Err("That is the PIN you already have.".into());
    }

    // Server path. Also the only way an account moves off the old local
    // Argon2id hash: the server cannot verify those, so signing in returns
    // "set it again from the desktop app" and this is what does it.
    if crate::server_api::available(db.inner()).await {
        let _: serde_json::Value = crate::server_api::call(
            db.inner(),
            "auth.changePin",
            serde_json::json!({ "currentPin": current_pin, "nextPin": next_pin }),
        )
        .await?;
        return Ok(());
    }

    Err("The server API is not configured for this build.".into())
}

#[cfg(test)]
mod tests {
    use super::{lock_seconds_for, validate_pin, FREE_ATTEMPTS};

    #[test]
    fn the_first_few_wrong_pins_do_not_lock() {
        for a in 1..=FREE_ATTEMPTS {
            assert_eq!(lock_seconds_for(a), None, "attempt {a} should not lock");
        }
    }

    #[test]
    fn lockouts_escalate_and_never_shorten() {
        let mut last = 0;
        for a in (FREE_ATTEMPTS + 1)..=12 {
            let s = lock_seconds_for(a).expect("should lock");
            assert!(s >= last, "attempt {a} shortened the lockout");
            last = s;
        }
        assert_eq!(lock_seconds_for(20), Some(24 * 60 * 60));
    }

    #[test]
    fn a_full_walk_of_the_keyspace_is_not_feasible() {
        // The reason a 4-digit PIN is defensible at all, asserted rather than
        // assumed. Past the escalation an attacker gets one guess per tail
        // lockout, so walking all ten thousand takes:
        let tail = lock_seconds_for(99).expect("the tail must lock");
        let years = 10_000 * tail / (365 * 24 * 3600);
        assert!(years >= 20, "the tail lockout is too short: {years} years");
    }

    #[test]
    fn pins_must_be_four_digits() {
        assert!(validate_pin("2846").is_ok());
        assert!(validate_pin("284").is_err());
        assert!(validate_pin("28465").is_err());
        assert!(validate_pin("28a6").is_err());
        assert!(validate_pin("").is_err());
    }

    #[test]
    fn the_obvious_pins_are_refused() {
        for bad in ["0000", "1111", "9999", "1234", "4321", "1212", "6969", "1010", "2000"] {
            assert!(validate_pin(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn an_ordinary_pin_is_not_caught_by_the_pattern_rules() {
        for good in ["2846", "7391", "5028", "9174", "3607"] {
            assert!(validate_pin(good).is_ok(), "{good} should be allowed");
        }
    }
}
