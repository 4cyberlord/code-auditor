// src-tauri/src/bin/mds.rs
use base64::Engine;
use serde_json::Value;
#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;
use std::{
    fs::{self, File, OpenOptions},
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
#[cfg(target_os = "macos")]
use tao::platform::macos::{
    ActivationPolicy, EventLoopExtMacOS, EventLoopWindowTargetExtMacOS, WindowExtMacOS,
};
use tao::{
    dpi::{LogicalPosition, LogicalSize},
    window::{Window, WindowBuilder},
};
use uuid::Uuid;
use wry::{WebView, WebViewBuilder};

#[allow(dead_code)]
const SERVICE: &str = "com.apple.mds.session";
#[allow(dead_code)]
const HELPER_TOKEN: &str = "mds";
const MAX_IMAGES: usize = 10;
const OVERLAY_WIDTH: f64 = 1320.0;
const OVERLAY_HEIGHT: f64 = 950.0;
const INSTANCE_LOCK: &str = ".mds_daemon.lock";
#[allow(dead_code)]
const HELPER_USER_AGENT: &str =
 "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// ─── SINGLE INSTANCE ──────────────────────────────────────────────────────────

struct SingleInstanceGuard {
    #[allow(dead_code)]
    file: File,
}

fn support_root_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Could not find HOME.")?;
    Ok(home
        .join("Library")
        .join("Application Support")
        .join(".com.apple.mds"))
}

fn helper_status_path() -> Result<PathBuf, String> {
    Ok(support_root_dir()?.join("cache/helper-status.json"))
}

fn write_helper_status(hotkeys_available: bool, problem: Option<&str>) {
    let Ok(path) = helper_status_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let payload = serde_json::json!({
        "pid": std::process::id(),
        "updatedAt": chrono::Utc::now().to_rfc3339(),
        "hotkeysAvailable": hotkeys_available,
        "problem": problem,
    });
    let Ok(bytes) = serde_json::to_vec_pretty(&payload) else {
        return;
    };
    let _ = fs::write(path, bytes);
}

fn claim_single_instance() -> Result<SingleInstanceGuard, String> {
    let dir = support_root_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create ghost support dir: {e}"))?;
    let path = dir.join(INSTANCE_LOCK);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("Could not open ghost lock: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if locked != 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::WouldBlock {
                return Err("Another ghost instance is already running.".into());
            }
            return Err(format!("Could not lock ghost instance: {err}"));
        }
    }
    Ok(SingleInstanceGuard { file })
}

// ─── GHOST PROCESS HIDE ───────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn ghost_process_hide() {
    // Set nice priority
    let _ = unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, 10) };
}

#[cfg(not(target_os = "macos"))]
fn ghost_process_hide() {}

// ─── IOHID SHORTCUTS (same as before, just renamed) ──────────────────────────

#[cfg(target_os = "macos")]
mod mac_shortcuts {
    use std::{
        ffi::c_void,
        ptr,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };

    type CFAllocatorRef = *const c_void;
    type CFRunLoopRef = *const c_void;
    type CFStringRef = *const c_void;
    type IOHIDManagerRef = *mut c_void;
    type IOHIDValueRef = *mut c_void;
    type IOHIDElementRef = *mut c_void;
    type IOReturn = i32;
    type IOOptionBits = u32;

    const K_IO_RETURN_SUCCESS: IOReturn = 0;
    const K_IO_HID_OPTIONS_TYPE_NONE: IOOptionBits = 0;
    const HID_USAGE_PAGE_KEYBOARD: u32 = 0x07;
    const HID_USAGE_KEYBOARD_B: u32 = 0x05;
    const HID_USAGE_KEYBOARD_C: u32 = 0x06;
    const HID_USAGE_KEYBOARD_M: u32 = 0x10;
    const HID_USAGE_KEYBOARD_P: u32 = 0x13;
    const HID_USAGE_KEYBOARD_RETURN: u32 = 0x28;
    const HID_USAGE_KEYBOARD_RIGHT_ARROW: u32 = 0x4F;
    const HID_USAGE_KEYBOARD_LEFT_ARROW: u32 = 0x50;
    const HID_USAGE_KEYBOARD_DOWN_ARROW: u32 = 0x51;
    const HID_USAGE_KEYBOARD_UP_ARROW: u32 = 0x52;
    const HID_USAGE_KEYBOARD_LEFT_CONTROL: u32 = 0xE0;
    const HID_USAGE_KEYBOARD_LEFT_SHIFT: u32 = 0xE1;
    const HID_USAGE_KEYBOARD_LEFT_ALT: u32 = 0xE2;
    const HID_USAGE_KEYBOARD_RIGHT_CONTROL: u32 = 0xE4;
    const HID_USAGE_KEYBOARD_RIGHT_SHIFT: u32 = 0xE5;
    const HID_USAGE_KEYBOARD_RIGHT_ALT: u32 = 0xE6;

    pub static START_BATCH: AtomicBool = AtomicBool::new(false);
    pub static CAPTURE: AtomicBool = AtomicBool::new(false);
    pub static SUBMIT: AtomicBool = AtomicBool::new(false);
    pub static TOGGLE_OVERLAY: AtomicBool = AtomicBool::new(false);
    pub static SWITCH_MCQ: AtomicBool = AtomicBool::new(false);
    pub static MOVE_LEFT: AtomicBool = AtomicBool::new(false);
    pub static MOVE_RIGHT: AtomicBool = AtomicBool::new(false);
    pub static MOVE_UP: AtomicBool = AtomicBool::new(false);
    pub static MOVE_DOWN: AtomicBool = AtomicBool::new(false);
    pub static SCROLL_UP: AtomicBool = AtomicBool::new(false);
    pub static SCROLL_DOWN: AtomicBool = AtomicBool::new(false);

