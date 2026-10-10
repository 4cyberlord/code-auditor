mod auth;
mod background_helper;
mod capture;
mod coding_tools;
mod config;
mod db;
pub mod deployment;
mod exec;
pub mod ghost_mode;
mod helper_auth;
mod knowledge;
mod overlay;
mod overlay_state;
mod platform_base;
mod providers;
mod runner;
mod secrets;
mod server_api;
mod sessions;
mod storage;
mod vision;

use db::Db;
use ghost_mode::{app_binding, GhostModeConfig};
use providers::RunRegistry;
use std::sync::Arc;
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

/// Emitted when a global shortcut or the tray menu asks for a capture or a run.
/// Both entry points land on the same events, so the frontend has one path.
pub const EV_CAPTURE: &str = "shortcut://capture";
pub const EV_CAPTURE_SCREEN: &str = "shortcut://capture-screen";
pub const EV_CAPTURE_LEFT: &str = "shortcut://capture-left";
pub const EV_CAPTURE_RIGHT: &str = "shortcut://capture-right";
pub const EV_SOLVE: &str = "shortcut://solve";
pub const EV_SETTINGS: &str = "settings://open";
pub const EV_WORKSPACE: &str = "workspace://select";

/// The system-wide accelerators. Registered in Rust rather than from JavaScript:
/// the webview remounts its effects in development and can be reloaded at any
/// time, and a hotkey that survives only as long as the current mount is exactly
/// the thing that silently stops working. Registered here it lives as long as the
/// process does.
/// Overridable, because "registered successfully but never fires" is a real and
/// invisible failure: a utility holding a `CGEventTap` (a launcher, a screenshot
/// tool, vendor keyboard software) consumes the keystroke upstream of the Carbon
/// hotkey table, so registration reports success and the press simply never
/// arrives. Nothing in the API can detect that. Being able to move the key
/// without a rebuild is how you find out that is what is happening.
/// Control+Option+letter, for two reasons. Nothing in macOS claims this family --
/// unlike Control+digit, which Mission Control binds to "Switch to Desktop N" --
/// and few apps register global hotkeys with it, so the keystroke actually
/// reaches us. And the letters say what they do:
///
///   S = Screen   grab the whole display
///   R = Region   drag a box
///   A = Audit    hand it to the agents
///   O = Overlay  toggle the capture-exempt glass panel
pub const ACCEL_CAPTURE_SCREEN: &str = "Control+Alt+S";
pub const ACCEL_CAPTURE: &str = "Control+Alt+R";
pub const ACCEL_CAPTURE_LEFT: &str = "Control+Alt+Shift+L";
pub const ACCEL_CAPTURE_RIGHT: &str = "Control+Alt+Shift+R";
pub const ACCEL_SOLVE: &str = "Control+Alt+A";
pub const ACCEL_OVERLAY: &str = "Control+Alt+O";

