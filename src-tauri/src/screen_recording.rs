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

fn status() -> ScreenRecordingPermission {
    #[cfg(target_os = "macos")]
    {
        // These Core Graphics APIs do not transfer ownership or retain pointers.
        let granted = unsafe { CGPreflightScreenCaptureAccess() };
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
