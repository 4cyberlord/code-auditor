use serde_json::Value;
use std::{
    io::Write,
    os::unix::net::UnixListener,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    thread,
};

struct OverlaySocket {
    state: Arc<Mutex<Vec<u8>>>,
}

static OVERLAY_SOCKET: OnceLock<OverlaySocket> = OnceLock::new();

fn socket_path() -> PathBuf {
    PathBuf::from(format!("/tmp/.csp_{}.sock", std::process::id()))
}

pub fn cleanup_socket() {
    let path = socket_path();
    let _ = std::fs::remove_file(path);
}

fn remove_stale_socket(path: &PathBuf) {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let Some(pid) = name
        .strip_prefix(".csp_")
        .and_then(|value| value.strip_suffix(".sock"))
        .and_then(|value| value.parse::<libc::pid_t>().ok())
    else {
        return;
    };

    // kill(pid, 0) only probes process existence. Never remove a socket that
    // could still belong to a running process.
    let running = unsafe { libc::kill(pid, 0) == 0 };
    if !running {
        let _ = std::fs::remove_file(path);
    }
}

fn overlay_socket() -> Result<&'static OverlaySocket, String> {
    if let Some(socket) = OVERLAY_SOCKET.get() {
        return Ok(socket);
    }

    let path = socket_path();
    if path.exists() {
        remove_stale_socket(&path);
    }
    let listener = UnixListener::bind(&path).map_err(|e| {
        format!(
            "Could not bind overlay state socket {}: {e}",
            path.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    let state = Arc::new(Mutex::new(
        br#"{"runId":null,"updatedAt":"","phase":"idle","agents":[],"solution":null,"tests":[]}"#
            .to_vec(),
    ));
    let thread_state = Arc::clone(&state);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                continue;
            };
            let bytes = thread_state
                .lock()
                .map(|state| state.clone())
                .unwrap_or_default();
            let _ = stream.write_all(&bytes);
        }
    });

    let _ = OVERLAY_SOCKET.set(OverlaySocket { state });
    OVERLAY_SOCKET
        .get()
        .ok_or("Could not initialise overlay state socket.".to_string())
}

#[tauri::command]
pub async fn overlay_state_write(state: Value) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(&state).map_err(|e| format!("Could not encode overlay state: {e}"))?;
    let socket = overlay_socket()?;
    *socket
        .state
        .lock()
        .map_err(|_| "Could not lock overlay state.".to_string())? = bytes;
    Ok(())
}