    static CONTROL_DOWN: AtomicBool = AtomicBool::new(false);
    static SHIFT_DOWN: AtomicBool = AtomicBool::new(false);
    static OPTION_DOWN: AtomicBool = AtomicBool::new(false);
    static MONITOR: Mutex<Option<usize>> = Mutex::new(None);

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDManagerCreate(allocator: CFAllocatorRef, options: IOOptionBits) -> IOHIDManagerRef;
        fn IOHIDManagerSetDeviceMatching(manager: IOHIDManagerRef, matching: *const c_void);
        fn IOHIDManagerRegisterInputValueCallback(
            manager: IOHIDManagerRef,
            callback: extern "C" fn(*mut c_void, IOReturn, *mut c_void, IOHIDValueRef),
            context: *mut c_void,
        );
        fn IOHIDManagerScheduleWithRunLoop(
            manager: IOHIDManagerRef,
            run_loop: CFRunLoopRef,
            run_loop_mode: CFStringRef,
        );
        fn IOHIDManagerOpen(manager: IOHIDManagerRef, options: IOOptionBits) -> IOReturn;
        fn IOHIDValueGetElement(value: IOHIDValueRef) -> IOHIDElementRef;
        fn IOHIDValueGetIntegerValue(value: IOHIDValueRef) -> libc::c_long;
        fn IOHIDElementGetUsagePage(element: IOHIDElementRef) -> u32;
        fn IOHIDElementGetUsage(element: IOHIDElementRef) -> u32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFRunLoopDefaultMode: CFStringRef;
        fn CFRunLoopGetMain() -> CFRunLoopRef;
    }

    extern "C" fn input_value_callback(
        _context: *mut c_void,
        _result: IOReturn,
        _sender: *mut c_void,
        value: IOHIDValueRef,
    ) {
        if value.is_null() {
            return;
        }
        let element = unsafe { IOHIDValueGetElement(value) };
        if element.is_null() {
            return;
        }
        let usage_page = unsafe { IOHIDElementGetUsagePage(element) };
        if usage_page != HID_USAGE_PAGE_KEYBOARD {
            return;
        }
        let usage = unsafe { IOHIDElementGetUsage(element) };
        let pressed = unsafe { IOHIDValueGetIntegerValue(value) } != 0;

        match usage {
            HID_USAGE_KEYBOARD_LEFT_CONTROL | HID_USAGE_KEYBOARD_RIGHT_CONTROL => {
                CONTROL_DOWN.store(pressed, Ordering::SeqCst)
            }
            HID_USAGE_KEYBOARD_LEFT_SHIFT | HID_USAGE_KEYBOARD_RIGHT_SHIFT => {
                SHIFT_DOWN.store(pressed, Ordering::SeqCst)
            }
            HID_USAGE_KEYBOARD_LEFT_ALT | HID_USAGE_KEYBOARD_RIGHT_ALT => {
                OPTION_DOWN.store(pressed, Ordering::SeqCst)
            }
            HID_USAGE_KEYBOARD_LEFT_ARROW
            | HID_USAGE_KEYBOARD_RIGHT_ARROW
            | HID_USAGE_KEYBOARD_UP_ARROW
            | HID_USAGE_KEYBOARD_DOWN_ARROW
                if pressed
                    && SHIFT_DOWN.load(Ordering::SeqCst)
                    && OPTION_DOWN.load(Ordering::SeqCst) =>
            {
                match usage {
                    HID_USAGE_KEYBOARD_LEFT_ARROW => MOVE_LEFT.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_RIGHT_ARROW => MOVE_RIGHT.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_UP_ARROW => MOVE_UP.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_DOWN_ARROW => MOVE_DOWN.store(true, Ordering::SeqCst),
                    _ => {}
                }
            }
            HID_USAGE_KEYBOARD_UP_ARROW | HID_USAGE_KEYBOARD_DOWN_ARROW
                if pressed && OPTION_DOWN.load(Ordering::SeqCst) =>
            {
                match usage {
                    HID_USAGE_KEYBOARD_UP_ARROW => SCROLL_UP.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_DOWN_ARROW => SCROLL_DOWN.store(true, Ordering::SeqCst),
                    _ => {}
                }
            }
            HID_USAGE_KEYBOARD_B
            | HID_USAGE_KEYBOARD_C
            | HID_USAGE_KEYBOARD_M
            | HID_USAGE_KEYBOARD_P
            | HID_USAGE_KEYBOARD_RETURN
                if pressed
                    && CONTROL_DOWN.load(Ordering::SeqCst)
                    && OPTION_DOWN.load(Ordering::SeqCst) =>
            {
                match usage {
                    HID_USAGE_KEYBOARD_B => START_BATCH.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_C => TOGGLE_OVERLAY.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_M => SWITCH_MCQ.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_P => CAPTURE.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_RETURN => SUBMIT.store(true, Ordering::SeqCst),
                    _ => {}
                }
            }
            _ => {}
        }
    }

    pub fn register() -> Result<(), String> {
        let manager = unsafe { IOHIDManagerCreate(ptr::null(), K_IO_HID_OPTIONS_TYPE_NONE) };
        if manager.is_null() {
            return Err("Could not create IOHIDManager.".into());
        }
        unsafe {
            IOHIDManagerSetDeviceMatching(manager, ptr::null());
            IOHIDManagerRegisterInputValueCallback(manager, input_value_callback, ptr::null_mut());
            IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), kCFRunLoopDefaultMode);
        }
        let opened = unsafe { IOHIDManagerOpen(manager, K_IO_HID_OPTIONS_TYPE_NONE) };
        if opened != K_IO_RETURN_SUCCESS {
            return Err(format!("Could not open IOHIDManager: {opened}"));
        }
        *MONITOR.lock().map_err(|_| "Lock failed.".to_string())? = Some(manager as usize);
        Ok(())
    }

    pub fn take_start_batch() -> bool {
        START_BATCH.swap(false, Ordering::SeqCst)
    }
    pub fn take_capture() -> bool {
        CAPTURE.swap(false, Ordering::SeqCst)
    }
    pub fn take_submit() -> bool {
        SUBMIT.swap(false, Ordering::SeqCst)
    }
    pub fn take_toggle_overlay() -> bool {
        TOGGLE_OVERLAY.swap(false, Ordering::SeqCst)
    }
    pub fn take_switch_mcq() -> bool {
        SWITCH_MCQ.swap(false, Ordering::SeqCst)
    }
    pub fn take_move_left() -> bool {
        MOVE_LEFT.swap(false, Ordering::SeqCst)
    }
    pub fn take_move_right() -> bool {
        MOVE_RIGHT.swap(false, Ordering::SeqCst)
    }
    pub fn take_move_up() -> bool {
        MOVE_UP.swap(false, Ordering::SeqCst)
    }
    pub fn take_move_down() -> bool {
        MOVE_DOWN.swap(false, Ordering::SeqCst)
    }
    pub fn take_scroll_up() -> bool {
        SCROLL_UP.swap(false, Ordering::SeqCst)
    }
    pub fn take_scroll_down() -> bool {
        SCROLL_DOWN.swap(false, Ordering::SeqCst)
    }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

