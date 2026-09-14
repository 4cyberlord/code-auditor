use serde::{Deserialize, Serialize};
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

#[derive(Default)]
struct LaunchState {
    loaded: bool,
    running: bool,
    state: Option<String>,
    last_exit_code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperRuntimeStatus {
    hotkeys_available: Option<bool>,
    problem: Option<String>,
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

fn helper_status_path() -> Result<PathBuf, String> {
    Ok(support_dir()?.join("cache/helper-status.json"))
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

fn launch_state() -> LaunchState {
    let output = std::process::Command::new("launchctl")
        .arg("print")
        .arg(format!("{}/{GHOST_LABEL}", launchctl_domain()))
        .output()
        .ok();

    let Some(output) = output else {
        return LaunchState::default();
    };
    if !output.status.success() {
        return LaunchState::default();
    }

    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let state = text.lines().find_map(|line| {
        line.trim()
            .strip_prefix("state = ")
            .map(|value| value.trim().to_string())
    });
    let last_exit_code = text.lines().find_map(|line| {
        line.trim()
            .strip_prefix("last exit code = ")
            .map(|value| value.trim().to_string())
    });

    LaunchState {
        loaded: true,
        running: state.as_deref() == Some("running"),
        state,
        last_exit_code,
    }
}

fn wait_for_launchd_running() {
    for _ in 0..20 {
        let launch = launch_state();
        if launch.loaded && launch.running {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
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
 <key>com.apple.security.network.client</key>
 <true/>
 <key>com.apple.security.network.server</key>
 <true/>
 <key>com.apple.security.device.camera</key>
 <true/>
 <key>com.apple.security.device.microphone</key>
 <true/>
 <key>com.apple.security.device.input</key>
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
    let launch = launch_state();
    let loaded = installed && launch.loaded && launch.running;
    let runtime = read_helper_runtime_status();

    // Read signature info
    let (signature, entitlements) = read_signature_info()?;
    let sandboxed = entitlements
        .as_deref()
        .map(|e| e.contains("com.apple.security.app-sandbox"))
        .unwrap_or(false);

    Ok(GhostModeStatus {
        installed,
        loaded,
        problem: helper_problem(installed, &launch, runtime.as_ref()),
        plist_path: path.to_string_lossy().to_string(),
        app_path: helper_bundle_path()?.to_string_lossy().to_string(),
        helper_path: helper_executable_path()?.to_string_lossy().to_string(),
        signature,
        entitlements,
        sandboxed,
    })
}

fn helper_problem(
    installed: bool,
    launch: &LaunchState,
    runtime: Option<&HelperRuntimeStatus>,
) -> Option<String> {
    if !installed {
        return None;
    }
    if !launch.loaded {
        return Some(
            "Ghost agent is on disk but launchd has not loaded it. Reinstall and check status."
                .into(),
        );
    }
    if !launch.running {
        let state = launch.state.as_deref().unwrap_or("unknown");
        let exit = launch
            .last_exit_code
            .as_deref()
            .map(|code| format!(", last exit code {code}"))
            .unwrap_or_default();
        return Some(format!(
            "Ghost agent is registered with launchd but is not running (state {state}{exit}). Reinstall, then check Input Monitoring permission."
        ));
    }
    if runtime.and_then(|status| status.hotkeys_available) == Some(false) {
        return runtime
            .and_then(|status| status.problem.clone())
            .or_else(|| Some("Ghost agent is running, but hotkeys are unavailable. Grant Input Monitoring permission for the helper in macOS System Settings.".into()));
    }
    None
}

fn read_helper_runtime_status() -> Option<HelperRuntimeStatus> {
    let path = helper_status_path().ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_signature_info() -> Result<(Option<String>, Option<String>), String> {
    let bundle = helper_bundle_path()?;
    if !bundle.exists() {
        return Ok((None, None));
    }
    let display = std::process::Command::new("codesign")
        .args(["--display", "--verbose=4", &bundle.to_string_lossy()])
        .output()
        .map_err(|e| format!("Signing the helper failed: {e}"))?;
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
        .map_err(|e| format!("Reading the helper's entitlements failed: {e}"))?;
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

    wait_for_launchd_running();
    let mut status = background_helper_status().await?;
    if !status.loaded {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .trim()
        .to_string();
        status.problem = Some(if !out.status.success() && !detail.is_empty() {
            format!("The launchd service refused the background helper: {detail}")
        } else if !out.status.success() {
            format!("The launchd service refused the background helper with exit status {}.", out.status)
        } else if detail.is_empty() {
            "The launchd service did not load the background helper.".to_string()
        } else {
            format!("The launchd service accepted the helper, but it was not running yet: {detail}")
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
