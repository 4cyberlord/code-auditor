use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const OVERLAY_LABEL: &str = "coding-capture-exempt-overlay";

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
