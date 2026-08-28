//! Provider keys, held in the database rather than on this machine.
//!
//! This file replaces `keychain.rs`, and the reason is worth writing down: the
//! Keychain is a good place for a secret, but it is still *this Mac*. A machine
//! that has to be set up by hand, entry by entry, is a machine nobody can
//! reproduce — and a laptop holding every provider key is a laptop that is worth
//! stealing. The keys now live in `app_config`, which has RLS enabled and no
//! policy, so only the service role reaches them.
//!
//! ## The webview still cannot read one
//!
//! That was the entire point of the old module and it is preserved exactly.
//! [`set_api_key`], [`has_api_key`] and [`delete_api_key`] are commands, so JS
//! can save a key and ask *whether* one exists. [`read_api_key`] is not a
//! command, so the only thing that can read a value is Rust, on its way to an
//! outbound request. A rendered model answer is untrusted HTML; anything the
//! webview can ask for is one XSS away from being taken.
//!
//! ## Why a cache rather than a query per call
//!
//! `read_api_key` is called from deep inside request builders — `build_request`,
//! `run_once_responses`, `execute_responses` — that have no `Db` and no async
//! context to acquire one. Threading state through all of them to fetch a value
//! that changes about once a month would be a large change to say a small thing.
//! So the keys are read once, when someone signs in, and held in memory for the
//! session. [`load`] is called again whenever a key is written, so saving one in
//! Settings takes effect immediately.
//!
//! In memory, not on disk. Quitting the app forgets every key.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use crate::db::Db;

fn cache() -> &'static RwLock<HashMap<String, String>> {
    static CACHE: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Read the signed-in person's keys into memory. Called after sign-in and after
/// any write.
///
/// Two tiers, and the user's own always wins. A row owned by the nil UUID is a
/// platform row — the app owner's, shared with every account, for the things
/// that genuinely are shared: the APNs key, the Apple team id, anything tied to
/// the software rather than to whoever is using it. A row owned by this person
/// shadows it. `distinct on` with the owner in the sort does that in one query
/// rather than two round trips and a merge in Rust.
pub(crate) async fn load(db: &Db) -> Result<(), String> {
    if crate::auth::current().is_none() {
        // Nobody is signed in, so there is nobody to load keys for. Not an
        // error: this is the ordinary state at startup.
        clear();
        return Ok(());
    }

    let next: HashMap<String, String> =
        crate::server_api::call(db, "secrets.load", serde_json::json!({})).await?;

    if let Ok(mut c) = cache().write() {
        *c = next;
    }
    Ok(())
}

/// Forget everything. Called on sign-out, so locking the app also drops the keys.
pub(crate) fn clear() {
    if let Ok(mut c) = cache().write() {
        c.clear();
    }
}

/// Read one key for an outbound request. Not a command, so JS cannot reach it.
///
/// The lock check is kept from the old module and matters as much as it did: a
/// locked app must not be able to spend money or move a screenshot, and this is
/// the chokepoint every model call and every upload passes through.
pub fn read_api_key(provider: &str) -> Result<String, String> {
    crate::auth::require()?;
    let found = cache()
        .read()
        .ok()
        .and_then(|c| c.get(provider).cloned())
        .filter(|v| !v.trim().is_empty());

    found.ok_or_else(|| format!("No API key saved for \"{provider}\". Add one in Settings."))
}

#[tauri::command]
pub async fn set_api_key(
    db: tauri::State<'_, Db>,
    provider: String,
    key: String,
) -> Result<(), String> {
    crate::auth::require()?;
    let provider = provider.trim().to_string();
    if provider.is_empty() {
        return Err("A provider name cannot be empty.".into());
    }

    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "config.set",
        serde_json::json!({ "key": provider, "value": key.trim(), "secret": true }),
    )
    .await?;

    load(db.inner()).await
}

#[tauri::command]
pub async fn delete_api_key(db: tauri::State<'_, Db>, provider: String) -> Result<(), String> {
    crate::auth::require()?;
    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "config.delete",
        serde_json::json!({ "key": provider.trim() }),
    )
    .await?;
    load(db.inner()).await
}

/// Whether a key is stored. Never the key itself.
#[tauri::command]
pub async fn has_api_key(db: tauri::State<'_, Db>, provider: String) -> Result<bool, String> {
    crate::auth::require()?;
    if let Ok(c) = cache().read() {
        if !c.is_empty() {
            return Ok(c.contains_key(provider.trim()));
        }
    }
    load(db.inner()).await?;
    Ok(cache()
        .read()
        .map(|c| c.contains_key(provider.trim()))
        .unwrap_or(false))
}
