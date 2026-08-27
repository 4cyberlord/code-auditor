mod auth;
mod capture;
mod background_helper;
mod db;
mod exec;
mod keychain;
mod platform_base;
mod providers;
mod runner;
mod sessions;
mod storage;
mod vision;

use db::Db;
use providers::RunRegistry;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

/// Emitted when a global shortcut or the tray menu asks for a capture or a run.
/// Both entry points land on the same two events, so the frontend has one path.
pub const EV_CAPTURE: &str = "shortcut://capture";
pub const EV_CAPTURE_SCREEN: &str = "shortcut://capture-screen";
pub const EV_SOLVE: &str = "shortcut://solve";

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
pub const ACCEL_CAPTURE_SCREEN: &str = "Control+Alt+S";
pub const ACCEL_CAPTURE: &str = "Control+Alt+R";
pub const ACCEL_SOLVE: &str = "Control+Alt+A";

fn accel(var: &str, default: &str) -> String {
    std::env::var(var)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// Stderr tracing, off unless `CODE_AUDITOR_TRACE` is set. The whole class of bug
/// here is silence, so there has to be a way to see the pipeline without a
/// rebuild -- but not one that spams a terminal-launched run by default.
pub fn trace(msg: &str) {
    if std::env::var_os("CODE_AUDITOR_TRACE").is_some() {
        eprintln!("[code-auditor] {msg}");
    }
    // Also to a file, because stderr depends on how the app was launched: double
    // clicked from Finder it goes nowhere, so the one time you need the trace --
    // a user reporting that nothing happens -- is the time you cannot read it.
    if let Some(home) = std::env::var_os("HOME") {
        let dir = std::path::Path::new(&home).join("Library/Logs/CodeAuditor");
        if std::fs::create_dir_all(&dir).is_ok() {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("trace.log"))
            {
                let _ = writeln!(f, "{msg}");
            }
        }
    }
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
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Resolved before the plugin is constructed, because the handler has to be
    // attached at construction time -- see the comment on the plugin below.
    let cap_accel = accel("CODE_AUDITOR_CAPTURE_KEY", ACCEL_CAPTURE);
    let screen_accel = accel("CODE_AUDITOR_SCREEN_KEY", ACCEL_CAPTURE_SCREEN);
    let solve_accel = accel("CODE_AUDITOR_SOLVE_KEY", ACCEL_SOLVE);

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

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
        let solve_key = parse_accel(&solve_accel, ACCEL_SOLVE);

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
                    } else if *shortcut == solve_key {
                        EV_SOLVE
                    } else {
                        trace("hotkey fired for an accelerator we do not own; ignored");
                        return;
                    };
                    trace(&format!("hotkey fired -> {ev}"));
                    let _ = app.emit(ev, ());
                })
                .build(),
        )
    };

    let app = builder
        .manage(RunRegistry::default())
        .manage(Db::default())
        .invoke_handler(tauri::generate_handler![
            auth::auth_status,
            auth::auth_login,
            auth::auth_logout,
            auth::auth_change_pin,
            keychain::set_api_key,
            keychain::delete_api_key,
            keychain::has_api_key,
            providers::run_agent,
            providers::run_once,
            providers::cancel_run,
            providers::list_gateway_models,
            providers::probe_models,
            capture::capture_selection,
            capture::capture_screen,
            capture::read_capture,
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
            db::db_save_url,
            db::db_clear_url,
            db::db_has_url,
            db::db_test,
            db::db_migrate,
            db::settings_load,
            db::settings_save,
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
                let solve = MenuItem::with_id(app, "solve", "Solve", true, Some("Ctrl+Alt+A"))?;
                let sep = PredefinedMenuItem::separator(app)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Council Editor", true, None::<&str>)?;
                let menu =
                    Menu::with_items(app, &[&show, &capture, &capture_screen, &solve, &sep, &quit])?;

                // A template image: black-on-transparent, recoloured by macOS for
                // the light, dark and highlighted menu bar.
                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .icon_as_template(true)
                    .tooltip("Council Editor — ⌃⌥S screen, ⌃⌥R region, ⌃⌥A audit")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => reveal(app),
                        "capture" => {
                            let _ = app.emit(EV_CAPTURE, ());
                        }
                        "capture-screen" => {
                            let _ = app.emit(EV_CAPTURE_SCREEN, ());
                        }
                        "solve" => {
                            let _ = app.emit(EV_SOLVE, ());
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;

                use tauri_plugin_global_shortcut::GlobalShortcutExt;

                let cap_key = parse_accel(&cap_accel, ACCEL_CAPTURE);
                let screen_key = parse_accel(&screen_accel, ACCEL_CAPTURE_SCREEN);
                let solve_key = parse_accel(&solve_accel, ACCEL_SOLVE);

                // Another app owning the accelerator is the common failure, and a
                // hotkey that does nothing with no explanation is worse than a
                // loud startup error. Say so where it will be seen.
                match app
                    .global_shortcut()
                    .register_multiple([cap_key, screen_key, solve_key])
                {
                    Ok(()) => trace(&format!(
                        "claimed {cap_accel} (region), {screen_accel} (screen), {solve_accel} (solve)"
                    )),
                    Err(e) => eprintln!(
                        "Could not claim {cap_accel} / {screen_accel} / {solve_accel} as global \
                         shortcuts: {e}. Another app probably owns one of them; the tray menu \
                         still works, and CODE_AUDITOR_CAPTURE_KEY / CODE_AUDITOR_SCREEN_KEY / \
                         CODE_AUDITOR_SOLVE_KEY move them."
                    ),
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window must not end the process: the global shortcuts
            // only exist while it is alive, and the whole point of them is to work
            // when the app is nowhere in sight. Quit lives in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Code Editor");

    app.run(|app, event| {
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
