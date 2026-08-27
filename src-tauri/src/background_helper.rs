use serde::Serialize;
use std::path::PathBuf;

// Namespaced under the bundle identifier, not a near-miss of it. This read
// `com.charles.codeeditor.…` while the bundle id and the Keychain service are
// both `com.charles.codeauditor` — the kind of drift that leaves an orphaned
// LaunchAgent running under a label nothing looks for after a rename.
const LABEL: &str = "com.charles.codeauditor.cloud-sync-helper";
/// The label the agent used to be installed under, so an upgrade can clean it up.
const LEGACY_LABEL: &str = "com.charles.codeeditor.cloud-sync-helper";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundHelperStatus {
    /// The LaunchAgent file is on disk.
    pub installed: bool,
    /// launchd has actually accepted it. `installed` without this is a file
    /// nobody is reading — which is what "installed" used to mean here.
    pub loaded: bool,
    /// Why launchd refused, when it did.
    pub problem: Option<String>,
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

fn legacy_plist_path() -> Result<PathBuf, String> {
    Ok(home()?
        .join("Library/LaunchAgents")
        .join(format!("{LEGACY_LABEL}.plist")))
}

/// Does launchd actually know about this agent?
///
/// `launchctl print` is the only honest answer. Writing the plist is not
/// installing it: a malformed file, a missing binary or an agent already loaded
/// under the old label all leave a file on disk that nothing ever reads.
fn is_loaded() -> bool {
    std::process::Command::new("launchctl")
        .arg("print")
        .arg(format!("{}/{LABEL}", launchctl_domain()))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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

fn plist(helper: &str, logs: &str) -> String {
    let helper = xml_escape(helper);
    let logs = xml_escape(logs);
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
  <!-- The helper already writes ~/Library/Logs/CodeAuditor/helper.log itself.
       These used to point at /tmp, which is world-readable and cleared on
       reboot, so a second copy of everything the helper said sat where anyone
       on the machine could read it and where nobody would think to look. -->
  <key>StandardOutPath</key>
  <string>{logs}/helper.out.log</string>
  <key>StandardErrorPath</key>
  <string>{logs}/helper.err.log</string>
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
    let installed = path.exists();
    let loaded = installed && is_loaded();
    Ok(BackgroundHelperStatus {
        installed,
        loaded,
        problem: match (installed, loaded) {
            (true, false) => Some(
                "The LaunchAgent is on disk but launchd has not loaded it. Check                  ~/Library/Logs/CodeAuditor/helper.err.log, or reinstall."
                    .into(),
            ),
            _ => None,
        },
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

    let logs = home()?.join("Library/Logs/CodeAuditor");
    std::fs::create_dir_all(&logs)
        .map_err(|e| format!("Could not create the log directory: {e}"))?;

    // An agent left over from the old label would keep running beside the new
    // one, capturing the same hotkey twice.
    if let Ok(legacy) = legacy_plist_path() {
        if legacy.exists() {
            let _ = std::process::Command::new("launchctl")
                .arg("bootout")
                .arg(format!("{}/{LEGACY_LABEL}", launchctl_domain()))
                .output();
            let _ = std::fs::remove_file(&legacy);
        }
    }

    std::fs::write(&path, plist(&helper, &logs.to_string_lossy()))
        .map_err(|e| format!("Could not write the LaunchAgent: {e}"))?;

    // Reloading rather than bootstrapping blind: bootstrap fails outright if the
    // label is already loaded, and that failure used to be discarded, so
    // reinstalling over a running agent silently changed nothing.
    let _ = std::process::Command::new("launchctl")
        .arg("bootout")
        .arg(format!("{}/{LABEL}", launchctl_domain()))
        .output();
    let out = std::process::Command::new("launchctl")
        .arg("bootstrap")
        .arg(launchctl_domain())
        .arg(&path)
        .output()
        .map_err(|e| format!("Could not run launchctl: {e}"))?;

    let mut status = background_helper_status().await?;
    if !status.loaded {
        // Say what launchd said, rather than reporting success and leaving the
        // user to discover later that nothing ever ran.
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        status.problem = Some(if detail.is_empty() {
            "launchd did not load the agent.".to_string()
        } else {
            format!("launchd refused the agent: {detail}")
        });
    }
    Ok(status)
}

#[tauri::command]
pub async fn background_helper_uninstall() -> Result<BackgroundHelperStatus, String> {
    crate::auth::require()?;
    let path = plist_path()?;
    let _ = std::process::Command::new("launchctl")
        .arg("bootout")
        .arg(format!("{}/{LABEL}", launchctl_domain()))
        .output();
    if let Ok(legacy) = legacy_plist_path() {
        if legacy.exists() {
            let _ = std::process::Command::new("launchctl")
                .arg("bootout")
                .arg(format!("{}/{LEGACY_LABEL}", launchctl_domain()))
                .output();
            let _ = std::fs::remove_file(&legacy);
        }
    }
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Could not remove the LaunchAgent: {e}"))?;
    }
    background_helper_status().await
}
