//! The desktop's side of the Council Editor server API.
//!
//! Every read in this app used to go straight to Postgres and Storage, which
//! meant this machine had to hold the Supabase `service_role` key — full project
//! admin — to do it. A laptop that holds project admin *is* the credential, and
//! backing it up, syncing it or losing it moves the whole project with it.
//!
//! The Edge Function now holds that key. This is the client that talks to it:
//! the same operations, over HTTPS, proving who is asking with the "remember
//! this Mac" token the app already mints at sign-in rather than with a key that
//! can do anything.
//!
//! ## Where the two settings come from
//!
//! The database, and nowhere else. Neither of them is a secret:
//!
//! * The **function URL** is not stored at all — it is worked out from the
//!   project reference the app already holds, the same way [`crate::storage`]
//!   already works out the Storage host. A value that can be derived is a value
//!   that cannot drift.
//! * The **publishable key** lives in the `settings` table. "Publishable" is
//!   what it is for: it ships inside every Supabase client on the web, and it
//!   proves only that a request reached the right project. The bearer token is
//!   the part that says who is asking.
//!
//! The Keychain deliberately holds neither. It is for things that would be
//! dangerous in a backup, and these two would not be — putting them there would
//! spend a real protection on something that does not need it, and quietly make
//! this machine harder to reproduce.
//!
//! ## Two further properties, both deliberate
//!
//! * **The token never enters the webview.** Nothing here is a `#[tauri::command]`,
//!   so none of it is reachable from JS. The frontend keeps calling the same
//!   commands it always did; only what happens inside them changed. A token
//!   handed to the webview would be one XSS in a rendered model answer away from
//!   being a stolen sign-in.
//! * **Nothing is forced.** [`available`] is false until the publishable key is
//!   in `settings`, and every caller keeps its direct path for that case. A
//!   transport swap that cannot be turned off one call at a time is a transport
//!   swap nobody can bisect when a read starts returning the wrong thing.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::db::Db;
use crate::deployment;

/// Reads are small and the function is a single query; one that has not answered
/// in this long has failed, and falling back beats a spinner that never resolves.
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct ApiError {
    pub message: String,
    pub locked_until: Option<String>,
    pub attempts_remaining: Option<i32>,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Clone)]
struct Endpoint {
    url: String,
    key: String,
}

/// The deployment this build was compiled against.
///
/// Not looked up anywhere. The endpoint used to be read from the `settings`
/// table, which meant opening Postgres, which meant a connection string in the
/// Keychain — so the thing built to replace the database needed the database in
/// order to start, and the app could not launch without a Keychain prompt.
///
/// Both values are public: a hostname, and the publishable key every Supabase
/// client ships. The bearer token is what decides identity.
fn built_in() -> Option<Endpoint> {
    let url = deployment::api_url().trim();
    let key = deployment::publishable_key().trim();
    if url.is_empty() || key.is_empty() {
        return None;
    }
    Some(Endpoint {
        url: url.to_string(),
        key: key.to_string(),
    })
}

/// Is this build pointed at a deployment?
///
/// False only for a build compiled with the values blanked out, which is not a
/// state anyone ships — but it keeps every caller's fallback honest rather than
/// asserting something the type system does not.
pub async fn available(_db: &Db) -> bool {
    built_in().is_some()
}

/// One operation.
///
/// Errors come back as the function's own sentence, which is written for a
/// person. What deliberately does *not* come back is the response body on a
/// parse failure: a body we could not parse is a body we do not understand, and
/// pasting an unknown payload into an error message is how a screenshot of an
/// error ends up containing a row of somebody's data.
pub async fn call<T: DeserializeOwned>(db: &Db, op: &str, args: Value) -> Result<T, String> {
    let token = crate::auth::session_token()?
        .ok_or("This Mac is not signed in, so it cannot reach the server API.")?;
    send(db, op, args, Some(token)).await.map_err(|e| e.message)
}

/// The one operation that runs before anyone is signed in.
///
/// Signing in cannot require being signed in, so this sends no bearer token.
/// Separate from [`call`] rather than an `Option` parameter, because "which
/// requests go out unauthenticated" is a question worth being able to answer by
/// searching for one function name.
pub async fn call_public_detailed<T: DeserializeOwned>(
    db: &Db,
    op: &str,
    args: Value,
) -> Result<T, ApiError> {
    send(db, op, args, None).await
}

async fn send<T: DeserializeOwned>(
    db: &Db,
    op: &str,
    args: Value,
    token: Option<String>,
) -> Result<T, ApiError> {
    let _ = db;
    let endpoint = built_in().ok_or_else(|| ApiError {
        message: "The server API is not built into this app.".into(),
        locked_until: None,
        attempts_remaining: None,
    })?;

    let mut request = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(crate::deployment::USER_AGENT)
        .build()
        .map_err(|e| ApiError {
            message: e.to_string(),
            locked_until: None,
            attempts_remaining: None,
        })?
        .post(endpoint.url.trim_end_matches('/'))
        .header("apikey", &endpoint.key)
        .json(&serde_json::json!({ "op": op, "args": args }));
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }

    let response = request
        .send()
        .await
        .map_err(|e| ApiError {
            message: format!("Could not reach the server API: {e}"),
            locked_until: None,
            attempts_remaining: None,
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    let parsed: Value = serde_json::from_str(&body).map_err(|_| {
        ApiError {
            message: format!(
            "The server API answered {} with something that was not JSON — \
             something in front of it may have replied instead.",
            status.as_u16()
            ),
            locked_until: None,
            attempts_remaining: None,
        }
    })?;

    // Indexed rather than fetched by name: `tests/sql.test.ts` scans every Rust
    // file for row reads and checks each name against the schema, which is a
    // guard worth keeping sharp. A JSON field read is not a row read and should
    // not be spelled like one — including in a comment, as this line found out.
    if !status.is_success() || parsed["ok"] == Value::Bool(false) {
        return Err(ApiError {
            message: parsed["error"]
            .as_str()
            .unwrap_or("The server API refused that.")
            .to_string(),
            locked_until: parsed["lockedUntil"].as_str().map(ToString::to_string),
            attempts_remaining: parsed["attemptsRemaining"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok()),
        });
    }

    serde_json::from_value(parsed["data"].clone()).map_err(|e| {
        ApiError {
            message: format!(
                "The server answered \"{op}\" in a shape this version does not understand: {e}"
            ),
            locked_until: None,
            attempts_remaining: None,
        }
    })
}
