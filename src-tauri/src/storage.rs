//! Screenshots live in Supabase Storage, not on this machine.
//!
//! A capture has to touch the disk once -- `screencapture` writes a file and
//! there is no way to ask macOS for the bytes directly -- but that file is a
//! staging area measured in seconds, not a place anything is kept. It is
//! uploaded and then deleted, and from that point the only copy is in the
//! project. That is what makes a screenshot reachable from an iPad later, and it
//! is why the `screenshots` table has carried `storage_bucket`, `storage_path`
//! and `uploaded_at` columns since the schema was first written.
//!
//! Storage rather than a `bytea` column, deliberately. The bytes would be
//! genuinely "in the database" either way, but a two-megabyte screenshot inlined
//! in a row is two megabytes travelling every time that row is listed, and an
//! iOS client would receive it as base64 inside JSON rather than as a URL it can
//! hand to an image view. Storage keeps the rows small and gives every image an
//! address.

use serde::Serialize;

use crate::keychain;

/// The Keychain entry for the Storage credential.
///
/// Separate from the Postgres connection string on purpose: they are different
/// secrets with different blast radii, and a `service_role` key pasted into the
/// database box would be a confusing way to find that out.
pub const PROVIDER: &str = "supabase_storage";

/// Where screenshots go. One bucket, private.
pub const BUCKET: &str = "screenshots";

