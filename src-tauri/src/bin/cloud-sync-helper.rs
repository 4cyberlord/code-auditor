use global_hotkey::{
    hotkey::HotKey, GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    str::FromStr,
    time::Duration,
};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use uuid::Uuid;

const SERVICE: &str = "com.charles.councileditor";

/// The helper's own credential: a thirty-day session token, minted by the app
/// and revocable from the database. Everything this binary used to read — the
/// Postgres connection string, the Storage service-role key — is gone; this one
/// entry is what replaced all of it.
const HELPER_TOKEN: &str = "helper-token";
const SETTINGS_KEY: &str = "app.v1";
const BUCKET: &str = "screenshots";
const MAX_IMAGES: usize = 10;
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PendingImage {
    position: usize,
    local_path: String,
    file_name: String,
    bytes: i64,
    mime: String,
    captured_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PendingBatch {
    id: String,
    status: String,
    started_at: String,
    images: Vec<PendingImage>,
    error: Option<String>,
}

/// One call to the Council Editor API, as the helper.
///
/// The helper cannot borrow the app's session — it runs when the app is closed,
/// which is the whole reason it exists — so it carries its own token. The
/// endpoint and publishable key are compiled in, shared with the app rather than
/// duplicated, so there is one place they can be wrong.
async fn api(op: &str, args: Value) -> Result<Value, String> {
    let token = read_keychain(HELPER_TOKEN).map_err(|_| {
        "The helper is not authorised. Open Council Editor and authorise background capture."
            .to_string()
    })?;

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?
        .post(council_editor_lib::deployment::api_url())
        .header("apikey", council_editor_lib::deployment::publishable_key())
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({ "op": op, "args": args }))
        .send()
        .await
        .map_err(|e| format!("Could not reach the server API: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|_| format!("The server API answered {} with something that was not JSON.", status.as_u16()))?;

    if !status.is_success() || parsed["ok"] == Value::Bool(false) {
        // A 401 here means the thirty days ran out, or the token was revoked.
        // Saying which is the difference between "press the button again" and
        // "something is broken".
        if status.as_u16() == 401 {
            return Err("The helper's authorisation has expired. Re-authorise it in Council Editor.".into());
        }
        return Err(parsed["error"].as_str().unwrap_or("The server API refused that.").to_string());
    }
    Ok(parsed["data"].clone())
}

fn main() {
    // `--reset-auth` is gone. It wrote an Argon2id hash, and the server verifies
    // bcrypt with a pepper this binary has never held — so it would have created
    // an account nobody could sign in to, which is a worse failure than not
    // having the tool. Setting a PIN is `npm run auth:set-pin` now, which hashes
    // the way the server checks.
    if std::env::args().any(|arg| arg == "--reset-auth") {
        eprintln!(
            "--reset-auth has been removed. Use: COUNCIL_EDITOR_PIN_PEPPER='...' \
             npm run auth:set-pin <username> <4-digit pin>"
        );
        std::process::exit(2);
    }

    if let Err(e) = run() {
        log(&format!("helper startup failed: {e}"));
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    log("helper starting");
    let event_loop = EventLoopBuilder::new().build();
    let manager = GlobalHotKeyManager::new().map_err(|e| e.to_string())?;
    let start = hotkey("CODE_AUDITOR_HELPER_START_KEY", "Control+Alt+B")?;
    let capture = hotkey("CODE_AUDITOR_HELPER_CAPTURE_KEY", "Control+Alt+P")?;
    let submit = hotkey("CODE_AUDITOR_HELPER_SUBMIT_KEY", "Control+Alt+Enter")?;

    manager.register(start).map_err(|e| format!("start hotkey: {e}"))?;
    manager
        .register(capture)
        .map_err(|e| format!("capture hotkey: {e}"))?;
    manager.register(submit).map_err(|e| format!("submit hotkey: {e}"))?;

    log(&format!(
        "hotkeys registered: start={}, capture={}, submit={}",
        start, capture, submit
    ));

    let receiver = GlobalHotKeyEvent::receiver();
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    event_loop.run(move |_event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        while let Ok(event) = receiver.try_recv() {
            if event.state != HotKeyState::Pressed {
                continue;
            }
            if event.id == start.id() {
                if let Err(e) = start_batch() {
                    log(&format!("start batch failed: {e}"));
                }
            } else if event.id == capture.id() {
                if let Err(e) = capture_screen() {
                    log(&format!("capture failed: {e}"));
                }
            } else if event.id == submit.id() {
                if let Err(e) = rt.block_on(submit_batch()) {
                    log(&format!("submit failed: {e}"));
                    let _ = update_pending_error(&e);
                }
            }
        }
    });
}

fn hotkey(var: &str, fallback: &str) -> Result<HotKey, String> {
    let raw = std::env::var(var)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string());
    HotKey::from_str(&raw).map_err(|e| format!("{raw} is not a valid hotkey: {e}"))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set.".to_string())
}

fn support_dir() -> Result<PathBuf, String> {
    Ok(home()?.join("Library/Application Support/CodeAuditor/BackgroundHelper"))
}

fn log_dir() -> Result<PathBuf, String> {
    Ok(home()?.join("Library/Logs/CodeAuditor"))
}

fn pending_path() -> Result<PathBuf, String> {
    Ok(support_dir()?.join("pending-batch.json"))
}

fn captures_dir(batch_id: &str) -> Result<PathBuf, String> {
    Ok(support_dir()?.join("captures").join(batch_id))
}

fn log(message: &str) {
    let stamped = format!("{} {message}\n", now());
    if let Ok(dir) = log_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("helper.log"))
            .and_then(|mut file| {
                use std::io::Write;
                file.write_all(stamped.as_bytes())
            });
    }
    eprint!("{stamped}");
}

