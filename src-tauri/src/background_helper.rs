use serde::Serialize;
use std::path::PathBuf;


const LABEL: &str = "com.apple.sync.daemon";

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
    Ok("/Applications/Council Editor.app".to_string())
}

fn bundled_helper_path() -> Result<String, String> {
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

fn helper_path() -> Result<String, String> {
    Ok(home()?
        .join("Library/Application Support/.council/bin/syncd")
        .to_string_lossy()
        .to_string())
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
    <string>/dev/null</string>
  <key>StandardErrorPath</key>
    <string>/dev/null</string>
    <key>LSUIElement</key>
    <true/>
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
                "The LaunchAgent is on disk but launchd has not loaded it. Reinstall the helper and check launchd status."
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
    let bundled_helper = bundled_helper_path()?;
    if !std::path::Path::new(&bundled_helper).exists() {
        return Err(format!(
            "The bundled background helper does not exist yet at {bundled_helper}. Build the Tauri side first, or set CODE_AUDITOR_HELPER_PATH."
        ));
    }
    let helper = helper_path()?;
    if let Some(dir) = std::path::Path::new(&helper).parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create the hidden helper directory: {e}"))?;
    }
    std::fs::copy(&bundled_helper, &helper)
        .map_err(|e| format!("Could not install the background helper: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&helper)
            .map_err(|e| format!("Could not inspect the installed helper: {e}"))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&helper, permissions)
            .map_err(|e| format!("Could not make the installed helper executable: {e}"))?;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create LaunchAgents directory: {e}"))?;
    }

    std::fs::write(&path, plist(&helper))
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
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Could not remove the LaunchAgent: {e}"))?;
    }
    background_helper_status().await
}
