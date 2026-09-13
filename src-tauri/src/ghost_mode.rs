// Master module for ghost mode.
//! GHOST SUPER MODE
//!
//! A self-contained stealth layer that makes the background helper
//! virtually invisible to process scanners, file watchers, and
//! signature checkers. The entire ghost mode is gated behind the
//! main app's lifecycle — when Council Editor exits, ghost mode
//! tears itself down. Nothing persists outside the app's session
//! unless explicitly re-armed.

#![allow(dead_code)]

pub mod app_binding;
pub mod identity;
pub mod keychain;
pub mod overlay;
pub mod socket;
pub mod stealth;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

/// Master switch: Ghost Mode is only active while the main app
/// process is alive AND the user has not disabled it via settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhostModeConfig {
    /// Master on/off. Persisted in the app's own settings blob.
    pub enabled: bool,
    /// Which stealth tier to use.
    /// 0 = Basic (name mimicry only)
    /// 1 = Advanced (name + path + signature + entitlements)
    /// 2 = Super (everything + file date spoofing + memory hiding)
    pub tier: u8,
    /// If true, the helper only lives while the main app PID is alive.
    /// The helper polls /tmp/.csp_app_<pid>.alive each tick.
    pub app_bound: bool,
    /// Override the support directory (for testing).
    pub support_dir: Option<PathBuf>,
}

impl Default for GhostModeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            tier: 2,
            app_bound: true,
            support_dir: None,
        }
    }
}

/// Where all ghost state lives. By default this is a hidden
/// subdirectory inside the app's own support folder so that
/// uninstalling the app removes everything in one sweep.
pub fn ghost_root(config: &GhostModeConfig) -> PathBuf {
    if let Some(ref dir) = config.support_dir {
        return dir.clone();
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    // Nest under the app's own support dir so it dies with the app.
    home.join("Library")
        .join("Application Support")
        .join("com.charles.councileditor")
        .join(".ghost")
}

pub fn ghost_cache_dir(config: &GhostModeConfig) -> PathBuf {
    ghost_root(config).join("cache")
}

pub fn ghost_log_dir(config: &GhostModeConfig) -> PathBuf {
    ghost_root(config).join("logs")
}

pub fn ghost_bin_dir(config: &GhostModeConfig) -> PathBuf {
    ghost_root(config).join("bin")
}

pub fn ghost_lock_file(config: &GhostModeConfig) -> PathBuf {
    ghost_root(config).join(".ghost_daemon.lock")
}

/// The "alive" sentinel the helper checks every 500 ms.
/// When the main app writes this file, the helper knows to stay.
/// When the main app deletes it (on exit), the helper self-terminates.
pub fn app_alive_sentinel(_config: &GhostModeConfig, app_pid: u32) -> PathBuf {
    // Use /tmp so it's world-readable but ephemeral.
    // Name pattern: .csp_alive_<pid> — the .csp_ prefix is
    // already established in the codebase.
    std::env::temp_dir().join(format!(".csp_alive_{app_pid}"))
}

#[tauri::command]
pub fn ghost_mode_status(
    config: tauri::State<'_, Arc<GhostModeConfig>>,
) -> Result<GhostModeConfig, String> {
    Ok((**config).clone())
}

#[tauri::command]
pub fn ghost_mode_toggle(
    config: tauri::State<'_, Arc<GhostModeConfig>>,
    enabled: Option<bool>,
) -> Result<GhostModeConfig, String> {
    let mut next = (**config).clone();
    next.enabled = enabled.unwrap_or(!next.enabled);
    Ok(next)
}
