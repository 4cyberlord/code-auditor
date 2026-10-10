// src-tauri/src/bin/mds.rs
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::net::UnixStream,
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

const SERVICE: &str = "com.apple.mds.session";
const HELPER_TOKEN: &str = "mds";
const SETTINGS_KEY: &str = "app.v1";
const BUCKET: &str = "screenshots";
const MAX_IMAGES: usize = 10;
const OVERLAY_WIDTH: f64 = 1320.0;
const OVERLAY_HEIGHT: f64 = 950.0;
const INSTANCE_LOCK: &str = ".mds_daemon.lock";
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
    const HID_USAGE_KEYBOARD_L: u32 = 0x0F;
    const HID_USAGE_KEYBOARD_P: u32 = 0x13;
    const HID_USAGE_KEYBOARD_R: u32 = 0x15;
    const HID_USAGE_KEYBOARD_S: u32 = 0x16;
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
    pub static CAPTURE_REGION: AtomicBool = AtomicBool::new(false);
    pub static CAPTURE_LEFT: AtomicBool = AtomicBool::new(false);
    pub static CAPTURE_RIGHT: AtomicBool = AtomicBool::new(false);
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
            HID_USAGE_KEYBOARD_L | HID_USAGE_KEYBOARD_R
                if pressed && CONTROL_DOWN.load(Ordering::SeqCst)
                    && OPTION_DOWN.load(Ordering::SeqCst)
                    && SHIFT_DOWN.load(Ordering::SeqCst) => {
                match usage {
                    HID_USAGE_KEYBOARD_L => CAPTURE_LEFT.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_R => CAPTURE_RIGHT.store(true, Ordering::SeqCst),
                    _ => {}
                }
            }
            HID_USAGE_KEYBOARD_B
            | HID_USAGE_KEYBOARD_C
            | HID_USAGE_KEYBOARD_M
            | HID_USAGE_KEYBOARD_P
            | HID_USAGE_KEYBOARD_R
            | HID_USAGE_KEYBOARD_S
            | HID_USAGE_KEYBOARD_RETURN
                if pressed
                    && CONTROL_DOWN.load(Ordering::SeqCst)
                    && OPTION_DOWN.load(Ordering::SeqCst) =>
            {
                match usage {
                    HID_USAGE_KEYBOARD_B => START_BATCH.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_C => TOGGLE_OVERLAY.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_M => SWITCH_MCQ.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_P | HID_USAGE_KEYBOARD_S => CAPTURE.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_R => CAPTURE_REGION.store(true, Ordering::SeqCst),
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
    pub fn take_capture_region() -> bool {
        CAPTURE_REGION.swap(false, Ordering::SeqCst)
    }
    pub fn take_capture_left() -> bool {
        CAPTURE_LEFT.swap(false, Ordering::SeqCst)
    }
    pub fn take_capture_right() -> bool {
        CAPTURE_RIGHT.swap(false, Ordering::SeqCst)
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

async fn space_api_calls() {
    let delay_ms = 300 + rand::random::<u64>() % 500;
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PendingImage {
    position: usize,
    local_path: String,
    file_name: String,
    bytes: i64,
    mime: String,
    captured_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PendingBatch {
    id: String,
    status: String,
    started_at: String,
    #[serde(default)]
    images: Vec<PendingImage>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SubmittedJob {
    id: String,
    mode: String,
    #[serde(default)]
    mcq_model: Option<String>,
    status: String,
    #[serde(default)]
    progress_phase: String,
    submitted_at: String,
    #[serde(default)]
    previews: Vec<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    report: Option<Value>,
    #[serde(default)]
    events: Vec<Value>,
}

async fn api(op: &str, args: Value) -> Result<Value, String> {
    let token = read_keychain(HELPER_TOKEN).map_err(|_| {
        "The background worker is not authorised. Authorise it in the main application.".to_string()
    })?;

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(HELPER_USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?
        .post(council_editor_lib::deployment::api_url())
        .header("apikey", council_editor_lib::deployment::publishable_key())
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({ "op": op, "args": args }))
        .send()
        .await
        .map_err(|e| format!("Could not reach the server API: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&body).map_err(|_| {
        format!(
            "The server API answered {} with something that was not JSON.",
            status.as_u16()
        )
    })?;

    if !status.is_success() || parsed["ok"] == Value::Bool(false) {
        if status.as_u16() == 401 {
            return Err("The background authorisation has expired. Authorise it again.".into());
        }
        return Err(parsed["error"]
            .as_str()
            .unwrap_or("The server API refused that.")
            .to_string());
    }

    Ok(parsed["data"].clone())
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

fn main() {
    if let Err(e) = run() {
        if !e.contains("Another ghost instance is already running") {
            write_helper_status(false, Some(&format!("Startup failed: {e}")));
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
                "Hotkeys are unavailable: {error}. Grant Input Monitoring permission for the helper in macOS System Settings, then reinstall or restart the helper."
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
                if let Err(e) = start_batch() {
                    eprintln!("start batch failed: {e}");
                }
                let _ = update_overlay(&webview, &active_view);
            }
            let full_capture = mac_shortcuts::take_capture();
            let region_capture = mac_shortcuts::take_capture_region();
            let left_capture = mac_shortcuts::take_capture_left();
            let right_capture = mac_shortcuts::take_capture_right();
            if full_capture || region_capture || left_capture || right_capture {
                let restore = overlay_visible;
                if overlay_visible {
                    overlay_visible = false;
                    let _ = show_overlay(&overlay, false);
                }
                event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                let capture_mode = if full_capture { CaptureMode::Full }
                    else if left_capture { CaptureMode::Left }
                    else if right_capture { CaptureMode::Right }
                    else if region_capture { CaptureMode::Region }
                    else { CaptureMode::Full };
                let result = capture_screen(capture_mode);
                overlay_visible = restore;
                event_loop_target.set_activation_policy_at_runtime(if overlay_visible {
                    ActivationPolicy::Accessory
                } else {
                    ActivationPolicy::Prohibited
                });
                let _ = show_overlay(&overlay, overlay_visible);
                if let Err(e) = result {
                    eprintln!("capture failed: {e}");
                }
                let _ = update_overlay(&webview, &active_view);
            }
            if mac_shortcuts::take_submit() {
                if let Err(e) = rt.block_on(submit_batch(&active_view)) {
                    eprintln!("submit failed: {e}");
                    let _ = update_pending_error(&e);
                }
                let _ = update_overlay(&webview, &active_view);
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

// ─── CAPTURE / SUBMIT ────────────────────────────────────────────────────────

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn cache_dir() -> Result<PathBuf, String> {
    Ok(support_root_dir()?.join("cache"))
}

fn log_dir() -> Result<PathBuf, String> {
    Ok(support_root_dir()?.join("logs"))
}

fn pending_path() -> Result<PathBuf, String> {
    Ok(cache_dir()?.join("pending-batch.json"))
}

fn submitted_job_path() -> Result<PathBuf, String> {
    Ok(cache_dir()?.join("submitted-job.json"))
}

fn captures_dir(batch_id: &str) -> Result<PathBuf, String> {
    Ok(cache_dir()?.join("captures").join(batch_id))
}

fn write_private(path: &std::path::Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn log(message: &str) {
    let stamped = format!("{} {message}\n", now());
    if let Ok(dir) = log_dir() {
        let _ = fs::create_dir_all(&dir);
        let path = dir.join(".state");
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let lines: Vec<&str> = existing.lines().chain(stamped.lines()).collect();
        let start = lines.len().saturating_sub(80);
        let bounded = format!("{}\n", lines[start..].join("\n"));
        let _ = write_private(&path, bounded);
    }
}

fn save_pending(batch: &PendingBatch) -> Result<(), String> {
    let path = pending_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create helper state directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(batch).map_err(|e| e.to_string())?;
    write_private(&path, json).map_err(|e| format!("Could not save helper batch: {e}"))
}

fn read_pending() -> Result<Option<PendingBatch>, String> {
    let path = pending_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Could not read helper batch: {e}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("Could not parse helper batch: {e}"))
}

fn save_submitted_job(job: &SubmittedJob) -> Result<(), String> {
    let path = submitted_job_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create helper state directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(job).map_err(|e| e.to_string())?;
    write_private(&path, json).map_err(|e| format!("Could not save submitted job: {e}"))
}

fn read_submitted_job() -> Result<Option<SubmittedJob>, String> {
    let path = submitted_job_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Could not read submitted job: {e}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("Could not parse submitted job: {e}"))
}

fn clear_submitted_job() -> Result<(), String> {
    let path = submitted_job_path()?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Could not clear submitted job: {e}"))?;
    }
    Ok(())
}

fn update_pending_error(message: &str) -> Result<(), String> {
    if let Some(mut batch) = read_pending()? {
        batch.error = Some(message.to_string());
        save_pending(&batch)?;
    }
    Ok(())
}

fn start_batch() -> Result<(), String> {
    let id = format!("batch-{}", Uuid::new_v4());
    clear_submitted_job()?;
    let batch = PendingBatch {
        id: id.clone(),
        status: "collecting".to_string(),
        started_at: now(),
        images: vec![],
        error: None,
    };
    fs::create_dir_all(captures_dir(&id)?)
        .map_err(|e| format!("Could not create capture directory: {e}"))?;
    save_pending(&batch)?;
    log(&format!("started {id}"));
    Ok(())
}

#[derive(Clone, Copy)]
enum CaptureMode { Full, Region, Left, Right }

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CapturePoint { x: f64, y: f64 }
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CaptureSize { width: f64, height: f64 }
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CaptureRect { origin: CapturePoint, size: CaptureSize }
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CaptureRect;
}

fn capture_screen(mode: CaptureMode) -> Result<(), String> {
    // A screenshot shortcut must work even when the main app is closed and the
    // user has not explicitly started a batch. Reuse a pending batch for
    // successive screenshots instead of silently replacing earlier captures.
    if read_pending()?.is_none() {
        start_batch()?;
    }
    let mut batch = read_pending()?.ok_or("Could not initialize screenshot batch.".to_string())?;
    if batch.images.len() >= MAX_IMAGES {
        batch.status = "ready".to_string();
        batch.error = Some(format!("A helper batch can hold {MAX_IMAGES} screenshots."));
        save_pending(&batch)?;
        return Err(format!("A helper batch can hold {MAX_IMAGES} screenshots."));
    }

    let dir = captures_dir(&batch.id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create capture directory: {e}"))?;
    let position = batch.images.len();
    let file_name = format!(
        "{position}-{}.png",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    let path = dir.join(&file_name);

    let mut command = Command::new("/usr/sbin/screencapture");
    command.arg("-x");
    match mode {
        CaptureMode::Region => { command.arg("-i"); }
        CaptureMode::Left | CaptureMode::Right => {
            #[cfg(target_os = "macos")]
            {
                let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
                let x = bounds.origin.x.round() as i64;
                let y = bounds.origin.y.round() as i64;
                let width = bounds.size.width.round() as i64;
                let height = bounds.size.height.round() as i64;
                if width < 2 || height < 1 {
                    return Err("Could not determine display bounds for half-screen capture.".into());
                }
                let left_width = width / 2;
                let (start, part_width) = match mode {
                    CaptureMode::Left => (x, left_width),
                    _ => (x + left_width, width - left_width),
                };
                command.arg("-R").arg(format!("{start},{y},{part_width},{height}"));
            }
        }
        CaptureMode::Full => {}
    }
    let out = command.arg(&path).output()
        .map_err(|e| format!("Screen capture could not be started: {e}"))?;
    if matches!(mode, CaptureMode::Region) && !path.exists() {
        // Escape cancels region selection without corrupting the pending batch.
        return Ok(());
    }
    if !out.status.success() {
        let _ = fs::remove_file(&path);
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            "Screen capture failed. Check Screen Recording permission.".into()
        } else {
            format!("Screen capture failed: {stderr}")
        };
        batch.error = Some(msg.clone());
        save_pending(&batch)?;
        return Err(msg);
    }

    let bytes = fs::metadata(&path)
        .map_err(|e| format!("Could not inspect captured screenshot: {e}"))?
        .len() as i64;
    if bytes <= 0 {
        batch.error = Some("Captured screenshot was empty.".to_string());
        save_pending(&batch)?;
        return Err("Captured screenshot was empty.".to_string());
    }
    batch.images.push(PendingImage {
        position,
        local_path: path.to_string_lossy().to_string(),
        file_name,
        bytes,
        mime: "image/png".to_string(),
        captured_at: now(),
    });
    batch.status = "ready".to_string();
    batch.error = None;
    save_pending(&batch)?;
    log(&format!("captured image {} for {}", position + 1, batch.id));
    Ok(())
}

async fn submit_batch(active_view: &str) -> Result<(), String> {
    let batch = read_pending()?.ok_or("No helper batch is waiting to submit.".to_string())?;
    if batch.images.is_empty() {
        return Err("The helper batch has no screenshots.".to_string());
    }
    let user_settings = api("settings.load", serde_json::json!({ "key": SETTINGS_KEY }))
        .await
        .unwrap_or_else(|e| {
            log(&format!("Settings could not be loaded: {e}"));
            Value::Null
        });
    let user_settings = sanitize_settings(if user_settings.is_null() {
        Value::Object(Default::default())
    } else {
        user_settings
    });
    space_api_calls().await;

    let session_title = format!(
        "Background capture batch {}",
        chrono::Utc::now().format("%Y-%m-%d %H:%M UTC")
    );
    let session = api(
        "sessions.create",
        serde_json::json!({ "title": session_title }),
    )
    .await?;
    space_api_calls().await;
    let session_id = session["id"]
        .as_str()
        .ok_or("The server did not return a session id.")?
        .to_string();

    let owner = api("auth.whoami", serde_json::json!({})).await?;
    space_api_calls().await;
    let owner_id = owner["userId"]
        .as_str()
        .ok_or("The server did not say who the helper is.")?
        .to_string();

    // The pane being viewed is not the classification of the screenshots.
    // Keep auto mode in the cloud Council pipeline so its vision reading can
    // distinguish a coding problem from MCQ before choosing a solver.
    let mode = match user_settings.get("overlayMode").and_then(Value::as_str) {
        Some("mcq") => "mcq".to_string(),
        Some("coding") | Some("auto") => "council".to_string(),
        _ => if active_view == "mcq" { "mcq".to_string() } else { "council".to_string() },
    };
    let mcq_model = if mode == "mcq" {
        user_settings
            .get("mcqModel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    let mut images = vec![];
    let mut previews = vec![];
    for image in &batch.images {
        let bytes = fs::read(&image.local_path)
            .map_err(|e| format!("Could not read {}: {e}", image.file_name))?;
        previews.push(format!(
            "data:{};base64,{}",
            if image.mime.is_empty() {
                "image/png"
            } else {
                &image.mime
            },
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ));
        let path = format!("{owner_id}/{session_id}/{}", safe_segment(&image.file_name));
        let signed = api(
            "storage.uploadUrl",
            serde_json::json!({ "path": path, "bucket": BUCKET }),
        )
        .await?;
        space_api_calls().await;
        let url = signed["url"]
            .as_str()
            .ok_or("The server did not return an upload URL.")?;

        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(HELPER_USER_AGENT)
            .build()
            .map_err(|e| e.to_string())?
            .put(url)
            .header(
                "Content-Type",
                if image.mime.is_empty() {
                    "image/png"
                } else {
                    &image.mime
                },
            )
            .body(bytes.clone())
            .send()
            .await
            .map_err(|e| format!("Could not upload {}: {e}", image.file_name))?;
        if !resp.status().is_success() {
            return Err(format!(
                "Could not upload {}: the storage service answered {}.",
                image.file_name,
                resp.status().as_u16()
            ));
        }

        images.push(serde_json::json!({
            "storageBucket": BUCKET,
            "storagePath": path,
            "fileName": image.file_name,
            "bytes": bytes.len() as i64,
            "mime": image.mime,
            "width": Value::Null,
            "height": Value::Null,
        }));
    }

    let job = api(
        "jobs.create",
        serde_json::json!({
            "sessionId": session_id,
            "mode": mode,
            "settingsSnapshot": user_settings,
            "images": images,
        }),
    )
    .await?;
    let job_id = job["id"].as_str().unwrap_or_default().to_string();
    if job_id.trim().is_empty() {
        return Err("Cloud job was not assigned an ID; screenshots retained for retry.".into());
    }
    save_submitted_job(&SubmittedJob {
        id: job_id.clone(),
        mode,
        mcq_model,
        status: "queued".to_string(),
        progress_phase: "queued".to_string(),
        submitted_at: now(),
        previews,
        error: None,
        report: None,
        events: vec![],
    })?;

    for image in &batch.images {
        let _ = fs::remove_file(&image.local_path);
    }
    let _ = fs::remove_file(pending_path()?);
    log(&format!("submitted {} as job {job_id}", batch.id));
    Ok(())
}

async fn refresh_job() -> Result<(), String> {
    let Some(mut tracked) = read_submitted_job()? else {
        return Ok(());
    };
    if tracked.id.trim().is_empty() {
        return Err("Submitted background job has no cloud ID.".into());
    }
    if matches!(
        tracked.status.as_str(),
        "completed" | "failed" | "needs_attention" | "cancelled"
    ) && (tracked.report.is_some() || tracked.status != "completed")
    {
        return Ok(());
    }

    let jobs = api("jobs.list", serde_json::json!({ "status": "all" })).await?;
    if let Some(job) = jobs.as_array().and_then(|items| {
        items
            .iter()
            .find(|job| job["id"].as_str() == Some(tracked.id.as_str()))
    }) {
        tracked.status = job["status"]
            .as_str()
            .unwrap_or(&tracked.status)
            .to_string();
        tracked.progress_phase = job["progressPhase"]
            .as_str()
            .unwrap_or(&tracked.progress_phase)
            .to_string();
        tracked.error = job["error"].as_str().map(|s| s.to_string());
    }
    space_api_calls().await;

    if let Ok(events) = api("jobs.events", serde_json::json!({ "jobId": tracked.id })).await {
        tracked.events = events.as_array().cloned().unwrap_or_default();
    }
    space_api_calls().await;

    if let Ok(report) = api("reports.get", serde_json::json!({ "jobId": tracked.id })).await {
        if !report.is_null() {
            // Auto-routed MCQs are submitted as Council jobs. Promote their
            // actual result kind before saving so the overlay picks the MCQ pane.
            let body = report.get("report").unwrap_or(&report);
            if body.get("kind").and_then(Value::as_str) == Some("mcq") {
                tracked.mode = "mcq".to_string();
                if let Some(model) = body.get("model").and_then(Value::as_str) {
                    tracked.mcq_model = Some(model.to_string());
                }
            }
            tracked.report = Some(report);
            // A report may be partial or accompany a failed job. Trust the job status.
            if tracked.status == "completed" {
                tracked.progress_phase = "completed".to_string();
            }
        }
    }
    save_submitted_job(&tracked)
}

fn update_overlay(webview: &WebView, active_view: &str) -> Result<(), String> {
    let sources: Vec<String> = if let Some(batch) = read_pending()? {
        batch
            .images
            .iter()
            .filter_map(|image| fs::read(&image.local_path).ok())
            .map(|bytes| {
                format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            })
            .collect()
    } else {
        read_submitted_job()?
            .map(|job| job.previews)
            .unwrap_or_default()
    };
    let payload = serde_json::to_string(&sources).map_err(|e| e.to_string())?;
    let state = read_overlay_state(active_view);
    webview
        .evaluate_script(&format!(
            "window.updateOverlayState({state});window.updatePreviews({payload});"
        ))
        .map_err(|e| format!("Could not update ghost overlay: {e}"))
}

fn read_overlay_state(active_view: &str) -> String {
    let fallback =
        r#"{"runId":null,"updatedAt":"","phase":"idle","agents":[],"solution":null,"tests":[]}"#;

    if let Ok(Some(job)) = read_submitted_job() {
        let is_mcq = job.mode == "mcq" || mcq_from_submitted(&job).is_some();
        if active_view == "mcq" && is_mcq {
            return serde_json::to_string(&submitted_overlay_state(&job))
                .unwrap_or_else(|_| fallback.to_string());
        }
        if active_view != "mcq" && !is_mcq {
            return serde_json::to_string(&coding_overlay_state(&job))
                .unwrap_or_else(|_| fallback.to_string());
        }
        // Job mode and overlay view disagree: still prefer the job so the
        // helper never falls back to a hollow idle shell mid-run.
        if is_mcq {
            return serde_json::to_string(&submitted_overlay_state(&job))
                .unwrap_or_else(|_| fallback.to_string());
        }
        return serde_json::to_string(&coding_overlay_state(&job))
            .unwrap_or_else(|_| fallback.to_string());
    }

    if active_view == "mcq" {
        if let Ok(Some(batch)) = read_pending() {
            if batch.error.is_some() || !batch.images.is_empty() {
                return serde_json::to_string(&mcq_pending_state(&batch))
                    .unwrap_or_else(|_| fallback.to_string());
            }
        }
        return serde_json::to_string(&mcq_placeholder_state())
            .unwrap_or_else(|_| fallback.to_string());
    }

    if let Ok(Some(batch)) = read_pending() {
        if batch.error.is_some() || !batch.images.is_empty() {
            return serde_json::to_string(&coding_pending_state(&batch))
                .unwrap_or_else(|_| fallback.to_string());
        }
    }

    if let Some(socket_state) = read_coding_socket_state() {
        return socket_state;
    }

    fallback.to_string()
}

fn read_coding_socket_state() -> Option<String> {
    let entries = fs::read_dir("/tmp").ok()?;
    let mut sockets: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(".mds_") && name.ends_with(".sock"))
                .unwrap_or(false)
        })
        .collect();
    sockets.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    sockets.reverse();

    for path in sockets {
        let Ok(stream) = UnixStream::connect(&path) else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
        let mut buf = Vec::with_capacity(65_536);
        if stream.take(65_536).read_to_end(&mut buf).is_ok() {
            if let Ok(text) = String::from_utf8(buf) {
                if serde_json::from_str::<Value>(&text).is_ok() {
                    return Some(text);
                }
            }
        }
    }
    None
}

fn mcq_placeholder_state() -> Value {
    serde_json::json!({
        "kind": "mcq",
        "phase": "idle",
        "status": "idle",
        "progress": "MCQ overlay ready. Start a batch, capture screenshots, then submit.",
        "error": Value::Null,
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
}

fn mcq_pending_state(batch: &PendingBatch) -> Value {
    let progress = if let Some(error) = batch.error.as_deref() {
        error.to_string()
    } else if batch.images.is_empty() {
        "MCQ batch started. Capture screenshots, then submit.".to_string()
    } else {
        format!(
            "MCQ batch ready with {} screenshot{}. Press ⌃⌥ ↵ to submit.",
            batch.images.len(),
            if batch.images.len() == 1 { "" } else { "s" }
        )
    };
    serde_json::json!({
        "kind": "mcq",
        "phase": if batch.error.is_some() { "error" } else { "collecting" },
        "status": batch.status,
        "progress": progress,
        "error": batch.error,
        "history": [],
        "mcq": {
            "question": "",
            "options": [],
            "answer": { "label": "", "text": "" },
            "reason": progress,
            "whyNot": [],
            "knowledgeUsed": false,
            "model": "none",
        },
    })
}

fn coding_pending_state(batch: &PendingBatch) -> Value {
    let waiting = if let Some(error) = batch.error.as_deref() {
        error.to_string()
    } else if batch.images.is_empty() {
        "Batch started. Capture screenshots, then submit.".to_string()
    } else {
        format!(
            "Batch ready with {} screenshot{}. Press ⌃⌥ ↵ to submit.",
            batch.images.len(),
            if batch.images.len() == 1 { "" } else { "s" }
        )
    };
    serde_json::json!({
        "runId": batch.id,
        "updatedAt": now(),
        "phase": if batch.error.is_some() { "error" } else { "running" },
        "agents": [],
        "solution": {
            "title": "solution",
            "language": "",
            "code": waiting,
            "source": "helper",
            "status": "candidate",
        },
        "tests": [],
    })
}

fn coding_overlay_state(job: &SubmittedJob) -> Value {
    let progress = job_progress_message(job);
    let Some(report) = job.report.as_ref() else {
        let phase = match job.status.as_str() {
            "failed" | "needs_attention" | "cancelled" => "error",
            "completed" => "done",
            _ => "running",
        };
        return serde_json::json!({
            "runId": job.id,
            "updatedAt": now(),
            "phase": phase,
            "agents": coding_agents_from_events(job),
            "solution": {
                "title": "solution",
                "language": "",
                "code": if job.error.as_deref().unwrap_or("").is_empty() {
                    progress
                } else {
                    job.error.clone().unwrap_or(progress)
                },
                "source": "helper",
                "status": "candidate",
            },
            "tests": [],
        });
    };

    let body = report.get("report").unwrap_or(report);
    let candidates = body
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let winner = body
        .get("winner")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let agents: Vec<Value> = candidates
        .iter()
        .take(5)
        .map(|candidate| {
            let letter = candidate
                .get("letter")
                .and_then(Value::as_str)
                .unwrap_or("?");
            let model = candidate
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let error = candidate
                .get("error")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let has_code = candidate
                .pointer("/final/code")
                .and_then(Value::as_str)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let status = if error.is_some() {
                "error"
            } else if !winner.is_empty() && letter.eq_ignore_ascii_case(&winner) {
                "done"
            } else if has_code {
                "done"
            } else {
                "pending"
            };
            serde_json::json!({
                "id": letter,
                "label": letter,
                "model": model,
                "status": status,
                "error": error,
            })
        })
        .collect();

    let solution = coding_solution_from_report(body, &winner, &candidates)
        .unwrap_or_else(|| {
            serde_json::json!({
                "title": "solution",
                "language": "",
                "code": if progress.is_empty() {
                    "Council finished, but no code was returned.".to_string()
                } else {
                    progress
                },
                "source": "helper",
                "status": "candidate",
            })
        });

    let tests = coding_tests_from_report(body);

    serde_json::json!({
        "runId": job.id,
        "updatedAt": now(),
        "phase": if job.error.is_some() { "error" } else { "done" },
        "agents": agents,
        "solution": solution,
        "tests": tests,
        // Standing, approach, per-candidate evidence and the bench's dissent,
        // already computed on the report. The thought-process panes had nothing
        // to render because nothing was sending them anything.
        "presentation": body.get("presentation").cloned().unwrap_or(Value::Null),
    })
}

fn job_progress_message(job: &SubmittedJob) -> String {
    if let Some(error) = job.error.as_deref().filter(|s| !s.is_empty()) {
        return error.to_string();
    }
    if let Some(message) = job
        .events
        .last()
        .and_then(|event| event.get("message"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return message.to_string();
    }
    if job.progress_phase.is_empty() {
        "Waiting for the worker.".to_string()
    } else {
        job.progress_phase.clone()
    }
}

fn coding_agents_from_events(job: &SubmittedJob) -> Vec<Value> {
    let label = if job.progress_phase.is_empty() {
        "worker"
    } else {
        job.progress_phase.as_str()
    };
    let status = match job.status.as_str() {
        "failed" | "needs_attention" | "cancelled" => "error",
        "completed" => "done",
        "queued" => "pending",
        _ => "running",
    };
    vec![serde_json::json!({
        "id": "worker",
        "label": label,
        "model": job.mode,
        "status": status,
        "error": job.error,
    })]
}

fn coding_solution_from_report(
    body: &Value,
    winner: &str,
    candidates: &[Value],
) -> Option<Value> {
    // What the council shipped, when it shipped something. The presentation
    // carries the synthesis' assembled answer — reviewed, revised, executed and
    // gated — which is a better thing to put in front of a user than whichever
    // candidate happens to sit first in the array.
    if let Some(code) = body
        .pointer("/presentation/code")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|code| !code.is_empty())
    {
        let language = body
            .pointer("/presentation/language")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let source = body
            .pointer("/presentation/provenance")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("council")
            .to_string();
        let standing = body
            .pointer("/presentation/standing")
            .and_then(Value::as_str)
            .unwrap_or("");
        let title = if language.is_empty() {
            "solution".to_string()
        } else {
            format!("solution.{language}")
        };
        let status = if standing == "verified" { "reviewed" } else { "candidate" };
        return Some(serde_json::json!({
            "title": title,
            "language": language,
            "code": code,
            "source": source,
            "status": status,
        }));
    }

    let pick = if !winner.is_empty() {
        candidates.iter().find(|candidate| {
            candidate
                .get("letter")
                .and_then(Value::as_str)
                .map(|letter| letter.eq_ignore_ascii_case(winner))
                .unwrap_or(false)
        })
    } else {
        None
    }
    .or_else(|| {
        candidates.iter().find(|candidate| {
            candidate
                .pointer("/final/code")
                .and_then(Value::as_str)
                .map(|code| !code.trim().is_empty())
                .unwrap_or(false)
        })
    })?;

    let code = pick
        .pointer("/final/code")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .or_else(|| {
            pick.get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })?;
    let language = pick
        .pointer("/final/language")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let letter = pick
        .get("letter")
        .and_then(Value::as_str)
        .unwrap_or("solution");
    let model = pick.get("model").and_then(Value::as_str).unwrap_or("");
    let title = if language.is_empty() {
        format!("solution.{letter}")
    } else {
        format!("solution.{language}")
    };
    let source = if model.is_empty() {
        letter.to_string()
    } else {
        format!("{letter} · {model}")
    };
    Some(serde_json::json!({
        "title": title,
        "language": language,
        "code": code,
        "source": source,
        "status": if winner.is_empty() { "candidate" } else { "reviewed" },
    }))
}

fn coding_tests_from_report(body: &Value) -> Vec<Value> {
    // One row per candidate, carrying what its run did. The harness rows this
    // falls back to say "From cloud report" five times, which is a pane that
    // reports nothing at all.
    if let Some(evidence) = body
        .pointer("/presentation/evidence")
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty())
    {
        return evidence
            .iter()
            .take(8)
            .map(|row| {
                let letter = row.get("letter").and_then(Value::as_str).unwrap_or("?");
                let gate = row.get("gate").and_then(Value::as_str).unwrap_or("untested");
                let passed = row.get("passed").and_then(Value::as_i64).unwrap_or(0);
                let failed = row.get("failed").and_then(Value::as_i64).unwrap_or(0);
                let revised = row.get("revised").and_then(Value::as_bool).unwrap_or(false);
                let note = row.get("note").and_then(Value::as_str).unwrap_or("");
                let runtime = row.get("runtime").and_then(Value::as_str).unwrap_or("");
                let name = if revised {
                    format!("Candidate {letter} (revised)")
                } else {
                    format!("Candidate {letter}")
                };
                let actual = if gate == "untested" {
                    if note.is_empty() {
                        "not executed".to_string()
                    } else {
                        note.to_string()
                    }
                } else if runtime.is_empty() {
                    format!("{passed} passed, {failed} failed")
                } else {
                    format!("{passed} passed, {failed} failed · {runtime}")
                };
                let expected = if gate == "untested" {
                    "not executed".to_string()
                } else {
                    format!("{} case(s)", passed + failed)
                };
                let status = match gate {
                    "pass" => "passed",
                    "fail" => "failed",
                    _ => "pending",
                };
                serde_json::json!({
                    "name": name,
                    "input": row.get("model").and_then(Value::as_str).unwrap_or(""),
                    "expected": expected,
                    "actual": actual,
                    "status": status,
                })
            })
            .collect();
    }

    let Some(suites) = body.get("suites").and_then(Value::as_array) else {
        return vec![];
    };
    suites
        .iter()
        .take(5)
        .enumerate()
        .map(|(index, suite)| {
            let language = suite
                .get("language")
                .and_then(Value::as_str)
                .unwrap_or("suite");
            serde_json::json!({
                "name": format!("Harness {}", index + 1),
                "input": language,
                "expected": "PASS lines",
                "actual": "From cloud report",
                "status": "pending",
            })
        })
        .collect()
}

fn submitted_overlay_state(job: &SubmittedJob) -> Value {
    let mut mcq = mcq_from_submitted(job);
    if let Some(body) = mcq.as_mut() {
        if body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            body["model"] = job
                .mcq_model
                .as_deref()
                .filter(|model| !model.trim().is_empty())
                .map(Value::from)
                .unwrap_or_else(|| Value::from("none"));
        }
    }
    let progress = job
        .events
        .last()
        .and_then(|event| event.get("message"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if job.progress_phase.is_empty() {
                "Waiting for the worker."
            } else {
                &job.progress_phase
            }
        });
    serde_json::json!({
        "kind": "mcq",
        "phase": job.progress_phase,
        "status": job.status,
        "progress": progress,
        "error": job.error,
        "history": mcq_history(job),
        "mcq": mcq.unwrap_or_else(|| serde_json::json!({
            "question": "",
            "options": [],
            "answer": { "label": "", "text": "" },
            "reason": progress,
            "whyNot": [],
            "knowledgeUsed": false,
            "model": job.mcq_model.as_deref().unwrap_or("none"),
        })),
    })
}

fn mcq_history(job: &SubmittedJob) -> Vec<Value> {
    job.events
        .iter()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|event| {
            serde_json::json!({
                "level": event.get("level").and_then(Value::as_str).unwrap_or("info"),
                "phase": event.get("phase").and_then(Value::as_str).unwrap_or("worker"),
                "message": event.get("message").and_then(Value::as_str).unwrap_or(""),
                "createdAt": event.get("createdAt").and_then(Value::as_str).unwrap_or(""),
            })
        })
        .collect()
}

fn mcq_from_submitted(job: &SubmittedJob) -> Option<Value> {
    let report = job.report.as_ref()?;
    let body = report.get("report").unwrap_or(report);
    if body.get("kind").and_then(Value::as_str) == Some("mcq") {
        return Some(body.clone());
    }
    None
}

fn job_mode_for_settings(settings: &Value) -> String {
    match settings
        .get("overlayMode")
        .and_then(Value::as_str)
        .unwrap_or("auto")
    {
        "mcq" => "mcq".to_string(),
        _ => "council".to_string(),
    }
}

fn read_keychain(account: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            Err(format!("No Keychain value saved for {account}."))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn sanitize_settings(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| !is_secret_key(key))
                .map(|(key, value)| (key, sanitize_settings(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(sanitize_settings).collect()),
        other => other,
    }
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["api", "secret", "token", "key", "password", "credential"]
        .iter()
        .any(|needle| key.contains(needle))
}

fn safe_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    let out = out.trim_matches(['-', '.']);
    if out.is_empty() {
        "item".to_string()
    } else {
        out.to_string()
    }
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
		            function renderSmartTests(target,count,code,stateTests){target.innerHTML='';const cases=Array.isArray(stateTests)?stateTests:[];count.textContent=cases.length?cases.length+' evidence row'+(cases.length===1?'':'s'):'no execution evidence';if(!cases.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No verified execution evidence available yet.';target.appendChild(empty);return;}cases.slice(0,8).forEach((item)=>{const card=document.createElement('div');card.className='case';const name=document.createElement('b');name.textContent=item.name||'Execution result';const detail=document.createElement('code');detail.textContent=[item.status,item.expected!==undefined?'expected: '+String(item.expected):'',item.actual!==undefined?'actual: '+String(item.actual):'',item.input!==undefined?'input: '+String(item.input):''].filter(Boolean).join(' · ');card.appendChild(name);card.appendChild(detail);target.appendChild(card);});}
            function renderCouncilInsights(presentation){const p=presentation||{};const root=document.querySelector('.thought-list');if(!root)return;const items=root.querySelectorAll('.thought-item');const set=(index,value)=>{const el=items[index]&&items[index].querySelector('.thought-space');if(el)el.textContent=value||'Not reported by Council.';};set(0,p.approach);set(2,p.dataStructures);const complexity=String(p.complexity||'');const timeMatch=complexity.match(/(?:time|runtime)\s*(?:complexity)?\s*[:=\-]\s*([^\n;]+)/i);const spaceMatch=complexity.match(/(?:space|memory)\s*(?:complexity)?\s*[:=\-]\s*([^\n;]+)/i);set(3,p.timeComplexity||(timeMatch&&timeMatch[1])||complexity);set(4,p.spaceComplexity||(spaceMatch&&spaceMatch[1]));set(5,Array.isArray(p.dissent)?p.dissent.join('\n'):p.dissent);set(6,Array.isArray(p.evidence)?p.evidence.map(e=>[e.letter,e.gate,e.passed!==undefined?'passed: '+e.passed:'',e.failed!==undefined?'failed: '+e.failed:'',Number.isFinite(e.elapsedMs)?'elapsed: '+e.elapsedMs+' ms':'',Number.isFinite(e.peakMemoryKb)?'peak memory: '+e.peakMemoryKb+' KB':'',e.runtime||''].filter(Boolean).join(' · ')).join('\n'):'');set(7,Array.isArray(p.rejected)?p.rejected.join('\n'):p.rejected);}
                        window.updatePreviews=function(images){window.__lastPreviews=images||[];const pictures=document.getElementById('pictures');if(!pictures)return;pictures.innerHTML='';if(!images.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Captured images will appear here';pictures.appendChild(empty);return;}images.forEach((src,i)=>{const pill=document.createElement('div');pill.className='picture-pill';const img=document.createElement('img');img.src=src;img.alt='Capture '+(i+1);const count=document.createElement('span');count.className='picture-count';count.textContent=(i+1)+'/10';pill.appendChild(img);pill.appendChild(count);pictures.appendChild(pill);});};
                function renderMcq(state){const left=document.querySelector('.pictures-pane');const right=document.querySelector('.thought-pane');const m=state.mcq||{};const picked=(m.answer&&m.answer.label)||'';const found=Array.isArray(m.options)?m.options:[];const position=found.findIndex((o)=>o.label===picked);const ordinal=(n)=>n%100>=11&&n%100<=13?'th':n%10===1?'st':n%10===2?'nd':n%10===3?'rd':'th';const formatted=position>=0?'✅ '+picked+' ('+(position+1)+ordinal(position+1)+' Option) - '+String((m.answer&&m.answer.text)||found[position].text||''):'';const displayAnswer=formatted||String(m.displayAnswer||'');const selectedModel=(m.model&&String(m.model).trim())?String(m.model).trim():'none';const hasModel=selectedModel.toLowerCase()!=='none';left.innerHTML='<div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title-row"><div class="title">Question</div><div class="mcq-model-pill" data-enabled="'+(hasModel?'true':'false')+'">'+esc(hasModel?selectedModel:'No Model')+'</div></div><div class="mcq-box mcq-question"></div><div class="title">Answer</div><div class="mcq-box mcq-answer"></div>';right.innerHTML='<div class="title">Question history</div><div class="mcq-history"></div>';document.querySelector('.mcq-question').textContent=m.question||state.progress||'Reading the captured question...';document.querySelector('.mcq-answer').innerHTML='<b>'+esc(displayAnswer||(picked||'Answer'))+'</b>'+(displayAnswer?'':(m.answer&&m.answer.text?' — '+esc(m.answer.text):''))+'<br><br>'+esc(m.reason||state.error||state.progress||'Waiting for the MCQ worker result...');const hist=document.querySelector('.mcq-history');const add=(title,body,level,meta)=>{const row=document.createElement('div');row.className='mcq-history-row';row.dataset.level=level||'info';const h=document.createElement('b');h.textContent=title;const p=document.createElement('div');p.textContent=body||'';row.appendChild(h);row.appendChild(p);if(meta&&meta.length){const mrow=document.createElement('div');mrow.className='mcq-history-meta';meta.forEach((x)=>{const s=document.createElement('span');s.textContent=x;mrow.appendChild(s);});row.appendChild(mrow);}hist.appendChild(row);};add('AI selected',selectedModel,'info',[state.status||'',state.phase||''].filter(Boolean));add('Captured question',m.question||'Waiting for the screenshot reading.',state.error?'error':'info',[state.status||'',state.phase||''].filter(Boolean));if(m.options&&m.options.length){add('Choices found',(m.options||[]).map((o)=>(o.label?o.label+'. ':'')+(o.text||'')).join('\\n'),'info',[]);}if(m.knowledgeUsed!==undefined){add('Local knowledge check',m.knowledgeUsed?'A local knowledge match or guidance was included before the model answer.':'The local knowledge pack was checked before the model answer, but no direct match was used.','info',[selectedModel]);}if(picked||m.reason){add('Selected answer',(picked?picked+': ':'')+(m.answer&&m.answer.text?m.answer.text:'')+'\\n'+(m.reason||''),'info',[selectedModel]);}(m.whyNot||[]).forEach((x)=>add('Rejected choice '+(x.label||''),x.reason||'Not selected.','info',[]));(state.history||[]).forEach((e)=>add(e.phase||'worker event',e.message||'',e.level||'info',[e.createdAt||''].filter(Boolean)));if(!hist.children.length)add('Waiting','The helper is waiting for the worker history.','info',[]);window.updatePreviews(window.__lastPreviews||[]);}
			            function restoreCodingShell(){if(document.getElementById('agents'))return;document.getElementById('panel').innerHTML='<div class="pane pictures-pane"><div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title">Solution</div><div class="solution-status" id="agents"></div><div class="solution-editor"><div class="editor-head"><b id="solution-title">solution</b><span id="solution-source">waiting</span></div><ol class="code-lines" id="solution-code"></ol></div><div class="tests"><div class="tests-head"><b>Test cases</b><span id="tests-count">real data</span></div><div class="case-list" id="tests"></div></div></div><div class="pane thought-pane"><div class="title">Thought process</div><div class="thought-list"><div class="thought-item"><div class="thought-heading">Approach/algorithm</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Functions</div><div class="thought-space function-notes" id="function-notes"></div></div><div class="thought-item"><div class="thought-heading">Data structures</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Time complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Space complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Edge cases</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Testing</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Trade-offs</div><div class="thought-space"></div></div></div></div>';window.updatePreviews(window.__lastPreviews||[]);}
			            window.updateOverlayState=function(state){state=state||{agents:[],tests:[],solution:null,phase:'idle'};if(state.kind==='mcq'||state.mcq){renderMcq(state);return;}restoreCodingShell();const agents=document.getElementById('agents');agents.innerHTML='';if(!state.agents||!state.agents.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No active model run';agents.appendChild(empty);}else{state.agents.slice(0,5).forEach((a)=>{const chip=document.createElement('div');chip.className='model-chip';chip.dataset.state=stateTone(a.status);const dot=document.createElement('span');dot.className='dot';const name=document.createElement('b');name.textContent=a.label||a.id;const status=document.createElement('span');status.textContent=a.status==='error'?(a.error||'error'):a.status;chip.title=[a.model,a.error].filter(Boolean).join(' — ');chip.appendChild(dot);chip.appendChild(name);chip.appendChild(status);agents.appendChild(chip);});}const title=document.getElementById('solution-title');const source=document.getElementById('solution-source');const code=document.getElementById('solution-code');const tests=document.getElementById('tests');const count=document.getElementById('tests-count');if(state.solution&&state.solution.code){title.textContent=state.solution.title||'solution';source.textContent=state.solution.status==='reviewed'?'reviewed':('candidate · '+(state.solution.source||''));renderCodeLines(code,state.solution.code,state.solution.language);renderFunctionNotes(state.solution.code);renderSmartTests(tests,count,state.solution.code,state.tests);renderCouncilInsights(state.presentation);}else{title.textContent='solution';source.textContent=state.phase==='idle'?'idle':'waiting';const waiting=state.phase==='idle'?'No run yet.':'Waiting for solution...';renderCodeLines(code,waiting,'');renderFunctionNotes(waiting);renderSmartTests(tests,count,waiting,state.tests);renderCouncilInsights(state.presentation);}};
    </script></body></html>"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coding_overlay_maps_winner_code_from_report() {
        let job = SubmittedJob {
            id: "job-1".into(),
            mode: "council".into(),
            mcq_model: None,
            status: "completed".into(),
            progress_phase: "completed".into(),
            submitted_at: now(),
            previews: vec![],
            error: None,
            report: Some(serde_json::json!({
                "report": {
                    "winner": "B",
                    "candidates": [
                        {
                            "letter": "A",
                            "model": "model-a",
                            "final": { "kind": "code", "language": "py", "code": "print(1)" },
                            "error": null
                        },
                        {
                            "letter": "B",
                            "model": "model-b",
                            "final": { "kind": "code", "language": "py", "code": "def solve():\n    return 42" },
                            "error": null
                        }
                    ],
                    "suites": [{ "language": "python" }]
                }
            })),
            events: vec![],
        };
        let state = coding_overlay_state(&job);
        assert_eq!(state["phase"], "done");
        assert_eq!(state["solution"]["status"], "reviewed");
        assert!(state["solution"]["code"]
            .as_str()
            .unwrap_or("")
            .contains("return 42"));
        assert_eq!(state["agents"].as_array().map(|a| a.len()), Some(2));
        assert_eq!(state["tests"].as_array().map(|a| a.len()), Some(1));
    }

    #[test]
    fn coding_overlay_shows_progress_before_report() {
        let job = SubmittedJob {
            id: "job-2".into(),
            mode: "council".into(),
            mcq_model: None,
            status: "running".into(),
            progress_phase: "solving".into(),
            submitted_at: now(),
            previews: vec![],
            error: None,
            report: None,
            events: vec![serde_json::json!({
                "level": "info",
                "phase": "solving",
                "message": "Asking models for candidates."
            })],
        };
        let state = coding_overlay_state(&job);
        assert_eq!(state["phase"], "running");
        assert!(state["solution"]["code"]
            .as_str()
            .unwrap_or("")
            .contains("Asking models"));
    }

    #[test]
    fn mcq_overlay_keeps_progress_without_answer() {
        let job = SubmittedJob {
            id: "job-3".into(),
            mode: "mcq".into(),
            mcq_model: Some("anthropic/claude".into()),
            status: "running".into(),
            progress_phase: "answering".into(),
            submitted_at: now(),
            previews: vec![],
            error: None,
            report: None,
            events: vec![],
        };
        let state = submitted_overlay_state(&job);
        assert_eq!(state["kind"], "mcq");
        assert_eq!(state["mcq"]["model"], "anthropic/claude");
        assert_eq!(state["status"], "running");
    }

    #[test]
    fn auto_routed_mcq_report_selects_mcq_overlay() {
        let job = SubmittedJob {
            id: "auto-mcq".into(), mode: "council".into(), mcq_model: None,
            status: "completed".into(), progress_phase: "completed".into(),
            submitted_at: now(), previews: vec![], error: None,
            report: Some(serde_json::json!({"report": {"kind": "mcq", "model": "vision-reader", "question": "Which?", "answer": {"label": "C", "text": "Queue"}, "options": [{"label":"C","text":"Queue"}]}})),
            events: vec![],
        };
        assert!(mcq_from_submitted(&job).is_some());
        assert_eq!(submitted_overlay_state(&job)["mcq"]["answer"]["label"], "C");
    }

    #[test]
    fn pending_batch_tolerates_missing_optional_fields() {
        let raw = r#"{
            "id": "batch-1",
            "images": [],
            "startedAt": "2026-09-14T04:59:27.929558+00:00",
            "status": "collecting"
        }"#;
        let batch: PendingBatch = serde_json::from_str(raw).expect("parse pending batch");
        assert!(batch.error.is_none());
        assert!(batch.images.is_empty());
    }
}
