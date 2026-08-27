use serde::Serialize;
use std::path::PathBuf;

const LABEL: &str = "com.charles.codeeditor.cloud-sync-helper";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundHelperStatus {
    pub installed: bool,
    pub plist_path: String,
    pub app_path: String,
    pub helper_path: String,
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Could not find your home directory.".into())
}

fn plist_path() -> Result<PathBuf, String> {
    Ok(home()?.join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
}

fn app_path() -> Result<String, String> {
    if let Ok(path) = std::env::var("CODE_AUDITOR_APP_PATH") {
        let path = path.trim();
        if !path.is_empty() {
            return Ok(path.to_string());
        }
    }
    Ok("/Applications/Code Editor.app".to_string())
}

fn helper_path() -> Result<String, String> {
    if let Ok(path) = std::env::var("CODE_AUDITOR_HELPER_PATH") {
        let path = path.trim();
        if !path.is_empty() {
            return Ok(path.to_string());
        }
    }

    let current = std::env::current_exe()
        .map_err(|e| format!("Could not locate the running app executable: {e}"))?;
    let sibling = current.with_file_name("cloud-sync-helper");
    Ok(sibling.to_string_lossy().to_string())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn plist(helper: &str) -> String {
    let helper = xml_escape(helper);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{helper}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/cloud-sync-helper.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/cloud-sync-helper.err.log</string>
</dict>
</plist>
"#
    )
}

fn launchctl_domain() -> String {
    let uid = std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "501".to_string());
    format!("gui/{uid}")
}

#[tauri::command]
pub async fn background_helper_status() -> Result<BackgroundHelperStatus, String> {
    crate::auth::require()?;
    let path = plist_path()?;
    Ok(BackgroundHelperStatus {
        installed: path.exists(),
        plist_path: path.to_string_lossy().to_string(),
        app_path: app_path()?,
        helper_path: helper_path()?,
    })
}

#[tauri::command]
pub async fn background_helper_install() -> Result<BackgroundHelperStatus, String> {
    crate::auth::require()?;
    let path = plist_path()?;
    let helper = helper_path()?;
    if !std::path::Path::new(&helper).exists() {
        return Err(format!(
            "The background helper binary does not exist yet at {helper}. Build the Tauri side first, or set CODE_AUDITOR_HELPER_PATH."
        ));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create LaunchAgents directory: {e}"))?;
    }
    std::fs::write(&path, plist(&helper))
        .map_err(|e| format!("Could not write the LaunchAgent: {e}"))?;
    let _ = std::process::Command::new("launchctl")
        .arg("bootstrap")
        .arg(launchctl_domain())
        .arg(&path)
        .output();
    background_helper_status().await
}

#[tauri::command]
pub async fn background_helper_uninstall() -> Result<BackgroundHelperStatus, String> {
    crate::auth::require()?;
    let path = plist_path()?;
    let _ = std::process::Command::new("launchctl")
        .arg("bootout")
        .arg(launchctl_domain())
        .arg(&path)
        .output();
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Could not remove the LaunchAgent: {e}"))?;
    }
    background_helper_status().await
}