fn save_pending(batch: &PendingBatch) -> Result<(), String> {
    let path = pending_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create helper state directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(batch).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Could not save helper batch: {e}"))
}

fn read_pending() -> Result<Option<PendingBatch>, String> {
    let path = pending_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Could not read helper batch: {e}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("Could not parse helper batch: {e}"))
}

fn update_pending_error(message: &str) -> Result<(), String> {
    if let Some(mut batch) = read_pending()? {
        batch.error = Some(message.to_string());
        save_pending(&batch)?;
    }
    Ok(())
}

fn start_batch() -> Result<(), String> {
    let id = format!("batch-{}", Uuid::new_v4());
    let batch = PendingBatch {
        id: id.clone(),
        status: "collecting".to_string(),
        started_at: now(),
        images: vec![],
        error: None,
    };
    fs::create_dir_all(captures_dir(&id)?)
        .map_err(|e| format!("Could not create capture directory: {e}"))?;
    save_pending(&batch)?;
    log(&format!("started {id}"));
    Ok(())
}

fn capture_screen() -> Result<(), String> {
    let mut batch = read_pending()?.ok_or("Start a helper batch before capturing.".to_string())?;
    if batch.images.len() >= MAX_IMAGES {
        batch.status = "ready".to_string();
        batch.error = Some(format!("A helper batch can hold {MAX_IMAGES} screenshots."));
        save_pending(&batch)?;
        return Err(format!("A helper batch can hold {MAX_IMAGES} screenshots."));
    }
    let dir = captures_dir(&batch.id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create capture directory: {e}"))?;
    let position = batch.images.len();
    let file_name = format!("{position}-{}.png", chrono::Utc::now().format("%Y%m%dT%H%M%SZ"));
    let path = dir.join(&file_name);
    let out = Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg(&path)
        .output()
        .map_err(|e| format!("Could not launch screencapture: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            "screencapture failed. Check macOS Screen Recording permission.".to_string()
        } else {
            format!("screencapture failed: {stderr}")
        };
        batch.error = Some(msg.clone());
        save_pending(&batch)?;
        return Err(msg);
    }
    let bytes = fs::metadata(&path)
        .map_err(|e| format!("Could not inspect captured screenshot: {e}"))?
        .len() as i64;
    if bytes <= 0 {
        batch.error = Some("Captured screenshot was empty.".to_string());
        save_pending(&batch)?;
        return Err("Captured screenshot was empty.".to_string());
    }
    batch.images.push(PendingImage {
        position,
        local_path: path.to_string_lossy().to_string(),
        file_name,
        bytes,
        mime: "image/png".to_string(),
        captured_at: now(),
    });
    batch.status = "ready".to_string();
    batch.error = None;
    save_pending(&batch)?;
    log(&format!("captured image {} for {}", position + 1, batch.id));
    Ok(())
}

async fn submit_batch() -> Result<(), String> {
    let batch = read_pending()?.ok_or("No helper batch is waiting to submit.".to_string())?;
    if batch.images.is_empty() {
        return Err("The helper batch has no screenshots.".to_string());
    }
    // Everything below used to be a Postgres transaction plus a Storage
    // service-role key, both read from the Keychain. It is three API calls now,
    // carrying the helper's own token — so this binary holds no database
    // credential and no key that can write anywhere.

    let settings = api("settings.load", serde_json::json!({ "key": SETTINGS_KEY }))
        .await
        .unwrap_or_else(|e| {
            log(&format!("settings load skipped: {e}"));
            Value::Null
        });
    let settings = sanitize_settings(if settings.is_null() {
        Value::Object(Default::default())
    } else {
        settings
    });

    let session_title = format!(
        "Background capture batch {}",
        chrono::Utc::now().format("%Y-%m-%d %H:%M UTC")
    );
    let session = api("sessions.create", serde_json::json!({ "title": session_title })).await?;
    let session_id = session["id"]
        .as_str()
        .ok_or("The server did not return a session id.")?
        .to_string();

    // The owner prefix is required by the server: an upload happens before there
    // is any row to check ownership against, so the path is what carries it.
    let owner = api("auth.whoami", serde_json::json!({})).await?;
    let owner_id = owner["userId"]
        .as_str()
        .ok_or("The server did not say who the helper is.")?
        .to_string();

    let mut images = vec![];
    for (position, image) in batch.images.iter().enumerate() {
        let bytes = fs::read(&image.local_path)
            .map_err(|e| format!("Could not read {}: {e}", image.file_name))?;
        let path = format!("{owner_id}/{session_id}/{}", safe_segment(&image.file_name));

        let signed = api(
            "storage.uploadUrl",
            serde_json::json!({ "path": path, "bucket": BUCKET }),
        )
        .await?;
        let url = signed["url"].as_str().ok_or("The server did not return an upload URL.")?;

        let resp = reqwest::Client::new()
            .put(url)
            .header("Content-Type", if image.mime.is_empty() { "image/png" } else { &image.mime })
            .header("x-upsert", "true")
            .body(bytes.clone())
            .send()
            .await
            .map_err(|e| format!("Could not upload {}: {e}", image.file_name))?;
        if !resp.status().is_success() {
            return Err(format!(
                "Could not upload {}: the storage service answered {}.",
                image.file_name,
                resp.status().as_u16()
            ));
        }

        images.push(serde_json::json!({
            "storageBucket": BUCKET,
            "storagePath": path,
            "fileName": image.file_name,
            "bytes": bytes.len() as i64,
            "mime": image.mime,
            "width": Value::Null,
            "height": Value::Null,
        }));
        let _ = position;
    }

    let job = api(
        "jobs.create",
        serde_json::json!({
            "sessionId": session_id,
            "settingsSnapshot": settings,
            "images": images,
        }),
    )
    .await?;
    let job_id = job["id"].as_str().unwrap_or_default().to_string();

    for image in &batch.images {
        let _ = fs::remove_file(&image.local_path);
    }
    let _ = fs::remove_file(pending_path()?);
    log(&format!("submitted {} as job {job_id}", batch.id));
    Ok(())
}

/// Read one Keychain value. Read-only by design: the app writes the helper's
/// token, the helper only ever reads it, so a bug here cannot invalidate its own
/// credential.
fn read_keychain(account: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => Err(format!("No Keychain value saved for {account}.")),
        Err(e) => Err(e.to_string()),
    }
}

