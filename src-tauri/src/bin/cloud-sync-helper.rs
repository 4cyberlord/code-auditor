use global_hotkey::{
    hotkey::HotKey, GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
};
use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHasher, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use hmac::{Hmac, Mac};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use sqlx::{postgres::PgPoolOptions, Row};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    str::FromStr,
    time::Duration,
};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use uuid::Uuid;

const SERVICE: &str = "com.charles.codeauditor";
const DB_KEYCHAIN_ID: &str = "supabase-url";
const STORAGE_KEYCHAIN_ID: &str = "supabase_storage";
const SETTINGS_KEY: &str = "app.v1";
const BUCKET: &str = "screenshots";
const MAX_IMAGES: usize = 10;
const KC_PEPPER: &str = "auth-pepper";
const KC_OWNER: &str = "auth-owner";
const KC_TOKEN: &str = "auth-token";
// No credentials live in this file any more.
//
// This binary ships *inside* the .app bundle, and it carried a username and PIN
// as compiled-in constants. `strings` on the sidecar printed the PIN, and
// `--reset-auth` truncated app_users and recreated that account — so anyone
// holding a copy of the app could take the account without ever seeing the
// PIN prompt. The Tauri commands are all behind `auth::require()`; running the
// sidecar directly walked around that entirely.
//
// The reset now exists only in debug builds, takes its credentials from the
// environment, and refuses to invent any. The database is the authority on who
// the owner is; nothing here should be able to overrule it in a shipped build.
#[cfg(debug_assertions)]
fn reset_credentials() -> Result<(String, String), String> {
    let name = std::env::var("CODE_AUDITOR_ADMIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or("Set CODE_AUDITOR_ADMIN to the owner username before resetting auth.")?;
    let pin = std::env::var("CODE_AUDITOR_ADMIN_PIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or("Set CODE_AUDITOR_ADMIN_PIN to the owner PIN before resetting auth.")?;
    Ok((name, pin))
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

#[derive(Debug, Clone)]
struct UploadedImage {
    position: usize,
    storage_path: String,
    file_name: String,
    bytes: i64,
    mime: String,
}

fn main() {
    if std::env::args().any(|arg| arg == "--reset-auth") {
        #[cfg(not(debug_assertions))]
        {
            eprintln!(
                "--reset-auth is a development tool and is not compiled into release builds. \
                 Change the PIN from Settings, or clear app_users in the database."
            );
            std::process::exit(2);
        }
        #[cfg(debug_assertions)]
        {
            let (name, pin) = match reset_credentials() {
                Ok(pair) => pair,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(2);
                }
            };
            let rt = tokio::runtime::Runtime::new().unwrap_or_else(|e| {
                eprintln!("Could not start reset runtime: {e}");
                std::process::exit(1);
            });
            if let Err(e) = rt.block_on(reset_auth(&name, &pin)) {
                eprintln!("{e}");
                std::process::exit(1);
            }
            println!("Auth reset complete for {name}. The PIN is the one you passed in.");
            return;
        }
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
    let conn = read_keychain(DB_KEYCHAIN_ID)?;
    let storage_key = read_keychain(STORAGE_KEYCHAIN_ID)?;
    let base = project_url(&conn).ok_or(
        "Could not infer the Supabase project URL from the saved database connection string.",
    )?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(15))
        .connect(&with_tls(&conn))
        .await
        .map_err(|e| format!("Could not connect to Supabase Postgres: {e}"))?;
    ensure_bucket(&base, &storage_key).await?;

    let mut uploaded = vec![];
    for image in &batch.images {
        uploaded.push(upload_image(&base, &storage_key, &batch.id, image).await?);
    }

    let settings = load_settings(&pool).await.unwrap_or_else(|e| {
        log(&format!("settings load skipped: {e}"));
        Value::Object(Default::default())
    });
    let settings = sanitize_settings(settings);
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let session_title = format!("Background capture batch {}", chrono::Utc::now().format("%Y-%m-%d %H:%M UTC"));
    let row = sqlx::query("insert into sessions (title) values ($1) returning id")
        .bind(session_title)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("Could not create a background session: {e}"))?;
    let session_id: Uuid = row.get("id");
    let row = sqlx::query(
        "insert into solve_jobs
             (session_id, mode, status, progress_phase, settings_snapshot)
         values ($1, 'council', 'queued', 'queued', $2)
         returning id",
    )
    .bind(session_id)
    .bind(settings)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("Could not create the solve job: {e}"))?;
    let job_id: Uuid = row.get("id");

    for image in &uploaded {
        sqlx::query(
            "insert into solve_job_images
                 (job_id, session_id, position, storage_bucket, storage_path,
                  file_name, bytes, mime, width, height)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        )
        .bind(job_id)
        .bind(session_id)
        .bind(image.position as i32)
        .bind(BUCKET)
        .bind(&image.storage_path)
        .bind(&image.file_name)
        .bind(image.bytes)
        .bind(&image.mime)
        .bind(Option::<i32>::None)
        .bind(Option::<i32>::None)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("Could not attach {} to the solve job: {e}", image.file_name))?;
    }

    sqlx::query(
        "insert into solve_job_events (job_id, level, phase, message, payload)
         values ($1, 'info', 'queued', 'Background helper queued the Council job.', $2)",
    )
    .bind(job_id)
    .bind(serde_json::json!({ "imageCount": uploaded.len(), "batchId": batch.id }))
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("Could not record the solve job event: {e}"))?;
    tx.commit()
        .await
        .map_err(|e| format!("Could not commit the solve job: {e}"))?;

    for image in &batch.images {
        let _ = fs::remove_file(&image.local_path);
    }
    let _ = fs::remove_file(pending_path()?);
    log(&format!("submitted {} as job {job_id}", batch.id));
    Ok(())
}

