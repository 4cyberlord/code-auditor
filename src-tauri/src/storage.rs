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


/// Where screenshots go. One bucket, private.
pub const BUCKET: &str = "screenshots";

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

/// Uploads one screenshot and returns where it landed.
///
/// The path is `<session>/<position>-<name>`, so an object's address says which
/// problem it belongs to and where in the sequence it sat. Ordering matters here
/// -- the panel is told which screenshot is first and which is last -- and an
/// address that carries it means the order survives even if a row is lost.
#[tauri::command]
pub async fn storage_upload(
    db: tauri::State<'_, crate::db::Db>,
    session_id: String,
    file_name: String,
    mime: String,
    data: String,
) -> Result<Uploaded, String> {
    let bytes = unbase64(&data).ok_or("That image is not valid base64.")?;
    if bytes.is_empty() {
        return Err("Refusing to upload an empty image.".into());
    }

    // Ownership lives in the path, because at upload time there is no row to
    // check it against — the screenshot record is written afterwards.
    let owner = crate::auth::current().ok_or(crate::auth::LOCKED)?.user_id;
    let path = format!("{owner}/{session_id}/{}", safe_name(&file_name));

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Signed {
        url: String,
    }
    let signed: Signed = crate::server_api::call(
        db.inner(),
        "storage.uploadUrl",
        serde_json::json!({ "path": path, "bucket": BUCKET }),
    )
    .await?;

    let started = std::time::Instant::now();
    let resp = client()?
        .put(&signed.url)
        .header("Content-Type", if mime.is_empty() { "image/png" } else { &mime })
        .header("x-upsert", "true")
        .body(bytes.clone())
        .send()
        .await
        .map_err(|e| format!("Could not upload the screenshot: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(explain_storage(status, &body));
    }

    crate::trace(&format!(
        "screenshot uploaded {path} ({} bytes, {}ms)",
        bytes.len(),
        started.elapsed().as_millis()
    ));
    Ok(Uploaded { bucket: BUCKET.to_string(), path, bytes: bytes.len() })
}

/// A time-limited URL for one stored screenshot.
///
/// The bucket is private, so this is how an image is shown again after the local
/// file is gone -- and how an iOS client will fetch one without ever holding a
/// key that can write.
#[tauri::command]
pub async fn storage_signed_url(
    db: tauri::State<'_, crate::db::Db>,
    path: String,
    seconds: u32,
) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct Signed {
        url: String,
    }
    let signed: Signed = crate::server_api::call(
        db.inner(),
        "storage.sign",
        serde_json::json!({ "path": path, "seconds": seconds, "bucket": BUCKET }),
    )
    .await?;
    Ok(signed.url)
}

/// Deletes one stored screenshot, so "delete" in the app means deleted.
#[tauri::command]
pub async fn storage_remove(
    db: tauri::State<'_, crate::db::Db>,
    path: String,
) -> Result<(), String> {
    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "storage.remove",
        serde_json::json!({ "path": path, "bucket": BUCKET }),
    )
    .await?;
    Ok(())
}

/// Removes the local file, now that the bytes are somewhere else.
///
/// Deliberately its own command rather than a step inside the upload: a delete
/// that happens as a side effect of a network call is a delete that happens when
/// the network call only half worked. The caller deletes after it has the row
/// back, which is the point at which losing the local copy costs nothing.
#[tauri::command]
pub fn forget_local_file(path: String) -> Result<(), String> {
    crate::auth::require()?;
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

