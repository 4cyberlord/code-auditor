//! Settings, and the marker the rest of the app is handed.
//!
//! This file used to be the database layer: a connection string in the Keychain,
//! a pool, the schema applied on first connect. None of that is here any more —
//! every read and write goes through the Council Editor API, so the app holds no
//! database credential and opens no connection.
//!
//! `Db` survives as a Tauri state marker. It carries nothing; it is threaded
//! through the commands because that is how they reach `server_api`, and giving
//! it up would mean touching every signature to say the same thing.
//!
//! Two consequences worth knowing rather than discovering:
//!
//!   * The app no longer applies `migrations.sql` on launch, because it no
//!     longer connects. Schema changes go through the Supabase CLI or the SQL
//!     editor.
//!   * There is no "connect your database" step, and nothing to configure. The
//!     deployment is compiled in (`deployment.rs`).

use serde_json::Value;

/// A marker, not a connection.
///
/// Kept so every command keeps the `db: tauri::State<'_, Db>` parameter it uses
/// to reach the server API. Tauri injects it, so the webview never passes it and
/// never notices it is empty.
#[derive(Default)]
pub struct Db;

// ------------------------------------------------------------- no keychain
//
// This file used to hold the Postgres connection string in the macOS Keychain,
// and reading it was the first thing the app did on launch. That is what made
// every rebuild prompt for a Keychain password — an item's access control is
// tied to the signature of the binary that created it, so a freshly built
// binary is a different program as far as macOS is concerned — and it is what
// turned a declined dialog into an app that would not open.
//
// There is nothing to store now. The backend is compiled in (`deployment.rs`),
// every read and write goes through the Edge Function, and the only credential
// is a session token that lives in memory until you quit. So the connection
// string, the commands that saved it and the "Connect your database" screen
// they served are all gone rather than merely unused.
//
// What this costs, stated plainly: the app no longer applies `migrations.sql`
// on connect, because it no longer connects. Schema changes are applied with
// the Supabase CLI or the SQL editor.

// ------------------------------------------------------------------ settings

#[tauri::command]
pub async fn settings_load(db: tauri::State<'_, Db>, key: String) -> Result<Option<Value>, String> {
    crate::auth::require()?;
    crate::server_api::call(
        db.inner(),
        "settings.load",
        serde_json::json!({ "key": key.trim() }),
    )
    .await
}

#[tauri::command]
pub async fn settings_save(
    db: tauri::State<'_, Db>,
    key: String,
    value: Value,
) -> Result<(), String> {
    crate::auth::require()?;
    let key = key.trim();
    if key.is_empty() {
        return Err("Settings key cannot be empty.".into());
    }
    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "settings.save",
        serde_json::json!({ "key": key, "value": value }),
    )
    .await?;
    Ok(())
}

// -------------------------------------------------------------------- health
