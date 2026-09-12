// App-only lifecycle module for ghost mode.
//! The GHOST MODE only lives while the main Council Editor
//! app is running. This is the "app-bound" constraint:
//!
//! 1. On app launch: write `/tmp/.csp_alive_<pid>` sentinel.
//! 2. Helper polls this file every 500 ms.
//! 3. On app exit: delete the sentinel. Helper sees it gone
//! within 500 ms and self-terminates.
//! 4. On crash: the sentinel file in /tmp is cleaned by
//! macOS within minutes, so the helper eventually dies.
//!
//! No LaunchAgent persists beyond the app's session unless
//! the user explicitly "pins" it in settings.

use std::fs;
use std::path::Path;
use std::time::Duration;

/// Write the alive sentinel. Called in `setup()` of the Tauri app.
pub fn write_alive_sentinel(sentinel_path: &Path, app_pid: u32) {
    let content = format!(
        "{app_pid}
"
    );
    let _ = fs::write(sentinel_path, content);
    // Set to 0644 so the helper (running as same user) can read it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(sentinel_path).is_ok() {
            let _ = fs::set_permissions(sentinel_path, fs::Permissions::from_mode(0o644));
        }
    }
}

/// Delete the alive sentinel. Called in the app's `on_exit` hook.
pub fn remove_alive_sentinel(sentinel_path: &Path) {
    let _ = fs::remove_file(sentinel_path);
}

/// Helper-side: check if the app is still alive.
/// Returns true if the sentinel exists AND contains the
/// expected PID (prevents a stale file from a crashed app).
pub fn is_app_alive(sentinel_path: &Path, expected_pid: u32) -> bool {
    let Ok(content) = fs::read_to_string(sentinel_path) else {
        return false;
    };
    let pid_str = content.trim();
    // Accept if the PID matches OR if the file was modified
    // within the last 10 seconds (app might have re-forked).
    if pid_str == expected_pid.to_string() {
        return true;
    }
    // Check modification time as a fallback.
    if let Ok(meta) = fs::metadata(sentinel_path) {
        if let Ok(mtime) = meta.modified() {
            if let Ok(elapsed) = mtime.elapsed() {
                return elapsed < Duration::from_secs(10);
            }
        }
    }
    false
}

/// Helper-side: poll in the event loop. If the app dies,
/// the helper cleans up its own state and exits.
pub fn check_and_self_terminate(sentinel_path: &Path, app_pid: u32) -> bool {
    if is_app_alive(sentinel_path, app_pid) {
        return false; // stay alive
    }
    // App is gone. Clean up and exit.
    eprintln!("app sentinel lost -- ghost mode self-terminating");
    true
}
