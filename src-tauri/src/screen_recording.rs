//! macOS Screen Recording permission.
//!
//! `screencapture` reports a refusal, but it does not initiate the system consent
//! prompt. Ask Core Graphics explicitly while the Council Editor window is open
//! so a first-run capture does not fail without telling the person how to grant it.

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRecordingPermission {
    pub supported: bool,
    pub granted: bool,
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// The overlay helper captures, not the app window. Its own TCC grant is what
/// matters, so a recent successful capture proves the permission even when the
/// app process itself was never granted.
fn helper_recently_captured() -> bool {
    let Ok(home) = std::env::var("HOME") else { return false };
    let root = std::path::PathBuf::from(home).join("Library/Application Support/.com.apple.mds");
    let Ok(status) = std::fs::read_to_string(root.join("cache/helper-status.json")) else { return false };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&status) else { return false };
    if value.get("problem").is_some_and(|problem| !problem.is_null()) { return false; }
    let captures = root.join("cache/captures");
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
    let Ok(days) = std::fs::read_dir(captures) else { return false };
    days.flatten().any(|entry| {
        std::fs::read_dir(entry.path()).ok().is_some_and(|files| files.flatten().any(|file| {
            file.metadata().ok().and_then(|meta| meta.modified().ok()).is_some_and(|at| at > cutoff)
        }))
    })
}

fn status() -> ScreenRecordingPermission {
    #[cfg(target_os = "macos")]
    {
        // These Core Graphics APIs do not transfer ownership or retain pointers.
        let granted = unsafe { CGPreflightScreenCaptureAccess() } || helper_recently_captured();
        return ScreenRecordingPermission {
            supported: true,
            granted,
        };
    }

    #[cfg(not(target_os = "macos"))]
    ScreenRecordingPermission {
        supported: false,
        granted: true,
    }
}

/// Read the current TCC consent state without displaying a prompt.
#[tauri::command]
pub fn screen_recording_permission_status() -> ScreenRecordingPermission {
    status()
}

/// Ask macOS to display its Screen Recording consent prompt. The operating
/// system owns the decision; this function never grants access itself.
#[tauri::command]
pub fn screen_recording_request_permission() -> ScreenRecordingPermission {
    #[cfg(target_os = "macos")]
    {
        // Calling the request API is what makes macOS present the consent UI.
        // Check again afterward because it returns false when approval requires
        // a System Settings change or the person declines the request.
        unsafe {
            CGRequestScreenCaptureAccess();
        }
    }
    status()
}

/// Open the exact macOS privacy pane when the system requires its Settings UI
/// rather than accepting the in-app consent request.
#[tauri::command]
pub fn screen_recording_open_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .status()
            .map_err(|e| format!("Could not open macOS System Settings: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("macOS did not open the Screen Recording settings pane.".into());
    }

    #[cfg(not(target_os = "macos"))]
    Ok(())
}

/// Relaunch only after a person has completed the macOS consent flow.
#[tauri::command]
pub fn screen_recording_restart(app: tauri::AppHandle) {
    // Let the IPC response reach the webview before replacing this process.
    // `AppHandle::restart` never returns, so it runs on this short-lived thread
    // rather than becoming an unserializable Tauri command response.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        app.restart();
    });
}
