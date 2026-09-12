use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const OVERLAY_LABEL: &str = "coding-capture-exempt-overlay";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayVisibilityStatus {
    sharing_type: u64,
    window_level: isize,
    collection_behavior: u64,
    is_visible: bool,
    sharing_disabled: bool,
    all_spaces: bool,
    fullscreen_auxiliary: bool,
    ignores_cycle: bool,
}

fn overlay_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("index.html?overlay=capture-exempt".into()),
    )
    .title("Capture Exempt Overlay")
    .inner_size(1320.0, 950.0)
    .center()
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .shadow(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .content_protected(true)
    .focused(false)
    .focusable(false)
    .skip_taskbar(true)
    .build()
    .map_err(|e| format!("Could not create overlay: {e}"))?;

    let _ = window.set_ignore_cursor_events(true);
    tune_for_macos(&window)?;
    Ok(window)
}

#[cfg(target_os = "macos")]
fn tune_for_macos(window: &WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{
        NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType,
    };

    let ns_window = window
        .ns_window()
        .map_err(|e| format!("Could not access macOS overlay window: {e}"))?;
    if ns_window.is_null() {
        return Err("Could not access macOS overlay window.".into());
    }

    unsafe {
        let ns_window = &*ns_window.cast::<NSWindow>();
        ns_window.setLevel(NSScreenSaverWindowLevel);
        ns_window.setSharingType(NSWindowSharingType::None);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn tune_for_macos(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn overlay_show(app: AppHandle) -> Result<(), String> {
    crate::auth::require()?;
    let window = overlay_window(&app)?;
    window
        .set_content_protected(true)
        .map_err(|e| format!("Could not protect overlay content: {e}"))?;
    let _ = window.set_focusable(false);
    let _ = window.set_ignore_cursor_events(true);
    tune_for_macos(&window)?;
    window
        .show()
        .map_err(|e| format!("Could not show overlay: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn overlay_hide(app: AppHandle) -> Result<(), String> {
    crate::auth::require()?;
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        window
            .hide()
            .map_err(|e| format!("Could not hide overlay: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_overlay(app: AppHandle, text: String) -> Result<(), String> {
    crate::auth::require()?;
    let window = overlay_window(&app)?;
    window
        .set_content_protected(true)
        .map_err(|e| format!("Could not protect overlay content: {e}"))?;
    let _ = window.set_focusable(false);
    let _ = window.set_ignore_cursor_events(true);
    tune_for_macos(&window)?;
    let _ = window.emit("overlay://text", text);
    window
        .show()
        .map_err(|e| format!("Could not show overlay: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn hide_overlay(app: AppHandle) -> Result<(), String> {
    overlay_hide(app).await
}

#[tauri::command]
pub async fn overlay_toggle(app: AppHandle) -> Result<bool, String> {
    crate::auth::require()?;
    let window = overlay_window(&app)?;
    let visible = window
        .is_visible()
        .map_err(|e| format!("Could not read overlay visibility: {e}"))?;
    if visible {
        window
            .hide()
            .map_err(|e| format!("Could not hide overlay: {e}"))?;
        Ok(false)
    } else {
        let _ = window.set_focusable(false);
        let _ = window.set_ignore_cursor_events(true);
        tune_for_macos(&window)?;
        window
            .show()
            .map_err(|e| format!("Could not show overlay: {e}"))?;
        Ok(true)
    }
}

#[tauri::command]
pub async fn overlay_visibility_status(app: AppHandle) -> Result<OverlayVisibilityStatus, String> {
    crate::auth::require()?;
    let window = overlay_window(&app)?;
    overlay_status_for(&window)
}

#[cfg(target_os = "macos")]
fn overlay_status_for(window: &WebviewWindow) -> Result<OverlayVisibilityStatus, String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowSharingType};

    let ns_window = window
        .ns_window()
        .map_err(|e| format!("Could not access macOS overlay window: {e}"))?;
    if ns_window.is_null() {
        return Err("Could not access macOS overlay window.".into());
    }

    unsafe {
        let ns_window = &*ns_window.cast::<NSWindow>();
        let sharing_type = ns_window.sharingType();
        let level = ns_window.level();
        let behavior = ns_window.collectionBehavior();
        Ok(OverlayVisibilityStatus {
            sharing_type: sharing_type.0 as u64,
            window_level: level,
            collection_behavior: behavior.bits() as u64,
            is_visible: window
                .is_visible()
                .map_err(|e| format!("Could not read overlay visibility: {e}"))?,
            sharing_disabled: sharing_type == NSWindowSharingType::None,
            all_spaces: behavior.contains(NSWindowCollectionBehavior::CanJoinAllSpaces),
            fullscreen_auxiliary: behavior
                .contains(NSWindowCollectionBehavior::FullScreenAuxiliary),
            ignores_cycle: behavior.contains(NSWindowCollectionBehavior::IgnoresCycle),
        })
    }
}

#[cfg(not(target_os = "macos"))]
fn overlay_status_for(window: &WebviewWindow) -> Result<OverlayVisibilityStatus, String> {
    Ok(OverlayVisibilityStatus {
        sharing_type: 0,
        window_level: 0,
        collection_behavior: 0,
        is_visible: window
            .is_visible()
            .map_err(|e| format!("Could not read overlay visibility: {e}"))?,
        sharing_disabled: false,
        all_spaces: false,
        fullscreen_auxiliary: false,
        ignores_cycle: false,
    })
}
