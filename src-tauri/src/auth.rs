//! Username and 4-digit PIN, guarding everything else in the app.
//!
//! This is a lock on a private tool, and it is worth being precise about what it
//! can and cannot do. Behind it sit API keys, a screen capturer, arbitrary code
//! execution and a database of past captures. In front of it sits one person's
//! Mac. So the threat this defends against is "someone else sitting at this
//! machine", and everything here is built for that:
//!
//!   * **The PIN is never stored.** `app_users.pin_hash` is an Argon2id PHC
//!     string, verified here in Rust. The hash never crosses into the webview.
//!
//!   * **The PIN is peppered from the Keychain.** Four digits is ten thousand
//!     possibilities; no key-derivation function makes that safe on its own, so
//!     the hash is taken over `HMAC-SHA256(pepper, pin)` where `pepper` is 32
//!     random bytes living in the macOS Keychain and deliberately *not* in
//!     Postgres. A stolen database dump is then not an offline attack -- it is
//!     an offline attack that first needs this laptop, at which point the PIN
//!     was never the thing standing in the way.
//!
//!   * **The counter lives in the database, not in memory.** Five wrong PINs
//!     start an escalating lockout. Keeping `failed_attempts` in Postgres is the
//!     whole point: quitting and relaunching the app must not be a way to reset
//!     it, and it would be if the number lived in this process.
//!
//!   * **"Remember this Mac" stores a token, not the PIN.** Thirty-two random
//!     bytes in the Keychain; the database holds only their SHA-256. The row
//!     cannot be replayed into a login, and signing out revokes it on both ends.
//!
//! What it is not: a defence against someone who already has admin on this Mac.
//! They can read the Keychain, and at that point the API keys are theirs anyway.
//! Pretending otherwise would be the only real mistake available here.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx::{PgPool, Row};
use std::sync::{OnceLock, RwLock};
use uuid::Uuid;

use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::db::{self, Db};

const SERVICE: &str = "com.charles.codeauditor";
const KC_PEPPER: &str = "auth-pepper";
const KC_OWNER: &str = "auth-owner";
const KC_TOKEN: &str = "auth-token";

/// How long "remember this Mac" lasts. Chosen rather than infinite so that a
/// laptop that stops being used eventually stops being a way in.
const REMEMBER_DAYS: i64 = 30;

/// The account this app provisions itself with, the first time it reaches a
/// database with no `app_users` in it.
///
/// There is no sign-up screen: this is a single-owner tool, so a registration
/// form would only ever be a way for someone else to claim it. Seeding instead
/// means the very first launch lands on a PIN prompt rather than a form.
///
/// The seed is a bootstrap, not a secret -- it is readable by anyone who reads
/// this file, so the honest description of it is "the PIN until you change it".
/// Settings -> Sessions -> Account changes it, and the environment overrides
/// below let it be different on a machine you do not control the source of.
const SEED_USERNAME: &str = "nimo";
const SEED_PIN: &str = "3313";

