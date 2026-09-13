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

#[tauri::command]
pub async fn helper_authorize(db: tauri::State<'_, Db>) -> Result<HelperAuth, String> {
    crate::auth::require()?;
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