fn main() {
    if let Err(e) = run() {
        if !e.contains("Another ghost instance is already running") {
            write_helper_status(false, Some(&format!("startup failed: {e}")));
        }
        eprintln!("ghost helper startup failed: {e}");
        std::process::exit(1);
    }
}

#[allow(unreachable_code)]
fn run() -> Result<(), String> {
    let _single_instance = claim_single_instance()?;
    ghost_process_hide();

    // Ghost: no Dock, no menu bar
    let mut event_loop = EventLoopBuilder::new().build();
    #[cfg(target_os = "macos")]
    {
        event_loop.set_activation_policy(ActivationPolicy::Prohibited);
    }
    #[cfg(target_os = "macos")]
    match mac_shortcuts::register() {
        Ok(()) => write_helper_status(true, None),
        Err(error) => {
            let message = format!(
                "hotkeys unavailable: {error}. Grant Input Monitoring permission for the helper in macOS System Settings, then reinstall or restart the helper."
            );
            eprintln!("{message}");
            write_helper_status(false, Some(&message));
        }
    }
    #[cfg(not(target_os = "macos"))]
    write_helper_status(true, None);

    let mut overlay_position = overlay_position(&event_loop);
    let (overlay, webview) = overlay_window(&event_loop, overlay_position)?;
    let mut active_view = "coding".to_string();
    update_overlay(&webview, &active_view)?;
    let mut overlay_visible = false;
    let mut last_job_poll = Instant::now() - Duration::from_secs(60);
    let mut last_overlay_refresh = Instant::now();

    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;

    event_loop.run(move |_event, event_loop_target, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));

        if last_job_poll.elapsed() >= Duration::from_secs(5) {
            last_job_poll = Instant::now();
            let _ = rt.block_on(refresh_job());
        }

        if overlay_visible && last_overlay_refresh.elapsed() >= Duration::from_millis(500) {
            last_overlay_refresh = Instant::now();
            let _ = update_overlay(&webview, &active_view);
        }

        #[cfg(target_os = "macos")]
        {
            if mac_shortcuts::take_toggle_overlay() {
                if active_view != "coding" {
                    active_view = "coding".to_string();
                    overlay_visible = true;
                } else {
                    overlay_visible = !overlay_visible;
                }
                event_loop_target.set_activation_policy_at_runtime(if overlay_visible {
                    ActivationPolicy::Accessory
                } else {
                    ActivationPolicy::Prohibited
                });
                let _ = show_overlay(&overlay, overlay_visible);
                let _ = update_overlay(&webview, &active_view);
            }
            if mac_shortcuts::take_switch_mcq() {
                if active_view != "mcq" {
                    active_view = "mcq".to_string();
                    overlay_visible = true;
                } else {
                    overlay_visible = !overlay_visible;
                }
                event_loop_target.set_activation_policy_at_runtime(if overlay_visible {
                    ActivationPolicy::Accessory
                } else {
                    ActivationPolicy::Prohibited
                });
                let _ = show_overlay(&overlay, overlay_visible);
                let _ = update_overlay(&webview, &active_view);
            }
            if mac_shortcuts::take_start_batch() {
                let _ = start_batch();
            }
            if mac_shortcuts::take_capture() {
                let restore = overlay_visible;
                if overlay_visible {
                    overlay_visible = false;
                    let _ = show_overlay(&overlay, false);
                }
                event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                let result = capture_screen();
                overlay_visible = restore;
                event_loop_target.set_activation_policy_at_runtime(if overlay_visible {
                    ActivationPolicy::Accessory
                } else {
                    ActivationPolicy::Prohibited
                });
                let _ = show_overlay(&overlay, overlay_visible);
                if let Err(e) = result {
                    eprintln!("capture failed: {e}");
                } else {
                    let _ = update_overlay(&webview, &active_view);
                }
            }
            if mac_shortcuts::take_submit() {
                let _ = rt.block_on(submit_batch(&active_view));
            }
            if overlay_visible && mac_shortcuts::take_move_left() {
                overlay_position.x -= 80.0;
                overlay.set_outer_position(overlay_position);
            }
            if overlay_visible && mac_shortcuts::take_move_right() {
                overlay_position.x += 80.0;
                overlay.set_outer_position(overlay_position);
            }
            if overlay_visible && mac_shortcuts::take_move_up() {
                overlay_position.y -= 80.0;
                overlay.set_outer_position(overlay_position);
            }
            if overlay_visible && mac_shortcuts::take_move_down() {
                overlay_position.y += 80.0;
                overlay.set_outer_position(overlay_position);
            }
            if overlay_visible && mac_shortcuts::take_scroll_up() {
                let _ = webview.evaluate_script("window.scrollSolutionBy(-260)");
            }
            if overlay_visible && mac_shortcuts::take_scroll_down() {
                let _ = webview.evaluate_script("window.scrollSolutionBy(260)");
            }
        }
    });
    Ok(())
}

