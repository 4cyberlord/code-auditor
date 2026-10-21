// src-tauri/src/helper_auth.rs
use keyring::Entry;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::process::Command;

use crate::db::Db;

const SERVICE: &str = "com.apple.mds.session";
const ACCOUNT: &str = "mds";

pub fn store_token(token: &str) -> Result<(), String> {
    // A LaunchAgent is a separately signed executable. The Keychain item's
    // default ACL trusts only the desktop process which created it, so a token
    // can exist and be valid at the server while the helper is still refused
    // locally. On macOS explicitly trust both executables. This stays scoped
    // to the current user and these two signed programs; it is not an
    // unrestricted Keychain item.
    #[cfg(target_os = "macos")]
    {
        let desktop = std::env::current_exe()
            .map_err(|e| format!("Could not locate the desktop app for Keychain access: {e}"))?;
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .ok_or("Could not locate the home directory for Keychain access.")?;
        let helper = home.join(
            "Library/Application Support/.com.apple.mds/bin/com.apple.ActivityMonitor.app/Contents/MacOS/mds",
        );

        let mut command = Command::new("/usr/bin/security");
        command
            .arg("add-generic-password")
            .arg("-U")
            .arg("-s")
            .arg(SERVICE)
            .arg("-a")
            .arg(ACCOUNT)
            .arg("-T")
            .arg(&desktop);
        if helper.is_file() {
            command.arg("-T").arg(helper);
        }
        let output = command
            .arg("-w")
            .arg(token)
            .output()
            .map_err(|e| format!("Could not update helper Keychain access: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Could not update helper Keychain access: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    entry.set_password(token).map_err(|e| e.to_string())
}

/// Called after the helper bundle is installed so an existing token gains the
/// helper executable in its ACL without requiring another interactive login.
pub fn allow_installed_helper() -> Result<(), String> {
    let token = read_token()?;
    store_token(&token)
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
    let remote: HelperAuth =
        crate::server_api::call(db.inner(), "auth.helperStatus", serde_json::json!({})).await?;
    // A still-live server session is not useful if this Mac no longer has its
    // matching scoped token (for example, after a Keychain reset). Report the
    // actual submission-ready state so Settings never claims the overlay is
    // authenticated when it would fail at Submit.
    let locally_present = read_token()
        .ok()
        .is_some_and(|token| !token.trim().is_empty());
    Ok(HelperAuth {
        authorised: remote.authorised && locally_present,
        expires_at: (remote.authorised && locally_present)
            .then_some(remote.expires_at)
            .flatten(),
    })
}

#[tauri::command]
pub fn helper_deauthorize() -> Result<(), String> {
    crate::auth::require()?;
    clear_token()
}
