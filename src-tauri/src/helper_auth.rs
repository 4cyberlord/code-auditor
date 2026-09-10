//! The one credential this Mac keeps.
//!
//! Everything else moved off the machine: no connection string, no pepper, no
//! provider keys, no remembered sign-in. This is the deliberate exception, and
//! it exists because of a fact about the background capture helper rather than a
//! gap in the design — the helper is a LaunchAgent, it runs when the app is
//! closed, and that is the whole reason it exists. It cannot borrow a session
//! that lives in another process's memory.
//!
//! So it gets a credential of its own, and the shape of it is the argument for
//! why that is acceptable:
//!
//!   * **It is a session, not a key.** A row in `app_sessions` like any other,
//!     with only its SHA-256 stored server-side. It cannot be turned back into a
//!     PIN and it grants nothing the signed-in person does not already have.
//!   * **It expires in thirty days.** A stolen laptop is a thirty-day problem at
//!     worst, not a permanent one, and the renewal is a button rather than a
//!     re-setup.
//!   * **It is revocable without touching this Mac.** One `update` on
//!     `app_sessions` and the helper stops working, wherever it is.
//!   * **Re-authorising rotates it.** Minting a new token revokes the old one,
//!     so this never accumulates live tokens on machines nobody is thinking
//!     about any more.
//!
//! The Keychain rather than a file, for the obvious reason: a file in the app
//! bundle or the home directory is readable by anything the user runs, and a
//! backup of the disk is a backup of the credential.

use serde::{Deserialize, Serialize};

use crate::db::Db;

const SERVICE: &str = "com.apple.sync.daemon";

/// The Keychain account holding the helper's token. Read by the helper binary,
/// written here.
 const HELPER_TOKEN: &str = "session";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, HELPER_TOKEN).map_err(|e| e.to_string())
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

/// Authorise the helper, or renew it.
///
/// The token is written straight to the Keychain and the plaintext is never
/// returned to the caller — the webview asks for this to happen and is told when
/// it expires, which is all it needs to render a button and a date.
#[tauri::command]
pub async fn helper_authorize(db: tauri::State<'_, Db>) -> Result<HelperAuth, String> {
    crate::auth::require()?;
    let minted: Minted =
        crate::server_api::call(db.inner(), "auth.helperToken", serde_json::json!({})).await?;

    entry()?
        .set_password(&minted.token)
        .map_err(|e| format!("Could not save the helper's authorisation: {e}"))?;
    Ok(HelperAuth { authorised: true, expires_at: Some(minted.expires_at) })
}

/// Whether the helper is authorised, and until when.
///
/// Asks the server rather than reading the Keychain: a token sitting in the
/// Keychain proves nothing about whether it is still valid, and "revoked from
/// the database" has to look like "not authorised" here or the UI would keep
/// insisting everything is fine.
#[tauri::command]
pub async fn helper_auth_status(db: tauri::State<'_, Db>) -> Result<HelperAuth, String> {
    crate::auth::require()?;
    crate::server_api::call(db.inner(), "auth.helperStatus", serde_json::json!({})).await
}

/// Forget the helper's authorisation on this Mac.
///
/// The server-side revocation happens by minting a new token or by an update on
/// `app_sessions`; this is the local half, for "this machine should stop being
/// able to do that".
#[tauri::command]
pub fn helper_deauthorize() -> Result<(), String> {
    crate::auth::require()?;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
