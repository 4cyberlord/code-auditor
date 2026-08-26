//! Session storage, backed by Postgres (Supabase).
//!
//! The connection string carries the database password, so it is treated exactly
//! like an API key: written to the OS keychain, read only inside this process,
//! never handed back to the webview. The JS side can ask *whether* a connection is
//! configured and whether it works, not what it is.
//!
//! Queries are built at runtime rather than with `sqlx::query!`. The macro form
//! checks SQL against a live database at compile time, which would mean nobody
//! could build the app without the credentials in their environment.

use serde::Serialize;
use serde_json::Value;
use sqlx::postgres::{PgPoolOptions, PgConnectOptions};
use sqlx::{PgPool, Row};
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::Mutex;

const KEYCHAIN_ID: &str = "supabase-url";

/// The schema travels inside the binary. Asking someone to paste SQL into a web
/// console before the app works is a setup step that should not exist, and it is
/// a step that silently rots the moment the schema changes.
///
/// Every statement in it is idempotent -- `create table if not exists`,
/// `create or replace function`, `drop trigger if exists` -- so applying it twice
/// is harmless and applying it to a partially-built database repairs it.
const SCHEMA: &str = include_str!("../../supabase/schema.sql");

/// Column additions, run on every connect.
///
/// `SCHEMA` only fires when a table is missing, so a database created by an
/// earlier build would never grow a new column. These statements are written to
/// be safe to repeat, which is what lets the app migrate itself instead of
/// handing the user SQL to paste.
const MIGRATIONS: &str = include_str!("../../supabase/migrations.sql");

/// Tables the app expects. Reported individually so a partial schema is
/// diagnosable rather than just "something is wrong".
const EXPECTED_TABLES: [&str; 8] = [
    "sessions",
    "screenshots",
    "runs",
    "agent_responses",
    "verdicts",
    "settings",
    "intelligence_sources",
    "intelligence_records",
];

#[derive(Default)]
pub struct Db(Arc<Mutex<Option<PgPool>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbHealth {
    pub connected: bool,
    /// Host and database only. Never the user or password.
    pub target: String,
    pub server_version: String,
    /// Tables from EXPECTED_TABLES that are actually present.
    pub tables_found: Vec<String>,
    pub tables_missing: Vec<String>,
    pub session_count: i64,
    /// Set when the schema has not been applied yet, so the UI can say what to do
    /// rather than only that something failed.
    pub advice: Option<String>,
}

// ------------------------------------------------------------------ keychain

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.charles.codeauditor", KEYCHAIN_ID).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_save_url(db: tauri::State<'_, Db>, url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return db_clear_url(db).await;
    }
    if !url.starts_with("postgres://") && !url.starts_with("postgresql://") {
        return Err("That does not look like a Postgres connection string. It should begin with postgresql://".into());
    }
    // Parsing here means a malformed string is rejected while the user is still
    // looking at the field, rather than failing later inside a capture.
    PgConnectOptions::from_str(&with_tls(&url))
        .map_err(|e| format!("Could not parse that connection string: {e}"))?;

    entry()?.set_password(&url).map_err(|e| e.to_string())?;
    // Any pool built from the old URL is now wrong.
    *db.0.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn db_clear_url(db: tauri::State<'_, Db>) -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    *db.0.lock().await = None;
    Ok(())
}

