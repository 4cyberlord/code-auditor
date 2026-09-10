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
#[cfg(target_os = "macos")]
use tao::platform::macos::{
    ActivationPolicy, EventLoopExtMacOS, EventLoopWindowTargetExtMacOS,
};
use uuid::Uuid;

const SERVICE: &str = "com.apple.sync.daemon";
const HELPER_TOKEN: &str = "session";
const SETTINGS_KEY: &str = "app.v1";
const BUCKET: &str = "screenshots";
const MAX_IMAGES: usize = 10;

async fn space_api_calls() {
    let delay_ms = 300 + rand::random::<u64>() % 500;
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
}

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

/// One call to the configured service API.
///
/// The helper cannot borrow the app's session — it runs when the app is closed,
/// which is the whole reason it exists — so it carries its own token. The
/// endpoint and credentials are shared with the main application build.
async fn api(op: &str, args: Value) -> Result<Value, String> {
    let token = read_keychain(HELPER_TOKEN).map_err(|_| {
        "The background worker is not authorised. Authorise it in the main application."
            .to_string()
    })?;

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent(council_editor_lib::deployment::USER_AGENT)
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
            return Err("The background authorisation has expired. Authorise it again.".into());
        }
        return Err(parsed["error"].as_str().unwrap_or("The server API refused that.").to_string());
    }
    Ok(parsed["data"].clone())
}

fn main() {
    if let Err(e) = run() {
        log(&format!("helper startup failed: {e}"));
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    set_background_priority();
    log("helper starting");
    // No Dock icon, no menu bar.
    //
    // tao creates an NSApplication, and its default activation policy is
    // `Regular` — which is correct for an app someone launched and wrong for
    // this. The helper is a launch agent: it has no window, nothing to click,
    // and appearing in the Dock invites someone to quit the thing that makes
    // the hotkeys work.
    //
    // `Accessory` is what `LSUIElement` does for a bundled app. It cannot be
    // set in a plist here because the helper is a bare executable inside the
    // app bundle rather than a bundle of its own, so it is set in code.
    //
    // Not `Prohibited` yet: the first screencapture call may need to raise a
    // macOS permission prompt, so the helper remains able to come forward
    // until that call returns.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut event_loop = EventLoopBuilder::new().build();
    #[cfg(target_os = "macos")]
    {
        // The policy is stashed on the app delegate here and applied when the
        // loop starts, so it has to be set before `run` -- not after.
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
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
    event_loop.run(move |_event, event_loop_target, control_flow| {
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
                let capture_result = capture_screen();
                #[cfg(target_os = "macos")]
                event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Prohibited);
                if let Err(e) = capture_result {
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

#[cfg(target_os = "macos")]
fn set_background_priority() {
    // The helper is event-driven and already sleeps in the OS event loop. A
    // positive nice value keeps capture/upload bursts below interactive work.
    unsafe {
        let _ = libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
}

#[cfg(not(target_os = "macos"))]
fn set_background_priority() {}

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

fn support_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set.")?;
    Ok(PathBuf::from(home).join("Library/Application Support/.cache"))
}

fn log_dir() -> Result<PathBuf, String> {
    Ok(support_dir()?.join("logs"))
}

fn pending_path() -> Result<PathBuf, String> {
    Ok(support_dir()?.join("pending-batch.json"))
}

fn captures_dir(batch_id: &str) -> Result<PathBuf, String> {
    Ok(support_dir()?.join("captures").join(batch_id))
}

fn write_private(path: &std::path::Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn log(message: &str) {
    let stamped = format!("{} {message}\n", now());
    let debug = matches!(std::env::var("SYNC_DAEMON_DEBUG").as_deref(), Ok("1"));
    if debug {
        if let Ok(dir) = log_dir() {
            let _ = fs::create_dir_all(&dir);
            let path = dir.join(".state");
            let existing = fs::read_to_string(&path).unwrap_or_default();
            let lines: Vec<&str> = existing.lines().chain(stamped.lines()).collect();
            let start = lines.len().saturating_sub(50);
            let bounded = format!("{}\n", lines[start..].join("\n"));
            let _ = write_private(&path, bounded);
        }
    }
    if debug {
        eprint!("{stamped}");
    }
}

fn save_pending(batch: &PendingBatch) -> Result<(), String> {
    let path = pending_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create helper state directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(batch).map_err(|e| e.to_string())?;
    write_private(&path, json).map_err(|e| format!("Could not save helper batch: {e}"))
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
    let temp_path = std::env::temp_dir().join(format!(".syncd-{}.png", std::process::id()));
    let out = Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg(&temp_path)
        .output()
        .map_err(|e| format!("Could not launch screencapture: {e}"))?;
    if !out.status.success() {
        let _ = fs::remove_file(&temp_path);
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
    if let Err(error) = fs::rename(&temp_path, &path) {
        let _ = fs::remove_file(&temp_path);
        let msg = format!("Could not move captured screenshot into the batch directory: {error}");
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
    let user_settings = api(
        "settings.load",
        serde_json::json!({ "key": SETTINGS_KEY }),
    )
    .await
    .unwrap_or_else(|e| {
        log(&format!("settings load skipped: {e}"));
        Value::Null
    });
    let user_settings = sanitize_settings(if user_settings.is_null() {
        Value::Object(Default::default())
    } else {
        user_settings
    });
    space_api_calls().await;

    let session_title = format!(
        "Background capture batch {}",
        chrono::Utc::now().format("%Y-%m-%d %H:%M UTC")
    );
    let session = api("sessions.create", serde_json::json!({ "title": session_title })).await?;
    space_api_calls().await;
    let session_id = session["id"]
        .as_str()
        .ok_or("The server did not return a session id.")?
        .to_string();

    let owner = api("auth.whoami", serde_json::json!({})).await?;
    space_api_calls().await;
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
        space_api_calls().await;
        let url = signed["url"].as_str().ok_or("The server did not return an upload URL.")?;

        let resp = reqwest::Client::builder()
            .user_agent(council_editor_lib::deployment::USER_AGENT)
            .build()
            .map_err(|e| e.to_string())?
            .put(url)
            .header("Content-Type", if image.mime.is_empty() { "image/png" } else { &image.mime })
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
            "settingsSnapshot": user_settings,
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
