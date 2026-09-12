// Socket module for ghost mode.
//! Unix socket for overlay state IPC between the main app
//! and the helper.
//!
//! Path: /tmp/.csp_<pid>.sock
//!
//! The `.csp_` prefix is our established pattern. A scanner
//! looking at /tmp will see these. We keep them short-lived
//! (created on app launch, deleted on exit) to minimize
//! the window of visibility.

use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

pub fn socket_path(app_pid: u32) -> PathBuf {
    std::env::temp_dir().join(format!(".csp_{app_pid}.sock"))
}

pub fn bind_socket(app_pid: u32) -> Result<UnixListener, String> {
    let path = socket_path(app_pid);
    let _ = std::fs::remove_file(&path);
    UnixListener::bind(&path).map_err(|e| format!("Ghost socket bind failed: {e}"))
}

pub fn connect_socket(app_pid: u32) -> Result<UnixStream, String> {
    let path = socket_path(app_pid);
    let stream =
        UnixStream::connect(&path).map_err(|e| format!("Ghost socket connect failed: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
    Ok(stream)
}

pub fn cleanup_socket(app_pid: u32) {
    let _ = std::fs::remove_file(socket_path(app_pid));
}