fn accel(var: &str, default: &str) -> String {
    std::env::var(var)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// Stderr tracing, off unless `CODE_AUDITOR_TRACE` is set.
pub fn trace(msg: &str) {
    if std::env::var_os("CODE_AUDITOR_TRACE").is_some() {
        eprintln!("[council-editor] {msg}");
    }
    if matches!(std::env::var("SYNC_DAEMON_DEBUG").as_deref(), Ok("1")) {
        if let Some(home) = std::env::var_os("HOME") {
            let dir = std::path::Path::new(&home)
                .join("Library")
                .join("Application Support")
                .join(".com.apple.mds")
                .join("logs");
            if std::fs::create_dir_all(&dir).is_ok() {
                let path = dir.join(".state");
                let existing = std::fs::read_to_string(&path).unwrap_or_default();
                let lines: Vec<&str> = existing.lines().chain(std::iter::once(msg)).collect();
                let start = lines.len().saturating_sub(50);
                let bounded = format!("{}\n", lines[start..].join("\n"));
                if let Err(error) = write_private(&path, bounded) {
                    eprintln!("Could not write debug trace: {error}");
                }
            }
        }
    }
}

fn write_private(path: &std::path::Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Parse an accelerator, falling back to the built-in default rather than
/// aborting startup: a typo in an override should cost you that one key, not the
/// whole app.
#[cfg(desktop)]
fn parse_accel(spec: &str, fallback: &str) -> tauri_plugin_global_shortcut::Shortcut {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;
    Shortcut::from_str(spec).unwrap_or_else(|e| {
        eprintln!("{spec} is not a valid accelerator ({e}); using {fallback} instead.");
        Shortcut::from_str(fallback).expect("built-in accelerator must parse")
    })
}

fn reveal(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.center();
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn center_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.center();
    }
}

#[cfg(desktop)]
fn install_native_menu(app: &mut tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let version = handle.package_info().version.to_string();
    let about_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
    let about = AboutMetadata {
        name: Some("Council Editor".into()),
        version: Some(version.clone()),
        short_version: Some(version),
        copyright: Some("Copyright 2026 Council Editor".into()),
        credits: Some(
            "Code Auditor workspace\n\nMulti-agent code review, screenshot reading, implementation planning, and optional cloud background jobs."
                .into(),
        ),
        icon: Some(about_icon),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        handle,
        "Council Editor",
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(about))?,
            &MenuItem::with_id(handle, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;
    let workspace_menu = Submenu::with_items(
        handle,
        "Workspace",
        true,
        &[
            &MenuItem::with_id(handle, "workspace-council", "Council", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(handle, "workspace-coding", "Coding", true, Some("CmdOrCtrl+2"))?,
            &MenuItem::with_id(handle, "workspace-knowledge", "Knowledge", true, Some("CmdOrCtrl+3"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(handle, None)?],
    )?;
    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;
    let help_menu = Submenu::with_items(handle, "Help", true, &[])?;
    let menu = Menu::with_items(
        handle,
        &[&app_menu, &workspace_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;
    app.set_menu(menu)?;
    handle.on_menu_event(|app, event| {
        match event.id.as_ref() {
            "settings" => {
                reveal(app);
                let _ = app.emit(EV_SETTINGS, ());
            }
            "workspace-council" => {
                reveal(app);
                let _ = app.emit(EV_WORKSPACE, "council");
            }
            "workspace-coding" => {
                reveal(app);
                let _ = app.emit(EV_WORKSPACE, "coding");
            }
            "workspace-knowledge" => {
                reveal(app);
                let _ = app.emit(EV_WORKSPACE, "knowledge");
            }
            _ => {}
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Resolved before the plugin is constructed, because the handler has to be
    // attached at construction time -- see the comment on the plugin below.
    let cap_accel = accel("CODE_AUDITOR_CAPTURE_KEY", ACCEL_CAPTURE);
    let screen_accel = accel("CODE_AUDITOR_SCREEN_KEY", ACCEL_CAPTURE_SCREEN);
    let left_accel = accel("CODE_AUDITOR_CAPTURE_LEFT_KEY", ACCEL_CAPTURE_LEFT);
    let right_accel = accel("CODE_AUDITOR_CAPTURE_RIGHT_KEY", ACCEL_CAPTURE_RIGHT);
    let solve_accel = accel("CODE_AUDITOR_SOLVE_KEY", ACCEL_SOLVE);
    let overlay_accel = accel("CODE_AUDITOR_OVERLAY_KEY", ACCEL_OVERLAY);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    // Global shortcuts are desktop-only; there is no mobile implementation.
    //
    // The handler is attached here, at plugin construction, rather than through
    // `on_shortcuts` during setup. Registering afterwards succeeded -- the key
    // showed as claimed -- but the callback never ran, which is the worst kind of
    // failure: nothing to see and nothing logged. This is the shape the plugin
    // documents, and it keeps registration and dispatch in one place.
    #[cfg(desktop)]
    let builder = {
        use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, ShortcutState};

        let cap_key = parse_accel(&cap_accel, ACCEL_CAPTURE);
        let screen_key = parse_accel(&screen_accel, ACCEL_CAPTURE_SCREEN);
        let left_key = parse_accel(&left_accel, ACCEL_CAPTURE_LEFT);
        let right_key = parse_accel(&right_accel, ACCEL_CAPTURE_RIGHT);
        let solve_key = parse_accel(&solve_accel, ACCEL_SOLVE);
        let overlay_key = parse_accel(&overlay_accel, ACCEL_OVERLAY);

        builder.plugin(
            ShortcutBuilder::new()
                .with_handler(move |app, shortcut, event| {
                    // Every accelerator fires twice, on press and on release.
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Matched explicitly rather than falling through to solve.
                    // A bare `else` means any accelerator this handler ever sees
                    // and does not recognise would silently fire a four-model run
                    // -- which today is unreachable, and the moment a fourth
                    // shortcut is added becomes an expensive surprise.
                    let ev = if *shortcut == cap_key {
                        EV_CAPTURE
                    } else if *shortcut == screen_key {
                        EV_CAPTURE_SCREEN
                    } else if *shortcut == left_key {
                        EV_CAPTURE_LEFT
                    } else if *shortcut == right_key {
                        EV_CAPTURE_RIGHT
                    } else if *shortcut == solve_key {
                        EV_SOLVE
                    } else if *shortcut == overlay_key {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = overlay::overlay_toggle(app).await {
                                trace(&format!("overlay hotkey failed: {error}"));
                            }
                        });
                        return;
                    } else {
                        trace("hotkey fired for an accelerator we do not own; ignored");
                        return;
                    };
                    if matches!(ev, EV_CAPTURE | EV_CAPTURE_SCREEN | EV_CAPTURE_LEFT | EV_CAPTURE_RIGHT)
                        && background_helper::capture_owner_pid().is_some() {
                        return; // Helper's IOHID callback already handled the physical press.
                    }
                    trace(&format!("hotkey fired -> {ev}"));
                    let _ = app.emit(ev, ());
                })
                .build(),
        )
    };

    let app = builder
        .manage(Arc::new(GhostModeConfig::default()))
        .manage(RunRegistry::default())
        .manage(Db::default())
        .invoke_handler(tauri::generate_handler![
            auth::require,
            auth::set_pin,
            auth::auth_status,
            auth::auth_login,
            auth::auth_logout,
            auth::auth_change_pin,
            auth::auth_reauthenticate,
            secrets::set_api_key,
            secrets::delete_api_key,
            secrets::has_api_key,
            providers::run_agent,
            providers::run_once,
            providers::run_coding_model_step,
            providers::run_local_qwen,
            providers::run_local_qwen_step,
            providers::cancel_local_qwen,
            providers::inspect_local_qwen,
            coding_tools::coding_tool_execute,
            providers::cancel_run,
            providers::list_gateway_models,
            providers::probe_models,
            knowledge::knowledge_list,
            knowledge::knowledge_save,
            knowledge::knowledge_delete,
            knowledge::knowledge_folder,
            knowledge::knowledge_publish,
            capture::capture_selection,
            capture::capture_screen,
            capture::capture_left_half,
            capture::capture_right_half,
            capture::read_capture,
            overlay::overlay_show,
            overlay::overlay_hide,
            overlay::overlay_toggle,
            overlay::show_overlay,
            overlay::hide_overlay,
            overlay::overlay_visibility_status,
            overlay_state::overlay_state_write,
            capture::save_reading,
            providers::set_gateway_rate,
            vision::ocr_images,
            storage::storage_upload,
            storage::storage_signed_url,
            storage::storage_remove,
            storage::forget_local_file,
            background_helper::background_helper_status,
            background_helper::background_helper_install,
            background_helper::background_helper_uninstall,
            ghost_mode::ghost_mode_status,
            ghost_mode::ghost_mode_toggle,
            helper_auth::helper_authorize,
            helper_auth::helper_auth_status,
            helper_auth::helper_deauthorize,
            db::settings_load,
            db::settings_save,
            config::config_list,
            config::config_set,
            config::config_delete,
            sessions::session_list,
            sessions::session_create,
            sessions::session_update,
            sessions::session_set_status,
            sessions::session_delete,
            sessions::screenshot_list,
            sessions::screenshot_add,
            sessions::screenshot_remove,
            sessions::screenshot_reorder,
            sessions::screenshots_purge,
            sessions::run_save,
            sessions::run_list,
            sessions::run_get,
            sessions::solve_job_create,
            sessions::solve_job_list,
            sessions::solve_job_event_list,
            sessions::solve_job_image_list,
            sessions::council_report_get,
            runner::run_code,
            runner::runnable_languages,
        ])
        .setup(move |app| {
            #[cfg(desktop)]
            install_native_menu(app)?;

            center_main_window(app.handle());

            let config = app.state::<Arc<GhostModeConfig>>().clone();
            let app_pid = std::process::id();
            if config.enabled {
                let root = ghost_mode::ghost_root(&config);
                std::fs::create_dir_all(&root).expect("Could not create ghost root directory");
                std::fs::create_dir_all(ghost_mode::ghost_cache_dir(&config))
                    .expect("Could not create ghost cache directory");
                std::fs::create_dir_all(ghost_mode::ghost_log_dir(&config))
                    .expect("Could not create ghost log directory");
                println!("[GHOST MODE] Active. PID={app_pid}, tier={}", config.tier);
            }
            let sentinel = ghost_mode::app_alive_sentinel(&config, app_pid);
            app_binding::write_alive_sentinel(&sentinel, app_pid);

            if let Ok(listener) = ghost_mode::socket::bind_socket(app_pid) {
                app.manage(listener);
            }

            #[cfg(desktop)]
            {
                let show = MenuItem::with_id(app, "show", "Open Council Editor", true, None::<&str>)?;
                let capture =
                    MenuItem::with_id(app, "capture", "Capture Region", true, Some("Ctrl+Alt+R"))?;
                let capture_screen = MenuItem::with_id(
                    app,
                    "capture-screen",
                    "Capture Whole Screen",
                    true,
                    Some("Ctrl+Alt+S"),
                )?;
                let capture_left = MenuItem::with_id(
                    app,
                    "capture-left",
                    "Capture Left Half",
                    true,
                    Some("Ctrl+Alt+Shift+L"),
                )?;
                let capture_right = MenuItem::with_id(
                    app,
                    "capture-right",
                    "Capture Right Half",
                    true,
                    Some("Ctrl+Alt+Shift+R"),
                )?;
                let solve = MenuItem::with_id(app, "solve", "Solve", true, Some("Ctrl+Alt+A"))?;
                let overlay =
                    MenuItem::with_id(app, "overlay", "Toggle Glass Overlay", true, Some("Ctrl+Alt+O"))?;
                let sep = PredefinedMenuItem::separator(app)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Council Editor", true, None::<&str>)?;
                let menu = Menu::with_items(
                    app,
                    &[&show, &capture, &capture_screen, &capture_left, &capture_right, &solve, &overlay, &sep, &quit],
                )?;

                // A template image: black-on-transparent, recoloured by macOS for
                // the light, dark and highlighted menu bar.
                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .icon_as_template(true)
                    .tooltip("Council Editor — ⌃⌥S screen, ⌃⌥R region, ⌃⌥⇧L left, ⌃⌥⇧R right")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => reveal(app),
                        "capture" => {
                            if !background_helper::forward_capture("region") {
                                let _ = app.emit(EV_CAPTURE, ());
                            }
                        }
                        "capture-screen" => {
                            if !background_helper::forward_capture("screen") {
                                let _ = app.emit(EV_CAPTURE_SCREEN, ());
                            }
                        }
                        "capture-left" => {
                            if !background_helper::forward_capture("left") {
                                let _ = app.emit(EV_CAPTURE_LEFT, ());
                            }
                        }
                        "capture-right" => {
                            if !background_helper::forward_capture("right") {
                                let _ = app.emit(EV_CAPTURE_RIGHT, ());
                            }
                        }
                        "solve" => {
                            let _ = app.emit(EV_SOLVE, ());
                        }
                        "overlay" => {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(error) = overlay::overlay_toggle(app).await {
                                    trace(&format!("overlay tray toggle failed: {error}"));
                                }
                            });
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;

                use tauri_plugin_global_shortcut::GlobalShortcutExt;

                let cap_key = parse_accel(&cap_accel, ACCEL_CAPTURE);
                let screen_key = parse_accel(&screen_accel, ACCEL_CAPTURE_SCREEN);
                let left_key = parse_accel(&left_accel, ACCEL_CAPTURE_LEFT);
                let right_key = parse_accel(&right_accel, ACCEL_CAPTURE_RIGHT);
                let solve_key = parse_accel(&solve_accel, ACCEL_SOLVE);
                let overlay_key = parse_accel(&overlay_accel, ACCEL_OVERLAY);

                // Another app owning the accelerator is the common failure, and a
                // hotkey that does nothing with no explanation is worse than a
                // loud startup error. Say so where it will be seen.
                // Register each key separately. macOS can reject one global
                // shortcut because another app owns it; grouping them made that
                // one collision disable every capture shortcut, including the
                // left/right actions that did not conflict.
                for (label, key, spec) in [
                    ("region", cap_key, cap_accel.as_str()),
                    ("screen", screen_key, screen_accel.as_str()),
                    ("left half", left_key, left_accel.as_str()),
                    ("right half", right_key, right_accel.as_str()),
                    ("solve", solve_key, solve_accel.as_str()),
                    ("overlay", overlay_key, overlay_accel.as_str()),
                ] {
                    match app.global_shortcut().register(key) {
                        Ok(()) => trace(&format!("claimed {spec} ({label})")),
                        Err(e) => eprintln!(
                            "Could not claim {spec} ({label}): {e}. Another app probably owns it; the tray menu still works."
                        ),
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let config = window.app_handle().state::<Arc<GhostModeConfig>>().clone();
                let app_pid = std::process::id();
                if config.enabled {
                    let sentinel = ghost_mode::app_alive_sentinel(&config, app_pid);
                    app_binding::remove_alive_sentinel(&sentinel);
                    ghost_mode::socket::cleanup_socket(app_pid);
                    println!("[GHOST MODE] Torn down. PID={app_pid}");
                }
            }

            // Closing the window must not end the process: the global shortcuts
            // only exist while it is alive, and the whole point of them is to work
            // when the app is nowhere in sight. Quit lives in the tray menu.
            if window.label() == "coding-capture-exempt-overlay" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Council Editor");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let config = app.state::<Arc<GhostModeConfig>>().clone();
            let app_pid = std::process::id();
            let alive_sentinel = ghost_mode::app_alive_sentinel(&config, app_pid);
            app_binding::remove_alive_sentinel(&alive_sentinel);
            ghost_mode::socket::cleanup_socket(app_pid);
            overlay_state::cleanup_socket();
        }
        // Clicking the dock icon while every window is hidden should bring the
        // app back, which is what a macOS user expects from a background app.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            reveal(app);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, event);
        }
    });
}