#[tauri::command]
pub fn db_has_url() -> Result<bool, String> {
    match entry()?.get_password() {
        Ok(v) => Ok(!v.trim().is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// The connection string, for code inside this process that needs the host.
///
/// `pub(crate)` and not a command: the string carries the database password, and
/// the whole reason it lives in the Keychain is that the webview never holds it.
/// Storage needs the project reference embedded in it, so it reads it here
/// rather than being handed it across the bridge.
pub(crate) fn connection_string() -> Result<String, String> {
    read_url()
}

fn read_url() -> Result<String, String> {
    match entry()?.get_password() {
        Ok(v) if !v.trim().is_empty() => Ok(v.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            Err("No database is configured yet. Add the connection string in Settings.".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Supabase requires TLS, and omitting it fails with a connection error that says
/// nothing about the cause.
fn with_tls(url: &str) -> String {
    if url.contains("sslmode=") {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&sslmode=require")
    } else {
        format!("{url}?sslmode=require")
    }
}

/// Host and database, for display. Deliberately drops the user and password so a
/// health readout can be pasted into a bug report.
fn describe(url: &str) -> String {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let host_part = after_scheme.rsplit('@').next().unwrap_or(after_scheme);
    host_part.split('?').next().unwrap_or(host_part).to_string()
}

// ---------------------------------------------------------------------- pool

/// Lazily builds the pool, then reuses it. A screen capture should never pay for
/// a TLS handshake that a previous one already made.
pub async fn pool(db: &Db) -> Result<PgPool, String> {
    if let Some(p) = db.0.lock().await.as_ref() {
        return Ok(p.clone());
    }
    let url = with_tls(&read_url()?);
    let built = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(15))
        .connect(&url)
        .await
        .map_err(|e| explain_connect_error(&url, &e.to_string()))?;

    // Set up on first connection rather than on a first save. Whichever way the
    // app reaches the database -- Settings, a capture, a run -- the tables are
    // there by the time anything tries to use them.
    ensure_schema(&built).await?;

    *db.0.lock().await = Some(built.clone());
    Ok(built)
}

/// Turns a connection failure into something a person can act on.
///
/// The raw error for the most common failure is "failed to lookup address
/// information: nodename nor servname provided, or not known", which is a DNS
/// message and reads like a broken connection string. It usually is not: Supabase
/// stopped publishing an IPv4 address for `db.<ref>.supabase.co`, so on an IPv4
/// network that host does not resolve at all and the pooler has to be used
/// instead. Saying so here is worth more than any amount of retrying, because no
/// retry will ever succeed.
fn explain_connect_error(url: &str, raw: &str) -> String {
    let lower = raw.to_lowercase();
    let dns = lower.contains("failed to lookup address information")
        || lower.contains("nodename nor servname")
        || lower.contains("name or service not known")
        || lower.contains("temporary failure in name resolution");

    // Built from a list rather than one long literal. A `\` line continuation
    // inside a Rust string swallows the newline *and* the indentation that
    // follows, which is easy to get subtly wrong and leaves the user reading a
    // paragraph with twenty spaces in the middle of it.
    let join = |lines: &[&str]| lines.join("\n");

    if dns {
        if let Some(reference) = supabase_direct_ref(url) {
            return format!(
                "{}\n\nDetails: {raw}",
                join(&[
                    "This address doesn't exist on your network, so there was nothing to connect to.",
                    "",
                    "It's the direct Supabase connection, which now needs IPv6. Yours doesn't have it, so",
                    "the name never resolves. Supabase's session pooler works over IPv4 and is the way in.",
                    "",
                    "Grab it from the Supabase dashboard under Connect, then Session pooler. It looks like:",
                    "",
                    &format!(
                        "  postgresql://postgres.{reference}:YOUR-PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres"
                    ),
                    "",
                    &format!("Watch the username - it becomes postgres.{reference}, not just postgres."),
                    "Copy the real string rather than typing this one; only your dashboard knows the region.",
                ])
            );
        }
        return format!(
            "{}\n\nDetails: {raw}",
            join(&[
                "That address doesn't exist on your network, so there was nothing to connect to.",
                "",
                "Worth checking the host name for a typo, and that this machine can reach it.",
            ])
        );
    }

    if lower.contains("password authentication failed") {
        return format!(
            "{}\n\nDetails: {raw}",
            join(&[
                "The database answered, but turned down the password.",
                "",
                "If your connection string still says [YOUR-PASSWORD], swap that for the real",
                "database password from the Supabase dashboard.",
            ])
        );
    }

    if lower.contains("timed out") || lower.contains("timeout") {
        return format!(
            "{}\n\nDetails: {raw}",
            join(&[
                "Found the server, but it never answered.",
                "",
                "That's usually a firewall, or a network blocking outbound connections on 5432.",
            ])
        );
    }

    format!("Could not reach the database: {raw}")
}

/// The project ref in a Supabase *direct* connection host, if this is one.
///
/// Matches `db.<ref>.supabase.co` only. A pooler host is already the working
/// shape and must not be diagnosed as the broken one.
fn supabase_direct_ref(url: &str) -> Option<String> {
    let after_at = url.rsplit('@').next()?;
    let host = after_at.split(['/', ':']).next()?;
    let rest = host.strip_prefix("db.")?;
    let reference = rest.strip_suffix(".supabase.co")?;
    if reference.is_empty() || reference.contains('.') {
        return None;
    }
    Some(reference.to_string())
}

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

/// Which of `EXPECTED_TABLES` exist right now.
async fn present_tables(p: &PgPool) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "select table_name from information_schema.tables
          where table_schema = 'public' and table_name = any($1)",
    )
    .bind(&EXPECTED_TABLES[..])
    .fetch_all(p)
    .await
    .map_err(|e| format!("Could not read the schema: {e}"))?;

    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>("table_name").ok())
        .collect())
}

/// Applies the additive column changes.
///
/// Deliberately unconditional: every statement in the file is an `if not exists`,
/// so running it against an already-current database is a handful of no-op
/// catalogue lookups. Trying to be clever about when to skip it is how a build
/// ends up querying a column that quietly never got added.
async fn apply_migrations(p: &PgPool) -> Result<(), String> {
    sqlx::raw_sql(MIGRATIONS).execute(p).await.map_err(|e| {
        format!(
            "Could not bring the tables up to date: {e}. Nothing is lost -- this only \
             adds columns -- but this build may not be able to save runs until it succeeds."
        )
    })?;
    Ok(())
}

/// Applies the embedded schema when anything is missing.
///
/// The check comes first so the common case -- everything already in place --
/// costs one cheap query instead of re-running the whole file on every launch.
pub async fn ensure_schema(p: &PgPool) -> Result<(), String> {
    let found = present_tables(p).await?;
    if found.len() == EXPECTED_TABLES.len() {
        return apply_migrations(p).await;
    }

    sqlx::raw_sql(SCHEMA).execute(p).await.map_err(|e| {
        format!(
            "Could not create the tables: {e}. If this mentions permissions, the \
             connection string may not be the one with owner rights."
        )
    })?;

    // Trust the database, not the fact that the statements returned without error.
    let after = present_tables(p).await?;
    let missing: Vec<&str> = EXPECTED_TABLES
        .iter()
        .copied()
        .filter(|t| !after.iter().any(|f| f == t))
        .collect();

    if missing.is_empty() {
        apply_migrations(p).await
    } else {
        Err(format!(
            "Ran the schema, but {} still {} missing.",
            missing.join(", "),
            if missing.len() == 1 { "is" } else { "are" }
        ))
    }
}

/// Re-applies the schema on demand, for when a table has been dropped by hand.
#[tauri::command]
pub async fn db_migrate(db: tauri::State<'_, Db>) -> Result<DbHealth, String> {
    let p = pool(&db).await?;
    // Force it, rather than relying on the has-everything shortcut.
    sqlx::raw_sql(SCHEMA)
        .execute(&p)
        .await
        .map_err(|e| format!("Could not apply the schema: {e}"))?;
    apply_migrations(&p).await?;
    db_test(db).await
}

// ------------------------------------------------------------------ settings

#[tauri::command]
pub async fn settings_load(db: tauri::State<'_, Db>, key: String) -> Result<Option<Value>, String> {
    let p = pool(&db).await?;
    let row = sqlx::query("select value from settings where key = $1")
        .bind(key.trim())
        .fetch_optional(&p)
        .await
        .map_err(|e| format!("Could not load settings: {e}"))?;

    Ok(row.and_then(|r| r.try_get::<Value, _>("value").ok()))
}

#[tauri::command]
pub async fn settings_save(
    db: tauri::State<'_, Db>,
    key: String,
    value: Value,
) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Settings key cannot be empty.".into());
    }

    let p = pool(&db).await?;
    sqlx::query(
        "insert into settings (key, value, updated_at)
         values ($1, $2, now())
         on conflict (key) do update set value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(&p)
    .await
    .map_err(|e| format!("Could not save settings: {e}"))?;

    Ok(())
}

// -------------------------------------------------------------------- health

#[tauri::command]
pub async fn db_test(db: tauri::State<'_, Db>) -> Result<DbHealth, String> {
    let url = read_url()?;
    let target = describe(&url);
    let p = pool(&db).await?;

    let server_version: String = sqlx::query("select version()")
        .fetch_one(&p)
        .await
        .map_err(|e| format!("Connected, but the server did not answer: {e}"))?
        .try_get(0)
        .map_err(|e| e.to_string())?;

    // Connecting already applied the schema, so this is a confirmation rather
    // than a question -- but it is worth confirming against the database instead
    // of assuming the earlier step worked.
    let found = present_tables(&p).await?;
    let missing: Vec<String> = EXPECTED_TABLES
        .iter()
        .filter(|t| !found.iter().any(|f| f == *t))
        .map(|t| t.to_string())
        .collect();

    // Only meaningful once the table exists.
    let session_count: i64 = if found.iter().any(|t| t == "sessions") {
        sqlx::query("select count(*) from sessions")
            .fetch_one(&p)
            .await
            .map_err(|e| e.to_string())?
            .try_get(0)
            .unwrap_or(0)
    } else {
        0
    };

    let advice = if !missing.is_empty() {
        Some(format!(
            "Connected, but {} could not be created. This usually means the \
             connection string lacks owner rights on the public schema.",
            missing.join(", ")
        ))
    } else {
        None
    };

    Ok(DbHealth {
        connected: true,
        target,
        server_version: server_version
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" "),
        tables_found: found,
        tables_missing: missing,
        session_count,
        advice,
    })
}

