use serde::Serialize;
use std::path::PathBuf;

const GHOST_LABEL: &str = "com.apple.mds.useragent";
const GHOST_BUNDLE_ID: &str = "com.apple.mds";
const GHOST_BUNDLE_NAME: &str = "mds";
const GHOST_EXECUTABLE: &str = "mds";
const GHOST_SUPPORT_DIR: &str = ".com.apple.mds";
#[allow(dead_code)]
const GHOST_LOCK_FILE: &str = ".mds_daemon.lock";
#[allow(dead_code)]
const GHOST_KEYCHAIN_SERVICE: &str = "com.apple.mds.session";
#[allow(dead_code)]
const GHOST_KEYCHAIN_ACCOUNT: &str = "mds";
#[allow(dead_code)]
const GHOST_SOCKET_PREFIX: &str = ".mds_"; // replaces .csp_

// ─── STATUS STRUCT ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhostModeStatus {
    pub installed: bool,
    pub loaded: bool,
    pub problem: Option<String>,
    pub plist_path: String,
    pub app_path: String,
    pub helper_path: String,
    pub signature: Option<String>,
    pub entitlements: Option<String>,
    pub sandboxed: bool,
}

// ─── PATH HELPERS ─────────────────────────────────────────────────────────────

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Could not find your home directory.".into())
}

fn plist_path() -> Result<PathBuf, String> {
    Ok(support_dir()?.join(format!("{GHOST_LABEL}.plist")))
}

fn support_dir() -> Result<PathBuf, String> {
    Ok(home()?
        .join("Library")
        .join("Application Support")
        .join(GHOST_SUPPORT_DIR))
}

fn helper_bin_dir() -> Result<PathBuf, String> {
    Ok(support_dir()?.join("bin"))
}

fn helper_bundle_path() -> Result<PathBuf, String> {
    Ok(helper_bin_dir()?.join(format!("{GHOST_BUNDLE_ID}.app")))
}

fn helper_executable_path() -> Result<PathBuf, String> {
    Ok(helper_bundle_path()?
        .join("Contents/MacOS")
        .join(GHOST_EXECUTABLE))
}

fn helper_info_plist_path() -> Result<PathBuf, String> {
    Ok(helper_bundle_path()?.join("Contents/Info.plist"))
}

fn helper_pkg_info_path() -> Result<PathBuf, String> {
    Ok(helper_bundle_path()?.join("Contents/PkgInfo"))
}

fn helper_entitlements_path() -> Result<PathBuf, String> {
    Ok(helper_bundle_path()?.join("Contents/Resources/entitlements.plist"))
}