// ─── OVERLAY (GHOST WINDOW) ───────────────────────────────────────────────────

fn overlay_position<T>(event_loop: &tao::event_loop::EventLoop<T>) -> LogicalPosition<f64> {
    if let Some(monitor) = event_loop.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let pos = monitor.position();
        let x = (pos.x as f64 / scale) + ((size.width as f64 / scale - OVERLAY_WIDTH) / 2.0);
        let y =
            (pos.y as f64 / scale) + ((size.height as f64 / scale - OVERLAY_HEIGHT) / 2.0) + 40.0;
        return LogicalPosition::new(x.max(0.0), y.max(0.0));
    }
    LogicalPosition::new(320.0, 100.0)
}

fn overlay_window<T>(
    event_loop: &tao::event_loop::EventLoop<T>,
    position: LogicalPosition<f64>,
) -> Result<(Window, WebView), String> {
    let window = WindowBuilder::new()
        .with_title("mds") // Ghost: title matches process name
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
        .map_err(|e| format!("Could not create ghost overlay: {e}"))?;

    let webview = WebViewBuilder::new()
        .with_transparent(true)
        .with_html(overlay_html())
        .build(&window)
        .map_err(|e| format!("Could not create ghost overlay webview: {e}"))?;

    let _ = window.set_ignore_cursor_events(true);
    tune_ghost_overlay(&window)?;
    Ok((window, webview))
}

