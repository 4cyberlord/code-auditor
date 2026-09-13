// src-tauri/src/bin/mds.rs
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
    mac_shortcuts::register()?;

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

fn update_overlay(webview: &WebView, _active_view: &str) -> Result<(), String> {
    let sources: Vec<Value> = vec![];
    let payload = serde_json::to_string(&sources).map_err(|e| e.to_string())?;
    let state = r#"{"phase":"idle","agents":[],"solution":null,"tests":[]}"#;
    webview
        .evaluate_script(&format!(
            "window.updatePreviews({payload});window.updateOverlayState({state});"
        ))
        .map_err(|e| format!("Could not update ghost overlay: {e}"))
}

fn overlay_html() -> &'static str {
    // Same HTML as before (the full overlay UI)
    r#"<!doctype html><html><head><meta charset="utf-8"><style>
 html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;color:rgba(255,255,255,.96);font:600 14px -apple-system,sans-serif}
 </style></head><body><div id="panel">Ghost Overlay Active</div>
 <script>
 window.scrollSolutionBy=function(d){};
 window.updatePreviews=function(){};
 window.updateOverlayState=function(){};
 </script></body></html>"#
}
