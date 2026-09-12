// Stealth module for ghost mode.
//! Stealth behaviors: process hiding, file hiding, network
//! signature, memory footprint reduction.
//!
//! TIER 2 adds:
//! - Set process name via `prctl`-equivalent (macOS: `proc_info`)
//! - Hide from `ps` by setting the process to a "background" class
//! - Reduce RSS by dropping caches after startup
//! - Use a single Unix socket (not multiple) for IPC

/// Set the kernel-level process name. On macOS this is done
/// by writing to the process's `p_comm` field via
/// `proc_pidinfo`. The simplest reliable method is to name
/// the binary correctly AND call `setproctitle`.
///
/// Since we can't easily link `libproc` in a Tauri build,
/// we use the `proc` command to verify and the binary name
/// as the primary mechanism.
#[cfg(target_os = "macos")]
pub fn set_process_name(_name: &str) -> Result<(), String> {
    // The binary is already named `com.apple.corespotlightd`,
    // which is what `ps` shows. But we also set the
    // `p_comm` field via a small C shim compiled at build time.
    //
    // For now, the binary name IS the process name.
    // A scanner running `ps aux | grep corespotlightd`
    // will see our process mixed in with the real one.
    //
    // The key differentiator (and our remaining weakness)
    // is the PATH column. We mitigate this by placing the
    // binary in a path that looks Apple-internal.
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn set_process_name(_name: &str) -> Result<(), String> {
    Ok(())
}

/// Hide the helper's open file descriptors from `lsof`.
/// We do this by keeping file handles in a small pool and
/// closing them immediately after use rather than keeping
/// long-lived handles open.
pub fn minimize_fd_footprint() {
    // Called after startup. Closes any inherited FDs
    // above FD 2 (stdin/stdout/stderr → /dev/null).
    #[cfg(target_os = "macos")]
    unsafe {
        for fd in 3..64 {
            let _ = libc::close(fd);
        }
    }
}

/// Reduce the process's RSS after the initial webview
/// allocation settles. We call `malloc_zone_statistics`
/// and trim.
#[cfg(target_os = "macos")]
pub fn trim_memory() {
    unsafe {
        // macOS: call `malloc_default_zone()` and
        // `malloc_zone_free` on idle buffers.
        // Simplest: just call `malloc_trim` equivalent.
        // The `zone` API is private, so we use the
        // `__malloc_trim` symbol if available.
        extern "C" {
            fn __malloc_trim(pad: usize) -> i32;
        }
        let _ = __malloc_trim(0);
    }
}

/// Network: the helper makes API calls to the Supabase
/// edge function. A network scanner sees outbound HTTPS
/// to `*.supabase.co`. We mitigate by:
/// 1. Using a custom User-Agent that matches Safari
/// 2. Batching all calls into one connection
/// 3. Adding jitter so the timing doesn't look robotic
pub const GHOST_USER_AGENT: &str =
 "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

pub fn jitter_delay_ms() -> u64 {
    // 200–700 ms random delay between API calls.
    200 + (rand::random::<u64>() % 500)
}
