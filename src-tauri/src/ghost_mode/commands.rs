
//! Tauri commands exposed to the frontend for the Ghost Mode UI.

 use crate::ghost_mode::{app_binding, GhostModeConfig};
 use serde::Serialize;
 use std::sync::Arc;
 use tauri::State;

 #[derive(Debug, Serialize)]
 #[serde(rename_all = "camelCase")]
 pub struct GhostModeStatus {
 pub enabled: bool,
 pub tier: u8,
 pub app_bound: bool,
 pub alive_sentinel_exists: bool,
 pub socket_bound: bool,
 pub helper_running: bool,
 pub support_dir: String,
 }

 #[tauri::command]
 pub async fn ghost_mode_status(
 config: State<'_, Arc<GhostModeConfig>>,
 ) -> Result<GhostModeStatus, String> {
 let app_pid = std::process::id();
 let sentinel = crate::ghost_mode::app_alive_sentinel(&config, app_pid);
 let root = crate::ghost_mode::ghost_root(&config);

 // Check if helper process is running.
 let helper_running = std::process::Command::new("pgrep")
 .arg("-f")
 .arg("com.apple.mds")
 .output()
 .map(|o| o.status.success() && !o.stdout.is_empty())
 .unwrap_or(false);

 Ok(GhostModeStatus {
 enabled: config.enabled,
 tier: config.tier,
 app_bound: config.app_bound,
 alive_sentinel_exists: sentinel.exists(),
 socket_bound: crate::ghost_mode::socket::socket_path(app_pid).exists(),
 helper_running,
 support_dir: root.to_string_lossy().to_string(),
 })
 }

 #[tauri::command]
 pub async fn ghost_mode_toggle(
 config: State<'_, Arc<GhostModeConfig>>,
 enabled: bool,
 ) -> Result<bool, String> {
 let mut config = config.inner().clone();
 *config = config.as_ref().clone();
 config.enabled = enabled;

 let app_pid = std::process::id();
 let sentinel = crate::ghost_mode::app_alive_sentinel(&config, app_pid);

 if enabled {
 crate::ghost_mode::ghost_root(&config);
 std::fs::create_dir_all(&crate::ghost_mode::ghost_root(&config))?;
 app_binding::write_alive_sentinel(&sentinel, app_pid);
 } else {
 app_binding::remove_alive_sentinel(&sentinel);
 crate::ghost_mode::socket::cleanup_socket(app_pid);
 }

 Ok(enabled)
 }