fn seed_username() -> String {
    std::env::var("CODE_AUDITOR_ADMIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| validate_username(s).is_ok())
        .unwrap_or_else(|| SEED_USERNAME.to_string())
}

fn seed_pin() -> String {
    std::env::var("CODE_AUDITOR_ADMIN_PIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| validate_pin(s).is_ok())
        .unwrap_or_else(|| SEED_PIN.to_string())
}

/// Wrong PINs allowed before the first lockout window opens.
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
/// `keychain::read_api_key`, `db::pool` -- can ask the question without every
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

/// Whether an account has been created on this Mac.
///
/// Read from the Keychain rather than the database, so it is still answerable
/// when the network is down -- which is exactly when the answer matters, since
/// "no account yet" is the state that opens the setup screen.
/// Fails *closed*. Every keychain failure that is not a plain "no such entry" --
/// a locked keychain, a denied ACL, a platform error -- has to read as "an
/// account exists", because the alternative is the bypass: `claimed() == false`
/// unlocks `db_save_url`, and an unlocked `db_save_url` lets anyone point the
/// app at their own Postgres, become its first user, and inherit this Mac's API
/// keys. A keychain that will not answer is not evidence of a fresh install.
pub fn claimed() -> bool {
    !matches!(kc_read(KC_OWNER), Ok(None))
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

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())
}

fn kc_read(id: &str) -> Result<Option<String>, String> {
    match entry(id)?.get_password() {
        Ok(v) if !v.trim().is_empty() => Ok(Some(v.trim().to_string())),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn kc_write(id: &str, value: &str) -> Result<(), String> {
    entry(id)?.set_password(value).map_err(|e| e.to_string())
}

fn kc_clear(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The pepper, created on first use.
///
/// Losing this is losing the account -- no PIN will verify against a hash taken
/// with a different pepper -- which is the intended shape: the credential is
/// "this PIN, on this Mac", not "this PIN".
fn pepper() -> Result<String, String> {
    if let Some(p) = kc_read(KC_PEPPER)? {
        return Ok(p);
    }
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let p = hex(&raw);
    kc_write(KC_PEPPER, &p)?;
    Ok(p)
}

// -------------------------------------------------------------------- crypto

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 64 MiB, three passes, one lane. Roughly a fifth of a second on an Apple
/// laptop: unnoticeable once per launch, and the most expensive thing we can
/// reasonably make each guess in an offline attack.
fn argon() -> Result<Argon2<'static>, String> {
    let params = Params::new(64 * 1024, 3, 1, None)
        .map_err(|e| format!("Could not configure the hasher: {e}"))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// HMAC the PIN with the Keychain pepper before it ever reaches Argon2. The
/// input to the KDF is then 32 bytes of high-entropy material rather than four
/// digits, and the database alone never sees either.
fn peppered(pin: &str) -> Result<String, String> {
    type H = Hmac<Sha256>;
    let mut mac = H::new_from_slice(pepper()?.as_bytes())
        .map_err(|e| format!("Could not prepare the hasher: {e}"))?;
    mac.update(pin.as_bytes());
    Ok(hex(&mac.finalize().into_bytes()))
}

fn hash_pin(pin: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(argon()?
        .hash_password(peppered(pin)?.as_bytes(), &salt)
        .map_err(|e| format!("Could not hash the PIN: {e}"))?
        .to_string())
}

fn verify_pin(pin: &str, stored: &str) -> Result<bool, String> {
    let parsed = PasswordHash::new(stored)
        .map_err(|_| "The stored credential is unreadable. The account needs resetting.".to_string())?;
    Ok(argon()?
        .verify_password(peppered(pin)?.as_bytes(), &parsed)
        .is_ok())
}

/// Argon2 at these parameters is a fifth of a second of solid CPU, and these are
/// `async` commands on the same runtime that serves every database query and
/// every streaming model response. Hashing on the runtime thread would stall all
/// of it. The Keychain read inside `pepper()` blocks too, so it goes across as
/// well rather than being hoisted out.
async fn hash_pin_off_thread(pin: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || hash_pin(&pin))
        .await
        .map_err(|e| format!("The hasher did not finish: {e}"))?
}

async fn verify_pin_off_thread(pin: String, stored: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || verify_pin(&pin, &stored))
        .await
        .map_err(|e| format!("The hasher did not finish: {e}"))?
}

/// Spend the same time on a username that does not exist as on one that does.
///
/// A single-user tool barely needs this, but "wrong username" returning in 2ms
/// while "wrong PIN" takes 200ms is a free oracle, and not building the oracle
/// costs one function.
async fn burn_time() {
    let _ = tokio::task::spawn_blocking(|| hash_pin("0000")).await;
}

fn new_token() -> String {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    hex(&raw)
}

fn token_fingerprint(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

// -------------------------------------------------------------------- policy

/// How long the account is locked after `attempts` consecutive failures.
///
/// `None` for the first few, then escalating. The shape matters more than the
/// exact numbers: four digits is 10,000 possibilities, and an attacker who can
/// try one per second walks the whole space in under three hours. At this
/// schedule the same walk takes centuries, which is the only reason a 4-digit
/// PIN is defensible at all.
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

/// Letters, digits, dot, dash, underscore. Narrow on purpose: the username is
/// only ever typed by its owner, so there is nothing to gain from allowing more
/// and something to lose from allowing whitespace at either end.
pub fn validate_username(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.len() < 3 || n.len() > 32 {
        return Err("The username has to be between 3 and 32 characters.".into());
    }
    if !n
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
    {
        return Err("The username can use letters, digits, dot, dash and underscore.".into());
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
async fn status_for(db: &Db) -> AuthStatus {
    // `Ok(None)` is the only answer that means "no account here". An `Err` means
    // the Keychain would not talk to us, and rendering the setup screen off the
    // back of that would invite someone to create a second account over the top
    // of a real one -- so it stays claimed, and says why.
    let (owner, kc_problem) = match kc_read(KC_OWNER) {
        Ok(v) => (v, None),
        Err(e) => (
            None,
            Some(format!("The Keychain would not answer, so this Mac cannot be identified: {e}")),
        ),
    };
    let mut out = AuthStatus {
        db_configured: db::db_has_url().unwrap_or(false),
        claimed: owner.is_some() || kc_problem.is_some(),
        username: owner,
        authenticated: current().is_some(),
        problem: kc_problem,
        ..Default::default()
    };

    if !out.db_configured {
        return out;
    }

    let p = match db::pool_unchecked(db).await {
        Ok(p) => p,
        Err(e) => {
            // Unreachable database plus an existing account plus nobody signed in
            // is a genuine dead end: the connection string is only rewritable
            // while signed in, and signing in needs the database. That guard is
            // right -- an attacker can manufacture a connection failure by
            // pulling the network, so "let them retype it when it fails" would
            // be the bypass. What is owed here is the way out, spelled out,
            // rather than a screen that just says it cannot connect.
            out.problem = Some(if out.claimed && !out.authenticated {
                format!(
                    "{e}\n\nThe connection string can only be changed while signed in, and \
                     signing in needs this database -- so if it has moved, clear this Mac's \
                     record of the account and set it up again against the new one:\n\n  \
                     security delete-generic-password -s com.charles.codeauditor -a auth-owner\n\n\
                     The account in Postgres is untouched by that; you will be asked to sign in \
                     to it again."
                )
            } else {
                e
            });
            return out;
        }
    };

    // The database is the authority on whether an account exists; the Keychain
    // marker is only a cache that survives being offline. Reconcile them, so a
    // database restored from scratch does not leave the app permanently
    // insisting on a login that can never succeed.
    let count: i64 = sqlx::query("select count(*) from app_users")
        .fetch_one(&p)
        .await
        .and_then(|r| r.try_get(0))
        .unwrap_or(0);

    if count == 0 && out.problem.is_none() {
        // An empty table is a database that has never been used, not a locked
        // app with no way in. Provision the owner and carry on to the PIN
        // prompt, so "delete from app_users" is a working PIN reset rather than
        // a door that closes behind you.
        match seed(&p).await {
            Ok(name) => {
                out.username = Some(name);
                out.claimed = true;
            }
            Err(e) => {
                out.problem = Some(e);
                return out;
            }
        }
    } else if count > 0 {
        out.claimed = true;
    }

    if !out.authenticated {
        // A remembered token is the ordinary path back in, so it is tried here
        // rather than behind a separate command the UI has to remember to call.
        match resume(&p).await {
            Ok(Some(principal)) => {
                out.username = Some(principal.username.clone());
                sign_in(principal);
                out.authenticated = true;
                return out;
            }
            Ok(None) => {}
            Err(e) => out.problem = Some(e),
        }
    }

    if let Some(name) = out.username.clone() {
        if let Ok(Some(row)) = lookup(&p, &name).await {
            out.locked_until = row.locked_until.map(|t| t.to_rfc3339());
            if row.locked_until.map(|t| t <= Utc::now()).unwrap_or(true) {
                out.locked_until = None;
                // Floored at one, not zero. `failed_attempts` is only reset by a
                // successful login, so an account whose lockout has expired still
                // carries five failures -- and telling its owner they have "0
                // tries left" on a screen that will happily accept the next one
                // is the app describing a rule it does not have.
                out.attempts_remaining = Some((FREE_ATTEMPTS + 1 - row.failed_attempts).max(1));
            }
        }
    }

    out
}

// ---------------------------------------------------------------------- rows

struct UserRow {
    id: Uuid,
    username: String,
    pin_hash: String,
    failed_attempts: i32,
    locked_until: Option<DateTime<Utc>>,
}

async fn lookup(p: &PgPool, username: &str) -> Result<Option<UserRow>, String> {
    let row = sqlx::query(
        "select id, username, pin_hash, failed_attempts, locked_until
           from app_users where lower(username) = lower($1)",
    )
    .bind(username.trim())
    .fetch_optional(p)
    .await
    .map_err(|e| format!("Could not read the account: {e}"))?;

    Ok(row.map(|r| UserRow {
        id: r.try_get("id").unwrap_or_else(|_| Uuid::nil()),
        username: r.try_get("username").unwrap_or_default(),
        pin_hash: r.try_get("pin_hash").unwrap_or_default(),
        failed_attempts: r.try_get("failed_attempts").unwrap_or(0),
        locked_until: r.try_get("locked_until").unwrap_or(None),
    }))
}

// ------------------------------------------------------------------- remember

/// Mint a "remember this Mac" token: plaintext to the Keychain, fingerprint to
/// the database. Failing to store it is not failing to log in, so this returns
/// `()` and swallows nothing louder than a keychain refusal.
async fn remember(p: &PgPool, user_id: Uuid) -> Result<(), String> {
    let token = new_token();
    let label = hostname();
    // The expiry is computed here rather than as `now() + interval` in SQL, so
    // the bound value is a plain timestamptz and there is no parameter whose type
    // Postgres has to infer out of a string concatenation.
    let expires = Utc::now() + Duration::days(REMEMBER_DAYS);
    sqlx::query(
        "insert into app_sessions (user_id, token_hash, label, expires_at)
         values ($1, $2, $3, $4)",
    )
    .bind(user_id)
    .bind(token_fingerprint(&token))
    .bind(&label)
    .bind(expires)
    .execute(p)
    .await
    .map_err(|e| format!("Could not save the sign-in: {e}"))?;

    kc_write(KC_TOKEN, &token)
}

/// Drop the remembered sign-in on both ends: revoked in Postgres, gone from the
/// Keychain. Used by sign-out and by signing in with the box unticked, so the
/// two cannot drift apart.
async fn forget(p: &PgPool) -> Result<(), String> {
    if let Some(token) = kc_read(KC_TOKEN)? {
        let _ = sqlx::query(
            "update app_sessions set revoked_at = now()
              where token_hash = $1 and revoked_at is null",
        )
        .bind(token_fingerprint(&token))
        .execute(p)
        .await;
    }
    kc_clear(KC_TOKEN)
}

/// Try the stored token. A token that is expired, revoked or simply unknown is
/// not an error -- it is a request to show the PIN screen -- so all three come
/// back as `None`.
async fn resume(p: &PgPool) -> Result<Option<Principal>, String> {
    let Some(token) = kc_read(KC_TOKEN)? else {
        return Ok(None);
    };

    let row = sqlx::query(
        "select s.id, s.user_id, u.username
           from app_sessions s
           join app_users u on u.id = s.user_id
          where s.token_hash = $1
            and s.revoked_at is null
            and s.expires_at > now()
            and (u.locked_until is null or u.locked_until <= now())",
    )
    .bind(token_fingerprint(&token))
    .fetch_optional(p)
    .await
    .map_err(|e| format!("Could not check the saved sign-in: {e}"))?;

    let Some(row) = row else {
        // Stale on this side too, so the next launch does not retry it.
        let _ = kc_clear(KC_TOKEN);
        return Ok(None);
    };

    let id: Uuid = row.try_get("id").map_err(|e| e.to_string())?;
    let user_id: Uuid = row.try_get("user_id").map_err(|e| e.to_string())?;
    let username: String = row.try_get("username").unwrap_or_default();

    let _ = sqlx::query("update app_sessions set last_seen_at = now() where id = $1")
        .bind(id)
        .execute(p)
        .await;

    Ok(Some(Principal { user_id, username }))
}

/// What to call this machine in `app_sessions.label`.
///
/// `HOST` and `HOSTNAME` are set by a shell, and an app launched from Finder has
/// no shell -- so reading only those would have labelled every row "this Mac"
/// and made the column worthless. `scutil` is the one that answers.
fn hostname() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
    {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    std::env::var("HOST")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "this Mac".to_string())
}

// --------------------------------------------------------------------- seed

/// Create the owner account on a database that has none, and return its name.
///
/// The hash is taken here rather than shipped as SQL for the reason the whole
/// scheme rests on: the PIN is peppered with a secret that only exists in this
/// Mac's Keychain, so a precomputed hash in a migration could never verify. The
/// consequence is worth stating plainly -- the same seed PIN on two Macs
/// produces two different hashes, and moving to a new Mac means resetting the
/// row rather than carrying it across.
async fn seed(p: &PgPool) -> Result<String, String> {
    let name = seed_username();
    let hash = hash_pin_off_thread(seed_pin()).await?;

    sqlx::query(
        "insert into app_users (username, pin_hash) values ($1, $2)
         on conflict do nothing",
    )
    .bind(&name)
    .bind(&hash)
    .execute(p)
    .await
    .map_err(|e| format!("Could not create the owner account: {e}"))?;

    kc_write(KC_OWNER, &name)?;
    Ok(name)
}

// --------------------------------------------------------------------- login

#[tauri::command]
pub async fn auth_login(
    db: tauri::State<'_, Db>,
    username: String,
    pin: String,
    remember_me: bool,
) -> Result<AuthStatus, String> {
    let p = db::pool_unchecked(&db).await?;

    let Some(user) = lookup(&p, &username).await? else {
        burn_time().await;
        return Err("That username and PIN do not match.".into());
    };

    if let Some(until) = user.locked_until {
        if until > Utc::now() {
            return Err(lockout_message(until));
        }
    }

    if !verify_pin_off_thread(pin, user.pin_hash.clone()).await? {
        let attempts = user.failed_attempts + 1;
        let until = lock_seconds_for(attempts).map(|s| Utc::now() + Duration::seconds(s));

        sqlx::query("update app_users set failed_attempts = $2, locked_until = $3 where id = $1")
            .bind(user.id)
            .bind(attempts)
            .bind(until)
            .execute(&p)
            .await
            .map_err(|e| format!("Could not record the failed attempt: {e}"))?;

        return Err(match until {
            Some(t) => lockout_message(t),
            None => {
                let left = (FREE_ATTEMPTS + 1 - attempts).max(0);
                format!(
                    "That username and PIN do not match. {left} {} before the account locks.",
                    if left == 1 { "try left" } else { "tries left" }
                )
            }
        });
    }

    sqlx::query(
        "update app_users
            set failed_attempts = 0, locked_until = null, last_login_at = now()
          where id = $1",
    )
    .bind(user.id)
    .execute(&p)
    .await
    .map_err(|e| format!("Could not complete the sign-in: {e}"))?;

    kc_write(KC_OWNER, &user.username)?;
    sign_in(Principal { user_id: user.id, username: user.username.clone() });

    if remember_me {
        let _ = remember(&p, user.id).await;
    } else {
        // Not just a local clear. A row left live until `expires_at` contradicts
        // what the checkbox said, and reads as an active session to anything
        // auditing `revoked_at`.
        let _ = forget(&p).await;
    }

    Ok(status_for(&db).await)
}

fn lockout_message(until: DateTime<Utc>) -> String {
    let secs = (until - Utc::now()).num_seconds().max(0);
    let human = if secs >= 3600 {
        format!("{} hours", (secs as f64 / 3600.0).ceil() as i64)
    } else if secs >= 60 {
        format!("{} minutes", (secs as f64 / 60.0).ceil() as i64)
    } else {
        format!("{secs} seconds")
    };
    format!("Too many wrong PINs. Locked for another {human}.")
}

// -------------------------------------------------------------------- logout

#[tauri::command]
pub async fn auth_logout(db: tauri::State<'_, Db>) -> Result<AuthStatus, String> {
    // Revoke first, clear locally second: if the database is unreachable the
    // token stays valid there, and the local clear still locks this app.
    if let Ok(p) = db::pool_unchecked(&db).await {
        let _ = forget(&p).await;
    }
    let _ = kc_clear(KC_TOKEN);
    sign_out();
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
    let Some(me) = current() else {
        return Err(LOCKED.into());
    };
    validate_pin(&next_pin)?;
    if next_pin != confirm {
        return Err("The two new PINs are not the same.".into());
    }
    if next_pin == current_pin {
        return Err("That is the PIN you already have.".into());
    }

    let p = db::pool_unchecked(&db).await?;
    let Some(user) = lookup(&p, &me.username).await? else {
        return Err("That account no longer exists.".into());
    };
    // The signed-in principal was minted against a row id. If the row behind the
    // same username is now a different one, the database was rebuilt underneath
    // us and this session is stale -- changing that row's PIN would be changing
    // a stranger's.
    if user.id != me.user_id {
        return Err("This sign-in belongs to a different account. Sign out and back in.".into());
    }

    if !verify_pin_off_thread(current_pin, user.pin_hash.clone()).await? {
        return Err("The current PIN is wrong.".into());
    }

    let hash = hash_pin_off_thread(next_pin).await?;
    sqlx::query("update app_users set pin_hash = $2, failed_attempts = 0, locked_until = null where id = $1")
        .bind(user.id)
        .bind(&hash)
        .execute(&p)
        .await
        .map_err(|e| format!("Could not change the PIN: {e}"))?;

    // Every remembered sign-in was minted under the old PIN, so all of them go.
    // A PIN change that leaves an old token working is not a PIN change.
    // Whether this Mac was being remembered has to be read before the revoke
    // wipes the evidence. Reissuing unconditionally would silently opt someone
    // who unticked the box back into a 30-day token.
    let was_remembered = kc_read(KC_TOKEN).unwrap_or(None).is_some();

    let _ = sqlx::query("update app_sessions set revoked_at = now() where user_id = $1 and revoked_at is null")
        .bind(user.id)
        .execute(&p)
        .await;
    let _ = kc_clear(KC_TOKEN);
    if was_remembered {
        let _ = remember(&p, user.id).await;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        for good in ["2846", "9153", "3708", "5291"] {
            assert!(validate_pin(good).is_ok(), "{good} should be allowed");
        }
    }

    #[test]
    fn usernames_are_trimmed_and_bounded() {
        assert!(validate_username("charles").is_ok());
        assert!(validate_username("charles.a_duboakye-70").is_ok());
        assert!(validate_username("ab").is_err());
        assert!(validate_username(&"x".repeat(33)).is_err());
        assert!(validate_username("has space").is_err());
    }

    #[test]
    fn hex_is_lowercase_and_fixed_width() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn a_lockout_message_says_how_long_is_left() {
        let m = lockout_message(Utc::now() + Duration::seconds(90));
        assert!(m.contains("minutes"), "{m}");
    }
}
