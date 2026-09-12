// Overlay module for ghost mode.
//! The overlay window is the most visible artifact.
//! GHOST TIER 2 makes it as invisible as possible:
//!
//! - Screen-saver window level (above everything)
//! - NSWindowSharingType::None (excluded from screenshots)
//! - Content protection (excluded from screen capture)
//! - Ignores mouse events (click-through)
//! - No shadow, no border
//! - LSUIElement + LSBackgroundOnly (no Dock, no menu)
//! - Alpha 0.46 (semi-transparent, looks like a HUD)
//! - ActivationPolicy::Prohibited when hidden
//!
//! A scanner looking for "always-on-top borderless windows
//! at screen-saver level" will find this. But that's the
//! price of a click-through HUD. We minimize the time it's
//! visible by only showing it on hotkey.

use tao::{
    dpi::{LogicalPosition, LogicalSize},
    window::{Window, WindowBuilder},
};
use wry::{WebView, WebViewBuilder};

pub const OVERLAY_WIDTH: f64 = 1320.0;
pub const OVERLAY_HEIGHT: f64 = 950.0;

#[cfg(target_os = "macos")]
pub fn create_ghost_overlay<T>(
    event_loop: &tao::event_loop::EventLoop<T>,
    position: LogicalPosition<f64>,
    html: &str,
) -> Result<(Window, WebView), String> {
    let window = WindowBuilder::new()
        .with_title("Capture Exempt Overlay")
        .with_inner_size(LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT))
        .with_position(position)
        .with_visible(false)
        .with_decorations(false)
        .with_resizable(false)
        .with_transparent(true)
        .with_always_on_top(true)
        .with_focused(false)
        .with_focusable(false)
        .with_content_protection(true)
        .with_visible_on_all_workspaces(true)
        .build(event_loop)
        .map_err(|e| format!("Ghost overlay creation failed: {e}"))?;

    let webview = WebViewBuilder::new()
        .with_transparent(true)
        .with_html(html)
        .build(&window)
        .map_err(|e| format!("Ghost overlay webview failed: {e}"))?;

    let _ = window.set_ignore_cursor_events(true);
    tune_macos(&window)?;
    Ok((window, webview))
}

#[cfg(target_os = "macos")]
fn tune_macos(window: &Window) -> Result<(), String> {
    use objc2_app_kit::{
        NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType,
        NSWindowStyleMask,
    };
    use tao::platform::macos::WindowExtMacOS;
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    unsafe {
        let ns_window = window.ns_window();
        if ns_window.is_null() {
            return Err("Ghost overlay: null NSWindow".into());
        }
        let ns_window = &*ns_window.cast::<NSWindow>();
        ns_window.setLevel(NSScreenSaverWindowLevel);
        ns_window.setAlphaValue(0.46);
        ns_window.setSharingType(NSWindowSharingType::None);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        ns_window.setIgnoresMouseEvents(true);
        ns_window.setHasShadow(false);
        ns_window.setStyleMask(NSWindowStyleMask::Borderless);
    }

    apply_vibrancy(
        window,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::Active),
        Some(16.0),
    )
    .map_err(|e| format!("Ghost overlay vibrancy failed: {e}"))?;

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn tune_macos(_window: &Window) -> Result<(), String> {
    Ok(())
}