fn first_codesigning_identity(prefix: &str) -> Option<String> {
    let out = std::process::Command::new("security")
        .args(["find-identity", "-v", "-p", "codesigning"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().find_map(|line| {
        let start = line.find('"')?;
        let rest = &line[start + 1..];
        let end = rest.find('"')?;
        let identity = &rest[..end];
        identity.starts_with(prefix).then(|| identity.to_string())
    })
}

fn helper_signing_identity() -> String {
    std::env::var("APPLE_SIGNING_IDENTITY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("CODESIGN_IDENTITY")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| first_codesigning_identity("Developer ID Application:"))
        .or_else(|| first_codesigning_identity("Apple Development:"))
        .unwrap_or_else(|| "-".to_string())
}

// ─── LAUNCHCTL ────────────────────────────────────────────────────────────────

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

fn is_loaded() -> bool {
    std::process::Command::new("launchctl")
        .arg("print")
        .arg(format!("{}/{GHOST_LABEL}", launchctl_domain()))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn bootout(label: &str) {
    let _ = std::process::Command::new("launchctl")
        .arg("bootout")
        .arg(format!("{}/{label}", launchctl_domain()))
        .output();
}

// ─── BUNDLED HELPER PATH ──────────────────────────────────────────────────────

fn bundled_helper_path() -> Result<String, String> {
    if let Ok(path) = std::env::var("CODE_AUDITOR_HELPER_PATH") {
        let path = path.trim();
        if !path.is_empty() {
            return Ok(path.to_string());
        }
    }
    let current = std::env::current_exe()
        .map_err(|e| format!("Could not locate the running app executable: {e}"))?;
    let sibling = current.with_file_name(GHOST_EXECUTABLE);
    Ok(sibling.to_string_lossy().to_string())
}

// ─── PLIST GENERATION ─────────────────────────────────────────────────────────

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn launch_agent_plist(helper: &str) -> String {
    let helper = xml_escape(helper);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
 <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
 <plist version="1.0">
 <dict>
 <key>Label</key>
 <string>{GHOST_LABEL}</string>
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
 <key>LowPriorityBackgroundNetworking</key>
 <true/>
 <key>Nice</key>
 <integer>10</integer>
 <key>StandardOutPath</key>
 <string>/dev/null</string>
 <key>StandardErrorPath</key>
 <string>/dev/null</string>
 <key>LimitLoadToSessionType</key>
 <string>Aqua</string>
 <key>ThrottleInterval</key>
 <integer>10</integer>
 <key>AbandonProcessGroup</key>
 <true/>
 </dict>
 </plist>
 "#
    )
}

fn helper_info_plist() -> String {
    let bundle_id = xml_escape(GHOST_BUNDLE_ID);
    let bundle_name = xml_escape(GHOST_BUNDLE_NAME);
    let executable = xml_escape(GHOST_EXECUTABLE);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
 <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
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
 <string>1.0</string>
 <key>CFBundleVersion</key>
 <string>1</string>
 <key>LSBackgroundOnly</key>
 <true/>
 <key>LSUIElement</key>
 <true/>
 <key>NSHighResolutionCapable</key>
 <true/>
 <key>NSAppSleepDisabled</key>
 <true/>
 <key>NSSupportsAutomaticTermination</key>
 <false/>
 <key>NSSupportsSuddenTermination</key>
 <true/>
 <key>LSMinimumSystemVersion</key>
 <string>11.0</string>
 <key>NSPrincipalClass</key>
 <string>NSApplication</string>
 </dict>
 </plist>
 "#
    )
}

fn entitlements_plist() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
 <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
 <plist version="1.0">
 <dict>
 <key>com.apple.security.app-sandbox</key>
 <true/>
 <key>com.apple.security.temporary-exception.files.home-relative-path.read-only</key>
 <array>
 <string>Library/Application Support/{GHOST_SUPPORT_DIR}</string>
 </array>
 <key>com.apple.security.temporary-exception.files.home-relative-path</key>
 <array>
    <string>
    Library/Application Support/{GHOST_SUPPORT_DIR}
    </string> 
</array>
 <key>com.apple.security.network.client</key>
 <true/>
 <key>com.apple.security.network.server</key>
 <true/>
 <key>com.apple.security.device.camera</key>
 <true/>
 <key>com.apple.security.device.microphone</key>
 <true/>
 <key>com.apple.security.automation.apple-events</key>
 <true/>
 <key>com.apple.security.cs.anti-mach-lookup</key>
 <array>
 <string>com.apple.mds</string>
 </array>
 <key>com.apple.security.cs.allow-jit</key>
 <true/>
 <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
 <true/>
 <key>com.apple.security.cs.disable-library-validation</key>
 <true/>
 <key>com.apple.security.files.user-selected.read-write</key>
 <true/>
 <key>com.apple.security.inheritance</key>
 <true/>
 </dict>
 </plist>
 "#
    )
}

// ─── INSTALL / UNINSTALL ──────────────────────────────────────────────────────

fn install_helper_bundle(bundled_helper: &str) -> Result<String, String> {
    let bundle = helper_bundle_path()?;
    let macos_dir = helper_bundle_path()?.join("Contents/MacOS");
    std::fs::create_dir_all(&macos_dir)
        .map_err(|e| format!("Could not create ghost helper bundle: {e}"))?;

    let executable = helper_executable_path()?;
    std::fs::copy(bundled_helper, &executable)
        .map_err(|e| format!("Could not install ghost helper executable: {e}"))?;
    std::fs::write(helper_info_plist_path()?, helper_info_plist())
        .map_err(|e| format!("Could not write ghost Info.plist: {e}"))?;
    std::fs::write(helper_pkg_info_path()?, "APPL????")
        .map_err(|e| format!("Could not write ghost PkgInfo: {e}"))?;

    // Write entitlements
    let resources_dir = helper_bundle_path()?.join("Contents/Resources");
    std::fs::create_dir_all(&resources_dir)
        .map_err(|e| format!("Could not create Resources dir: {e}"))?;
    std::fs::write(helper_entitlements_path()?, entitlements_plist())
        .map_err(|e| format!("Could not write entitlements: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&executable)
            .map_err(|e| format!("Could not inspect ghost helper: {e}"))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions)
            .map_err(|e| format!("Could not make ghost helper executable: {e}"))?;
    }

    let identity = helper_signing_identity();
    let out = std::process::Command::new("codesign")
        .arg("--force")
        .arg("--sign")
        .arg(&identity)
        .arg("--options")
        .arg("runtime")
        .arg("--entitlements")
        .arg(helper_entitlements_path()?)
        .arg(&bundle)
        .output()
        .map_err(|e| format!("Could not run codesign for ghost helper bundle: {e}"))?;
    if !out.status.success() {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        return Err(format!(
            "Could not codesign ghost helper bundle with identity {identity}: {}",
            detail.trim()
        ));
    }

    Ok(executable.to_string_lossy().to_string())
}

