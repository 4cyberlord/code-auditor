//! Which deployment this build talks to.
//!
//! Both values are public by design. The function URL is a hostname, and the
//! publishable key is the one Supabase intends every client to ship — it proves
//! a request reached the right project and says nothing about who sent it. The
//! bearer token is what decides identity.
//!
//! Compiled in rather than looked up, and that is the point. The server API used
//! to find its own address by reading the `settings` table, which meant opening
//! Postgres, which meant reading the connection string from the Keychain — so
//! the thing built to replace the database depended on the database to start.
//! An app that ships knowing its own backend needs neither.
//!
//! Override at build time when pointing a build at a different project:
//!
//!   COUNCIL_EDITOR_API_URL=... SUPABASE_PUBLISHABLE_KEY=... npm run app:build

/// Browser-like User-Agent shared by the app and its background helper.
pub const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/// `https://<ref>.supabase.co/functions/v1/council-editor-api`
pub fn api_url() -> &'static str {
    match option_env!("COUNCIL_EDITOR_API_URL") {
        Some(url) if !url.is_empty() => url,
        _ => "https://ikpzlesstdqauevsdwem.supabase.co/functions/v1/council-editor-api",
    }
}

/// The project's publishable (anon) key.
pub fn publishable_key() -> &'static str {
    match option_env!("SUPABASE_PUBLISHABLE_KEY") {
        Some(key) if !key.is_empty() => key,
        _ => "sb_publishable_qhH6xqP5MOdm2ITyHEXpxA_zbSuz2qf",
    }
}