/// The project's REST host, worked out from the database connection string.
///
/// Both Supabase connection shapes carry the project reference, and asking the
/// user to find their project URL in the dashboard when we are already holding
/// something that contains it is asking them to do a lookup we can do. So this
/// takes the string they have already pasted and produces the host, and the only
/// thing left to paste is the key itself.
///
/// - direct:  `postgresql://postgres:pw@db.<ref>.supabase.co:5432/postgres`
/// - pooler:  `postgresql://postgres.<ref>:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`
///
/// The password is allowed to contain `@`, so the host is taken from the *last*
/// `@` rather than the first -- the same trap the connection diagnostics fell
/// into once already.
pub fn project_url(conn: &str) -> Option<String> {
    let after_at = conn.rsplit('@').next()?;
    let host = after_at.split(['/', ':']).next()?;

    // Direct host: the reference is in the hostname.
    if let Some(rest) = host.strip_prefix("db.") {
        if let Some(reference) = rest.strip_suffix(".supabase.co") {
            if !reference.is_empty() && !reference.contains('.') {
                return Some(format!("https://{reference}.supabase.co"));
            }
        }
    }

    // Pooler host: the reference is in the *username*, as `postgres.<ref>`.
    if host.ends_with(".pooler.supabase.com") {
        let creds = conn.rsplit_once('@')?.0;
        let after_scheme = creds.split("//").nth(1)?;
        let user = after_scheme.split(':').next()?;
        let reference = user.strip_prefix("postgres.")?;
        if !reference.is_empty() && !reference.contains('.') {
            return Some(format!("https://{reference}.supabase.co"));
        }
    }

    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uploaded {
    pub bucket: String,
    pub path: String,
    pub bytes: usize,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

/// Creates the bucket if it is not there yet.
///
/// Private, always. A screenshot is whatever happened to be on the screen when
/// the shortcut was pressed, which is a category that includes far more than the
/// code someone meant to capture, and a public bucket would make every one of
/// them a guessable URL.
async fn ensure_bucket(base: &str, key: &str) -> Result<(), String> {
    let c = client()?;
    let resp = c
        .post(format!("{base}/storage/v1/bucket"))
        .header("Authorization", format!("Bearer {key}"))
        .header("apikey", key)
        .json(&serde_json::json!({
            "id": BUCKET,
            "name": BUCKET,
            "public": false,
        }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Supabase Storage: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    // Already existing is the normal case, not a failure.
    if status.is_success() {
        crate::trace(&format!("storage bucket created: {BUCKET}"));
        return Ok(());
    }
    if body.contains("already exists") || status.as_u16() == 409 {
        return Ok(());
    }
    Err(explain_storage(status, &body))
}

/// Uploads one screenshot and returns where it landed.
///
/// The path is `<session>/<position>-<name>`, so an object's address says which
/// problem it belongs to and where in the sequence it sat. Ordering matters here
/// -- the panel is told which screenshot is first and which is last -- and an
/// address that carries it means the order survives even if a row is lost.
#[tauri::command]
pub async fn storage_upload(
    session_id: String,
    file_name: String,
    mime: String,
    data: String,
) -> Result<Uploaded, String> {
    let key = keychain::read_api_key(PROVIDER)?;
    // Read here, never passed in. The connection string carries the database
    // password; the webview has never held it and must not start now just
    // because Storage happens to need the project reference inside it.
    let conn = crate::db::connection_string()?;
    let base = project_url(&conn).ok_or(
        "Could not work out the Supabase project URL from the database connection string. \
         Check the connection string in Settings — it should end in `.supabase.co` or \
         `.pooler.supabase.com`.",
    )?;

    let bytes = unbase64(&data).ok_or("That image is not valid base64.")?;
    if bytes.is_empty() {
        return Err("Refusing to upload an empty image.".into());
    }

    ensure_bucket(&base, &key).await?;

    let path = format!("{session_id}/{}", safe_name(&file_name));
    let started = std::time::Instant::now();
    let c = client()?;
    let resp = c
        .post(format!("{base}/storage/v1/object/{BUCKET}/{path}"))
        .header("Authorization", format!("Bearer {key}"))
        .header("apikey", &key)
        .header("Content-Type", if mime.is_empty() { "image/png" } else { &mime })
        // Re-uploading the same capture replaces it rather than failing, so a
        // retry after a dropped connection is safe to press.
        .header("x-upsert", "true")
        .body(bytes.clone())
        .send()
        .await
        .map_err(|e| format!("Could not upload the screenshot: {e}"))?;

    let status = resp.status();
    let ms = started.elapsed().as_millis();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let why = explain_storage(status, &body);
        // Logged as well as returned. An upload that fails while the panel is
        // busy answering is exactly the kind of thing that gets dismissed and
        // then wondered about later; the log is what makes "later" answerable.
        crate::trace(&format!(
            "storage upload FAILED {} ({} bytes, {}ms): {}",
            path,
            bytes.len(),
            ms,
            why
        ));
        return Err(why);
    }

    crate::trace(&format!(
        "storage upload ok {} ({} bytes, {}ms)",
        path,
        bytes.len(),
        ms
    ));

    Ok(Uploaded {
        bucket: BUCKET.to_string(),
        path,
        bytes: bytes.len(),
    })
}

/// A time-limited URL for one stored screenshot.
///
/// The bucket is private, so this is how an image is shown again after the local
/// file is gone -- and how an iOS client will fetch one without ever holding a
/// key that can write.
#[tauri::command]
pub async fn storage_signed_url(path: String, seconds: u32) -> Result<String, String> {
    let key = keychain::read_api_key(PROVIDER)?;
    let conn = crate::db::connection_string()?;
    let base = project_url(&conn).ok_or("Could not work out the Supabase project URL.")?;
    let c = client()?;

    let resp = c
        .post(format!("{base}/storage/v1/object/sign/{BUCKET}/{path}"))
        .header("Authorization", format!("Bearer {key}"))
        .header("apikey", &key)
        .json(&serde_json::json!({ "expiresIn": seconds.clamp(60, 604_800) }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Supabase Storage: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(explain_storage(status, &body));
    }

    let signed = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["signedURL"].as_str().map(str::to_string))
        .ok_or("Supabase Storage signed the object but returned no URL.")?;

    // The API returns a path, not an absolute URL.
    Ok(if signed.starts_with("http") {
        signed
    } else {
        format!("{base}/storage/v1{}", signed)
    })
}

/// Deletes one stored screenshot, so "delete" in the app means deleted.
#[tauri::command]
pub async fn storage_remove(path: String) -> Result<(), String> {
    let key = keychain::read_api_key(PROVIDER)?;
    let conn = crate::db::connection_string()?;
    let base = project_url(&conn).ok_or("Could not work out the Supabase project URL.")?;
    let c = client()?;
    let resp = c
        .delete(format!("{base}/storage/v1/object/{BUCKET}/{path}"))
        .header("Authorization", format!("Bearer {key}"))
        .header("apikey", &key)
        .send()
        .await
        .map_err(|e| format!("Could not reach Supabase Storage: {e}"))?;

    let status = resp.status();
    if status.is_success() || status.as_u16() == 404 {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    Err(explain_storage(status, &body))
}

/// Removes the local file, now that the bytes are somewhere else.
///
/// Deliberately its own command rather than a step inside the upload: a delete
/// that happens as a side effect of a network call is a delete that happens when
/// the network call only half worked. The caller deletes after it has the row
/// back, which is the point at which losing the local copy costs nothing.
#[tauri::command]
pub fn forget_local_file(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Ok(());
    }
    match std::fs::remove_file(&path) {
        Ok(()) => {
            // The promise is that nothing stays on this machine. A promise with
            // no record of being kept is a promise nobody can check.
            crate::trace(&format!("local capture deleted {path}"));
            Ok(())
        }
        // Already gone is the outcome we wanted.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => {
            crate::trace(&format!("local capture NOT deleted {path}: {e}"));
            Err(format!("Could not delete {path}: {e}"))
        }
    }
}

/// Standard base64, decoded.
///
/// Hand-rolled to match the encoder in `capture.rs` and for the same reason: a
/// dependency that cannot be compiled here cannot be checked here, and thirty
/// lines with reference vectors behind them is a smaller risk than a crate this
/// project takes on trust. Whitespace is skipped, because base64 that has been
/// through a JSON encoder and a webview has often been wrapped somewhere.
fn unbase64(s: &str) -> Option<Vec<u8>> {
    const INVALID: u8 = 255;
    fn sextet(c: u8) -> u8 {
        match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => INVALID,
        }
    }

    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut padding = 0usize;

    for &c in s.as_bytes() {
        if c.is_ascii_whitespace() {
            continue;
        }
        if c == b'=' {
            padding += 1;
            continue;
        }
        // Padding is only ever the tail. Data after it means the string is not
        // one encoding but two stuck together, and guessing which is wrong.
        if padding > 0 {
            return None;
        }
        let v = sextet(c);
        if v == INVALID {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }

    // Whatever is left must be zero-padding, not dropped data: `QUJD0` would
    // otherwise decode as `ABC` and quietly lose a character.
    if padding > 2 || bits >= 6 || acc != 0 {
        return None;
    }
    Some(out)
}

/// Keeps a file name usable as an object path.
///
/// Storage keys are a flat namespace with `/` as the only structure, so a name
/// containing one would silently invent a folder. Everything else that would
/// need escaping in a URL goes too.
fn safe_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        let c = if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
            c
        } else {
            '-'
        };
        // Runs collapse. Without this a name with a space before a bracket
        // becomes `caf---1-.png`, which is safe but looks like a bug every time
        // anyone reads the bucket.
        if (c == '-' || c == '.') && out.ends_with(c) {
            continue;
        }
        out.push(c);
    }
    // `..` cannot survive even collapsed, because a doubled dot in an object key
    // is the shape of a parent reference and there is no reason to keep one.
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    let trimmed = out.trim_matches(|c| c == '-' || c == '.').to_string();
    if trimmed.is_empty() {
        "capture.png".into()
    } else {
        trimmed
    }
}

