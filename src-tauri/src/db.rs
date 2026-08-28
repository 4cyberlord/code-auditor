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

// ---------------------------------------------------------------------- pool

#[cfg(test)]
mod connect_error_tests {
    use super::*;

    const DNS: &str =
        "error communicating with database: failed to lookup address information: \
         nodename nor servname provided, or not known";

    #[test]
    fn direct_supabase_host_is_recognised() {
        assert_eq!(
            supabase_direct_ref("postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres")
                .as_deref(),
            Some("abcdef")
        );
    }

    #[test]
    fn a_password_containing_an_at_sign_does_not_confuse_the_host() {
        assert_eq!(
            supabase_direct_ref("postgresql://postgres:p@ss@db.abcdef.supabase.co:5432/postgres")
                .as_deref(),
            Some("abcdef")
        );
    }

    #[test]
    fn the_pooler_is_not_diagnosed_as_the_direct_host() {
        assert!(supabase_direct_ref(
            "postgresql://postgres.abcdef:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres"
        )
        .is_none());
    }

    #[test]
    fn a_non_supabase_host_is_left_alone() {
        assert!(supabase_direct_ref("postgresql://u:p@localhost:5432/postgres").is_none());
    }

    #[test]
    fn dns_failure_names_the_pooler_and_the_project() {
        let msg = explain_connect_error(
            "postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres",
            DNS,
        );
        assert!(msg.contains("pooler.supabase.com"), "{msg}");
        assert!(msg.contains("postgres.abcdef"), "{msg}");
    }

    #[test]
    fn a_bad_password_is_not_reported_as_a_dns_problem() {
        let msg = explain_connect_error(
            "postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres",
            "password authentication failed for user \"postgres\"",
        );
        // Asserted on substance rather than phrasing: the wording of these is
        // meant to be reworked, and a test that breaks every time someone makes
        // a sentence friendlier teaches people to edit the test instead of
        // reading it. What must not change is which problem it names.
        assert!(msg.to_lowercase().contains("password"), "{msg}");
        assert!(!msg.contains("pooler.supabase.com"), "{msg}");
    }

    #[test]
    fn an_unrecognised_failure_is_passed_through_rather_than_guessed_at() {
        let msg = explain_connect_error(
            "postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres",
            "connection reset by peer",
        );
        assert!(msg.contains("connection reset by peer"), "{msg}");
        assert!(!msg.contains("pooler.supabase.com"), "{msg}");
    }

    #[test]
    fn the_raw_error_survives_every_branch() {
        // Whatever we decide a failure means, the original text has to stay in
        // the message -- it is the only thing that is definitely true.
        for raw in [DNS, "password authentication failed", "connection timed out"] {
            let msg =
                explain_connect_error("postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres", raw);
            assert!(msg.contains(raw), "lost the raw error in: {msg}");
        }
    }
}

// ------------------------------------------------------------------ settings

#[tauri::command]
pub async fn settings_load(db: tauri::State<'_, Db>, key: String) -> Result<Option<Value>, String> {
    crate::auth::require()?;
    crate::server_api::call(db.inner(), "settings.load", serde_json::json!({ "key": key.trim() })).await
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