fn read_keychain(account: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => Err(format!("No Keychain value saved for {account}.")),
        Err(e) => Err(e.to_string()),
    }
}

fn keychain_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn write_keychain(account: &str, value: &str) -> Result<(), String> {
    keychain_entry(account)?
        .set_password(value)
        .map_err(|e| e.to_string())
}

#[cfg(debug_assertions)]
fn clear_keychain(account: &str) -> Result<(), String> {
    match keychain_entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(debug_assertions)]
fn pepper() -> Result<String, String> {
    match keychain_entry(KC_PEPPER)?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let mut raw = [0u8; 32];
            OsRng.fill_bytes(&mut raw);
            let value = hex(&raw);
            write_keychain(KC_PEPPER, &value)?;
            Ok(value)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(debug_assertions)]
fn peppered(pin: &str) -> Result<String, String> {
    type H = Hmac<Sha256>;
    let mut mac = H::new_from_slice(pepper()?.as_bytes())
        .map_err(|e| format!("Could not prepare the hasher: {e}"))?;
    mac.update(pin.as_bytes());
    Ok(hex(&mac.finalize().into_bytes()))
}

#[cfg(debug_assertions)]
fn hash_pin(pin: &str) -> Result<String, String> {
    let params = Params::new(64 * 1024, 3, 1, None)
        .map_err(|e| format!("Could not configure the hasher: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = SaltString::generate(&mut OsRng);
    argon
        .hash_password(peppered(pin)?.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| format!("Could not hash the PIN: {e}"))
}

#[cfg(debug_assertions)]
async fn reset_auth(username: &str, pin: &str) -> Result<(), String> {
    let conn = read_keychain(DB_KEYCHAIN_ID)?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(15))
        .connect(&with_tls(&conn))
        .await
        .map_err(|e| format!("Could not connect to Supabase Postgres: {e}"))?;
    let owned = pin.to_string();
    let hash = tokio::task::spawn_blocking(move || hash_pin(&owned))
        .await
        .map_err(|e| format!("Could not schedule PIN hashing: {e}"))??;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("truncate table app_sessions, app_users cascade")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("Could not clear auth tables: {e}"))?;
    sqlx::query("insert into app_users (username, pin_hash) values ($1, $2)")
        .bind(username)
        .bind(hash)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("Could not create test user: {e}"))?;
    tx.commit()
        .await
        .map_err(|e| format!("Could not commit auth reset: {e}"))?;
    clear_keychain(KC_TOKEN)?;
    write_keychain(KC_OWNER, username)?;
    Ok(())
}

fn project_url(conn: &str) -> Option<String> {
    let after_at = conn.rsplit('@').next()?;
    let host = after_at.split(['/', ':']).next()?;
    if let Some(rest) = host.strip_prefix("db.") {
        if let Some(reference) = rest.strip_suffix(".supabase.co") {
            if !reference.is_empty() && !reference.contains('.') {
                return Some(format!("https://{reference}.supabase.co"));
            }
        }
    }
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

fn with_tls(url: &str) -> String {
    if url.contains("sslmode=") {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&sslmode=require")
    } else {
        format!("{url}?sslmode=require")
    }
}

async fn load_settings(pool: &sqlx::PgPool) -> Result<Value, String> {
    let row = sqlx::query("select value from settings where key = $1")
        .bind(SETTINGS_KEY)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Could not load settings: {e}"))?;
    Ok(row
        .and_then(|r| r.try_get::<Value, _>("value").ok())
        .unwrap_or_else(|| Value::Object(Default::default())))
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

async fn ensure_bucket(base: &str, key: &str) -> Result<(), String> {
    let c = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = c
        .post(format!("{base}/storage/v1/bucket"))
        .header("Authorization", format!("Bearer {key}"))
        .header("apikey", key)
        .json(&serde_json::json!({ "id": BUCKET, "name": BUCKET, "public": false }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Supabase Storage: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.is_success() || status == StatusCode::CONFLICT || body.contains("already exists") {
        Ok(())
    } else {
        Err(format!("Supabase Storage returned {status}: {}", body.trim()))
    }
}

async fn upload_image(
    base: &str,
    key: &str,
    batch_id: &str,
    image: &PendingImage,
) -> Result<UploadedImage, String> {
    let bytes = fs::read(&image.local_path)
        .map_err(|e| format!("Could not read {}: {e}", image.local_path))?;
    if bytes.is_empty() {
        return Err(format!("{} is empty.", image.local_path));
    }
    let safe_batch = safe_segment(batch_id);
    let safe_name = safe_segment(&image.file_name);
    let storage_path = format!("background/{safe_batch}/{safe_name}");
    let c = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = c
        .post(format!("{base}/storage/v1/object/{BUCKET}/{storage_path}"))
        .header("Authorization", format!("Bearer {key}"))
        .header("apikey", key)
        .header("Content-Type", &image.mime)
        .header("x-upsert", "true")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Could not upload {}: {e}", image.file_name))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Supabase Storage returned {status}: {}", body.trim()));
    }
    Ok(UploadedImage {
        position: image.position,
        storage_path,
        file_name: image.file_name.clone(),
        bytes: image.bytes,
        mime: image.mime.clone(),
    })
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
    fn project_url_reads_direct_and_pooler_hosts() {
        assert_eq!(
            project_url("postgresql://postgres:pw@db.abc123.supabase.co:5432/postgres").as_deref(),
            Some("https://abc123.supabase.co")
        );
        assert_eq!(
            project_url("postgresql://postgres.abc123:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres").as_deref(),
            Some("https://abc123.supabase.co")
        );
    }

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