fn sanitize_settings(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| !is_secret_key(key))
                .map(|(key, value)| (key, sanitize_settings(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(sanitize_settings).collect()),
        other => other,
    }
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["api", "secret", "token", "key", "password", "credential"]
        .iter()
        .any(|needle| key.contains(needle))
}

fn safe_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    let out = out.trim_matches(['-', '.']);
    if out.is_empty() {
        "item".to_string()
    } else {
        out.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_settings_strips_nested_secrets() {
        let clean = sanitize_settings(serde_json::json!({
            "mode": "auto",
            "apiKey": "nope",
            "nested": {
                "token": "nope",
                "model": "ok"
            },
            "list": [
                { "storageKey": "nope", "id": "ok" }
            ]
        }));
        assert_eq!(clean["mode"], "auto");
        assert!(clean.get("apiKey").is_none());
        assert!(clean["nested"].get("token").is_none());
        assert_eq!(clean["nested"]["model"], "ok");
        assert!(clean["list"][0].get("storageKey").is_none());
        assert_eq!(clean["list"][0]["id"], "ok");
    }

    #[test]
    fn safe_segment_keeps_storage_paths_plain() {
        assert_eq!(safe_segment("hello world.png"), "hello-world.png");
        assert_eq!(safe_segment("../../secret"), "secret");
        assert_eq!(safe_segment(""), "item");
    }
}