// ─── TAURI COMMANDS ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn background_helper_status() -> Result<GhostModeStatus, String> {
    crate::auth::require()?;
    let path = plist_path()?;
    let installed = path.exists();
    let loaded = installed && is_loaded();

    // Read signature info
    let (signature, entitlements) = read_signature_info()?;
    let sandboxed = entitlements
        .as_deref()
        .map(|e| e.contains("com.apple.security.app-sandbox"))
        .unwrap_or(false);

    Ok(GhostModeStatus {
        installed,
        loaded,
        problem: match (installed, loaded) {
            (true, false) => Some(
                "Ghost agent is on disk but launchd has not loaded it. Reinstall and check status."
                    .into(),
            ),
            _ => None,
        },
        plist_path: path.to_string_lossy().to_string(),
        app_path: helper_bundle_path()?.to_string_lossy().to_string(),
        helper_path: helper_executable_path()?.to_string_lossy().to_string(),
        signature,
        entitlements,
        sandboxed,
    })
}

fn read_signature_info() -> Result<(Option<String>, Option<String>), String> {
    let bundle = helper_bundle_path()?;
    if !bundle.exists() {
        return Ok((None, None));
    }
    let display = std::process::Command::new("codesign")
        .args(["--display", "--verbose=4", &bundle.to_string_lossy()])
        .output()
        .map_err(|e| format!("codesign failed: {e}"))?;
    let display_text = format!(
        "{}{}",
        String::from_utf8_lossy(&display.stdout),
        String::from_utf8_lossy(&display.stderr)
    );
    let signature = display_text.lines().find_map(|line| {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("Authority=") {
            Some(value.to_string())
        } else if let Some(value) = line.strip_prefix("Signature=") {
            Some(value.to_string())
        } else {
            None
        }
    });
    let entitlement_out = std::process::Command::new("codesign")
        .arg("--display")
        .arg("--entitlements")
        .arg(":-")
        .arg(&bundle)
        .output()
        .map_err(|e| format!("codesign entitlements failed: {e}"))?;
    let entitlement_text = format!(
        "{}{}",
        String::from_utf8_lossy(&entitlement_out.stdout),
        String::from_utf8_lossy(&entitlement_out.stderr)
    );
    let entitlements = entitlement_text
        .contains("<?xml")
        .then(|| entitlement_text.clone());
    Ok((signature, entitlements))
}

#[tauri::command]
pub async fn background_helper_install() -> Result<GhostModeStatus, String> {
    crate::auth::require()?;
    let path = plist_path()?;
    let bundled = bundled_helper_path()?;
    if !std::path::Path::new(&bundled).exists() {
        return Err(format!(
 "Ghost helper not found at {bundled}. Build the Tauri side first, or set CODE_AUDITOR_HELPER_PATH."
 ));
    }
    let helper = install_helper_bundle(&bundled)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create ghost plist dir: {e}"))?;
    }
    std::fs::write(&path, launch_agent_plist(&helper))
        .map_err(|e| format!("Could not write ghost LaunchAgent: {e}"))?;

    bootout(GHOST_LABEL);
    let out = std::process::Command::new("launchctl")
        .arg("bootstrap")
        .arg(launchctl_domain())
        .arg(&path)
        .output()
        .map_err(|e| format!("Could not run launchctl: {e}"))?;

    let mut status = background_helper_status().await?;
    if !status.loaded {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        status.problem = Some(if detail.is_empty() {
            "launchd did not load the ghost agent.".to_string()
        } else {
            format!("launchd refused the ghost agent: {detail}")
        });
    }
    Ok(status)
}

#[tauri::command]
pub async fn background_helper_uninstall() -> Result<GhostModeStatus, String> {
    crate::auth::require()?;
    let path = plist_path()?;
    bootout(GHOST_LABEL);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Could not remove ghost LaunchAgent: {e}"))?;
    }
    if let Ok(bundle) = helper_bundle_path() {
        if bundle.exists() {
            std::fs::remove_dir_all(&bundle)
                .map_err(|e| format!("Could not remove ghost bundle: {e}"))?;
        }
    }
    if let Ok(support) = support_dir() {
        let _ = std::fs::remove_dir_all(&support);
    }
    background_helper_status().await
}