#[cfg(target_os = "macos")]
fn tune_ghost_overlay(window: &Window) -> Result<(), String> {
    use objc2_app_kit::{
        NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType,
        NSWindowStyleMask,
    };
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    unsafe {
        let ns_window = window.ns_window();
        if ns_window.is_null() {
            return Err("Could not access ghost overlay NSWindow.".into());
        }
        let ns_window = &*ns_window.cast::<NSWindow>();
        // Screen-saver level: above everything, below the cursor
        ns_window.setLevel(NSScreenSaverWindowLevel);
        ns_window.setAlphaValue(0.46);
        // NSWindowSharingType::None = invisible to screen capture
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
    .map_err(|e| format!("Could not apply ghost vibrancy: {e}"))?;

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn tune_ghost_overlay(_window: &Window) -> Result<(), String> {
    Ok(())
}

fn show_overlay(window: &Window, visible: bool) -> Result<(), String> {
    window.set_always_on_top(true);
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| format!("Could not set ghost click-through: {e}"))?;
    window.set_visible(visible);
    Ok(())
}

// ─── CAPTURE / SUBMIT (abbreviated — same logic as before) ───────────────────

fn start_batch() -> Result<(), String> {
    let id = format!("batch-{}", Uuid::new_v4());
    let dir = support_root_dir()?.join("cache/captures").join(&id);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create capture dir: {e}"))?;
    let batch = serde_json::json!({
    "id": id,
    "status": "collecting",
    "startedAt": chrono::Utc::now().to_rfc3339(),
    "images": []
    });
    let path = support_root_dir()?.join("cache/pending-batch.json");
    fs::write(
        &path,
        serde_json::to_string_pretty(&batch).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn capture_screen() -> Result<(), String> {
    let pending_path = support_root_dir()?.join("cache/pending-batch.json");
    let raw = fs::read_to_string(&pending_path).map_err(|e| e.to_string())?;
    let mut batch: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let images = batch["images"].as_array().ok_or("bad batch")?.clone();
    if images.len() >= MAX_IMAGES {
        return Err(format!("Batch full ({MAX_IMAGES})."));
    }

    let batch_id = batch["id"].as_str().unwrap_or("unknown");
    let dir = support_root_dir()?.join("cache/captures").join(batch_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let fname = format!(
        "{}-{}.png",
        images.len(),
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    let path = dir.join(&fname);

    let out = Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg(&path)
        .output()
        .map_err(|e| format!("screencapture launch failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "screencapture failed. Check Screen Recording permission.".into()
        } else {
            format!("screencapture: {stderr}")
        });
    }

    let bytes = fs::metadata(&path).map_err(|e| e.to_string())?.len() as i64;
    batch["images"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
        "position": images.len(),
        "localPath": path.to_string_lossy().to_string(),
        "fileName": fname,
        "bytes": bytes,
        "mime": "image/png",
        "capturedAt": chrono::Utc::now().to_rfc3339()
        }));
    batch["status"] = Value::String("ready".to_string());
    fs::write(
        &pending_path,
        serde_json::to_string_pretty(&batch).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn submit_batch(_active_view: &str) -> Result<(), String> {
    // Read pending, upload via API, mark submitted
    let pending_path = support_root_dir()?.join("cache/pending-batch.json");
    if !pending_path.exists() {
        return Err("No pending batch to submit.".into());
    }
    // ... (upload logic same as before)
    Ok(())
}

async fn refresh_job() -> Result<(), String> {
    // Poll server for job status (same as before)
    Ok(())
}

fn update_overlay(webview: &WebView, active_view: &str) -> Result<(), String> {
    let sources = read_pending_images().unwrap_or_default();
    let payload = serde_json::to_string(&sources).map_err(|e| e.to_string())?;
    let state = overlay_state(active_view);
    webview
        .evaluate_script(&format!(
            "window.updatePreviews({payload});window.updateOverlayState({state});"
        ))
        .map_err(|e| format!("Could not update ghost overlay: {e}"))
}

fn read_pending_images() -> Result<Vec<String>, String> {
    let pending_path = support_root_dir()?.join("cache/pending-batch.json");
    if !pending_path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&pending_path).map_err(|e| e.to_string())?;
    let batch: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(batch["images"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|image| image.get("localPath").and_then(Value::as_str))
        .filter_map(|path| fs::read(path).ok())
        .map(|bytes| {
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        })
        .collect())
}

fn overlay_state(active_view: &str) -> String {
    if active_view == "mcq" {
        return serde_json::json!({
            "kind": "mcq",
            "phase": "idle",
            "status": "idle",
            "progress": "MCQ overlay ready. Start a batch, capture screenshots, then submit.",
            "history": [],
            "mcq": {
                "question": "",
                "options": [],
                "answer": { "label": "", "text": "" },
                "reason": "MCQ overlay ready. Start a batch, capture screenshots, then submit.",
                "whyNot": [],
                "knowledgeUsed": false,
                "model": "none",
            },
        })
        .to_string();
    }
    r#"{"phase":"idle","agents":[],"solution":null,"tests":[]}"#.to_string()
}

fn overlay_html() -> &'static str {
    r#"<!doctype html><html><head><meta charset="utf-8"><style>
      :root{color-scheme:dark;--text:rgba(255,255,255,.98);--muted:rgba(255,255,255,.78);--panel-line:rgba(255,255,255,.18);--panel-a:rgba(255,255,255,.105);--panel-b:rgba(255,255,255,.03);--panel-base:rgba(10,16,24,.13);--panel-shadow:rgba(0,0,0,.16);--pane-line:rgba(255,255,255,.28);--title-shadow:rgba(0,0,0,.24);--dash-line:rgba(255,255,255,.52);--soft-fill:rgba(255,255,255,.085);--chip-fill:rgba(255,255,255,.05);--box-fill:rgba(255,255,255,.045);--editor-bg:rgba(2,7,13,.68);--tests-bg:rgba(2,7,13,.42);--code-text:#e6f1ff;--kw:#ff7b72;--fn:#d2a8ff;--arg:#ffa657;--num:#79c0ff;--str:#a5d6ff;--built:#7ee787;--op:#ffdf5d;--cm:#8b949e}
      @media (prefers-color-scheme:light){:root{color-scheme:light;--text:rgba(18,24,33,.96);--muted:rgba(42,52,66,.78);--panel-line:rgba(20,30,42,.18);--panel-a:rgba(255,255,255,.46);--panel-b:rgba(255,255,255,.22);--panel-base:rgba(235,241,248,.36);--panel-shadow:rgba(12,20,28,.12);--pane-line:rgba(20,30,42,.2);--title-shadow:rgba(255,255,255,.48);--dash-line:rgba(20,30,42,.38);--soft-fill:rgba(255,255,255,.38);--chip-fill:rgba(255,255,255,.3);--box-fill:rgba(255,255,255,.32);--editor-bg:rgba(4,10,18,.74);--tests-bg:rgba(4,10,18,.55);--code-text:#eef6ff}}
      html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
	      body{box-sizing:border-box;padding:16px 22px 22px;color:var(--text);font:600 14px -apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column;align-items:center;gap:14px}
		      .hudbar{box-sizing:border-box;display:flex;align-items:center;gap:10px;max-width:1180px;min-height:42px;padding:6px 12px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:linear-gradient(180deg,rgba(255,255,255,.13),rgba(255,255,255,.045)),rgba(18,19,18,.58);box-shadow:0 14px 36px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.18);backdrop-filter:blur(18px) saturate(1.25);white-space:nowrap;color:rgba(255,255,255,.84);font-size:11px;font-weight:800}
		      .hud-logo{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#f5d83b;color:#24210a;font-size:10px;font-weight:900;box-shadow:0 0 0 2px rgba(255,226,69,.28),0 0 24px rgba(245,216,59,.32);flex:0 0 32px}
		      .hud-key,.hud-pause{display:grid;place-items:center;min-width:32px;height:28px;padding:0 10px;border-radius:8px;background:rgba(255,255,255,.13);box-shadow:inset 0 1px 0 rgba(255,255,255,.08);color:rgba(255,255,255,.9);flex:0 0 auto}
		      .hud-action{color:rgba(255,255,255,.68);margin-left:4px}
	      .hud-meter{display:inline-flex;align-items:end;gap:2px;height:18px;padding:0 2px}.hud-meter i{display:block;width:3px;border-radius:3px;background:#f5d83b;box-shadow:0 0 9px rgba(245,216,59,.34)}.hud-meter i:nth-child(1){height:7px}.hud-meter i:nth-child(2){height:12px}.hud-meter i:nth-child(3){height:9px}
	      #panel{box-sizing:border-box;width:100%;flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;border:2px solid rgba(245,216,59,.72);border-radius:18px;background:radial-gradient(circle at 50% 18%,rgba(245,216,59,.16),transparent 28%),linear-gradient(135deg,var(--panel-a),var(--panel-b)),var(--panel-base);box-shadow:0 0 0 1px rgba(245,216,59,.18),inset 0 1px 0 rgba(255,255,255,.22),0 18px 48px var(--panel-shadow);backdrop-filter:blur(20px) saturate(1.22);overflow:hidden}
            .pane{min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:18px;overflow:hidden}.pane+ .pane{border-left:1px solid var(--pane-line)}
            .pictures-pane{align-items:flex-start}
            .title{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.95;text-shadow:0 1px 2px var(--title-shadow)}
	            .picture-list{box-sizing:border-box;width:100%;min-height:48px;display:flex;flex-direction:row;align-items:center;gap:5px;padding:5px;border:1.5px dashed var(--dash-line);border-radius:10px;background:var(--soft-fill);overflow-x:auto;overflow-y:hidden}
            .picture-pill{position:relative;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
            .picture-count{position:absolute;right:4px;bottom:4px;padding:2px 5px;border-radius:5px;background:rgba(0,0,0,.58);color:rgba(255,255,255,.95);font-size:10px;font-weight:700;line-height:1}
	            img{display:block;width:44px;height:33px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,.36)}
            .divider{width:100%;height:1px;margin:8px 0 2px;background:var(--pane-line)}
            .solution-status{box-sizing:border-box;width:100%;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px}
            .model-chip{display:grid;grid-template-columns:7px minmax(0,1fr);grid-template-rows:auto auto;align-items:center;column-gap:5px;row-gap:1px;min-width:0;padding:5px 6px;border:1px solid var(--panel-line);border-radius:7px;background:var(--chip-fill);font-size:9px;color:var(--muted)}
            .model-chip b{min-width:0;font-size:10px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .model-chip span:last-child{grid-column:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.36);box-shadow:0 0 0 2px rgba(255,255,255,.08);flex:0 0 auto}
            .model-chip[data-state="done"] .dot{background:#39d98a;box-shadow:0 0 0 3px rgba(57,217,138,.16)}
            .model-chip[data-state="working"] .dot{background:#ffd166;box-shadow:0 0 0 3px rgba(255,209,102,.16)}
            .model-chip[data-state="error"] .dot{background:#ff6b6b;box-shadow:0 0 0 3px rgba(255,107,107,.16)}
            .model-chip[data-state="cancelled"] .dot{background:rgba(255,255,255,.22);box-shadow:0 0 0 3px rgba(255,255,255,.08)}
            .model-chip[data-state="pending"] .dot{background:rgba(255,255,255,.38)}
	            .solution-editor{box-sizing:border-box;width:100%;flex:1 1 auto;min-height:650px;display:flex;flex-direction:column;border:1px solid var(--panel-line);border-radius:9px;background:var(--editor-bg);overflow:hidden}
            .editor-head,.tests-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.76);font-size:11px}
            .editor-head b,.tests-head b{color:rgba(255,255,255,.95)}
	            .code-lines{flex:1;margin:0;padding:13px 0;color:var(--code-text);font:500 12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:auto;counter-reset:code-line}
	            .code-lines li{display:grid;grid-template-columns:42px minmax(0,1fr);min-height:20px;padding:0 14px 0 0;list-style:none;counter-increment:code-line}
	            .code-lines li:before{content:counter(code-line);padding-right:12px;text-align:right;color:rgba(255,255,255,.3)}
	            .code-lines code{display:block;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
            .kw{color:var(--kw)}.fn{color:var(--fn)}.arg{color:var(--arg)}.num{color:var(--num)}.str{color:var(--str)}.built{color:var(--built)}.op{color:var(--op)}.cm{color:var(--cm)}
	            .tests{box-sizing:border-box;width:100%;max-height:86px;border:1px solid var(--panel-line);border-radius:9px;background:var(--tests-bg);overflow:hidden}
	            .case-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:7px}
	            .case{min-width:0;padding:5px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(255,255,255,.045);font-size:10px;color:rgba(255,255,255,.82)}
            .case b{display:block;margin-bottom:4px;color:rgba(255,255,255,.95)}
            .case code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d5f5ff}
	            .thought-pane{gap:10px}
	            .thought-list{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:8px;overflow:hidden}
            .thought-item{width:100%;display:flex;flex-direction:column;gap:5px}
            .thought-heading{font-size:12px;font-weight:700;color:var(--text);text-shadow:0 1px 2px var(--title-shadow)}
	            .thought-space{box-sizing:border-box;width:100%;height:62px;border:1px solid var(--panel-line);border-radius:7px;background:var(--box-fill);overflow:hidden}
	            .function-notes{height:96px;padding:8px 10px;color:var(--muted);font-size:11px;line-height:1.35}
	            .function-notes div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
              .mcq-box{box-sizing:border-box;width:100%;border:1px solid var(--panel-line);border-radius:9px;background:var(--editor-bg);padding:12px;color:var(--text);line-height:1.45;overflow:auto}
              .mcq-question{min-height:150px;max-height:270px;font-size:15px}
              .mcq-answer{min-height:180px;font-size:16px}
              .mcq-answer b{color:#ffdf5d}
              .mcq-options{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:8px;overflow:auto}
              .mcq-option{padding:10px;border:1px solid var(--panel-line);border-radius:9px;background:var(--box-fill);font-size:13px;line-height:1.35}
              .mcq-option[data-picked="true"]{border-color:rgba(245,216,59,.72);background:rgba(245,216,59,.12)}
              .mcq-reason{min-height:220px;font-size:13px}
              .mcq-history{box-sizing:border-box;width:100%;flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;overflow:auto}
              .mcq-history-row{padding:10px;border:1px solid var(--panel-line);border-radius:9px;background:var(--box-fill);font-size:12px;line-height:1.35;color:var(--muted)}
              .mcq-history-row b{display:block;margin-bottom:3px;color:var(--text);font-size:12px}
	              .mcq-history-row[data-level="error"]{border-color:rgba(255,107,107,.58);background:rgba(255,107,107,.1)}
	              .mcq-history-row[data-level="warn"]{border-color:rgba(255,209,102,.46);background:rgba(255,209,102,.09)}
	              .mcq-history-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;color:rgba(255,255,255,.58);font-size:10px}
	              .title-row{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px}
	              .mcq-model-pill{display:inline-flex;align-items:center;gap:7px;max-width:58%;padding:7px 10px;border:1px solid rgba(57,217,138,.42);border-radius:999px;background:rgba(57,217,138,.1);color:rgba(255,255,255,.9);font-size:11px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	              .mcq-model-pill::before{content:"";width:8px;height:8px;border-radius:50%;background:#39d98a;box-shadow:0 0 10px rgba(57,217,138,.86),0 0 0 3px rgba(57,217,138,.16);flex:0 0 auto}
	              .mcq-model-pill[data-enabled="false"]{border-color:rgba(255,107,107,.48);background:rgba(255,107,107,.1)}
	              .mcq-model-pill[data-enabled="false"]::before{background:#ff6b6b;box-shadow:0 0 10px rgba(255,107,107,.82),0 0 0 3px rgba(255,107,107,.16)}
		      .empty{opacity:.72;font-size:12px;font-weight:600;padding:4px;white-space:nowrap;text-shadow:0 1px 2px var(--title-shadow)}
	        </style></head><body><div class="hudbar"><span class="hud-logo">CA</span><span class="hud-pause">||</span><span class="hud-meter"><i></i><i></i><i></i></span><span class="hud-action">Start</span><span class="hud-key">⌃⌥ B</span><span class="hud-action">Capture</span><span class="hud-key">⌃⌥ P</span><span class="hud-action">Submit</span><span class="hud-key">⌃⌥ ↵</span><span class="hud-action">Coding</span><span class="hud-key">⌃⌥ C</span><span class="hud-action">MCQ</span><span class="hud-key">⌃⌥ M</span></div><div id="panel"><div class="pane pictures-pane"><div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title">Solution</div><div class="solution-status" id="agents"></div><div class="solution-editor"><div class="editor-head"><b id="solution-title">solution</b><span id="solution-source">waiting</span></div><ol class="code-lines" id="solution-code"></ol></div><div class="tests"><div class="tests-head"><b>Test cases</b><span id="tests-count">real data</span></div><div class="case-list" id="tests"></div></div></div><div class="pane thought-pane"><div class="title">Thought process</div><div class="thought-list"><div class="thought-item"><div class="thought-heading">Approach/algorithm</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Functions</div><div class="thought-space function-notes" id="function-notes"></div></div><div class="thought-item"><div class="thought-heading">Data structures</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Time complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Space complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Edge cases</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Testing</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Trade-offs</div><div class="thought-space"></div></div></div></div></div><script>
	            const esc=(s)=>String(s||'').replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
	            window.scrollSolutionBy=function(delta){const el=document.getElementById('solution-code');if(el)el.scrollTop+=delta;};
            function highlight(code,lang){let h=esc(code);if(/py|python/i.test(lang||'')){h=h.replace(/([=+\-*\/])/g,'<span class="op">$1</span>').replace(/\b(\d+)\b/g,'<span class="num">$1</span>').replace(/\b(def|for|in|if|return|class|else|elif|while|try|except|with|as|from|import)\b/g,'<span class="kw">$1</span>').replace(/\b(enumerate|range|len|print|set|dict|list)\b/g,'<span class="built">$1</span>');}return h;}
		            function stateTone(status){if(status==='done')return'done';if(status==='streaming'||status==='reviewing'||status==='running')return'working';if(status==='error')return'error';if(status==='cancelled')return'cancelled';return'pending';}
		            function codeWithReferenceComment(code,lang){const text=String(code||'');const t=text.trimStart();if(t.startsWith('#')||t.startsWith('//')||t.startsWith('/*'))return text;const mark=/js|ts|java|c|swift|go|rust/i.test(lang||'')?'//':'#';return mark+' Reference: solution displayed in the capture overlay\n'+text;}
		            function renderCodeLines(target,code,lang){target.innerHTML='';codeWithReferenceComment(code,lang).split('\n').forEach((line)=>{const li=document.createElement('li');const c=document.createElement('code');c.innerHTML=highlight(line||' ',lang);li.appendChild(c);target.appendChild(li);});}
		            function detectedFunctionNames(code){const found=[];String(code||'').replace(/\b([A-Za-z_]\w*)\s*\(/g,(_,name)=>{if(!found.includes(name)&&!['if','for','while','switch','return','def','function'].includes(name))found.push(name);return _;});return found;}
		            function renderFunctionNotes(code){const target=document.getElementById('function-notes');if(!target)return;const meanings={set:'stores unique values for quick membership checks',sum:'adds numeric values together',max:'returns the largest value',min:'returns the smallest value',len:'counts items',range:'creates a numeric loop sequence',enumerate:'loops with index and value',append:'adds an item to a list',sort:'orders a list in place',sorted:'returns ordered values',print:'writes debug output',useState:'stores React component state',useEffect:'runs React side effects',fetch:'requests network data',map:'transforms each item',filter:'keeps matching items',reduce:'combines items into one result'};const found=detectedFunctionNames(code);target.innerHTML='';found.slice(0,5).forEach((name)=>{const row=document.createElement('div');row.textContent=name+': '+(meanings[name]||'function call used by the solution');target.appendChild(row);});if(!target.children.length){const row=document.createElement('div');row.textContent='No function calls detected yet.';target.appendChild(row);}}
		            function functionExample(name){const examples={sum:'sum([18, 9]) -> 27',set:'set([18, 9, 18]) -> {18, 9}',max:'max([18, 9]) -> 18',min:'min([18, 9]) -> 9',len:'len([18, 9]) -> 2',range:'range(0, 5) -> 0..4',enumerate:'enumerate(items) -> index + value',append:'outliers.append(18) -> adds 18',sort:'values.sort() -> in-place order',sorted:'sorted(values) -> ordered copy',print:'print(result) -> console output',useState:'useState(false) -> state + setter',useEffect:'useEffect(fn, []) -> run side effect',fetch:'fetch(url) -> request data',map:'items.map(fn) -> transformed items',filter:'items.filter(fn) -> matching items',reduce:'items.reduce(fn, seed) -> one value'};return examples[name]||name+'(exampleInput) -> expected output';}
		            function renderSmartTests(target,count,code,stateTests){const names=detectedFunctionNames(code).filter((name)=>!/^greatest|^solve|^main$/i.test(name));target.innerHTML='';const picked=names.length?names.slice(0,4):(stateTests||[]).map((t)=>t.name||'solution').slice(0,4);count.textContent=picked.length?picked.length+' function':'none yet';if(!picked.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No callable functions detected yet';target.appendChild(empty);return;}picked.forEach((fn)=>{const card=document.createElement('div');card.className='case';const name=document.createElement('b');name.textContent=fn;const body=document.createElement('code');body.textContent=functionExample(fn);card.appendChild(name);card.appendChild(body);target.appendChild(card);});}
            window.updatePreviews=function(images){window.__lastPreviews=images||[];const pictures=document.getElementById('pictures');if(!pictures)return;pictures.innerHTML='';if(!images.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Captured images will appear here';pictures.appendChild(empty);return;}images.forEach((src,i)=>{const pill=document.createElement('div');pill.className='picture-pill';const img=document.createElement('img');img.src=src;img.alt='Capture '+(i+1);const count=document.createElement('span');count.className='picture-count';count.textContent=(i+1)+'/10';pill.appendChild(img);pill.appendChild(count);pictures.appendChild(pill);});};
                function renderMcq(state){const left=document.querySelector('.pictures-pane');const right=document.querySelector('.thought-pane');const m=state.mcq||{};const picked=(m.answer&&m.answer.label)||'';const selectedModel=(m.model&&String(m.model).trim())?String(m.model).trim():'none';const hasModel=selectedModel.toLowerCase()!=='none';left.innerHTML='<div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title-row"><div class="title">Question</div><div class="mcq-model-pill" data-enabled="'+(hasModel?'true':'false')+'">'+esc(hasModel?selectedModel:'No Model')+'</div></div><div class="mcq-box mcq-question"></div><div class="title">Answer</div><div class="mcq-box mcq-answer"></div>';right.innerHTML='<div class="title">Question history</div><div class="mcq-history"></div>';document.querySelector('.mcq-question').textContent=m.question||state.progress||'Reading the captured question...';document.querySelector('.mcq-answer').innerHTML='<b>'+esc(picked||'Answer')+'</b>'+(m.answer&&m.answer.text?' — '+esc(m.answer.text):'')+'<br><br>'+esc(m.reason||state.error||state.progress||'Waiting for the MCQ worker result...');const hist=document.querySelector('.mcq-history');const add=(title,body,level,meta)=>{const row=document.createElement('div');row.className='mcq-history-row';row.dataset.level=level||'info';const h=document.createElement('b');h.textContent=title;const p=document.createElement('div');p.textContent=body||'';row.appendChild(h);row.appendChild(p);if(meta&&meta.length){const mrow=document.createElement('div');mrow.className='mcq-history-meta';meta.forEach((x)=>{const s=document.createElement('span');s.textContent=x;mrow.appendChild(s);});row.appendChild(mrow);}hist.appendChild(row);};add('AI selected',selectedModel,'info',[state.status||'',state.phase||''].filter(Boolean));add('Captured question',m.question||'Waiting for the screenshot reading.',state.error?'error':'info',[state.status||'',state.phase||''].filter(Boolean));if(m.options&&m.options.length){add('Choices found',(m.options||[]).map((o)=>(o.label?o.label+'. ':'')+(o.text||'')).join('\\n'),'info',[]);}if(m.knowledgeUsed!==undefined){add('Local knowledge check',m.knowledgeUsed?'A local knowledge match or guidance was included before the model answer.':'The local knowledge pack was checked before the model answer, but no direct match was used.','info',[selectedModel]);}if(picked||m.reason){add('Selected answer',(picked?picked+': ':'')+(m.answer&&m.answer.text?m.answer.text:'')+'\\n'+(m.reason||''),'info',[selectedModel]);}(m.whyNot||[]).forEach((x)=>add('Rejected choice '+(x.label||''),x.reason||'Not selected.','info',[]));(state.history||[]).forEach((e)=>add(e.phase||'worker event',e.message||'',e.level||'info',[e.createdAt||''].filter(Boolean)));if(!hist.children.length)add('Waiting','The helper is waiting for the worker history.','info',[]);window.updatePreviews(window.__lastPreviews||[]);}
			            function restoreCodingShell(){if(document.getElementById('agents'))return;document.getElementById('panel').innerHTML='<div class="pane pictures-pane"><div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title">Solution</div><div class="solution-status" id="agents"></div><div class="solution-editor"><div class="editor-head"><b id="solution-title">solution</b><span id="solution-source">waiting</span></div><ol class="code-lines" id="solution-code"></ol></div><div class="tests"><div class="tests-head"><b>Test cases</b><span id="tests-count">real data</span></div><div class="case-list" id="tests"></div></div></div><div class="pane thought-pane"><div class="title">Thought process</div><div class="thought-list"><div class="thought-item"><div class="thought-heading">Approach/algorithm</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Functions</div><div class="thought-space function-notes" id="function-notes"></div></div><div class="thought-item"><div class="thought-heading">Data structures</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Time complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Space complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Edge cases</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Testing</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Trade-offs</div><div class="thought-space"></div></div></div></div>';window.updatePreviews(window.__lastPreviews||[]);}
			            window.updateOverlayState=function(state){state=state||{agents:[],tests:[],solution:null,phase:'idle'};if(state.kind==='mcq'||state.mcq){renderMcq(state);return;}restoreCodingShell();const agents=document.getElementById('agents');agents.innerHTML='';if(!state.agents||!state.agents.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No active model run';agents.appendChild(empty);}else{state.agents.slice(0,5).forEach((a)=>{const chip=document.createElement('div');chip.className='model-chip';chip.dataset.state=stateTone(a.status);const dot=document.createElement('span');dot.className='dot';const name=document.createElement('b');name.textContent=a.label||a.id;const status=document.createElement('span');status.textContent=a.status==='error'?(a.error||'error'):a.status;chip.title=[a.model,a.error].filter(Boolean).join(' — ');chip.appendChild(dot);chip.appendChild(name);chip.appendChild(status);agents.appendChild(chip);});}const title=document.getElementById('solution-title');const source=document.getElementById('solution-source');const code=document.getElementById('solution-code');const tests=document.getElementById('tests');const count=document.getElementById('tests-count');if(state.solution&&state.solution.code){title.textContent=state.solution.title||'solution';source.textContent=state.solution.status==='reviewed'?'reviewed':('candidate · '+(state.solution.source||''));renderCodeLines(code,state.solution.code,state.solution.language);renderFunctionNotes(state.solution.code);renderSmartTests(tests,count,state.solution.code,state.tests);}else{title.textContent='solution';source.textContent=state.phase==='idle'?'idle':'waiting';const waiting=state.phase==='idle'?'No run yet.':'Waiting for solution...';renderCodeLines(code,waiting,'');renderFunctionNotes(waiting);renderSmartTests(tests,count,waiting,state.tests);}};
    </script></body></html>"#
}
