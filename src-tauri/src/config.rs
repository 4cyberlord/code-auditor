//! Configuration lives in the database, not in a file on this machine.
//!
//! Everything that used to sit in `.development.env` — gateway tuning, worker
//! rosters, cron settings, provider keys — is a row in `app_config`. The point is
//! that the machine running the app is not also the place its configuration
//! lives: a laptop that has to be set up by hand from a file is a laptop nobody
//! can reproduce, and a file full of keys is a file that ends up in a backup.
//!
//! ## Why not the `settings` table
//!
//! Because [`crate::db::settings_load`] is a `#[tauri::command]`, and that means
//! the webview can read any key in it. That is exactly right for a pane layout
//! and exactly wrong for a TokenRouter key. This module has no command that
//! returns a secret value — [`config_list`] reports secrets by name and by
//! whether they are set, never by content, and the only way to the value itself
//! is [`value`], which is not reachable from JS.
//!
//! That is the same line [`crate::secrets`] draws, and it is drawn here for the
//! same reason: a rendered model answer is untrusted HTML, and anything the
//! webview can ask for is one XSS away from being taken.
//!
//! ## What is deliberately *not* here
//!
//! The four values that open the database — the connection string, the project
//! URL and the two Supabase keys. Storing them in the thing they unlock is
//! circular, so they stay local, and there is no amount of engineering that
//! changes that.

use serde::{Deserialize, Serialize};

use crate::db::Db;

/// One configuration entry, as the UI is allowed to see it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub key: String,
    /// Empty for secrets, always. Use `is_set` to know whether one has a value.
    pub value: String,
    pub secret: bool,
    /// Whether a value is stored, which is the only thing worth saying about a
    /// secret. Without this the UI could not tell "not configured" from
    /// "configured, and you cannot see it" — and those need different buttons.
    pub is_set: bool,
    /// True when this value comes from the platform tier rather than from you.
    /// Shown so the UI can say "provided with the app" instead of offering a
    /// Remove button that would silently do nothing.
    pub platform: bool,
    pub updated_at: String,
}

/// Every entry, with secret values withheld.
#[tauri::command]
pub async fn config_list(db: tauri::State<'_, Db>) -> Result<Vec<ConfigEntry>, String> {
    crate::auth::require()?;
    crate::server_api::call(db.inner(), "config.list", serde_json::json!({})).await
}

/// Store one entry. Writing an empty value clears it.
#[tauri::command]
pub async fn config_set(
    db: tauri::State<'_, Db>,
    key: String,
    value: String,
    secret: bool,
) -> Result<(), String> {
    crate::auth::require()?;
    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "config.set",
        serde_json::json!({ "key": key.trim(), "value": value.trim(), "secret": secret }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn config_delete(db: tauri::State<'_, Db>, key: String) -> Result<(), String> {
    crate::auth::require()?;
    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "config.delete",
        serde_json::json!({ "key": key.trim() }),
    )
    .await?;
    Ok(())
}

/// Read one value in full, secrets included.
///
/// Not a `#[tauri::command]`: this is how Rust reads a key on its way to an
/// outbound request, and there is no path to it from the webview.
#[allow(dead_code)]
pub(crate) async fn value(db: &Db, key: &str) -> Result<Option<String>, String> {
    let all: std::collections::HashMap<String, String> =
        crate::server_api::call(db, "secrets.load", serde_json::json!({})).await?;
    Ok(all.get(key.trim()).cloned().filter(|v| !v.trim().is_empty()))
}
