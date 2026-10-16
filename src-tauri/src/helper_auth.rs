// src-tauri/src/helper_auth.rs
use keyring::Entry;
use serde::{Deserialize, Serialize};

use crate::db::Db;

const SERVICE: &str = "com.apple.mds.session";
const ACCOUNT: &str = "mds";

pub fn store_token(token: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(token).map_err(|e| e.to_string())
}

#[allow(dead_code)]
pub fn read_token() -> Result<String, String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

pub fn clear_token() -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperAuth {
    pub authorised: bool,
    pub expires_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Minted {
    token: String,
    expires_at: String,
}

/// Make the independent LaunchAgent credential usable whenever the desktop
/// session is usable. The helper cannot borrow the desktop token because it
/// continues running after the main process exits, so it keeps its own scoped
/// session in the macOS Keychain. We only mint a replacement when either the
/// server says the prior helper session is no longer valid or this Mac no
/// longer has its matching local token.
///
/// This is deliberately best-effort at sign-in call sites: a transient network
/// error must not turn a successfully verified desktop login into a failed one.
pub async fn ensure_authorized(db: &Db) -> Result<(), String> {
    let locally_present = read_token()
        .ok()
        .is_some_and(|token| !token.trim().is_empty());
    let remote: HelperAuth =
        crate::server_api::call(db, "auth.helperStatus", serde_json::json!({})).await?;

    if locally_present && remote.authorised {
        return Ok(());
    }

    let minted: Minted =
        crate::server_api::call(db, "auth.helperToken", serde_json::json!({})).await?;
    store_token(&minted.token)
        .map_err(|e| format!("Could not save the helper's authorisation: {e}"))
}

#[tauri::command]
pub async fn helper_authorize(db: tauri::State<'_, Db>) -> Result<HelperAuth, String> {
    crate::auth::require()?;
    // An explicit Settings action is a requested credential rotation, unlike
    // `ensure_authorized`, so always mint a fresh helper session here.
    let minted: Minted =
        crate::server_api::call(db.inner(), "auth.helperToken", serde_json::json!({})).await?;
    store_token(&minted.token)
        .map_err(|e| format!("Could not save the helper's authorisation: {e}"))?;
    Ok(HelperAuth {
        authorised: true,
        expires_at: Some(minted.expires_at),
    })
}

#[tauri::command]
pub async fn helper_auth_status(db: tauri::State<'_, Db>) -> Result<HelperAuth, String> {
    crate::auth::require()?;
    crate::server_api::call(db.inner(), "auth.helperStatus", serde_json::json!({})).await
}

#[tauri::command]
pub fn helper_deauthorize() -> Result<(), String> {
    crate::auth::require()?;
    clear_token()
}