/// Storage's own errors, in words worth reading.
fn explain_storage(status: reqwest::StatusCode, body: &str) -> String {
    let low = body.to_lowercase();
    if status.as_u16() == 401 || low.contains("invalid jwt") || low.contains("invalid api key") {
        return "Supabase Storage rejected that key. It needs to be the project's \
                `service_role` key — the anon key cannot write to a private bucket. \
                Find it under Project Settings → API."
            .into();
    }
    if status.as_u16() == 403 || low.contains("row-level security") || low.contains("violates") {
        return "Supabase Storage refused the write. A `service_role` key bypasses row-level \
                security; an anon key does not, which is usually what this means."
            .into();
    }
    if low.contains("payload too large") || status.as_u16() == 413 {
        return "That screenshot is larger than the project's upload limit. Raise it under \
                Storage → Settings, or capture a region instead of the whole screen."
            .into();
    }
    let snippet: String = body.chars().take(300).collect();
    format!("Supabase Storage returned {status}: {snippet}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pooler_string_yields_the_project_url() {
        assert_eq!(
            project_url(
                "postgresql://postgres.ikpzlesstdqauevsdwem:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
            )
            .as_deref(),
            Some("https://ikpzlesstdqauevsdwem.supabase.co")
        );
    }

    #[test]
    fn the_direct_string_yields_it_too() {
        assert_eq!(
            project_url("postgresql://postgres:pw@db.ikpzlesstdqauevsdwem.supabase.co:5432/postgres")
                .as_deref(),
            Some("https://ikpzlesstdqauevsdwem.supabase.co")
        );
    }

    #[test]
    fn a_password_containing_an_at_sign_does_not_confuse_the_host() {
        // The trap the connection diagnostics fell into once already.
        assert_eq!(
            project_url("postgresql://postgres.abcdef:p@ss@aws-0-eu-west-2.pooler.supabase.com:5432/postgres")
                .as_deref(),
            Some("https://abcdef.supabase.co")
        );
        assert_eq!(
            project_url("postgresql://postgres:p@ss@db.abcdef.supabase.co:5432/postgres").as_deref(),
            Some("https://abcdef.supabase.co")
        );
    }

    #[test]
    fn a_non_supabase_database_has_no_project_url() {
        assert!(project_url("postgresql://u:p@localhost:5432/postgres").is_none());
        assert!(project_url("postgresql://u:p@db.example.com:5432/postgres").is_none());
        assert!(project_url("").is_none());
    }

    #[test]
    fn a_pooler_host_without_a_project_username_is_refused() {
        // Rather than inventing a project reference out of "postgres".
        assert!(project_url("postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres").is_none());
    }

    #[test]
    fn a_slash_in_a_file_name_cannot_invent_a_folder() {
        assert_eq!(safe_name("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_name("a/b.png"), "a-b.png");

        // The exact spelling of a mangled name does not matter; what matters is
        // the two properties, so they are asserted rather than a string guessed.
        for hostile in [
            "../../etc/passwd",
            "..%2F..%2Fsecret.png",
            "/absolute/path.png",
            "....//....//x.png",
            "a\\b.png",
        ] {
            let got = safe_name(hostile);
            assert!(!got.contains('/'), "{hostile} -> {got}");
            assert!(!got.contains(".."), "{hostile} -> {got}");
            assert!(!got.is_empty(), "{hostile} -> empty");
        }
    }

    #[test]
    fn ordinary_capture_names_are_left_alone() {
        assert_eq!(safe_name("capture-1756000000000.png"), "capture-1756000000000.png");
        assert_eq!(safe_name("0-shot.png"), "0-shot.png");
    }

    #[test]
    fn a_name_made_entirely_of_junk_still_produces_something() {
        assert_eq!(safe_name("///"), "capture.png");
        assert_eq!(safe_name(""), "capture.png");
    }

    #[test]
    fn spaces_and_unicode_become_safe() {
        assert_eq!(safe_name("Screen Shot 2026.png"), "Screen-Shot-2026.png");
        assert_eq!(safe_name("café (1).png"), "caf-1-.png");
    }

    #[test]
    fn base64_round_trips_the_reference_vectors() {
        // RFC 4648, the same vectors the encoder in capture.rs is held to.
        assert_eq!(unbase64("").unwrap(), b"");
        assert_eq!(unbase64("Zg==").unwrap(), b"f");
        assert_eq!(unbase64("Zm8=").unwrap(), b"foo"[..2].to_vec());
        assert_eq!(unbase64("Zm9v").unwrap(), b"foo");
        assert_eq!(unbase64("Zm9vYg==").unwrap(), b"foob");
        assert_eq!(unbase64("Zm9vYmE=").unwrap(), b"fooba");
        assert_eq!(unbase64("Zm9vYmFy").unwrap(), b"foobar");
    }

    #[test]
    fn base64_decodes_a_real_png_header() {
        // The first bytes of any PNG, which is what actually arrives here.
        let png = unbase64("iVBORw0KGgo=").unwrap();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    }

    #[test]
    fn wrapped_base64_still_decodes() {
        assert_eq!(unbase64("Zm9v\nYmFy").unwrap(), b"foobar");
        assert_eq!(unbase64(" Zm9vYmFy ").unwrap(), b"foobar");
    }

    #[test]
    fn rubbish_is_refused_rather_than_half_decoded() {
        assert!(unbase64("not base64!").is_none());
        assert!(unbase64("Zm9v$mFy").is_none());
        // Data after the padding is two strings stuck together.
        assert!(unbase64("Zg==Zg==").is_none());
        // A stray trailing sextet would silently lose a character.
        assert!(unbase64("QUJD0").is_none());
    }

    #[test]
    fn an_anon_key_is_diagnosed_rather_than_dumped() {
        let msg = explain_storage(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"message":"Invalid JWT"}"#,
        );
        assert!(msg.contains("service_role"), "{msg}");
    }

    #[test]
    fn an_oversized_upload_says_what_to_do() {
        let msg = explain_storage(
            reqwest::StatusCode::PAYLOAD_TOO_LARGE,
            r#"{"message":"Payload too large"}"#,
        );
        assert!(msg.contains("region"), "{msg}");
    }
}