#[cfg(test)]
mod tests {
    use super::{describe, with_tls};

    #[test]
    fn tls_is_added_once() {
        assert_eq!(
            with_tls("postgresql://u:p@h:5432/db"),
            "postgresql://u:p@h:5432/db?sslmode=require"
        );
        assert_eq!(
            with_tls("postgresql://u:p@h:5432/db?application_name=x"),
            "postgresql://u:p@h:5432/db?application_name=x&sslmode=require"
        );
        // Already specified: left alone, even if it disables TLS deliberately.
        assert_eq!(
            with_tls("postgresql://u:p@h:5432/db?sslmode=disable"),
            "postgresql://u:p@h:5432/db?sslmode=disable"
        );
    }

    #[test]
    fn describe_drops_the_credentials() {
        let d = describe("postgresql://postgres:hunter2@db.abc.supabase.co:5432/postgres");
        assert_eq!(d, "db.abc.supabase.co:5432/postgres");
        assert!(!d.contains("hunter2"));
        assert!(!d.contains("postgres:"));
    }

    #[test]
    fn describe_survives_a_password_containing_an_at_sign() {
        let d = describe("postgresql://postgres:p@ss@db.abc.supabase.co:5432/postgres");
        assert_eq!(d, "db.abc.supabase.co:5432/postgres");
        assert!(!d.contains("p@ss"));
    }
}
