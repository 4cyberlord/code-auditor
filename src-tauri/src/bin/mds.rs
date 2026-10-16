// src-tauri/src/bin/mds.rs
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
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
// Overlay captures use the same private Azure container as the main app. The
// helper receives only a short-lived, blob-scoped SAS URL from the API — never
// the Azure connection string itself.
const BUCKET: &str = "azure:council-images";
const AZURE_STORAGE_VERSION: &str = "2023-11-03";
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
            atomic::{AtomicBool, AtomicU8, Ordering},
            Mutex,
        },
        time::{Duration, Instant},
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
    const HID_USAGE_KEYBOARD_H: u32 = 0x0B;
    const HID_USAGE_KEYBOARD_L: u32 = 0x0F;
    const HID_USAGE_KEYBOARD_P: u32 = 0x13;
    const HID_USAGE_KEYBOARD_R: u32 = 0x15;
    const HID_USAGE_KEYBOARD_Y: u32 = 0x1C;
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
    // USB HID usages for the number row (0..9).
    const HID_USAGE_KEYBOARD_1: u32 = 0x1E;
    const HID_USAGE_KEYBOARD_2: u32 = 0x1F;
    const HID_USAGE_KEYBOARD_3: u32 = 0x20;
    const HID_USAGE_KEYBOARD_4: u32 = 0x21;
    const HID_USAGE_KEYBOARD_5: u32 = 0x22;
    const HID_USAGE_KEYBOARD_0: u32 = 0x27;
    const HID_USAGE_KEYBOARD_MINUS: u32 = 0x2D;
    const HID_USAGE_KEYBOARD_EQUAL: u32 = 0x2E;

    pub static START_BATCH: AtomicBool = AtomicBool::new(false);
    pub static CAPTURE: AtomicBool = AtomicBool::new(false);
    pub static CAPTURE_REGION: AtomicBool = AtomicBool::new(false);
    pub static CAPTURE_LEFT: AtomicBool = AtomicBool::new(false);
    pub static CAPTURE_RIGHT: AtomicBool = AtomicBool::new(false);
    pub static SUBMIT: AtomicBool = AtomicBool::new(false);
    pub static MOVE_LEFT: AtomicBool = AtomicBool::new(false);
    pub static MOVE_RIGHT: AtomicBool = AtomicBool::new(false);
    pub static MOVE_UP: AtomicBool = AtomicBool::new(false);
    pub static MOVE_DOWN: AtomicBool = AtomicBool::new(false);
    pub static SCROLL_UP: AtomicBool = AtomicBool::new(false);
    pub static SCROLL_DOWN: AtomicBool = AtomicBool::new(false);
    static FADE_DOWN: AtomicBool = AtomicBool::new(false);
    static FADE_UP: AtomicBool = AtomicBool::new(false);
    static HISTORY_PREVIOUS: AtomicBool = AtomicBool::new(false);
    static HISTORY_NEXT: AtomicBool = AtomicBool::new(false);
    static HISTORY_OPEN: AtomicBool = AtomicBool::new(false);
    static HISTORY_BACK: AtomicBool = AtomicBool::new(false);
    static LANGUAGE_COMMAND: AtomicU8 = AtomicU8::new(0);
    static LANGUAGE_KEY_HELD: AtomicU8 = AtomicU8::new(0);
    static LAST_LANGUAGE_KEY: Mutex<Option<(u32, Instant)>> = Mutex::new(None);
    static CODING_OVERLAY_VISIBLE: AtomicBool = AtomicBool::new(false);
    static HISTORY_VISIBLE: AtomicBool = AtomicBool::new(false);
    // 1 coding, 2 multiple-choice, 3 shared cloud history.
    static PANEL_COMMAND: AtomicU8 = AtomicU8::new(0);
    // Suppress hardware key-repeat; require two distinct keydown edges.
    static PANEL_KEY_HELD: AtomicU8 = AtomicU8::new(0);
    static LAST_PANEL_KEY: Mutex<Option<(u8, Instant)>> = Mutex::new(None);
    // Encoded pairs: 00 and 10-13 route to the main app, 21-25 are coding
    // overlay controls, and 31-35 are MCQ overlay controls.
    static NUMBER_COMMAND: AtomicU8 = AtomicU8::new(0);

    static CONTROL_DOWN: AtomicBool = AtomicBool::new(false);
    static SHIFT_DOWN: AtomicBool = AtomicBool::new(false);
    static OPTION_DOWN: AtomicBool = AtomicBool::new(false);
    static LAST_DIGIT: Mutex<Option<(u8, Instant)>> = Mutex::new(None);
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

        // Case-insensitive CC/MM/HH via physical HID codes. A double press
        // must have a key release between taps. The callback does not store
        // keystrokes or interfere with the underlying app's input stream.
        let panel_key = match usage {
            HID_USAGE_KEYBOARD_C => Some((1_u8, 1_u8)),
            HID_USAGE_KEYBOARD_M => Some((2_u8, 2_u8)),
            HID_USAGE_KEYBOARD_H => Some((3_u8, 4_u8)),
            _ => None,
        };
        if let Some((command, bit)) = panel_key {
            if !pressed {
                PANEL_KEY_HELD.fetch_and(!bit, Ordering::SeqCst);
            } else if !CONTROL_DOWN.load(Ordering::SeqCst)
                && !OPTION_DOWN.load(Ordering::SeqCst)
                && PANEL_KEY_HELD.fetch_or(bit, Ordering::SeqCst) & bit == 0
            {
                if let Ok(mut previous) = LAST_PANEL_KEY.lock() {
                    if super::double_tap_panel(&mut previous, command, Instant::now()).is_some() {
                        PANEL_COMMAND.store(command, Ordering::SeqCst);
                    }
                }
            }
        } else if pressed && usage < HID_USAGE_KEYBOARD_LEFT_CONTROL {
            if let Ok(mut previous) = LAST_PANEL_KEY.lock() { *previous = None; }
        }
        if pressed && (usage == HID_USAGE_KEYBOARD_LEFT_CONTROL
            || usage == HID_USAGE_KEYBOARD_RIGHT_CONTROL
            || usage == HID_USAGE_KEYBOARD_LEFT_ALT
            || usage == HID_USAGE_KEYBOARD_RIGHT_ALT)
        {
            if let Ok(mut previous) = LAST_PANEL_KEY.lock() { *previous = None; }
        }

        // The optional RR / CP / PY view commands are active only in Coding.
        // The observer doesn't suppress foreground input or log typed text.
        let lang_key=match usage {
            HID_USAGE_KEYBOARD_R=>Some(1_u8), HID_USAGE_KEYBOARD_C=>Some(2_u8),
            HID_USAGE_KEYBOARD_P=>Some(4_u8), HID_USAGE_KEYBOARD_Y=>Some(8_u8),
            _=>None,
        };
        if let Some(bit)=lang_key {
            if !pressed {LANGUAGE_KEY_HELD.fetch_and(!bit,Ordering::SeqCst);}
            else if CODING_OVERLAY_VISIBLE.load(Ordering::SeqCst)
                && !HISTORY_VISIBLE.load(Ordering::SeqCst)
                && !CONTROL_DOWN.load(Ordering::SeqCst)
                && !OPTION_DOWN.load(Ordering::SeqCst)
                && !SHIFT_DOWN.load(Ordering::SeqCst)
                && LANGUAGE_KEY_HELD.fetch_or(bit,Ordering::SeqCst)&bit==0
            {
                if let Ok(mut previous)=LAST_LANGUAGE_KEY.lock(){
                    let pair=previous.take().filter(|(_,at)|at.elapsed()<=Duration::from_millis(650))
                        .map(|(first,_)|(first,usage));
                    *previous=Some((usage,Instant::now()));
                    let choice=match pair {
                        Some((HID_USAGE_KEYBOARD_R,HID_USAGE_KEYBOARD_R))=>1,
                        Some((HID_USAGE_KEYBOARD_C,HID_USAGE_KEYBOARD_P))=>2,
                        Some((HID_USAGE_KEYBOARD_P,HID_USAGE_KEYBOARD_Y))=>3,
                        _=>0,
                    };
                    if choice!=0 {LANGUAGE_COMMAND.store(choice,Ordering::SeqCst);*previous=None;}
                }
            }
        }else if pressed&&usage<HID_USAGE_KEYBOARD_LEFT_CONTROL{
            if let Ok(mut previous)=LAST_LANGUAGE_KEY.lock(){*previous=None;}
        }
        // Number pairs route into three independent destinations. The first
        // digit selects the workflow; the second selects its capture mode.
        if pressed && !CONTROL_DOWN.load(Ordering::SeqCst)
            && !SHIFT_DOWN.load(Ordering::SeqCst)
            && !OPTION_DOWN.load(Ordering::SeqCst)
        {
            let digit = match usage {
                HID_USAGE_KEYBOARD_0 => Some(0),
                HID_USAGE_KEYBOARD_1 => Some(1),
                HID_USAGE_KEYBOARD_2 => Some(2),
                HID_USAGE_KEYBOARD_3 => Some(3),
                HID_USAGE_KEYBOARD_4 => Some(4),
                HID_USAGE_KEYBOARD_5 => Some(5),
                _ => None,
            };
            if let Some(digit) = digit {
                if let Ok(mut previous) = LAST_DIGIT.lock() {
                    let pair = previous.take().filter(|(_, at)| at.elapsed() <= Duration::from_millis(650))
                        .map(|(first, _)| (first, digit));
                    *previous = Some((digit, Instant::now()));
                    if let Some((first, second)) = pair {
                        if let Some(command) = super::number_pair_command(first, second) {
                            NUMBER_COMMAND.store(command, Ordering::SeqCst);
                        }
                    }
                }
            } else if usage < HID_USAGE_KEYBOARD_LEFT_CONTROL {
                if let Ok(mut previous) = LAST_DIGIT.lock() { *previous = None; }
            }
        }

        // These controls are deliberately active only while the coding overlay
        // is visible, so ordinary typing elsewhere is unaffected.
        if pressed && (CODING_OVERLAY_VISIBLE.load(Ordering::SeqCst) || HISTORY_VISIBLE.load(Ordering::SeqCst))
            && !CONTROL_DOWN.load(Ordering::SeqCst)
            && !OPTION_DOWN.load(Ordering::SeqCst)
        {
            match (usage, SHIFT_DOWN.load(Ordering::SeqCst)) {
                (HID_USAGE_KEYBOARD_UP_ARROW, false) if HISTORY_VISIBLE.load(Ordering::SeqCst) => HISTORY_PREVIOUS.store(true, Ordering::SeqCst),
                (HID_USAGE_KEYBOARD_DOWN_ARROW, false) if HISTORY_VISIBLE.load(Ordering::SeqCst) => HISTORY_NEXT.store(true, Ordering::SeqCst),
                (HID_USAGE_KEYBOARD_UP_ARROW, false) if CODING_OVERLAY_VISIBLE.load(Ordering::SeqCst) => SCROLL_UP.store(true, Ordering::SeqCst),
                (HID_USAGE_KEYBOARD_DOWN_ARROW, false) if CODING_OVERLAY_VISIBLE.load(Ordering::SeqCst) => SCROLL_DOWN.store(true, Ordering::SeqCst),
                // Back is intentionally local to the read-only History
                // surface: it never moves the click-through overlay window.
                (HID_USAGE_KEYBOARD_LEFT_ARROW, false) if HISTORY_VISIBLE.load(Ordering::SeqCst) => HISTORY_BACK.store(true, Ordering::SeqCst),
                // Right-arrow selects the highlighted saved run and opens its
                // full read-only Council result in the overlay.
                (HID_USAGE_KEYBOARD_RIGHT_ARROW, false) if HISTORY_VISIBLE.load(Ordering::SeqCst) => HISTORY_OPEN.store(true, Ordering::SeqCst),
                (HID_USAGE_KEYBOARD_MINUS, false) => FADE_DOWN.store(true, Ordering::SeqCst),
                (HID_USAGE_KEYBOARD_EQUAL, false) => FADE_UP.store(true, Ordering::SeqCst),
                _ => {}
            }
        }

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

    pub fn hotkeys_ready() -> bool { MONITOR.lock().ok().and_then(|guard| *guard).is_some() }
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
    pub fn take_panel_command() -> u8 { PANEL_COMMAND.swap(0, Ordering::SeqCst) }
    pub fn set_history_visible(value: bool) { HISTORY_VISIBLE.store(value, Ordering::SeqCst); }
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
    pub fn take_number_command() -> u8 { NUMBER_COMMAND.swap(0, Ordering::SeqCst) }
    pub fn set_coding_overlay_visible(value: bool) { CODING_OVERLAY_VISIBLE.store(value, Ordering::SeqCst); }
    pub fn take_fade_down() -> bool { FADE_DOWN.swap(false, Ordering::SeqCst) }
    pub fn take_fade_up() -> bool { FADE_UP.swap(false, Ordering::SeqCst) }
    pub fn take_history_previous() -> bool { HISTORY_PREVIOUS.swap(false, Ordering::SeqCst) }
    pub fn take_history_next() -> bool { HISTORY_NEXT.swap(false, Ordering::SeqCst) }
    pub fn take_history_open() -> bool { HISTORY_OPEN.swap(false, Ordering::SeqCst) }
    pub fn take_history_back() -> bool { HISTORY_BACK.swap(false, Ordering::SeqCst) }
    pub fn take_language_command() -> u8 { LANGUAGE_COMMAND.swap(0, Ordering::SeqCst) }
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
    submission_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    owner_id: Option<String>,
    #[serde(default)]
    settings_snapshot: Option<Value>,
    #[serde(default)]
    mode: Option<String>,
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

#[cfg(target_os = "macos")]
fn drain_capture_commands() {
    let Ok(dir) = support_root_dir().map(|path| path.join("cache/capture-commands")) else { return; };
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
        let claimed = path.with_extension("processing");
        if fs::rename(&path, &claimed).is_err() { continue; }
        let raw = fs::read_to_string(&claimed).unwrap_or_default();
        let _ = fs::remove_file(&claimed);
        let Ok(command) = serde_json::from_str::<Value>(&raw) else { continue; };
        if command["pid"].as_u64() != Some(std::process::id() as u64) { continue; }
        let _ = write_private(&path.with_extension("ack"), b"accepted");
        use std::sync::atomic::Ordering;
        match command["mode"].as_str().unwrap_or_default() {
            "region" => mac_shortcuts::CAPTURE_REGION.store(true, Ordering::SeqCst),
            "screen" => mac_shortcuts::CAPTURE.store(true, Ordering::SeqCst),
            "left" => mac_shortcuts::CAPTURE_LEFT.store(true, Ordering::SeqCst),
            "right" => mac_shortcuts::CAPTURE_RIGHT.store(true, Ordering::SeqCst),
            _ => {}
        }
    }
}

#[cfg(target_os = "macos")]
fn send_capture_to_council(mode: &str) {
    if !matches!(mode, "region" | "screen" | "left" | "right") { return; }
    let Ok(dir) = support_root_dir().map(|path| path.join("cache/app-capture-requests")) else { return; };
    if fs::create_dir_all(&dir).is_err() { return; }
    let id = Uuid::new_v4().to_string();
    let target = dir.join(format!("{id}.json"));
    let temp = dir.join(format!(".{id}.tmp"));
    if fs::write(&temp, serde_json::json!({"mode": mode, "createdAt": chrono::Utc::now().to_rfc3339()}).to_string()).is_ok() {
        if fs::rename(&temp, &target).is_err() { let _ = fs::remove_file(temp); }
    }
}

#[cfg(target_os = "macos")]
fn send_process_to_council() {
    let Ok(dir) = support_root_dir().map(|path| path.join("cache/app-capture-requests")) else { return; };
    if fs::create_dir_all(&dir).is_err() { return; }
    let id = Uuid::new_v4().to_string();
    let target = dir.join(format!("{id}.json"));
    let temp = dir.join(format!(".{id}.tmp"));
    if fs::write(&temp, serde_json::json!({"mode": "process", "createdAt": chrono::Utc::now().to_rfc3339()}).to_string()).is_ok() {
        if fs::rename(&temp, &target).is_err() { let _ = fs::remove_file(temp); }
    }
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
    let mut overlay_refresh = OverlayRefresh::default();
    update_overlay(&webview, &active_view, &mut overlay_refresh)?;
    let mut overlay_visible = false;
    let mut overlay_alpha = 0.46_f64;
    let mut history_open = false;
    let mut history_rows: Vec<Value> = Vec::new();
    let mut history_index = 0_usize;
    let mut history_detail_open = false;
    let mut history_fetch: Option<tokio::task::JoinHandle<Result<(Vec<Value>,Option<String>),String>>> = None;
    let mut history_detail_fetch: Option<tokio::task::JoinHandle<Result<Value,String>>> = None;
    let mut last_job_poll = Instant::now() - Duration::from_secs(60);
    let mut last_overlay_refresh = Instant::now();
    let mut last_history_refresh = Instant::now() - Duration::from_secs(60);
    let mut last_heartbeat = Instant::now();
    let mut last_capture_cleanup = Instant::now() - Duration::from_secs(3600);
    #[cfg(target_os = "macos")]
    let helper_hotkeys_ready = mac_shortcuts::hotkeys_ready();

    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    // Keep blocking HTTP/upload work off the macOS event loop. Serialize
    // submissions with polling so a stale refresh cannot overwrite a new job.
    let cloud_gate = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    let mut refresh_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut submit_task: Option<tokio::task::JoinHandle<()>> = None;
    // macOS interactive region selection can take as long as the user needs.
    // Run screencapture on a blocking worker instead of freezing event handling.
    #[cfg(target_os = "macos")]
    let mut capture_task: Option<tokio::task::JoinHandle<Result<(), String>>> = None;
    #[cfg(target_os = "macos")]
    let mut restore_overlay_after_capture = false;
    #[cfg(target_os = "macos")]
    let mut capture_active_view: Option<String> = None;

    event_loop.run(move |_event, event_loop_target, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
        #[cfg(target_os = "macos")]
        drain_capture_commands();
        #[cfg(target_os = "macos")]
        {
            let command = mac_shortcuts::take_number_command();
            match command {
                10 => send_capture_to_council("screen"),
                11 => send_capture_to_council("left"),
                12 => send_capture_to_council("right"),
                13 => send_process_to_council(),
                6 => {
                    // 00 starts a new Coding overlay workspace. Previous
                    // finished jobs remain archived; main-app runs are untouched.
                    active_view = "coding".to_string();
                    if capture_task.as_ref().is_some_and(|task| !task.is_finished()) {
                        eprintln!("new session unavailable during screenshot selection");
                    } else if submit_task.as_ref().is_some_and(|task| !task.is_finished()) {
                        eprintln!("new session unavailable during cloud submission");
                    } else if let Err(error) = reset_pending_batch("coding").and_then(|_| start_batch("coding")) {
                        eprintln!("new coding session failed: {error}");
                    }
                    overlay_visible = true;
                    let _ = show_overlay(&overlay, true);
                    let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                }
                25 => {
                    // This undo is deliberately limited to the visible Coding
                    // overlay: it cannot alter submitted jobs or MCQ captures.
                    if overlay_visible && active_view == "coding" {
                        match remove_last_pending_image("coding") {
                            Ok(true) => log("removed newest staged coding capture"),
                            Ok(false) => log("no staged coding capture to remove"),
                            Err(error) => eprintln!("remove newest capture failed: {error}"),
                        }
                        let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                    }
                }
                20 | 22 | 23 | 31..=34 => {
                    let target_view = if command < 30 { "coding" } else { "mcq" };
                    if capture_task.as_ref().is_some_and(|task| !task.is_finished()) {
                        eprintln!("screenshot capture already in progress");
                    } else if submit_task.as_ref().is_some_and(|task| !task.is_finished()) {
                        eprintln!("screenshot capture unavailable during cloud submission");
                    } else if let Some(mode) = helper_capture_mode(if command == 20 { 1 } else if command < 30 { command - 20 } else { command % 10 }) {
                        active_view = target_view.to_string();
                        capture_active_view = Some(active_view.clone());
                        // Background-route captures open their own coding/MCQ
                        // surface after the grab so the staged images and next
                        // action are visible without leaving the source app.
                        restore_overlay_after_capture = true;
                        overlay_visible = false;
                        let _ = show_overlay(&overlay, false);
                        event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                        let view = active_view.clone();
                        capture_task = Some(rt.spawn_blocking(move || capture_screen(mode, &view)));
                    }
                }
                24 | 35 => {
                    let target_view = if command == 24 { "coding" } else { "mcq" };
                    if capture_task.as_ref().is_some_and(|task| !task.is_finished()) {
                        eprintln!("finish the screenshot selection before submitting");
                    } else if submit_task.as_ref().is_some_and(|task| !task.is_finished()) {
                        eprintln!("cloud submission already running");
                    } else {
                        active_view = target_view.to_string();
                        overlay_visible = true;
                        let _ = show_overlay(&overlay, true);
                        event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                        let gate = std::sync::Arc::clone(&cloud_gate);
                        let view = active_view.clone();
                        submit_task = Some(rt.spawn(async move {
                            let _lock = gate.lock().await;
                            if let Err(error) = submit_batch(&view).await {
                                eprintln!("submit failed: {error}");
                                let _ = update_pending_error(&view, &error);
                            }
                        }));
                        let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                    }
                }
                _ => {}
            }
        }
        if history_fetch.as_ref().is_some_and(|task| task.is_finished()) {
            if let Some(task)=history_fetch.take() {
                match rt.block_on(task) {
                    Ok(Ok((rows,warning))) if history_open => {
                        history_rows=rows;
                        history_index=history_index.min(history_rows.len().saturating_sub(1));
                        let payload=serde_json::to_string(&history_rows)
                            .unwrap_or_else(|_| "[]".into());
                        let notice=serde_json::to_string(&warning).unwrap_or_else(|_| "null".into());
                        let _ = webview.evaluate_script(&format!(
                            "window.showSharedHistory({payload},{history_index},false,{notice})"));
                    }
                    Ok(Err(error)) if history_open => {
                        let safe=serde_json::to_string(&error).unwrap_or_else(|_| "\"History unavailable\"".into());
                        let _ = webview.evaluate_script(&format!(
                            "window.showSharedHistory(null,{history_index},false,{safe})"));
                    }
                    Err(error) if history_open => {
                        let safe=serde_json::to_string(&error.to_string()).unwrap_or_else(|_| "\"History unavailable\"".into());
                        let _ = webview.evaluate_script(&format!(
                            "window.showSharedHistory(null,{history_index},false,{safe})"));
                    }
                    _ => {}
                }
            }
        }
        if history_detail_fetch.as_ref().is_some_and(|task| task.is_finished()) {
            if let Some(task) = history_detail_fetch.take() {
                if history_open && history_detail_open {
                    let script = match rt.block_on(task) {
                        Ok(Ok(detail)) => format!("window.showSharedHistoryDetail({});", serde_json::to_string(&detail).unwrap_or_else(|_| "{}".into())),
                        Ok(Err(error)) => format!("window.showSharedHistoryDetail({});", serde_json::json!({"error": error})),
                        Err(error) => format!("window.showSharedHistoryDetail({});", serde_json::json!({"error": error.to_string()})),
                    };
                    let _ = webview.evaluate_script(&script);
                }
            }
        }
        // History is an account-scoped live view. Refresh its single server
        // snapshot once per second while the list is visible; never replace an
        // opened result underneath the person reading it.
        if history_open && !history_detail_open
            && history_fetch.as_ref().is_none_or(|task| task.is_finished())
            && last_history_refresh.elapsed() >= Duration::from_secs(1)
        {
            last_history_refresh = Instant::now();
            history_fetch = Some(rt.spawn(fetch_unified_history()));
        }
        if last_capture_cleanup.elapsed() >= Duration::from_secs(3600) {
            if let Err(error) = clean_expired_capture_dirs() {
                log(&format!("Capture cleanup skipped: {error}"));
            }
            last_capture_cleanup = Instant::now();
        }
        if last_heartbeat.elapsed() >= Duration::from_secs(4) {
            #[cfg(target_os = "macos")]
            write_helper_status(helper_hotkeys_ready, if helper_hotkeys_ready { None } else { Some("Input Monitoring permission unavailable") });
            last_heartbeat = Instant::now();
        }

        #[cfg(target_os = "macos")]
        if capture_task.as_ref().is_some_and(|task| task.is_finished()) {
            if let Some(task) = capture_task.take() {
                // The task has already finished. Awaiting its result here does
                // not wait on interactive selection or a running subprocess.
                let result = rt.block_on(task)
                    .map_err(|e| format!("Screenshot capture worker failed: {e}"))
                    .and_then(|result| result);
                overlay_visible = restore_overlay_after_capture;
                event_loop_target.set_activation_policy_at_runtime(if overlay_visible {
                    ActivationPolicy::Accessory
                } else {
                    ActivationPolicy::Prohibited
                });
                let _ = show_overlay(&overlay, overlay_visible);
                let capture_view = capture_active_view.take().unwrap_or_else(|| active_view.clone());
                if let Err(error) = result {
                    eprintln!("capture failed: {error}");
                    let _ = update_pending_error(&capture_view, &error);
                }
                let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
            }
        }

        if last_job_poll.elapsed() >= Duration::from_secs(5)
            && refresh_task.as_ref().is_none_or(|task| task.is_finished())
        {
            last_job_poll = Instant::now();
            let gate = std::sync::Arc::clone(&cloud_gate);
            refresh_task = Some(rt.spawn(async move {
                let _lock = gate.lock().await;
                if let Err(error) = refresh_job().await {
                    log(&format!("Cloud job refresh failed: {error}"));
                }
            }));
        }

        if overlay_visible && !history_open && last_overlay_refresh.elapsed() >= Duration::from_millis(500) {
            last_overlay_refresh = Instant::now();
            let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
        }

        #[cfg(target_os = "macos")]
        {
            mac_shortcuts::set_coding_overlay_visible(overlay_visible && active_view == "coding");
            // HH is its own surface; unlike the two task views it must not
            // change which batch is active. CC/MM switch surfaces in-place
            // without opening the main app, stealing application focus, or
            // changing the cloud solving engine.
            match mac_shortcuts::take_panel_command() {
                command @ (1 | 2 | 3)
                    if capture_task.as_ref().is_none_or(|task| task.is_finished()) =>
                {
                    if command == 3 {
                        // HH is a true toggle. Repeating it closes the whole
                        // overlay rather than leaving a hidden history sheet
                        // over the previous task view.
                        if overlay_visible && history_open {
                            history_open = false;
                            history_detail_open = false;
                            if let Some(task) = history_detail_fetch.take() { task.abort(); }
                            mac_shortcuts::set_history_visible(false);
                            let _ = webview.evaluate_script("window.closeSharedHistory()");
                            overlay_visible = false;
                            let _ = show_overlay(&overlay, false);
                        } else {
                            // The list is server-authoritative. Start empty
                            // rather than showing a stale helper cache while
                            // the first shared snapshot arrives.
                            history_rows.clear();
                            history_index = 0;
                            history_open = true;
                            history_detail_open = false;
                            mac_shortcuts::set_history_visible(true);
                            let rows = serde_json::to_string(&history_rows).unwrap_or_else(|_| "[]".into());
                            last_history_refresh = Instant::now();
                            history_fetch = Some(rt.spawn(fetch_unified_history()));
                            overlay_visible = true;
                            event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                            let _ = show_overlay(&overlay, true);
                            let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                            let _ = webview.evaluate_script(&format!(
                                "window.showSharedHistory({rows},0,true,null)"));
                        }
                    } else {
                        let target_view = if command == 1 { "coding" } else { "mcq" };
                        // CC/MM close their own open surface, while a command
                        // for the other surface switches without hiding.
                        if overlay_visible && !history_open && active_view == target_view {
                            overlay_visible = false;
                            let _ = show_overlay(&overlay, false);
                        } else {
                            history_open = false;
                            history_detail_open = false;
                            if let Some(task) = history_detail_fetch.take() { task.abort(); }
                            mac_shortcuts::set_history_visible(false);
                            let _ = webview.evaluate_script("window.closeSharedHistory()");
                            overlay_refresh.sent_state=None;
                            overlay_refresh.sent_previews=None;
                            active_view = target_view.to_string();
                            overlay_visible = true;
                            event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                            let _ = show_overlay(&overlay, true);
                            let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                        }
                    }
                }
                _ => {}
            }
            if mac_shortcuts::take_start_batch() {
                if capture_task.as_ref().is_some_and(|task| !task.is_finished()) {
                    eprintln!("start batch unavailable during screenshot selection");
                } else if submit_task.as_ref().is_some_and(|task| !task.is_finished()) {
                    eprintln!("start batch unavailable during cloud submission");
                } else if let Err(e) = start_batch(&active_view) {
                    eprintln!("start batch failed: {e}");
                }
                let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
            }
            let full_capture = mac_shortcuts::take_capture();
            let region_capture = mac_shortcuts::take_capture_region();
            let left_capture = mac_shortcuts::take_capture_left();
            let right_capture = mac_shortcuts::take_capture_right();
            if full_capture || region_capture || left_capture || right_capture {
                if capture_task.as_ref().is_some_and(|task| !task.is_finished()) {
                    eprintln!("screenshot capture already in progress");
                } else if submit_task.as_ref().is_some_and(|task| !task.is_finished()) {
                    eprintln!("screenshot capture unavailable during cloud submission");
                } else {
                    let capture_mode = if full_capture { CaptureMode::Full }
                        else if left_capture { CaptureMode::Left }
                        else if right_capture { CaptureMode::Right }
                        else if region_capture { CaptureMode::Region }
                        else { CaptureMode::Full };
                    restore_overlay_after_capture = overlay_visible;
                    capture_active_view = Some(active_view.clone());
                    overlay_visible = false;
                    let _ = show_overlay(&overlay, false);
                    event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                    let view = active_view.clone();
                    capture_task = Some(rt.spawn_blocking(move || capture_screen(capture_mode, &view)));
                }
            }
            if mac_shortcuts::take_submit() {
                if capture_task.as_ref().is_some_and(|task| !task.is_finished()) {
                    eprintln!("finish the screenshot selection before submitting");
                } else if submit_task.as_ref().is_some_and(|task| !task.is_finished()) {
                    eprintln!("cloud submission already running");
                } else {
                    let gate = std::sync::Arc::clone(&cloud_gate);
                    let view = active_view.clone();
                    submit_task = Some(rt.spawn(async move {
                        let _lock = gate.lock().await;
                        if let Err(error) = submit_batch(&view).await {
                            eprintln!("submit failed: {error}");
                            let _ = update_pending_error(&view, &error);
                        }
                    }));
                }
                let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
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
            if overlay_visible && !history_open && active_view == "coding" && mac_shortcuts::take_scroll_up() {
                let _ = webview.evaluate_script("window.scrollSolutionBy(-260)");
            }
            if overlay_visible && !history_open && active_view == "coding" && mac_shortcuts::take_scroll_down() {
                let _ = webview.evaluate_script("window.scrollSolutionBy(260)");
            }
            if overlay_visible && active_view == "coding" && mac_shortcuts::take_fade_down() {
                overlay_alpha = (overlay_alpha - 0.07).max(0.18);
                let _ = set_ghost_opacity(&overlay, overlay_alpha);
            }
            if overlay_visible && active_view == "coding" && mac_shortcuts::take_fade_up() {
                overlay_alpha = (overlay_alpha + 0.07).min(0.95);
                let _ = set_ghost_opacity(&overlay, overlay_alpha);
            }
            // Arrows navigate only while HH history is visible. They are
            // observed by IOHID and do not capture normal application keys.
            if history_open && overlay_visible {
                if mac_shortcuts::take_history_back() {
                    if history_detail_open {
                        // First ← returns from the opened saved result to its
                        // selected row. Do not let an in-flight remote lookup
                        // reopen a result the person has deliberately left.
                        history_detail_open = false;
                        if let Some(task) = history_detail_fetch.take() { task.abort(); }
                        let rows = serde_json::to_string(&history_rows).unwrap_or_else(|_| "[]".into());
                        let _ = webview.evaluate_script(&format!(
                            "window.showSharedHistory({rows},{history_index},false,null)"));
                    } else {
                        // A second ← leaves History entirely and restores the
                        // live capture/working surface without changing the
                        // current batch or Council job.
                        history_open = false;
                        mac_shortcuts::set_history_visible(false);
                        let _ = webview.evaluate_script("window.closeSharedHistory()");
                        overlay_refresh.sent_state=None;
                        overlay_refresh.sent_previews=None;
                        let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                    }
                }
                if !history_detail_open && mac_shortcuts::take_history_previous() {
                    history_index = history_index.saturating_sub(1);
                    let _ = webview.evaluate_script(&format!(
                        "window.selectSharedHistoryRow({history_index})"));
                }
                if !history_detail_open && mac_shortcuts::take_history_next() {
                    history_index = (history_index + 1).min(history_rows.len().saturating_sub(1));
                    let _ = webview.evaluate_script(&format!(
                        "window.selectSharedHistoryRow({history_index})"));
                }
                if !history_detail_open && mac_shortcuts::take_history_open()
                    && history_detail_fetch.as_ref().is_none_or(|task| task.is_finished())
                {
                    if let Some(row) = history_rows.get(history_index).cloned() {
                        let title = row.get("title").and_then(Value::as_str).unwrap_or("Saved result").to_string();
                        history_detail_open = true;
                        history_detail_fetch = Some(rt.spawn(async move {
                            let mut detail = fetch_history_detail(row).await?;
                            if let Some(state) = detail.get_mut("state").and_then(Value::as_object_mut) {
                                state.insert("historyTitle".into(), Value::String(title));
                            }
                            Ok(detail)
                        }));
                        let _ = webview.evaluate_script("window.showSharedHistoryDetail({loading:true});");
                    }
                }
            } else {
                let _ = mac_shortcuts::take_history_previous();
                let _ = mac_shortcuts::take_history_next();
                let _ = mac_shortcuts::take_history_open();
                let _ = mac_shortcuts::take_history_back();
            }
            let requested_language=mac_shortcuts::take_language_command();
            if overlay_visible&&!history_open&&active_view=="coding"&&requested_language!=0 {
                let language=match requested_language {1=>"rust",2=>"cpp",3=>"python",_=>""};
                if !language.is_empty() {
                    let _=webview.evaluate_script(&format!("window.selectVerifiedOverlayLanguage({});",
                        serde_json::to_string(language).unwrap_or_else(|_|"\"\"".into())));
                }
            }
            // HH and arrow-only History doesn't change the active solving task.
            mac_shortcuts::set_history_visible(history_open && overlay_visible);
            mac_shortcuts::set_coding_overlay_visible(overlay_visible && active_view == "coding");
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

#[cfg(target_os = "macos")]
fn set_ghost_opacity(window: &Window, alpha: f64) -> Result<(), String> {
    use objc2_app_kit::NSWindow;
    unsafe {
        let ns_window = window.ns_window();
        if ns_window.is_null() {
            return Err("Overlay NSWindow unavailable".into());
        }
        (&*ns_window.cast::<NSWindow>()).setAlphaValue(alpha.clamp(0.18, 0.95));
    }
    Ok(())
}

fn show_overlay(window: &Window, visible: bool) -> Result<(), String> {
    window.set_always_on_top(true);
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| format!("Could not set ghost click-through: {e}"))?;
    window.set_visible(visible);

    // `set_visible` alone does not bring an inactive application's window
    // above the foreground application. Keep this overlay click-through and
    // non-key, but explicitly order it to the front so its global shortcut
    // works from any app, Space, or full-screen desktop.
    #[cfg(target_os = "macos")]
    if visible {
        use objc2_app_kit::NSWindow;

        unsafe {
            let ns_window = window.ns_window();
            if ns_window.is_null() {
                return Err("Overlay NSWindow unavailable".into());
            }
            (&*ns_window.cast::<NSWindow>()).orderFrontRegardless();
        }
    }

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

fn pending_path_for(view: &str) -> Result<PathBuf, String> {
    let name = if view == "mcq" { "pending-mcq-batch.json" } else { "pending-batch.json" };
    Ok(cache_dir()?.join(name))
}

fn submitted_job_path_for(view: &str) -> Result<PathBuf, String> {
    let name = if view == "mcq" { "submitted-mcq-job.json" } else { "submitted-job.json" };
    Ok(cache_dir()?.join(name))
}
fn archive_job(job: &SubmittedJob) -> Result<(), String> {
    let dir = cache_dir()?.join("job-history");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_private(&dir.join(format!("{}.json", job.id)), serde_json::to_vec(job).map_err(|e| e.to_string())?)
       .map_err(|e| e.to_string())
}
fn last_good_settings_path() -> Result<PathBuf, String> {
    Ok(cache_dir()?.join("last-good-settings.json"))
}

/// A normalized history-row schema for the helper's persisted cloud jobs.
/// IDs remain namespaced because a queued cloud job and a main-app run are
/// distinct artifacts even if the UI assigns them the same title.
fn history_row(id: &str, origin: &str, kind: &str, title: &str, subtitle: &str,
               status: &str, at: &str) -> Value {
    serde_json::json!({
        "id": id, "origin": origin, "kind": kind, "title": title,
        "subtitle": subtitle, "status": status, "submittedAt": at
    })
}

fn normalize_history(rows: Vec<Value>) -> Result<Vec<Value>, String> {
    let mut map = std::collections::HashMap::<String,Value>::new();
    for row in rows {
        let Some(id)=row.get("id").and_then(Value::as_str).map(str::to_owned) else { continue; };
        if let Some(old) = map.get(&id) {
            let a=old.get("origin").and_then(Value::as_str).unwrap_or("");
            let b=row.get("origin").and_then(Value::as_str).unwrap_or("");
            if a=="Overlay" && b=="Overlay" && old.get("status").and_then(Value::as_str)==Some("completed") {
                // A saved completed result should not be replaced by an
                // older, queued snapshot with the same job ID.
                continue;
            }
        }
        map.insert(id,row);
    }
    let mut results: Vec<Value> = map.into_values().collect();
    results.sort_by(|a,b| b.get("submittedAt").and_then(Value::as_str).unwrap_or("")
        .cmp(a.get("submittedAt").and_then(Value::as_str).unwrap_or("")));
    Ok(results)
}

/// Uses only existing, account-scoped API operations. No new schema or
/// privileged keys on macOS. Fetch main-app runs from BOTH active and archived
/// sessions; fetch cloud queued-job history separately; fold local snapshots
/// in for items no longer in the API's most-recent-job page.
async fn fetch_unified_history() -> Result<(Vec<Value>,Option<String>), String> {
    // `history.list` is a single, account-scoped, server-authoritative read.
    // The overlay calls it while History is visible, so this list never depends
    // on local cache files or on a separate overlay-only history database.
    let payload = api("history.list", serde_json::json!({})).await?;
    let mut rows = Vec::new();
    let mut sessions=std::collections::HashMap::<String, Value>::new();
    for item in payload.get("sessions").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id)=item.get("id").and_then(Value::as_str) {
            sessions.insert(id.to_owned(),item.clone());
        }
    }
    // Overlay jobs are owned by a session. The worker renames the same
    // session after it understands the captured problem, so use that one title
    // for the overlay without importing main-app runs into HH.
    for item in payload.get("jobs").and_then(Value::as_array).into_iter().flatten() {
        let id=item.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty(){continue;}
        let mode=item.get("mode").and_then(Value::as_str).unwrap_or("council");
        let session_title=item.get("sessionId").and_then(Value::as_str)
            .and_then(|session_id| sessions.get(session_id))
            .and_then(|session| session.get("title").and_then(Value::as_str))
            .filter(|title| !title.trim().is_empty());
        let title=session_title
            .or_else(|| item.get("resultSummary").and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
            .unwrap_or(if mode=="mcq"{"MCQ screenshot task"}else{"Coding screenshot task"});
        rows.push(history_row(&format!("job:{id}"),"Overlay",
            if mode=="mcq"{"MCQ"}else{"Coding"}, title,
            item.get("resultSummary").and_then(Value::as_str).unwrap_or(""),
            item.get("status").and_then(Value::as_str).unwrap_or("unknown"),
            item.get("createdAt").and_then(Value::as_str).unwrap_or("")));
    }
    let rows=normalize_history(rows)?;
    Ok((rows,None))
}

/// Main-app runs persist the live desktop Council state as
/// `{ council, review }`, whereas cloud jobs persist the already-normalized
/// worker report.  Adapt the former into the latter shape before handing it to
/// the overlay.  This keeps History honest (only saved data is shown) while
/// preserving the winner, E2B evidence, runtime data, complexity and verified
/// language ports that the main app already saved.
fn main_council_history_report(council: &Value) -> Value {
    let candidates = council.get("candidates").cloned().unwrap_or_else(|| Value::Array(Vec::new()));
    let winner = council.get("winner").and_then(Value::as_str).unwrap_or("").trim();
    let runs = council.get("runs").cloned().unwrap_or_else(|| serde_json::json!({}));
    let revised_runs = council.get("revisedRuns").cloned().unwrap_or_else(|| serde_json::json!({}));
    let candidate_rows = candidates.as_array().cloned().unwrap_or_default();

    let evidence: Vec<Value> = candidate_rows.iter().map(|candidate| {
        let letter = candidate.get("letter").and_then(Value::as_str).unwrap_or("?");
        let revised = candidate.pointer("/revised/code").and_then(Value::as_str)
            .is_some_and(|code| !code.trim().is_empty());
        let run = if revised { revised_runs.get(letter) } else { runs.get(letter) }
            .unwrap_or(&Value::Null);
        let ran = run.get("ran").and_then(Value::as_bool).unwrap_or(false);
        let passed = run.get("passed").and_then(Value::as_u64).unwrap_or(0);
        let failed = run.get("failed").and_then(Value::as_u64).unwrap_or(0);
        let ok = run.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let gate = if ran && ok && passed > 0 && failed == 0 { "pass" }
            else if ran { "fail" } else { "untested" };
        serde_json::json!({
            "letter": letter,
            "model": candidate.get("model").and_then(Value::as_str).unwrap_or("Council agent"),
            "gate": gate,
            "passed": passed,
            "failed": failed,
            "revised": revised,
            "runtime": run.get("runtime").and_then(Value::as_str).unwrap_or(""),
            "elapsedMs": run.get("remoteElapsedMs").and_then(Value::as_i64)
                .or_else(|| run.get("durationMs").and_then(Value::as_i64)),
            "peakMemoryKb": run.get("peakMemoryKb").and_then(Value::as_i64),
            "note": run.get("note").and_then(Value::as_str).unwrap_or(""),
        })
    }).collect();

    let selected = candidate_rows.iter().find(|candidate| candidate.get("letter")
        .and_then(Value::as_str).is_some_and(|letter| letter.eq_ignore_ascii_case(winner)));
    let selected_final = selected.and_then(|candidate| {
        let revised = candidate.pointer("/revised/code").and_then(Value::as_str)
            .is_some_and(|code| !code.trim().is_empty());
        if revised { candidate.get("revised") } else { candidate.get("final") }
    });
    let winner_evidence = evidence.iter().find(|row| row.get("letter").and_then(Value::as_str)
        .is_some_and(|letter| letter.eq_ignore_ascii_case(winner)));
    let verified = winner_evidence.is_some_and(|row| row.get("gate").and_then(Value::as_str) == Some("pass"));
    let code = selected_final.and_then(|final_| final_.get("code")).and_then(Value::as_str)
        .filter(|code| !code.trim().is_empty()).unwrap_or("");
    let language = selected_final.and_then(|final_| final_.get("language")).and_then(Value::as_str).unwrap_or("");
    let complexity = selected_final.and_then(|final_| final_.get("complexity")).and_then(Value::as_str).unwrap_or("");
    let approach = council.pointer("/dossier/synthesis/approach").and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| council.get("synthesis").and_then(Value::as_str)).unwrap_or("");
    let time = council.pointer("/dossier/judges/0/reviews/0/time").and_then(Value::as_str).unwrap_or("");
    let space = council.pointer("/dossier/judges/0/reviews/0/space").and_then(Value::as_str).unwrap_or("");
    let provenance = selected.map(|candidate| format!("Candidate {winner} — {}",
        candidate.get("model").and_then(Value::as_str).unwrap_or("Council"))).unwrap_or_default();

    serde_json::json!({
        "candidates": candidates,
        "runs": runs,
        "revisedRuns": revised_runs,
        "winner": winner,
        "ports": council.get("ports").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "presentation": {
            "standing": if verified { "verified" } else { "unverified" },
            "provenance": provenance,
            "approach": approach,
            "timeComplexity": time,
            "spaceComplexity": space,
            "complexity": complexity,
            "code": if verified { code } else { "" },
            "language": if verified { language } else { "" },
            "evidence": evidence,
            "dissent": [],
            "rejected": [],
        }
    })
}

/// Fetch a saved result only after the person opens it from History. The list
/// itself stays metadata-only and every detail read remains account-scoped.
async fn fetch_history_detail(row: Value) -> Result<Value, String> {
    let id = row.get("id").and_then(Value::as_str).unwrap_or("");
    if let Some(job_id) = id.strip_prefix("job:") {
        // History is deliberately server-authoritative: do not allow an old
        // local helper snapshot to hide a newer completed Council report.
        let report = api("reports.get", serde_json::json!({"jobId": job_id})).await?;
        let body = report.get("report").unwrap_or(&report);
        return Ok(serde_json::json!({"state": history_coding_state(job_id, body)}));
    }
    if let Some(run_id) = id.strip_prefix("main:") {
        let payload = api("runs.get", serde_json::json!({"runId": run_id})).await?;
        if let Some(council) = payload.pointer("/report/council").filter(|council| council.is_object()) {
            let report = main_council_history_report(council);
            return Ok(serde_json::json!({"state": history_coding_state(run_id, &report)}));
        }
        if let Some(report) = payload.get("report").filter(|report| !report.is_null()) {
            let body = report.get("report").unwrap_or(report);
            return Ok(serde_json::json!({"state": history_coding_state(run_id, body)}));
        }
        let responses = payload.get("responses").and_then(Value::as_array).cloned().unwrap_or_default();
        let picked = responses.iter().find(|response| response.get("finalCode").and_then(Value::as_str)
            .is_some_and(|code| !code.trim().is_empty()));
        let summary = payload.pointer("/verdict/detail").and_then(Value::as_str)
            .or_else(|| payload.pointer("/verdict/headline").and_then(Value::as_str))
            .or_else(|| picked.and_then(|response| response.get("finalAnswer").and_then(Value::as_str)))
            .unwrap_or("No saved verdict detail.");
        let solution = picked.and_then(|response| response.get("finalCode").and_then(Value::as_str)
            .filter(|code| !code.trim().is_empty()).map(|code| serde_json::json!({
                "language": picked.and_then(|response| response.get("finalLanguage").and_then(Value::as_str)).unwrap_or(""),
                "code": code,
            })));
        return Ok(serde_json::json!({"state": {
            "runId": run_id, "kind": "coding", "phase": "done", "status": "completed",
            "progress": "Saved main-app result", "agents": [], "tests": [], "ports": [],
            "presentation": {"approach": summary},
            "solution": solution.map(|solution| serde_json::json!({
                "title": "saved_solution", "language": solution["language"], "code": solution["code"],
                "source": "Saved main-app run", "status": "reviewed"
            }))
        }}));
    }
    Err("The selected history item has no supported source identifier.".into())
}

/// Reuse the normal, professional coding-overlay state for an archived Council
/// report. History never invents a result: it only displays the report and
/// verified language ports which were already saved for that exact run.
fn history_coding_state(job_id: &str, body: &Value) -> Value {
    let job = SubmittedJob {
        id: job_id.to_string(), mode: "coding".to_string(), mcq_model: None,
        status: "completed".to_string(), progress_phase: "completed".to_string(),
        submitted_at: String::new(), previews: Vec::new(), error: None,
        report: Some(serde_json::json!({"report": body})), events: Vec::new(),
    };
    let mut state = coding_overlay_state(&job);
    if let Some(object) = state.as_object_mut() {
        object.insert("ports".to_string(), body.get("ports").cloned().unwrap_or_else(|| Value::Array(Vec::new())));
        object.insert("historyResult".to_string(), Value::Bool(true));
    }
    state
}

fn clean_expired_capture_dirs() -> Result<(), String> {
    let root = cache_dir()?.join("captures");
    let Ok(entries) = fs::read_dir(&root) else { return Ok(()); };
    let mut protected = std::collections::HashSet::new();
    for view in ["coding", "mcq"] {
        if let Some(pending) = read_pending_for(view)? { protected.insert(pending.id); }
    }
    let mut jobs = Vec::new();
    for view in ["coding", "mcq"] {
        if let Some(current) = read_submitted_job_for(view)? { jobs.push(current); }
    }
    if let Ok(history) = fs::read_dir(cache_dir()?.join("job-history")) {
        for file in history.flatten() {
            if let Ok(raw) = fs::read_to_string(file.path()) {
                if let Ok(job) = serde_json::from_str::<SubmittedJob>(&raw) {
                    jobs.push(job);
                }
            }
        }
    }
    for job in jobs {
        for preview in job.previews {
            if let Ok(relative) = std::path::Path::new(&preview).strip_prefix(&root) {
                if let Some(first) = relative.components().next() {
                    protected.insert(first.as_os_str().to_string_lossy().into_owned());
                }
            }
        }
    }
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || protected.contains(&entry.file_name().to_string_lossy().to_string()) { continue; }
        let expired = entry.metadata().ok().and_then(|m| m.modified().ok())
            .and_then(|date| std::time::SystemTime::now().duration_since(date).ok())
            .is_some_and(|age| age >= Duration::from_secs(7 * 24 * 3600));
        if expired { let _ = fs::remove_dir_all(path); }
    }
    Ok(())
}

fn captures_dir(batch_id: &str) -> Result<PathBuf, String> {
    Ok(cache_dir()?.join("captures").join(batch_id))
}

fn write_private(path: &std::path::Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    // The UI reads these files while background tasks persist them. Write a
    // private temporary file, then atomically replace the complete snapshot.
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let temporary = path.with_file_name(format!(".{name}-{}.tmp", Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(contents.as_ref())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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

fn save_pending_for(view: &str, batch: &PendingBatch) -> Result<(), String> {
    let path = pending_path_for(view)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create helper state directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(batch).map_err(|e| e.to_string())?;
    write_private(&path, json).map_err(|e| format!("Could not save helper batch: {e}"))
}

fn read_pending_for(view: &str) -> Result<Option<PendingBatch>, String> {
    let path = pending_path_for(view)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Could not read helper batch: {e}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("Could not parse helper batch: {e}"))
}

fn save_submitted_job_for(view: &str, job: &SubmittedJob) -> Result<(), String> {
    let path = submitted_job_path_for(view)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create helper state directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(job).map_err(|e| e.to_string())?;
    write_private(&path, json).map_err(|e| format!("Could not save submitted job: {e}"))
}

fn read_submitted_job_for(view: &str) -> Result<Option<SubmittedJob>, String> {
    let path = submitted_job_path_for(view)?;
    if path.exists() {
        let raw = fs::read_to_string(path).map_err(|e| format!("Could not read submitted job: {e}"))?;
        let job: SubmittedJob = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        return Ok((job.mode == if view == "mcq" { "mcq" } else { "council" }).then_some(job));
    }
    // Older versions stored both workflows in one file. Recover a legacy MCQ
    // result into its own view until the next refresh writes the separated file.
    if view == "mcq" {
        let legacy = cache_dir()?.join("submitted-job.json");
        if legacy.exists() {
            let raw = fs::read_to_string(legacy).map_err(|e| format!("Could not read legacy submitted job: {e}"))?;
            let job: SubmittedJob = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            return Ok((job.mode == "mcq").then_some(job));
        }
    }
    Ok(None)
}

fn update_pending_error(view: &str, message: &str) -> Result<(), String> {
    if let Some(mut batch) = read_pending_for(view)? {
        batch.status = "ready".to_string();
        batch.error = Some(message.to_string());
        save_pending_for(view, &batch)?;
    }
    Ok(())
}

fn start_batch(view: &str) -> Result<(), String> {
    // Do not orphan screenshots when the start shortcut is pressed twice.
    // The existing ordered batch remains available until it is submitted.
    if let Some(existing) = read_pending_for(view)? {
        if !existing.images.is_empty() {
            return Err(format!("Batch {} already contains {} screenshot(s). Submit it before starting another.", existing.id, existing.images.len()));
        }
    }
    let id = format!("batch-{}", Uuid::new_v4());
    // Keep the previous submitted job visible while collecting the next batch.
    let batch = PendingBatch {
        id: id.clone(),
        status: "collecting".to_string(),
        started_at: now(),
        submission_id: Some(Uuid::new_v4().to_string()),
        session_id: None,
        owner_id: None,
        settings_snapshot: None,
        mode: Some(if view == "mcq" { "mcq" } else { "council" }.to_string()),
        images: vec![],
        error: None,
    };
    fs::create_dir_all(captures_dir(&id)?)
        .map_err(|e| format!("Could not create capture directory: {e}"))?;
    save_pending_for(view, &batch)?;
    log(&format!("started {id}"));
    Ok(())
}

/// Remove only the active, unsubmitted capture batch for one overlay view.
/// History and submitted job records deliberately remain available.
fn reset_pending_batch(view: &str) -> Result<(), String> {
    if let Some(batch) = read_pending_for(view)? {
        let captures_root = cache_dir()?.join("captures");
        let capture_dir = captures_dir(&batch.id)?;
        if capture_dir.parent() != Some(captures_root.as_path()) {
            return Err("Refusing to clear an unexpected capture location.".into());
        }
        if capture_dir.exists() {
            fs::remove_dir_all(&capture_dir)
                .map_err(|e| format!("Could not clear staged screenshots: {e}"))?;
        }
    }
    let pending = pending_path_for(view)?;
    if pending.exists() {
        fs::remove_file(&pending).map_err(|e| format!("Could not clear the staged batch: {e}"))?;
    }
    Ok(())
}

/// Remove only the newest unsubmitted capture from one overlay batch.
/// Submitted jobs and their retained preview files are never touched.
fn remove_last_pending_image(view: &str) -> Result<bool, String> {
    let Some(mut batch) = read_pending_for(view)? else { return Ok(false); };
    let Some(image) = batch.images.pop() else { return Ok(false); };
    let capture_dir = captures_dir(&batch.id)?;
    let image_path = Path::new(&image.local_path);
    if image_path.parent() != Some(capture_dir.as_path()) {
        return Err("Refusing to remove a capture outside the active batch directory.".into());
    }
    if image_path.exists() {
        fs::remove_file(image_path)
            .map_err(|e| format!("Could not remove the newest staged screenshot: {e}"))?;
    }
    for (index, remaining) in batch.images.iter_mut().enumerate() {
        remaining.position = index + 1;
    }
    batch.status = "collecting".to_string();
    batch.error = None;
    save_pending_for(view, &batch)?;
    Ok(true)
}

#[derive(Clone, Copy)]
enum CaptureMode { Full, Region, Left, Right }

fn helper_capture_mode(digit: u8) -> Option<CaptureMode> {
    match digit {
        1 => Some(CaptureMode::Full),
        2 => Some(CaptureMode::Left),
        3 => Some(CaptureMode::Right),
        4 => Some(CaptureMode::Region),
        _ => None,
    }
}

/// Commands for the three overlay surfaces. This records only C, M or H,
/// never text typed into applications. The OS HID callback uses physical
/// key usages, making caps lock and shift equivalent for this command.
fn double_tap_panel(previous: &mut Option<(u8, Instant)>, key: u8, at: Instant) -> Option<u8> {
    let matched = previous.as_ref().is_some_and(|(last, time)|
        *last == key && at.saturating_duration_since(*time) <= Duration::from_millis(650)
    );
    *previous = if matched { None } else { Some((key, at)) };
    if matched { Some(key) } else { None }
}

fn number_pair_command(first: u8, second: u8) -> Option<u8> {
    match first {
        0 if second == 0 => Some(6),
        1 if second <= 4 => Some(10 + second),
        2 if second == 0 || (2..=5).contains(&second) => Some(20 + second),
        3 if (1..=5).contains(&second) => Some(30 + second),
        _ => None,
    }
}

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

fn capture_screen(mode: CaptureMode, view: &str) -> Result<(), String> {
    // A screenshot shortcut must work even when the main app is closed and the
    // user has not explicitly started a batch. Reuse a pending batch for
    // successive screenshots instead of silently replacing earlier captures.
    if read_pending_for(view)?.is_none() {
        start_batch(view)?;
    }
    let mut batch = read_pending_for(view)?.ok_or("Could not initialize screenshot batch.".to_string())?;
    if batch.images.len() >= MAX_IMAGES {
        batch.status = "ready".to_string();
        batch.error = Some(format!("A helper batch can hold {MAX_IMAGES} screenshots."));
        save_pending_for(view, &batch)?;
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
        save_pending_for(view, &batch)?;
        return Err(msg);
    }

    let bytes = fs::metadata(&path)
        .map_err(|e| format!("Could not inspect captured screenshot: {e}"))?
        .len() as i64;
    if bytes <= 0 {
        batch.error = Some("Captured screenshot was empty.".to_string());
        save_pending_for(view, &batch)?;
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
    save_pending_for(view, &batch)?;
    log(&format!("captured image {} for {}", position + 1, batch.id));
    Ok(())
}

async fn submit_batch(active_view: &str) -> Result<(), String> {
    // New submissions never depend on downloading an older job's report.
    let mut batch = read_pending_for(active_view)?
        .ok_or("No helper batch is waiting to submit.".to_string())?;
    if batch.images.is_empty() {
        return Err("The helper batch has no screenshots.".to_string());
    }
    // Do not upload a batch with missing or empty local files. Validate every
    // entry before creating a remote session or uploading partial screenshots.
    for image in &batch.images {
        let metadata = fs::metadata(&image.local_path)
            .map_err(|e| format!("Screenshot {} is unavailable: {e}", image.file_name))?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(format!("Screenshot {} is missing or empty; batch retained.", image.file_name));
        }
    }
    if batch.submission_id.is_none() {
        batch.submission_id = Some(Uuid::new_v4().to_string());
    }
    batch.status = "submitting".into();
    batch.error = None;
    save_pending_for(active_view, &batch)?;

    // Never continue a saved submission with another user's credentials.
    let owner = api("auth.whoami", serde_json::json!({})).await?;
    let owner_id = owner["userId"].as_str().ok_or("Account identity unavailable.")?.to_string();
    if batch.owner_id.as_deref().is_some_and(|saved| saved != owner_id) {
        return Err("Account changed; this batch belongs to a different account.".into());
    }
    batch.owner_id = Some(owner_id.clone());
    save_pending_for(active_view, &batch)?;

    let mut user_settings = if let Some(snapshot) = batch.settings_snapshot.clone() {
        snapshot
    } else {
        let loaded = api("settings.load", serde_json::json!({ "key": SETTINGS_KEY })).await;
        let settings = match loaded {
            Ok(value) if value.is_object() => {
                let sanitized = sanitize_settings(value);
                let cached = serde_json::json!({
                    "version": 1, "ownerId": owner_id, "settings": sanitized, "savedAt": now()
                });
                let path = last_good_settings_path()?;
                write_private(&path, serde_json::to_vec(&cached).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                sanitized
            }
            _ => {
                let raw = fs::read_to_string(last_good_settings_path()?).ok();
                let cached = raw.and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .filter(|value| value["version"] == 1 && value["ownerId"].as_str() == Some(owner_id.as_str()));
                let Some(value) = cached.and_then(|value| value.get("settings").cloned())
                    .filter(|value| value.is_object()) else {
                    return Err("Settings unavailable. No verified cached settings for this account; batch retained.".into());
                };
                log("Settings load failed; using last successfully loaded settings for this account.");
                value
            }
        };
        batch.settings_snapshot = Some(settings.clone());
        save_pending_for(active_view, &batch)?;
        settings
    };
    let mode = batch.mode.clone().unwrap_or_else(|| {
        if user_settings.get("overlayMode").and_then(Value::as_str) == Some("mcq") {
            "mcq".to_string()
        } else { "council".to_string() }
    });
    // The helper uses the SAME cloud Council job pipeline as the main app.
    // A Coding overlay submission must not be auto-routed into MCQ merely
    // because the desktop's saved overlay preference was "auto".
    // This override affects this one job snapshot, not account settings.
    user_settings["overlayMode"] = Value::String(
        if active_view == "mcq" { "mcq" } else { "code" }.to_string()
    );
    // Persist the submission surface with the job. This is metadata only;
    // both surfaces use the same Council engine and history store.
    user_settings["source"] = Value::String("overlay".to_string());
    user_settings["origin"] = Value::String("overlay".to_string());
    batch.mode = Some(mode.clone());
    save_pending_for(active_view, &batch)?;
    let mcq_model = if mode == "mcq" {
        user_settings.get("mcqModel").and_then(Value::as_str).map(str::trim)
           .filter(|s| !s.is_empty()).map(str::to_string)
    } else { None };
    let session_id = if let Some(id) = batch.session_id.clone() {
        id
    } else {
        let session = api("sessions.create", serde_json::json!({
            // Match the main app's replaceable session placeholder. The cloud
            // worker will rename it from the readers' problem understanding
            // once it has something meaningful to call this task.
            "title": format!("Session — {}", chrono::Utc::now().format("%Y-%m-%d %H:%M UTC"))
        })).await?;
        let id = session["id"].as_str().ok_or("Missing session ID")?.to_string();
        batch.session_id = Some(id.clone());
        save_pending_for(active_view, &batch)?;
        id
    };
    let mut images = vec![];
    let mut previews = vec![];
    for image in &batch.images {
        let bytes = fs::read(&image.local_path)
            .map_err(|e| format!("Could not read {}: {e}", image.file_name))?;
        previews.push(image.local_path.clone());
        let path = format!("{owner_id}/{session_id}/{}/{}-{}", batch.submission_id.as_deref().unwrap_or_default(), image.position, safe_segment(&image.file_name));
        let signed = api(
            "storage.azureUploadUrl",
            serde_json::json!({ "path": path }),
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
            .header("x-ms-blob-type", "BlockBlob")
            .header("x-ms-version", AZURE_STORAGE_VERSION)
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
            "submissionId": batch.submission_id,
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
    if let Some(previous) = read_submitted_job_for(active_view)? {
        if previous.id != job_id { archive_job(&previous)?; }
    }
    save_submitted_job_for(active_view, &SubmittedJob {
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

    // Retain referenced preview files until recovery/retention cleanup.
    let _ = fs::remove_file(pending_path_for(active_view)?);
    log(&format!("submitted {} as job {job_id}", batch.id));
    Ok(())
}

fn is_usable_cloud_report(report: &Value, expected_id: &str) -> bool {
    if report.is_null() { return false; }
    let body = report.get("report").unwrap_or(report);
    // Validate both envelope and payload IDs: an inner report can refer to
    // another run even if the outer wrapper has the expected identifier.
    for layer in [report, body] {
        let report_id = layer.get("job_id").or_else(|| layer.get("jobId"))
            .and_then(Value::as_str);
        if report_id.is_some_and(|id| id != expected_id) { return false; }
    }
    if body.get("stage").and_then(Value::as_str) == Some("provisional") {
        let item = body.get("provisional");
        return item.is_some_and(|p|
            p.get("status").and_then(Value::as_str) == Some("provisional")
            && p.get("code").and_then(Value::as_str).is_some_and(|code| !code.trim().is_empty())
            && p.get("passed").and_then(Value::as_u64).unwrap_or(0) > 0
            && p.get("failed").and_then(Value::as_u64).unwrap_or(1) == 0
        );
    }
    if body.get("kind").and_then(Value::as_str) == Some("mcq") {
        return body.pointer("/answer/label").and_then(Value::as_str)
            .is_some_and(|label| !label.trim().is_empty())
            || body.pointer("/answer/text").and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty());
    }
    let candidates_have_result = body.get("candidates")
        .and_then(Value::as_array)
        .is_some_and(|candidates| candidates.iter().any(|candidate| {
            candidate.pointer("/final/code").and_then(Value::as_str)
                .is_some_and(|code| !code.trim().is_empty())
                || candidate.get("text").and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty())
        }));
    let presentation_has_result = body.pointer("/presentation/code")
        .and_then(Value::as_str)
        .is_some_and(|code| !code.trim().is_empty());
    // A failed candidate's diagnostic text is not a solution; the council
    // response must contain an answer, not just logs from an aborted run.
    candidates_have_result || presentation_has_result
        || body.get("synthesis").and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
}

fn tracked_job_row<'a>(data: &'a Value, expected_id: &str) -> Option<&'a Value> {
    // jobs.get returns one object; older server versions only support jobs.list.
    if data.get("id").and_then(Value::as_str) == Some(expected_id) {
        return Some(data);
    }
    data.as_array()
        .or_else(|| data.get("jobs").and_then(Value::as_array))
        .or_else(|| data.get("items").and_then(Value::as_array))
        .and_then(|items| items.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(expected_id)))
}

async fn refresh_job() -> Result<(), String> {
    for view in ["coding", "mcq"] {
        if let Some(job) = read_submitted_job_for(view)? {
            save_submitted_job_for(view, &refresh_one_job(job).await?)?;
        }
    }
    // Poll two older unfinished jobs per tick. Preserve their reports separately.
    let dir = cache_dir()?.join("job-history");
    if let Ok(entries) = fs::read_dir(dir) {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        static NEXT_ARCHIVED: AtomicUsize = AtomicUsize::new(0);
        let mut paths: Vec<_> = entries.filter_map(Result::ok).map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|v| v.to_str()) == Some("json")).collect();
        paths.sort();
        let total = paths.len();
        let start = if total == 0 { 0 } else { NEXT_ARCHIVED.fetch_add(2, AtomicOrdering::Relaxed) % total };
        let mut count = 0;
        for index in 0..total {
            let path = &paths[(start + index) % total];
            if count >= 2 { break; }
            if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
            let Ok(raw) = fs::read_to_string(&path) else { continue; };
            let Ok(job) = serde_json::from_str::<SubmittedJob>(&raw) else { continue; };
            if matches!(job.status.as_str(), "failed" | "needs_attention" | "cancelled")
                || (job.status == "completed" && job.report.is_some()) { continue; }
            let result = refresh_one_job(job).await?;
            write_private(&path, serde_json::to_vec(&result).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    Ok(())
}
async fn refresh_one_job(mut tracked: SubmittedJob) -> Result<SubmittedJob, String> {
    if tracked.id.trim().is_empty() {
        return Err("Submitted background job has no cloud ID.".into());
    }
    if matches!(
        tracked.status.as_str(),
        "completed" | "failed" | "needs_attention" | "cancelled"
    ) && (tracked.status != "completed" || tracked.report.as_ref().is_some_and(|report| {
        let body = report.get("report").unwrap_or(report);
        body.get("stage").and_then(Value::as_str) != Some("provisional")
    }))
    {
        return Ok(tracked);
    }

    // Read the exact job by ID. Browsing is capped at 50 rows and cannot
    // reliably track a long-running solve. Older API deployments are supported
    // through a bounded fallback until the new operation is deployed.
    let status_data = if tracked.status == "completed" {
        Value::Null
    } else {
        match api("jobs.get", serde_json::json!({ "jobId": tracked.id })).await {
            Ok(job) => job,
            Err(error) => {
                log(&format!("Exact job lookup unavailable for {}: {error}", tracked.id));
                match api("jobs.list", serde_json::json!({ "status": "all" })).await {
                    Ok(rows) => rows,
                    Err(list_error) => {
                        log(&format!("Fallback job lookup unavailable for {}: {list_error}", tracked.id));
                        Value::Null
                    }
                }
            }
        }
    };
    if let Some(job) = tracked_job_row(&status_data, &tracked.id) {
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
        let rows = events.as_array()
            .or_else(|| events.get("events").and_then(Value::as_array))
            .or_else(|| events.get("items").and_then(Value::as_array));
        if let Some(rows) = rows {
            tracked.events = rows.clone();
        }
    }
    space_api_calls().await;

    // The cloud worker persists a verified preliminary solution before the
    // judges finish. Fetch that same account-bound report in-flight; never
    // treat an intermediate row as terminal or switch job identity.
    let live_ready = tracked.events.iter().any(|event| matches!(
        event.get("phase").and_then(Value::as_str),
        Some("provisional_solution_ready" | "primary_solution_ready" | "provisional_upgraded" | "port_verified")
    ));
    if tracked.status == "completed" || (tracked.status == "running" && live_ready) {
    let retry_path = cache_dir()?.join(format!("report-retry-{}.json", tracked.id));
    let retry: Value = fs::read_to_string(&retry_path).ok()
       .and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or(Value::Null);
    let current = chrono::Utc::now().timestamp_millis();
    if current < retry["nextAt"].as_i64().unwrap_or(0) { return Ok(tracked); }
    if let Ok(report) = api("reports.get", serde_json::json!({ "jobId": tracked.id })).await {
        if is_usable_cloud_report(&report, &tracked.id) {
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
            let _ = fs::remove_file(&retry_path);
            // A report may be partial or accompany a failed job. Trust the job status.
            if tracked.status == "completed" {
                tracked.progress_phase = "completed".to_string();
            }
        }
    }
    if tracked.status == "completed" && tracked.report.as_ref().is_none_or(|report| {
        report.get("report").unwrap_or(report).get("stage")
            .and_then(Value::as_str) == Some("provisional")
    }) {
        let attempts = retry["attempts"].as_u64().unwrap_or(0).saturating_add(1).min(20);
        let delay = (5_u64.saturating_mul(1_u64 << attempts.min(6))).min(300);
        let value = serde_json::json!({
            "attempts": attempts, "nextAt": current + (delay as i64 * 1000)
        });
        write_private(&retry_path, serde_json::to_vec(&value).map_err(|e| e.to_string())?)
           .map_err(|e| e.to_string())?;
        tracked.progress_phase = "report_pending".into();
    }
    }
    Ok(tracked)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PreviewFileKey {
    path: String,
    // Missing files have no identity and are retried on the next refresh.
    identity: Option<(u64, std::time::SystemTime)>,
}

fn preview_file_key(path: &str) -> PreviewFileKey {
    PreviewFileKey {
        path: path.to_string(),
        identity: fs::metadata(path).ok()
            .and_then(|metadata| metadata.modified().ok().map(|modified| (metadata.len(), modified))),
    }
}

#[derive(Default)]
struct OverlayRefresh {
    pending_keys: Vec<PreviewFileKey>,
    pending_sources: Vec<String>,
    preview_origin: String,
    submitted_sources: Vec<String>,
    sent_state: Option<String>,
    sent_previews: Option<String>,
}

impl OverlayRefresh {
    fn pending_sources(&mut self, paths: &[String]) -> &[String] {
        let keys: Vec<_> = paths.iter().map(|path| preview_file_key(path)).collect();
        if keys != self.pending_keys || keys.iter().any(|key| key.identity.is_none())
            || self.pending_sources.iter().any(|source| source.is_empty()) {
            // Reuse unchanged captures, including when a screenshot is appended.
            let sources = keys.iter().map(|key| {
                if key.identity.is_some() {
                    if let Some(index) = self.pending_keys.iter().position(|old| old == key) {
                        if let Some(source) = self.pending_sources.get(index) {
                            if !source.is_empty() { return source.clone(); }
                        }
                    }
                }
                fs::metadata(&key.path).ok()
                    .filter(|m| m.is_file() && m.len() <= 15 * 1024 * 1024)
                    .and_then(|_| fs::read(&key.path).ok())
                    .map(|bytes| format!("data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(bytes)))
                    .unwrap_or_default()
            }).collect();
            self.pending_keys = keys;
            self.pending_sources = sources;
        }
        &self.pending_sources
    }

    fn state_key(state: &str) -> String {
        // Projection timestamps describe refresh time, not a content change.
        if let Ok(mut value) = serde_json::from_str::<Value>(state) {
            if let Some(object) = value.as_object_mut() { object.remove("updatedAt"); }
            return value.to_string();
        }
        state.to_string()
    }

    fn script(&self, state: &str, previews: Option<&str>) -> String {
        let mut script = String::new();
        if self.sent_state.as_deref() != Some(Self::state_key(state).as_str()) {
            script.push_str(&format!("window.updateOverlayState({state});"));
        }
        if let Some(previews) = previews {
            if self.sent_previews.as_deref() != Some(previews) {
                script.push_str(&format!("window.updatePreviews({previews});"));
            }
        }
        script
    }
}

fn update_overlay(webview: &WebView, active_view: &str, refresh: &mut OverlayRefresh) -> Result<(), String> {
    let submitted = read_submitted_job_for(active_view)?;
    let running = submitted.as_ref().is_some_and(|job| {
        !matches!(job.status.as_str(), "completed" | "failed" | "needs_attention" | "cancelled")
    });
    // The overlay is showing the running job's solution, so show its input
    // screenshots too, not screenshots staged for the following job.
    let pending = read_pending_for(active_view)?;
    let pending_has_images = pending.as_ref().is_some_and(|batch| !batch.images.is_empty());
    // An explicit 00 session owns the Coding surface immediately, including
    // before its first image. The old cloud solve keeps running in the helper
    // and its saved record; don't display it over a new blank workspace.
    let coding_pending = active_view=="coding" && pending.is_some();
    let payload = if !coding_pending && (running || !pending_has_images) {
        let paths = submitted.as_ref().map(|job| job.previews.as_slice()).unwrap_or_default();
        let sources = if paths.iter().all(|path| path.starts_with("data:")) {
            paths.to_vec() // legacy job preview format
        } else { refresh.pending_sources(paths).to_vec() };
        if refresh.preview_origin != "submitted" || refresh.submitted_sources != sources {
            refresh.preview_origin = "submitted".into();
            refresh.submitted_sources = sources.clone();
            Some(serde_json::to_string(&sources).map_err(|e| e.to_string())?)
        } else { None }
    } else {
        let paths: Vec<_> = pending.as_ref().unwrap().images.iter()
            .map(|image| image.local_path.clone()).collect();
        let previous_keys = refresh.pending_keys.clone();
        let retrying_preview = refresh.pending_sources.iter().any(|source| source.is_empty());
        let origin_changed = refresh.preview_origin != "pending";
        refresh.pending_sources(&paths);
        refresh.preview_origin = "pending".into();
        if origin_changed || retrying_preview || previous_keys != refresh.pending_keys
            || refresh.pending_keys.iter().any(|key| key.identity.is_none())
            || refresh.pending_sources.iter().any(|source| source.is_empty())
        {
            let sources: Vec<_> = refresh.pending_sources.iter()
                .filter(|source| !source.is_empty()).collect();
            Some(serde_json::to_string(&sources).map_err(|e| e.to_string())?)
        } else {
            None
        }
    };
    // Keep the displayed state paired with the displayed screenshots.
    // A completed job remains available in the job cache while a subsequent
    // batch is being collected. Show pending state with pending thumbnails.
    let state = if coding_pending {
        serde_json::to_string(&coding_pending_state(pending.as_ref().unwrap()))
            .unwrap_or_else(|_| "{}".to_string())
    } else if !running {
        if let Some(batch) = pending.as_ref() {
            if pending_has_images {
                let pending_state = if active_view == "mcq" {
                    mcq_pending_state(&batch)
                } else {
                    coding_pending_state(&batch)
                };
                serde_json::to_string(&pending_state)
                    .unwrap_or_else(|_| read_overlay_state_snapshot(active_view, submitted.as_ref(), pending.as_ref()))
            } else {
                read_overlay_state_snapshot(active_view, submitted.as_ref(), pending.as_ref())
            }
        } else {
            read_overlay_state_snapshot(active_view, submitted.as_ref(), pending.as_ref())
        }
    } else {
        read_overlay_state_snapshot(active_view, submitted.as_ref(), pending.as_ref())
    };
    let script = refresh.script(&state, payload.as_deref());
    if script.is_empty() { return Ok(()); }
    if let Err(error) = webview.evaluate_script(&script) {
        refresh.preview_origin.clear();
        return Err(format!("Could not update ghost overlay: {error}"));
    }
    // Commit only after dispatch succeeds, so a failed update is retried.
    refresh.sent_state = Some(OverlayRefresh::state_key(&state));
    if let Some(payload) = payload { refresh.sent_previews = Some(payload); }
    Ok(())
}

fn read_overlay_state(active_view: &str) -> String {
    let submitted = read_submitted_job_for(active_view).ok().flatten();
    let pending = read_pending_for(active_view).ok().flatten();
    read_overlay_state_snapshot(active_view, submitted.as_ref(), pending.as_ref())
}

fn read_overlay_state_snapshot(active_view: &str, submitted: Option<&SubmittedJob>, pending: Option<&PendingBatch>) -> String {
    let fallback =
        r#"{"runId":null,"updatedAt":"","phase":"idle","agents":[],"solution":null,"tests":[]}"#;

    if let Some(job) = submitted {
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
        if let Some(batch) = pending {
            if batch.error.is_some() || !batch.images.is_empty() {
                return serde_json::to_string(&mcq_pending_state(&batch))
                    .unwrap_or_else(|_| fallback.to_string());
            }
        }
        return serde_json::to_string(&mcq_placeholder_state())
            .unwrap_or_else(|_| fallback.to_string());
    }

    if let Some(batch) = pending {
        if batch.error.is_some() || !batch.images.is_empty() {
            return serde_json::to_string(&coding_pending_state(&batch))
                .unwrap_or_else(|_| fallback.to_string());
        }
    }

    fallback.to_string()
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
    } else if batch.status == "submitting" {
        "Uploading screenshots and creating the cloud job...".to_string()
    } else if batch.images.is_empty() {
        "MCQ batch started. Capture screenshots, then submit.".to_string()
    } else {
        format!(
            "MCQ batch ready with {} screenshot{}. Submit with 24.",
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
    } else if batch.status == "submitting" {
        "Uploading screenshots and creating the cloud job...".to_string()
    } else if batch.images.is_empty() {
        "New Coding workspace ready. Capture screenshots, then submit with 24.".to_string()
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
        "agents": [], "progress": waiting, "solution": Value::Null, "tests": [],
    })
}

// Project only source-backed, read-only sidebar evidence. A listed harness
// assertion is not invented evidence: it comes from the stored reference test.
fn coding_sidebar_evidence(body:&Value)->Value {
    let p=body.get("presentation").unwrap_or(&Value::Null);
    let blueprint=body.get("semanticBlueprint").unwrap_or(&Value::Null);
    let structure=blueprint.get("structure").unwrap_or(&Value::Null);
    let summary=blueprint.get("explanation").and_then(Value::as_str).unwrap_or("");
    let approach=p.get("approach").and_then(Value::as_str)
        .filter(|s|!s.trim().is_empty()).unwrap_or(summary);
    let structures:Vec<String>=structure.get("dataStructures")
        .and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
        .take(6).map(|name|{
            let why=match name {
                "dictionaries / hash maps"=>"keyed lookup or counting",
                "sets"=>"membership and uniqueness checks",
                "lists / dynamic arrays"=>"ordered storage and traversal",
                "heaps / priority queues"=>"priority-based extraction",
                "binary search"=>"reducing a sorted search space",
                "sorting"=>"ordering values for comparison",
                _=>"operation found in source",
            };
            format!("{name} — {why} (inferred from code)")
        }).collect();
    let control=structure.get("controlFlow").and_then(Value::as_array)
        .into_iter().flatten().filter_map(Value::as_str).take(4)
        .collect::<Vec<_>>().join(", ");
    let language=p.get("language").and_then(Value::as_str).unwrap_or("");
    let verified=p.get("standing").and_then(Value::as_str)==Some("verified");
    let mut cases=Vec::<String>::new();
    if verified {
        for suite in body.get("suites").and_then(Value::as_array).into_iter().flatten(){
            if !language.is_empty() && suite.get("language").and_then(Value::as_str)!=Some(language) {continue;}
            if let Some(harness)=suite.get("harness").and_then(Value::as_str){
                for line in harness.lines(){
                    let line=line.trim();
                    if line.len()>9 && line.len()<170
                        && (line.starts_with("assert ") || line.starts_with("assert(")
                            || line.starts_with("assert_eq!") || line.starts_with("assert_eq(")
                            || line.starts_with("assertEqual("))
                        && !cases.iter().any(|existing|existing==line)
                    {
                        cases.push(line.to_owned());
                        if cases.len()>=4 {break;}
                    }
                }
            }
            if cases.len()>=4 {break;}
        }
    }
    let tests=p.get("evidence").and_then(Value::as_array)
        .into_iter().flatten().filter(|row|
            row.get("gate").and_then(Value::as_str)==Some("pass"))
        .map(|row|format!("Candidate {} · {} passed / {} failed in E2B",
            row.get("letter").and_then(Value::as_str).unwrap_or("?"),
            row.get("passed").and_then(Value::as_u64).unwrap_or(0),
            row.get("failed").and_then(Value::as_u64).unwrap_or(0)))
        .take(4).collect::<Vec<_>>().join("\n");
    serde_json::json!({
        "summary":summary.chars().take(480).collect::<String>(),
        "approach":approach.chars().take(800).collect::<String>(),
        "structures":structures,"controlFlow":control,"edgeCases":cases,
        "testing":tests,"edgeCoverageKnown":!cases.is_empty()
    })
}

fn coding_overlay_state(job: &SubmittedJob) -> Value {
    let progress = job_progress_message(job);
    let phase = match job.status.as_str() {
        "failed" | "needs_attention" | "cancelled" => "error",
        "completed" => "done",
        _ => "running",
    };
    let body = job.report.as_ref().map(|r| r.get("report").unwrap_or(r));
    let candidates: Vec<Value> = body.and_then(|b| b.get("candidates"))
        .and_then(Value::as_array).cloned().unwrap_or_default();
    let winner = body.and_then(|b| b.get("winner")).and_then(Value::as_str)
        .unwrap_or("").trim();
    let agents = if candidates.is_empty() {
        coding_agents_from_events(job)
    } else {
        candidates.iter().take(4).map(|candidate| {
            let letter = candidate.get("letter").and_then(Value::as_str).unwrap_or("?");
            let model = candidate.get("model").and_then(Value::as_str).unwrap_or("");
            let error = candidate.get("error").and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let has_code = candidate.pointer("/final/code").and_then(Value::as_str)
                .is_some_and(|code| !code.trim().is_empty());
            let gate = body.and_then(|b|b.pointer("/presentation/evidence"))
                .and_then(Value::as_array).into_iter().flatten()
                .find(|row|row.get("letter").and_then(Value::as_str)==Some(letter))
                .and_then(|row|row.get("gate").and_then(Value::as_str)).unwrap_or("untested");
            let status = if error.is_some() || gate=="fail" { "error" }
                else if has_code { "done" } else { "pending" };
            let detail = if error.is_some() { "Solver failed" }
                else if gate=="pass" && letter.eq_ignore_ascii_case(winner) {"Council winner · E2B passed"}
                else if gate=="pass" {"E2B tests passed · Council reviewed"}
                else if gate=="fail" {"Answer generated · E2B failed"}
                else if has_code {"Answer generated · validation pending"}
                else {"Awaiting model answer"};
            serde_json::json!({
                "id": letter, "label": model.rsplit('/').next().unwrap_or(model),
                "model": model, "status": status, "error": error,
                "detail": detail, "gate": gate
            })
        }).collect()
    };
    let solution = body.and_then(|b| coding_solution_from_report(b, winner, &candidates));
    let tests = body.map(coding_tests_from_report).unwrap_or_default();
    serde_json::json!({
        "runId": job.id, "updatedAt": now(), "kind": "coding",
        "phase": phase, "status": job.status,
        "progress": progress, "error": job.error,
        "agents": agents, "solution": solution, "tests": tests,
        "presentation": body.and_then(|b| b.get("presentation")).cloned(),
        "insights": body.map(coding_sidebar_evidence),
        "ports": body.and_then(|b|b.get("ports")).cloned().unwrap_or_else(||Value::Array(Vec::new())),
        "progressPhase": job.progress_phase,
        "upgrade": body.and_then(|b| b.get("upgrade")).cloned(),
        "solutionHistory": body.and_then(|b| b.get("solutionHistory")).cloned()
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
    // The saved Settings roster describes possible seats, not the final
    // eligible roster. Show cards only after the worker emits its authoritative
    // post-routing `solving` event.
    let models = job.events.iter().rev().find_map(|event| {
        if event.get("phase").and_then(Value::as_str) != Some("solving") {
            return None;
        }
        event.pointer("/payload/models").and_then(Value::as_array).map(|models| {
            models.iter().filter_map(Value::as_str).filter(|model| !model.trim().is_empty())
                .map(str::to_string).collect::<Vec<_>>()
        }).filter(|models| !models.is_empty())
    });
    let Some(models) = models else { return vec![]; };

    models.into_iter().take(4).enumerate().map(|(index, model)| {
        let event = job.events.iter().rev().find(|event| {
            event.pointer("/payload/model").and_then(Value::as_str) == Some(model.as_str())
                && matches!(event.get("phase").and_then(Value::as_str), Some("solver_done") | Some("solver_failed"))
        });
        let failed = event.is_some_and(|event| event.get("phase").and_then(Value::as_str) == Some("solver_failed"));
        let done = event.is_some_and(|event| event.get("phase").and_then(Value::as_str) == Some("solver_done"));
        let error = failed.then(|| event.and_then(|event| event.get("message").and_then(Value::as_str)).unwrap_or("Model failed.").to_string());
        let status = if failed { "error" } else if done { "done" } else if job.status == "queued" { "pending" } else { "running" };
        let detail = if failed { error.clone().unwrap_or_default() } else if done { "Answer ready; Council is continuing review.".to_string() } else if job.status == "queued" { "Waiting for Council to select eligible agents.".to_string() } else { "Generating candidate answer.".to_string() };
        let label = model.rsplit('/').next().unwrap_or(&model).replace('-', " ");
        serde_json::json!({ "id": format!("seat-{}", index + 1), "label": label, "model": model,
            "status": status, "detail": detail, "error": error })
    }).collect()
}

fn coding_solution_from_report(body: &Value, winner: &str, candidates: &[Value]) -> Option<Value> {
    // Early code may appear ONLY after the shared E2B gate approved it.
    if body.get("stage").and_then(Value::as_str) == Some("provisional") {
        let early = body.get("provisional")?;
        let code = early.get("code").and_then(Value::as_str)?.trim();
        if code.is_empty()
            || early.get("status").and_then(Value::as_str) != Some("provisional")
            || early.get("passed").and_then(Value::as_u64).unwrap_or(0) == 0
            || early.get("failed").and_then(Value::as_u64).unwrap_or(1) > 0
        { return None; }
        let lang = early.get("language").and_then(Value::as_str).unwrap_or("");
        let letter = early.get("letter").and_then(Value::as_str).unwrap_or("?");
        return Some(serde_json::json!({
            "title": format!("solution.{lang}"), "language": lang, "code": code,
            "source": format!("Candidate {letter} · E2B verified"), "status": "provisional"
        }));
    }
    // The cloud Council and desktop share the deterministic winner gates.
    // The synthesis' prose or an arbitrary candidate is never accepted as code.
    if body.pointer("/presentation/standing").and_then(Value::as_str) == Some("verified") {
        if let Some(code) = body.pointer("/presentation/code").and_then(Value::as_str)
            .map(str::trim).filter(|code| !code.is_empty()) {
            let lang = body.pointer("/presentation/language").and_then(Value::as_str).unwrap_or("");
            let source = body.pointer("/presentation/provenance").and_then(Value::as_str).unwrap_or("Council");
            return Some(serde_json::json!({
                "title": format!("solution.{lang}"), "language": lang, "code": code,
                "source": source, "status": "reviewed"
            }));
        }
    }
    // Legacy cloud reports without presentation still require actual matching
    // benchmark proof for the winner. Do not fall back to candidate A or logs.
    let chosen = candidates.iter().find(|candidate|
        candidate.get("letter").and_then(Value::as_str)
            .is_some_and(|letter| !winner.is_empty() && letter.eq_ignore_ascii_case(winner))
    )?;
    let revised = chosen.pointer("/revised/code").and_then(Value::as_str)
        .is_some_and(|code| !code.trim().is_empty());
    let runs = if revised { "revisedRuns" } else { "runs" };
    let evidence = body.get(runs)?.get(winner)?;
    if evidence.get("ran").and_then(Value::as_bool) != Some(true)
        || evidence.get("ok").and_then(Value::as_bool) != Some(true)
        || evidence.get("passed").and_then(Value::as_u64).unwrap_or(0) == 0
        || evidence.get("failed").and_then(Value::as_u64).unwrap_or(1) != 0
    { return None; }
    let final_code = if revised { chosen.get("revised") } else { chosen.get("final") }?;
    let code = final_code.get("code").and_then(Value::as_str)?.trim();
    if code.is_empty() { return None; }
    let lang = final_code.get("language").and_then(Value::as_str).unwrap_or("");
    Some(serde_json::json!({
        "title": format!("solution.{lang}"), "language": lang, "code": code,
        "source": chosen.get("model").and_then(Value::as_str).unwrap_or("Council"),
        "status": "reviewed"
    }))
}

fn coding_tests_from_report(body: &Value) -> Vec<Value> {
    // A provisional result has real E2B verification but no finalized Council
    // evidence rows yet. Report the measured passed count, never invented cases.
    if body.get("stage").and_then(Value::as_str) == Some("provisional") {
        if let Some(early) = body.get("provisional") {
            let passed = early.get("passed").and_then(Value::as_u64).unwrap_or(0);
            let failed = early.get("failed").and_then(Value::as_u64).unwrap_or(1);
            if passed > 0 && failed == 0 {
                let letter = early.get("letter").and_then(Value::as_str).unwrap_or("?");
                return vec![serde_json::json!({
                    "name": format!("Candidate {letter} · preliminary E2B"),
                    "input": early.get("language").and_then(Value::as_str).unwrap_or(""),
                    "expected": format!("{passed} executed test cases"),
                    "actual": format!("{passed} passed, 0 failed; Council review pending"),
                    "status": "passed"
                })];
            }
        }
    }
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
		      .hud-logo{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.14);color:rgba(255,255,255,.92);font-size:10px;font-weight:900;box-shadow:inset 0 1px 0 rgba(255,255,255,.28);flex:0 0 32px}
		      .hud-key,.hud-pause{display:grid;place-items:center;min-width:32px;height:28px;padding:0 10px;border-radius:8px;background:rgba(255,255,255,.13);box-shadow:inset 0 1px 0 rgba(255,255,255,.08);color:rgba(255,255,255,.9);flex:0 0 auto}
		      .hud-action{color:rgba(255,255,255,.68);margin-left:4px}
	      .hud-meter{display:inline-flex;align-items:end;gap:2px;height:18px;padding:0 2px}.hud-meter i{display:block;width:3px;border-radius:3px;background:rgba(205,224,242,.7);box-shadow:0 0 9px rgba(190,215,235,.18)}.hud-meter i:nth-child(1){height:7px}.hud-meter i:nth-child(2){height:12px}.hud-meter i:nth-child(3){height:9px}
	      #panel{box-sizing:border-box;width:100%;flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;border:1px solid rgba(255,255,255,.26);border-radius:18px;background:radial-gradient(circle at 50% 18%,rgba(205,222,239,.10),transparent 28%),linear-gradient(135deg,var(--panel-a),var(--panel-b)),var(--panel-base);box-shadow:0 0 0 1px rgba(255,255,255,.09),inset 0 1px 0 rgba(255,255,255,.22),0 18px 48px var(--panel-shadow);backdrop-filter:blur(20px) saturate(1.22);overflow:hidden}
            .pane{min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:18px;overflow:hidden}.pane+ .pane{border-left:1px solid var(--pane-line)}
            .pictures-pane{align-items:flex-start}
            .title{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.95;text-shadow:0 1px 2px var(--title-shadow)}
	            .picture-list{box-sizing:border-box;width:100%;min-height:48px;display:flex;flex-direction:row;align-items:center;gap:5px;padding:5px;border:1.5px dashed var(--dash-line);border-radius:10px;background:var(--soft-fill);overflow-x:auto;overflow-y:hidden}
            .picture-pill{position:relative;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
            .picture-count{position:absolute;right:4px;bottom:4px;padding:2px 5px;border-radius:5px;background:rgba(0,0,0,.58);color:rgba(255,255,255,.95);font-size:10px;font-weight:700;line-height:1}
	            img{display:block;width:44px;height:33px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,.36)}
            .divider{width:100%;height:1px;margin:8px 0 2px;background:var(--pane-line)}
            .solution-status{box-sizing:border-box;width:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
            .model-chip{display:grid;grid-template-columns:9px minmax(0,1fr);grid-template-rows:auto auto auto;align-items:center;column-gap:7px;row-gap:2px;min-width:0;padding:10px 11px;border:1px solid rgba(255,255,255,.18);border-radius:11px;background:linear-gradient(135deg,rgba(255,255,255,.13),rgba(255,255,255,.045));box-shadow:inset 0 1px 0 rgba(255,255,255,.14);font-size:10px;color:var(--muted)}
            .model-chip b{min-width:0;font-size:11px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .model-chip span:last-child{grid-column:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .model-chip .agent-model{grid-column:2;color:rgba(255,255,255,.54);font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.36);box-shadow:0 0 0 3px rgba(255,255,255,.08);flex:0 0 auto}
            .model-chip[data-state="done"] .dot{background:#39d98a;box-shadow:0 0 0 3px rgba(57,217,138,.16)}
            .model-chip[data-state="working"] .dot{background:#ffd166;box-shadow:0 0 0 3px rgba(255,209,102,.16)}
            .model-chip[data-state="error"] .dot{background:#ff6b6b;box-shadow:0 0 0 3px rgba(255,107,107,.16)}
            .model-chip[data-state="cancelled"] .dot{background:rgba(255,255,255,.22);box-shadow:0 0 0 3px rgba(255,255,255,.08)}
            .model-chip[data-state="pending"] .dot{background:rgba(255,255,255,.38)}
            .agent-header{box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:2px}
            .agent-header .title{font-size:11px}.agent-summary{color:var(--muted);font-size:10px;white-space:nowrap}
            .overlay-progress,.overlay-diagnostics{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid rgba(114,159,255,.34);border-radius:9px;background:rgba(67,112,199,.12);color:rgba(231,240,255,.86);font-size:10px;line-height:1.35}
            .overlay-history-context{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid rgba(201,228,245,.45);border-radius:9px;background:rgba(201,228,245,.10);color:rgba(255,246,188,.96);font-size:10px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .overlay-diagnostics{border-color:rgba(255,107,107,.48);background:rgba(255,107,107,.1);color:rgba(255,226,226,.94)}
            .overlay-diagnostics b{display:block;margin-bottom:2px;color:#ffd7d7}
	            .solution-editor{box-sizing:border-box;width:100%;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border:1px solid var(--panel-line);border-radius:9px;background:var(--editor-bg);overflow:hidden}
            .editor-head,.tests-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.76);font-size:11px}
            .editor-head b,.tests-head b{color:rgba(255,255,255,.95)}
	            .code-lines{flex:1;min-height:0;margin:0;padding:13px 0;color:var(--code-text);font:500 12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:auto;counter-reset:code-line}
	            .code-lines li{display:grid;grid-template-columns:42px minmax(0,1fr);min-height:20px;padding:0 14px 0 0;list-style:none;counter-increment:code-line}
	            .code-lines li:before{content:counter(code-line);padding-right:12px;text-align:right;color:rgba(255,255,255,.3)}
	            .code-lines code{display:block;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
            .kw{color:var(--kw)}.fn{color:var(--fn)}.arg{color:var(--arg)}.num{color:var(--num)}.str{color:var(--str)}.built{color:var(--built)}.op{color:var(--op)}.cm{color:var(--cm)}
	            .tests{box-sizing:border-box;width:100%;min-height:58px;max-height:120px;overflow-y:auto;border:1px solid var(--panel-line);border-radius:9px;background:var(--tests-bg);overflow:hidden}
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
            /* RIGHT THOUGHT COLUMN ONLY. No left editor, HUD, MCQ or overlay state changes.
               Trade boxed answers for an editorial insight rail with a single compact
               accent, proper hierarchy and subtle separators; keep the same eight slots. */
            .thought-pane .thought-list{
              counter-reset:insight-step;gap:0;min-height:0;overflow-x:hidden;overflow-y:auto;
              padding:0 5px 4px 0;scrollbar-width:thin;
              scrollbar-color:rgba(255,255,255,.22) transparent;
            }
            .thought-pane .thought-item{
              --insight-accent:#c9e4f5;
              counter-increment:insight-step;
              position:relative;box-sizing:border-box;flex:0 0 auto;width:100%;
              display:grid;grid-template-columns:3px minmax(0,1fr);grid-template-rows:auto auto;
              align-items:start;column-gap:13px;row-gap:6px;
              padding:12px 10px 13px 2px;margin:0;
              border:0;border-bottom:1px solid rgba(255,255,255,.12);
              background:linear-gradient(90deg,color-mix(in srgb,var(--insight-accent) 7%,transparent),transparent 72%);
            }
            .thought-pane .thought-item:first-child{padding-top:8px}
            .thought-pane .thought-item:last-child{border-bottom:0}
            .thought-pane .thought-item::before{
              content:"";grid-column:1;grid-row:1/3;align-self:stretch;min-height:34px;
              width:3px;border-radius:999px;
              background:linear-gradient(180deg,var(--insight-accent),color-mix(in srgb,var(--insight-accent) 25%,transparent));
              box-shadow:0 0 13px color-mix(in srgb,var(--insight-accent) 20%,transparent);
            }
            .thought-pane .thought-heading{
              grid-column:2;grid-row:1;display:flex;align-items:center;gap:10px;min-width:0;
              font-size:11px;line-height:1.3;font-weight:800;letter-spacing:.035em;
              color:var(--text);text-shadow:none;
            }
            .thought-pane .thought-heading::before{
              content:counter(insight-step,decimal-leading-zero);
              color:var(--insight-accent);font:800 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
              letter-spacing:0;opacity:.95;
            }
            .thought-pane .thought-space{
              box-sizing:border-box;grid-column:2;grid-row:2;width:100%;
              height:auto;min-height:19px;max-height:76px;overflow-x:hidden;overflow-y:auto;
              padding:0;border:0;border-radius:0;background:transparent;
              color:var(--muted);font-size:11.5px;font-weight:500;line-height:1.5;
              white-space:pre-wrap;overflow-wrap:anywhere;
              scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent;
            }
            .thought-pane .thought-item:first-child .thought-space{font-weight:600;color:var(--text)}
            .thought-pane .function-notes{height:auto;max-height:96px;padding:0}
            .thought-pane .function-notes div{white-space:normal;overflow-wrap:anywhere;overflow:visible;text-overflow:clip}
            .thought-pane .thought-item:nth-child(2){--insight-accent:#c2a8ff}
            .thought-pane .thought-item:nth-child(3){--insight-accent:#67dccb}
            .thought-pane .thought-item:nth-child(4){--insight-accent:#67e0a5}
            .thought-pane .thought-item:nth-child(5){--insight-accent:#8bb8ff}
            .thought-pane .thought-item:nth-child(6){--insight-accent:#f3b874}
            .thought-pane .thought-item:nth-child(7){--insight-accent:#65d8ed}
            .thought-pane .thought-item:nth-child(8){--insight-accent:#d5a1ff}
            .thought-pane .thought-item:nth-child(4) .thought-space,
            .thought-pane .thought-item:nth-child(5) .thought-space{
              color:var(--text);font:650 12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
            }
            @media (prefers-reduced-motion:no-preference){
              .thought-pane .thought-item{transition:background-color .2s ease}
            }
              .mcq-box{box-sizing:border-box;width:100%;border:1px solid var(--panel-line);border-radius:9px;background:var(--editor-bg);padding:12px;color:var(--text);line-height:1.45;overflow:auto}
              .mcq-question{min-height:150px;max-height:270px;font-size:15px}
              .mcq-answer{min-height:180px;font-size:16px}
              .mcq-answer b{color:#ffdf5d}
              .mcq-options{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:8px;overflow:auto}
              .mcq-option{padding:10px;border:1px solid var(--panel-line);border-radius:9px;background:var(--box-fill);font-size:13px;line-height:1.35}
              .mcq-option[data-picked="true"]{border-color:rgba(201,228,245,.72);background:rgba(201,228,245,.12)}
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
	            #panel{position:relative}
            .history-sheet{position:absolute;z-index:30;inset:0;box-sizing:border-box;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;padding:27px 32px 22px;background:linear-gradient(135deg,rgba(13,18,25,.95),rgba(18,24,32,.96));backdrop-filter:blur(24px) saturate(1.3);color:#f5f7fa}
            .history-sheet[hidden]{display:none}
            .history-heading{display:flex;align-items:start;justify-content:space-between;gap:15px;flex-wrap:wrap;padding-bottom:15px;border-bottom:1px solid rgba(255,255,255,.18)}
            .history-eyebrow{color:#c9e4f5;font-size:10px;font-weight:850;letter-spacing:.16em;text-transform:uppercase}
            .history-title{font-size:25px;font-weight:800;letter-spacing:-.035em;margin:5px 0 4px}
            .history-description{font-size:12px;font-weight:500;color:rgba(245,247,250,.58)}
            .history-counter{font:700 11px SFMono-Regular,Menlo,monospace;color:rgba(245,247,250,.66);padding:10px 12px;border:1px solid rgba(255,255,255,.16);border-radius:10px}
            .history-list{overflow-x:hidden;overflow-y:auto;min-height:0;flex:1;padding:8px 0;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
            .history-row{display:flex;align-items:center;gap:16px;min-height:66px;padding:13px 14px 13px 10px;border-bottom:1px solid rgba(255,255,255,.1);border-left:3px solid transparent;box-sizing:border-box;transition:background .16s,border .16s}
            .history-row[data-selected="true"]{border-left-color:#c9e4f5;background:linear-gradient(90deg,rgba(201,228,245,.16),rgba(201,228,245,.025))}
            .history-number{width:37px;flex:0 0 37px;text-align:center;font:700 12px SFMono-Regular,Menlo,monospace;color:rgba(255,255,255,.45)}
            .history-row[data-selected="true"] .history-number{color:#c9e4f5}
            .history-info{flex:1;min-width:0}
            .history-row-title{font-size:13px;color:white;font-weight:720;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .history-row-subtitle{font-size:11px;font-weight:500;color:rgba(245,247,250,.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:5px}
            .history-meta{display:flex;flex-direction:column;align-items:flex-end;gap:6px;font-size:10px;white-space:nowrap;color:rgba(255,255,255,.65)}
            .history-kind{padding:3px 7px;border-radius:7px;background:rgba(201,228,245,.12);color:#c9e4f5;font-weight:800;letter-spacing:.02em}
            .history-empty{padding:44px 16px;font-size:13px;font-weight:500;text-align:center;color:rgba(255,255,255,.66)}
            .history-footer{border-top:1px solid rgba(255,255,255,.15);padding-top:13px;display:flex;justify-content:space-between;gap:12px;font-size:11px;color:rgba(255,255,255,.6);font-weight:600}
            .hud-shortcuts{display:flex;align-items:center;flex-wrap:wrap;gap:5px 9px;min-width:0}
            .hud-shortcuts .hud-action{margin-left:1px}
            .hud-shortcuts .hud-key{padding:0 7px;min-width:auto;height:24px}
            .solution-toolbar{display:inline-flex;align-items:center;gap:8px}
            .overlay-port-list{display:flex;align-items:center;gap:6px;padding:6px 8px;flex-wrap:wrap}
            .overlay-port-chip{padding:4px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);font-size:10px;color:rgba(255,255,255,.74)}
            .overlay-port-chip[data-selected="true"]{border-color:rgba(184,224,245,.7);background:rgba(184,224,245,.17);color:#fff}
            .overlay-port-chip[data-available="false"]{opacity:.44}

            .overlay-diff-toggle{background:rgba(201,228,245,.12);border:1px solid rgba(201,228,245,.45);color:var(--text);padding:4px 8px;border-radius:7px;font:inherit;cursor:pointer}
            .code-lines li[data-change="remove"]{background:rgba(240,83,83,.18);border-left:3px solid rgba(240,83,83,.7)}
            .code-lines li[data-change="add"]{background:rgba(65,200,120,.16);border-left:3px solid rgba(65,200,120,.7)}
            .code-lines li[data-change="same"]{border-left:3px solid transparent}
            .code-lines li[data-change] code{overflow-wrap:anywhere}
        </style></head><body><div class="hudbar" id="hudbar"><span class="hud-logo">CA</span><span class="hud-pause">||</span><span class="hud-meter"><i></i><i></i><i></i></span><span id="hud-shortcuts" class="hud-shortcuts"></span></div><div id="panel"><div class="pane pictures-pane"><div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title">Solution</div><div class="solution-status" id="agents"></div><div class="solution-editor"><div class="editor-head"><b id="solution-title">solution</b><span class="solution-toolbar"><span id="solution-source">waiting</span><button type="button" class="overlay-diff-toggle" id="overlay-diff-toggle" hidden>Show final</button></span></div><ol class="code-lines" id="solution-code"></ol></div><div class="tests"><div class="tests-head"><b>Test cases</b><span id="tests-count">real data</span></div><div class="case-list" id="tests"></div></div></div><div class="pane thought-pane"><div class="title">Thought process</div><div class="thought-list"><div class="thought-item"><div class="thought-heading">Approach/algorithm</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Functions</div><div class="thought-space function-notes" id="function-notes"></div></div><div class="thought-item"><div class="thought-heading">Data structures</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Time complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Space complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Edge cases</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Testing</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Trade-offs</div><div class="thought-space"></div></div></div></div></div><script>
	            // HUD labels come from the numeric command table handled by mac_shortcuts.
            // Keep the overlay's real capture controls, not generic demo shortcuts.
            window.setOverlayControls=function(view){
              const host=document.getElementById('hud-shortcuts');if(!host)return;
              const controls=view==='history'
                ? [['Coding','cc'],['MCQ','mm'],['History','hh'],['Previous','↑'],['Next','↓']]
                : view==='mcq'
                ? [['MCQ','mm'],['Coding','cc'],['History','hh'],['Full','31'],['Left','32'],['Right','33'],['Region','34'],['Submit','35']]
                : [['Coding','cc'],['MCQ','mm'],['History','hh'],['New','00'],['Capture','20'],['Submit','24'],['Scroll','↑↓'],['Ports','rr/cp/py']];
              const fingerprint=controls.map(([name,key])=>name+key).join('|');
              if(host.dataset.shortcutSet===fingerprint)return;
              host.dataset.shortcutSet=fingerprint;host.replaceChildren();
              controls.forEach(([name,key])=>{
                const label=document.createElement('span');label.className='hud-action';label.textContent=name;
                const badge=document.createElement('span');badge.className='hud-key';badge.textContent=key;
                host.append(label,badge);
              });
            };
            const esc=(s)=>String(s||'').replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
	            window.scrollSolutionBy=function(delta){const el=document.getElementById('solution-code');if(el)el.scrollTop+=delta;};
            function highlight(code,lang){
              // Tokenize first, escape each token at emission. Never regex over
              // generated HTML or accept source as markup.
              const language=String(lang||'').toLowerCase();
              const kw=language.includes('rust')?/\b(?:fn|impl|struct|enum|trait|let|mut|pub|use|match|self|return|if|else|while|for|loop|const|static|where|async|await)\b/g:
                language.includes('cpp')||language.includes('c++')?/\b(?:auto|bool|char|class|const|constexpr|double|else|enum|for|if|int|long|namespace|private|protected|public|return|short|signed|static|struct|template|typename|unsigned|using|void|while)\b/g:
                /\b(?:def|for|in|if|return|class|else|elif|while|try|except|with|as|from|import|async|await|yield|lambda|pass|break|continue|True|False|None)\b/g;
              const pattern=/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|#[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
              const words=new Set([...String(code||'').matchAll(kw)].map(match=>match[0]));
              let html='',offset=0;
              for(const match of String(code||'').matchAll(pattern)){
                html+=esc(code.slice(offset,match.index));const token=match[0];
                let cls='';
                if(words.has(token))cls='kw';
                else if(/^["']/.test(token))cls='str';
                else if(/^\d/.test(token))cls='num';
                else if(token.startsWith('//')||token.startsWith('#'))cls='cm';
                html+=cls?'<span class="'+cls+'">'+esc(token)+'</span>':esc(token);
                offset=match.index+token.length;
              }
              return html+esc(code.slice(offset));
            }
		            function stateTone(status){if(status==='done')return'done';if(status==='streaming'||status==='reviewing'||status==='running')return'working';if(status==='error')return'error';if(status==='cancelled')return'cancelled';return'pending';}
            function codeWithReferenceComment(code,lang){return String(code||'');}
		            function renderCodeLines(target,code,lang){target.innerHTML='';codeWithReferenceComment(code,lang).split('\n').forEach((line)=>{const li=document.createElement('li');const c=document.createElement('code');c.innerHTML=highlight(line||' ',lang);li.appendChild(c);target.appendChild(li);});}
		            function detectedFunctionNames(code){const found=[];String(code||'').replace(/\b([A-Za-z_]\w*)\s*\(/g,(_,name)=>{if(!found.includes(name)&&!['if','for','while','switch','return','def','function'].includes(name))found.push(name);return _;});return found;}
		            function renderFunctionNotes(code){const target=document.getElementById('function-notes');if(!target)return;const meanings={set:'stores unique values for quick membership checks',sum:'adds numeric values together',max:'returns the largest value',min:'returns the smallest value',len:'counts items',range:'creates a numeric loop sequence',enumerate:'loops with index and value',append:'adds an item to a list',sort:'orders a list in place',sorted:'returns ordered values',print:'writes debug output',useState:'stores React component state',useEffect:'runs React side effects',fetch:'requests network data',map:'transforms each item',filter:'keeps matching items',reduce:'combines items into one result'};const found=detectedFunctionNames(code);target.innerHTML='';found.slice(0,5).forEach((name)=>{const row=document.createElement('div');row.textContent=name+': '+(meanings[name]||'function call used by the solution');target.appendChild(row);});if(!target.children.length){const row=document.createElement('div');row.textContent='No function calls detected yet.';target.appendChild(row);}}
		            function functionExample(name){const examples={sum:'sum([18, 9]) -> 27',set:'set([18, 9, 18]) -> {18, 9}',max:'max([18, 9]) -> 18',min:'min([18, 9]) -> 9',len:'len([18, 9]) -> 2',range:'range(0, 5) -> 0..4',enumerate:'enumerate(items) -> index + value',append:'outliers.append(18) -> adds 18',sort:'values.sort() -> in-place order',sorted:'sorted(values) -> ordered copy',print:'print(result) -> console output',useState:'useState(false) -> state + setter',useEffect:'useEffect(fn, []) -> run side effect',fetch:'fetch(url) -> request data',map:'items.map(fn) -> transformed items',filter:'items.filter(fn) -> matching items',reduce:'items.reduce(fn, seed) -> one value'};return examples[name]||name+'(exampleInput) -> expected output';}
		            function renderSmartTests(target,count,code,stateTests){target.innerHTML='';const cases=Array.isArray(stateTests)?stateTests:[];count.textContent=cases.length?cases.length+' evidence row'+(cases.length===1?'':'s'):'no execution evidence';if(!cases.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No verified execution evidence available yet.';target.appendChild(empty);return;}cases.slice(0,8).forEach((item)=>{const card=document.createElement('div');card.className='case';const name=document.createElement('b');name.textContent=item.name||'Execution result';const detail=document.createElement('code');detail.textContent=[item.status,item.expected!==undefined?'expected: '+String(item.expected):'',item.actual!==undefined?'actual: '+String(item.actual):'',item.input!==undefined?'input: '+String(item.input):''].filter(Boolean).join(' · ');card.appendChild(name);card.appendChild(detail);target.appendChild(card);});}
            // Show the Council worker's exact E2B-tested candidate first. When
            // the deterministic judges publish a changed final winner, render
            // an actual red/green line diff in the EXISTING code window.
            function overlayDiffRows(before,after){
              const a=String(before||'').split('\n'),b=String(after||'').split('\n'),out=[];
              if(a.length*b.length>90000||String(before||'').length+String(after||'').length>98304)
                return [['summary','The provisional and final solutions differ. This diff is too large to render safely; use Show final to view the verified code.']];
              const dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
              for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)
                dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
              let i=0,j=0;
              while(i<a.length||j<b.length){
                if(i<a.length&&j<b.length&&a[i]===b[j]){out.push(['same',a[i]]);i++;j++;}
                else if(i<a.length&&(j===b.length||dp[i+1][j]>=dp[i][j+1]))out.push(['remove',a[i++]]);
                else out.push(['add',b[j++]]);
              }
              return out;
            }
            function renderOverlayCodeResult(target,state){
              const current=state.solution||{},history=Array.isArray(state.solutionHistory)?state.solutionHistory:[];
              const previous=history.find(entry=>entry.version==='provisional');
              const final=history.find(entry=>entry.version==='final');
              const changed=state.upgrade&&state.upgrade.changed===true&&
                current.status==='reviewed'&&previous&&final&&
                previous.code&&final.code&&previous.language===final.language&&
                previous.code!==final.code;
              if(window.__overlayDiffRunId!==state.runId){window.__overlayDiffRunId=state.runId;window.__overlayDiffHidden=false;}
              const button=document.getElementById('overlay-diff-toggle');
              if(button){button.hidden=!changed;button.textContent=window.__overlayDiffHidden?'View changes':'Show final';}
              if(!changed||window.__overlayDiffHidden){renderCodeLines(target,current.code,current.language);return;}
              target.replaceChildren();
              overlayDiffRows(previous.code,final.code).forEach(([change,line])=>{
                const li=document.createElement('li');li.dataset.change=change;
                const code=document.createElement('code');code.textContent=(change==='remove'?'- ':change==='add'?'+ ':'  ')+line;
                li.append(code);target.append(li);
              });
            }
            window.toggleOverlayCodeDiff=function(){
              const state=window.__overlayCurrentState;
              if(!state||!state.solution)return;
              window.__overlayDiffHidden=!window.__overlayDiffHidden;
              renderOverlayCodeResult(document.getElementById('solution-code'),state);
            };
            document.addEventListener('click',function(event){
              if(event.target&&event.target.id==='overlay-diff-toggle')window.toggleOverlayCodeDiff();
            });
            function renderCouncilInsights(presentation,state){
              const p=presentation||{},extra=state&&state.insights||{};
              const root=document.querySelector('.thought-list');if(!root)return;
              if(root.dataset.codingOrder!=='set'){
                const items=Array.from(root.querySelectorAll('.thought-item'));
                // Keep the function-notes element intact while arranging the
                // eight existing insight surfaces in the requested order.
                const order=[0,2,5,6,3,4,1,7];
                const labels=['Solution summary','Data structures / Algorithm','Edge cases tested','Testing results',
                  'Time complexity','Space complexity','Functions','Approach · how it works'];
                order.forEach((old,i)=>{
                  const item=items[old];if(!item)return;
                  const heading=item.querySelector('.thought-heading');
                  if(heading)heading.textContent=labels[i];
                  root.append(item);
                });
                root.dataset.codingOrder='set';
              }
              const items=root.querySelectorAll('.thought-item');
              const set=(index,value)=>{
                const el=items[index]?.querySelector('.thought-space');
                if(el&&index!==6)el.textContent=value||'Not recorded in this Council report.';
              };
              const structures=Array.isArray(extra.structures)?extra.structures.join('\n'):'';
              const algorithm=extra.controlFlow?'Algorithm flow: '+extra.controlFlow:'';
              set(0,extra.summary||p.approach);
              set(1,[structures,algorithm].filter(Boolean).join('\n'));
              set(2,Array.isArray(extra.edgeCases)&&extra.edgeCases.length
                ? extra.edgeCases.map((x,i)=>String(i+1)+'. '+x).join('\n')
                : 'Specific edge-case assertions were not preserved in the verified report; no examples are invented.');
              const evidence=Array.isArray(p.evidence)?p.evidence.map(e=>
                [e.letter,e.gate,e.passed!==undefined?'passed: '+e.passed:'',
                e.failed!==undefined?'failed: '+e.failed:'',
                Number.isFinite(e.elapsedMs)?'elapsed: '+e.elapsedMs+' ms':''].filter(Boolean).join(' · ')).join('\n'):'';
              set(3,extra.testing||evidence||'Waiting for executable verification.');
              const claim=String(p.complexity||'');
              const time=claim.match(/(?:time|runtime)\s*(?:complexity)?\s*[:=\-]\s*([^\n;]+)/i);
              const space=claim.match(/(?:space|memory)\s*(?:complexity)?\s*[:=\-]\s*([^\n;]+)/i);
              set(4,p.timeComplexity||time?.[1]||'Not separately audited');
              set(5,p.spaceComplexity||space?.[1]||'Not separately audited');
              set(7,extra.approach||p.approach);
            }
                        window.updatePreviews=function(images){window.__lastPreviews=images||[];const pictures=document.getElementById('pictures');if(!pictures)return;if(pictures.__sources&&pictures.__sources.length===images.length&&images.every((src,i)=>src===pictures.__sources[i]))return;pictures.__sources=images.slice();pictures.innerHTML='';if(!images.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Captured images will appear here';pictures.appendChild(empty);return;}images.forEach((src,i)=>{const pill=document.createElement('div');pill.className='picture-pill';const img=document.createElement('img');img.src=src;img.alt='Capture '+(i+1);const count=document.createElement('span');count.className='picture-count';count.textContent=(i+1)+'/10';pill.appendChild(img);pill.appendChild(count);pictures.appendChild(pill);});};
                function renderMcq(state){const savedPictures=document.getElementById('pictures');const left=document.querySelector('.pictures-pane');const right=document.querySelector('.thought-pane');const m=state.mcq||{};const picked=(m.answer&&m.answer.label)||'';const found=Array.isArray(m.options)?m.options:[];const position=found.findIndex((o)=>o.label===picked);const ordinal=(n)=>n%100>=11&&n%100<=13?'th':n%10===1?'st':n%10===2?'nd':n%10===3?'rd':'th';const formatted=m.answerVerified===true&&position>=0?'✅ '+picked+' ('+(position+1)+ordinal(position+1)+' Option) - '+String((m.answer&&m.answer.text)||found[position].text||''):'';const displayAnswer=formatted||String(m.displayAnswer||'');const selectedModel=(m.model&&String(m.model).trim())?String(m.model).trim():'none';const hasModel=selectedModel.toLowerCase()!=='none';left.innerHTML='<div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title-row"><div class="title">Question</div><div class="mcq-model-pill" data-enabled="'+(hasModel?'true':'false')+'">'+esc(hasModel?selectedModel:'No Model')+'</div></div><div class="mcq-box mcq-question"></div><div class="title">Answer</div><div class="mcq-box mcq-answer"></div>';if(savedPictures)document.getElementById('pictures').replaceWith(savedPictures);right.innerHTML='<div class="title">Question history</div><div class="mcq-history"></div>';document.querySelector('.mcq-question').textContent=m.question||state.progress||'Reading the captured question...';document.querySelector('.mcq-answer').innerHTML='<b>'+esc(displayAnswer||(picked||'Answer'))+'</b>'+(displayAnswer?'':(m.answer&&m.answer.text?' — '+esc(m.answer.text):''))+'<br><br>'+esc(m.reason||state.error||state.progress||'Waiting for the MCQ worker result...');const hist=document.querySelector('.mcq-history');const add=(title,body,level,meta)=>{const row=document.createElement('div');row.className='mcq-history-row';row.dataset.level=level||'info';const h=document.createElement('b');h.textContent=title;const p=document.createElement('div');p.textContent=body||'';row.appendChild(h);row.appendChild(p);if(meta&&meta.length){const mrow=document.createElement('div');mrow.className='mcq-history-meta';meta.forEach((x)=>{const s=document.createElement('span');s.textContent=x;mrow.appendChild(s);});row.appendChild(mrow);}hist.appendChild(row);};add('AI selected',selectedModel,'info',[state.status||'',state.phase||''].filter(Boolean));add('Captured question',m.question||'Waiting for the screenshot reading.',state.error?'error':'info',[state.status||'',state.phase||''].filter(Boolean));if(m.options&&m.options.length){add('Choices found',(m.options||[]).map((o)=>(o.label?o.label+'. ':'')+(o.text||'')).join('\\n'),'info',[]);}if(m.knowledgeUsed!==undefined){add('Local knowledge check',m.knowledgeUsed?'A local knowledge match or guidance was included before the model answer.':'The local knowledge pack was checked before the model answer, but no direct match was used.','info',[selectedModel]);}if(picked||m.reason){add('Selected answer',(picked?picked+': ':'')+(m.answer&&m.answer.text?m.answer.text:'')+'\\n'+(m.reason||''),'info',[selectedModel]);}(m.whyNot||[]).forEach((x)=>add('Rejected choice '+(x.label||''),x.reason||'Not selected.','info',[]));(state.history||[]).forEach((e)=>add(e.phase||'worker event',e.message||'',e.level||'info',[e.createdAt||''].filter(Boolean)));if(!hist.children.length)add('Waiting','The helper is waiting for the worker history.','info',[]);window.updatePreviews(window.__lastPreviews||[]);}
			            function restoreCodingShell(){if(document.getElementById('agents'))return;document.getElementById('panel').innerHTML='<div class="pane pictures-pane"><div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title">Solution</div><div class="solution-status" id="agents"></div><div class="solution-editor"><div class="editor-head"><b id="solution-title">solution</b><span class="solution-toolbar"><span id="solution-source">waiting</span><button type="button" class="overlay-diff-toggle" id="overlay-diff-toggle" hidden>Show final</button></span></div><ol class="code-lines" id="solution-code"></ol></div><div class="tests"><div class="tests-head"><b>Test cases</b><span id="tests-count">real data</span></div><div class="case-list" id="tests"></div></div></div><div class="pane thought-pane"><div class="title">Thought process</div><div class="thought-list"><div class="thought-item"><div class="thought-heading">Approach/algorithm</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Functions</div><div class="thought-space function-notes" id="function-notes"></div></div><div class="thought-item"><div class="thought-heading">Data structures</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Time complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Space complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Edge cases</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Testing</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Trade-offs</div><div class="thought-space"></div></div></div></div>';window.updatePreviews(window.__lastPreviews||[]);}
			            window.updateOverlayState=function(state){state=state||{agents:[],tests:[],solution:null,phase:'idle'};window.__overlayCurrentState=state;if(state.kind==='mcq'||state.mcq){renderMcq(state);return;}restoreCodingShell();const agents=document.getElementById('agents');agents.innerHTML='';if(!state.agents||!state.agents.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No active model run';agents.appendChild(empty);}else{state.agents.slice(0,5).forEach((a)=>{const chip=document.createElement('div');chip.className='model-chip';chip.dataset.state=stateTone(a.status);const dot=document.createElement('span');dot.className='dot';const name=document.createElement('b');name.textContent=a.label||a.id;const status=document.createElement('span');status.textContent=a.status==='error'?(a.error||'error'):a.status;chip.title=[a.model,a.error].filter(Boolean).join(' — ');chip.appendChild(dot);chip.appendChild(name);chip.appendChild(status);agents.appendChild(chip);});}const title=document.getElementById('solution-title');const source=document.getElementById('solution-source');const code=document.getElementById('solution-code');const tests=document.getElementById('tests');const count=document.getElementById('tests-count');if(state.solution&&state.solution.code){title.textContent=state.solution.title||'solution';source.textContent=state.solution.status==='reviewed'?'Council verified':state.solution.status==='provisional'?'E2B passed · Council reviewing':('candidate · '+(state.solution.source||''));renderOverlayCodeResult(code,state);renderFunctionNotes(state.solution.code);renderSmartTests(tests,count,state.solution.code,state.tests);renderCouncilInsights(state.presentation,state);}else{title.textContent='solution';source.textContent=state.phase==='idle'?'idle':'waiting';const waiting=state.phase==='idle'?'No run yet.':'Waiting for solution...';renderCodeLines(code,waiting,'');renderFunctionNotes(waiting);renderSmartTests(tests,count,waiting,state.tests);renderCouncilInsights(state.presentation,state);}};
            // Keep the existing capture and result renderer intact, then give
            // its agent output the same clear, glassy Council presentation as
            // the Story workspace. This is intentionally display-only.
            // Shared account history is read-only. Neither opening HH nor
            // navigating it mutates the live Coding/MCQ batch or runs a solver.
            window.showSharedHistory=function(rows,selected,loading,error){
              const panel=document.getElementById('panel');if(!panel)return;
              let root=document.getElementById('shared-history-sheet');
              if(!root){
                root=document.createElement('section');
                root.id='shared-history-sheet';root.className='history-sheet';
                root.innerHTML='<header class="history-heading"><div><div class="history-eyebrow">Council Editor / Coding Overlay</div><div class="history-title">History</div><div class="history-description">Overlay captures only · Coding and MCQ results</div></div><div class="history-counter" id="history-counter">0 sessions</div></header><div class="history-list" id="history-list"></div><footer class="history-footer"><span>↑ / ↓ Navigate · → Open result</span><span>cc Coding · mm MCQ · hh History</span></footer>';
                panel.appendChild(root);
              }
              root.hidden=false;
              if(Array.isArray(rows))root.__rows=rows;
              else if(error)root.__rows=[];
              root.__rows=root.__rows||[];
              window.__historyLoading=Boolean(loading);
              window.__historyError=error||'';
              const list=root.querySelector('#history-list');
              list.replaceChildren();
              root.__rows.forEach((item,i)=>{
                const row=document.createElement('div');row.className='history-row';row.dataset.index=String(i);
                // The newest task is the first row, so it receives the
                // highest visible sequence number, matching the main History.
                const n=document.createElement('span');n.className='history-number';n.textContent=String(root.__rows.length-i).padStart(2,'0');
                const info=document.createElement('div');info.className='history-info';
                const title=document.createElement('div');title.className='history-row-title';title.textContent=item.title||'Saved task';
                const subtitle=document.createElement('div');subtitle.className='history-row-subtitle';subtitle.textContent=[item.origin||'',item.subtitle||''].filter(Boolean).join(' · ').slice(0,240);
                const meta=document.createElement('div');meta.className='history-meta';
                const kind=document.createElement('span');kind.className='history-kind';kind.textContent=item.kind||'Run';
                const stamp=document.createElement('span');
                const date=new Date(item.submittedAt||'');stamp.textContent=Number.isFinite(date.getTime())?date.toLocaleString():String(item.submittedAt||'');
                const status=document.createElement('span');status.textContent=item.status||'';
                info.append(title,subtitle);meta.append(kind,stamp,status);row.append(n,info,meta);list.appendChild(row);
              });
              if(!list.children.length){
                const empty=document.createElement('div');empty.className='history-empty';
                empty.textContent=error?'Could not load cloud history: '+error:loading?'Loading saved overlay history…':'No saved overlay runs yet. Your next Coding or MCQ capture will appear here.';
                list.appendChild(empty);
              }else if(error){
                const warning=document.createElement('div');warning.className='history-empty';
                warning.textContent='History is temporarily unavailable: '+error;
                list.prepend(warning);
              }
              const counter=root.querySelector('#history-counter');
              counter.textContent=root.__rows.length+' saved'+(loading?' · syncing':'');
              window.selectSharedHistoryRow(selected||0);
              window.setOverlayControls('history');
            };
            window.selectSharedHistoryRow=function(selected){
              const root=document.getElementById('shared-history-sheet');
              if(!root||root.hidden)return;
              root.querySelectorAll('.history-row').forEach((row,i)=>{
                const yes=i===selected;
                row.dataset.selected=yes?'true':'false';
                if(yes)row.scrollIntoView({block:'nearest'});
              });
            };
            window.closeSharedHistory=function(){
              const root=document.getElementById('shared-history-sheet');if(root)root.hidden=true;
              const detail=document.getElementById('shared-history-detail');if(detail)detail.hidden=true;
              window.setOverlayControls(window.__overlayCurrentState&&(window.__overlayCurrentState.kind==='mcq'||window.__overlayCurrentState.mcq)?'mcq':'coding');
            };
            window.showSharedHistoryDetail=function(detail){
              if(detail&&detail.state){window.closeSharedHistory();window.updateOverlayState(detail.state);return;}
              const panel=document.getElementById('panel');if(!panel)return;
              let root=document.getElementById('shared-history-detail');
              if(!root){root=document.createElement('section');root.id='shared-history-detail';root.className='history-sheet';panel.appendChild(root);}
              root.hidden=false;root.replaceChildren();
              const header=document.createElement('header');header.className='history-heading';
              const head=document.createElement('div');const eyebrow=document.createElement('div');eyebrow.className='history-eyebrow';eyebrow.textContent='Council Editor / Saved result';
              const title=document.createElement('div');title.className='history-title';title.textContent=detail&&detail.loading?'Loading result…':(detail&&detail.title)||'Saved result';
              const meta=document.createElement('div');meta.className='history-description';meta.textContent=[detail&&detail.origin,detail&&detail.status].filter(Boolean).join(' · ');
              head.append(eyebrow,title,meta);header.append(head);root.append(header);
              const body=document.createElement('div');body.className='history-list';
              if(detail&&detail.loading){const loading=document.createElement('div');loading.className='history-empty';loading.textContent='Loading the selected account-scoped result…';body.append(loading);}
              else if(detail&&detail.error){const error=document.createElement('div');error.className='history-empty';error.textContent='Could not open this saved result: '+detail.error;body.append(error);}
              else {const summary=document.createElement('pre');summary.className='history-row';summary.style.whiteSpace='pre-wrap';summary.textContent=(detail&&detail.summary)||'No saved summary.';body.append(summary);const solution=detail&&detail.solution;if(solution&&solution.code){const code=document.createElement('pre');code.className='history-row';code.style.whiteSpace='pre';code.style.overflow='auto';code.textContent=(solution.language?solution.language+'\n\n':'')+solution.code;body.append(code);}}
              root.append(body);const footer=document.createElement('footer');footer.className='history-footer';footer.textContent='hh returns to History · cc Coding · mm MCQ';root.append(footer);
            };
            const baseUpdateOverlayState=window.updateOverlayState;
            function agentStatusText(agent){
              if(agent.error)return String(agent.error);
              if(agent.detail)return String(agent.detail);
              const labels={done:'Answer ready',running:'Generating answer',streaming:'Generating answer',reviewing:'Reviewing answer',pending:'Queued for Council',cancelled:'Cancelled'};
              return labels[agent.status]||String(agent.status||'Waiting');
            }
            function renderStoryAgents(state){
              const agents=document.getElementById('agents');if(!agents)return;
              const pane=agents.closest('.pictures-pane');if(!pane)return;
              const oldHeader=pane.querySelector('.agent-header');if(oldHeader)oldHeader.remove();
              const oldProgress=pane.querySelector('.overlay-progress');if(oldProgress)oldProgress.remove();
              const oldDiagnostics=pane.querySelector('.overlay-diagnostics');if(oldDiagnostics)oldDiagnostics.remove();
              const header=document.createElement('div');header.className='agent-header';
              const heading=document.createElement('div');heading.className='title';heading.textContent='Selected Council agents';
              const summary=document.createElement('span');summary.className='agent-summary';
              const selected=Array.isArray(state.agents)?state.agents.slice(0,4):[];
              const ready=selected.filter((agent)=>agent.status==='done').length;
              summary.textContent=selected.length?(ready+'/'+selected.length+' answers ready'):'Waiting for the Council roster';
              header.appendChild(heading);header.appendChild(summary);
              const oldTitle=agents.previousElementSibling;if(oldTitle&&oldTitle.classList.contains('title'))oldTitle.replaceWith(header);else pane.insertBefore(header,agents);
              agents.innerHTML='';
              if(!selected.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='The selected Council agents will appear here.';agents.appendChild(empty);}else{selected.forEach((agent)=>{const card=document.createElement('div');card.className='model-chip';card.dataset.state=stateTone(agent.status);const dot=document.createElement('span');dot.className='dot';const name=document.createElement('b');name.textContent=agent.label||agent.id||'Council agent';const model=document.createElement('span');model.className='agent-model';model.textContent=agent.model||'Council';const detail=document.createElement('span');detail.textContent=agentStatusText(agent);card.title=[agent.model,agent.error].filter(Boolean).join(' — ');card.append(dot,name,model,detail);agents.appendChild(card);});}
              const progress=document.createElement('div');progress.className='overlay-progress';const waiting=state.phase==='idle'?'Capture screenshots to begin.':state.progress||'Council is selecting eligible agents.';const stages={queued:'Waiting for the cloud worker',contracting:'Reading the problem contract',
                reading:'Understanding screenshots',solving:'Generating candidate solutions',
                speccing:'Preparing independent E2B tests',benchmarking:'Running E2B cases',
                verifying:'Running E2B verification',reviewing:'Reviewing candidates',
                revising:'Repairing eligible solutions',reverifying:'Re-testing repaired code',
                judging:'Independent Council judges',synthesizing:'Selecting verified winner',
                porting:'Verifying language translations',completed:'Council completed'};
              const stage=stages[state.progressPhase]||waiting;
              progress.textContent=state.phase==='done'?'Council completed. Verified solution and ports are available below.':
                state.phase==='error'?'Council needs attention. See the diagnostic below.':
                stage+(state.progress&&stage!==state.progress?' · '+String(state.progress).slice(0,145):'');
              agents.after(progress);
              const failures=selected.filter((agent)=>agent.error).map((agent)=>(agent.label||agent.id||'Council agent')+': '+agent.error);
              if(failures.length||state.phase==='error'){const diagnostic=document.createElement('div');diagnostic.className='overlay-diagnostics';const label=document.createElement('b');label.textContent='Run diagnostics';const message=document.createElement('span');message.textContent=failures.join(' · ')||'The Council run reported an issue. The captured images and any available answer remain available.';diagnostic.append(label,message);progress.after(diagnostic);}
            }
            function renderHistoryContext(state){
              const old=document.getElementById('overlay-history-context');if(old)old.remove();
              const title=state&&String(state.historyTitle||'').trim();if(!title)return;
              const shown=title.length>72?title.slice(0,69)+'…':title;
              const pane=document.querySelector('.pictures-pane');if(!pane)return;
              const context=document.createElement('div');context.id='overlay-history-context';context.className='overlay-history-context';context.textContent='History result · '+shown;context.title=title;
              const progress=pane.querySelector('.overlay-progress');if(progress)progress.after(context);else{const agents=document.getElementById('agents');if(agents)agents.after(context);}
            }
            // The ghost window must remain click-through and non-focusable.
            // Language selection is exclusively via observed RR / CP / PY,
            // never an invisible HTML button competing for foreground focus.
            const canonicalPortLanguage=value=>{
              const key=String(value||'').toLowerCase().replace(/[^a-z+]/g,'');
              return key==='c++'||key==='cpp'||key==='cxx'?'cpp':
                key==='py'||key==='python'||key==='python3'?'python':
                key==='rs'||key==='rust'?'rust':key;
            };
            window.selectVerifiedOverlayLanguage=function(language){
              const state=window.__overlayCurrentState;
              if(!state||state.kind==='mcq'||!state.solution)return false;
              const desired=canonicalPortLanguage(language);
              if(!['python','rust','cpp'].includes(desired))return false;
              window.__overlayDesiredLanguage=desired;
              renderVerifiedPorts(state);
              return true;
            };
            function renderVerifiedPorts(state){
              const primary=state&&state.solution,editor=document.querySelector('.solution-editor');
              const old=document.getElementById('verified-language-ports');if(old)old.remove();
              if(!editor||!primary||!String(primary.code||'').trim())return;
              if(window.__overlayLanguageRunId!==state.runId){
                window.__overlayLanguageRunId=state.runId;
                window.__overlayDesiredLanguage='';
              }
              const ports=Array.isArray(state.ports)?state.ports:[];
              const validated=ports.filter(port=>port&&port.status==='verified'&&String(port.code||'').trim());
              const section=document.createElement('section');section.id='verified-language-ports';section.className='tests';
              const label=document.createElement('b');label.textContent='Verified languages';
              const summary=document.createElement('span');summary.textContent=validated.length+' independent E2B ports';
              const header=document.createElement('div');header.className='tests-head';header.append(label,summary);section.append(header);
              const list=document.createElement('div');list.className='overlay-port-list';
              const desired=window.__overlayDesiredLanguage;
              const primaryLang=canonicalPortLanguage(primary.language);
              const keyPairs=[['python','py'],['rust','rr'],['cpp','cp']];
              for(const [lang,key] of keyPairs){
                const available=lang===primaryLang||validated.some(port=>canonicalPortLanguage(port.language)===lang);
                const chip=document.createElement('span');chip.className='overlay-port-chip';
                chip.dataset.available=available?'true':'false';chip.dataset.selected=desired===lang?'true':'false';
                chip.textContent=lang==='cpp'?'C++ · '+key:lang[0].toUpperCase()+lang.slice(1)+' · '+key;
                chip.title=available?'E2B verified · type '+key+' to select':'Pending independent E2B verification';
                list.append(chip);
              }
              section.append(list);editor.after(section);
              if(!desired)return;
              const chosen=primaryLang===desired?primary:
                validated.find(port=>canonicalPortLanguage(port.language)===desired);
              const source=document.getElementById('solution-source'),title=document.getElementById('solution-title');
              if(!chosen){
                if(source)source.textContent=(desired==='cpp'?'C++':desired)+' not verified yet · primary solution shown';
                return;
              }
              const code=document.getElementById('solution-code');
              if(code){
                renderCodeLines(code,String(chosen.code||''),String(chosen.language||desired));
                code.scrollTop=0;
              }
              if(title)title.textContent='solution.'+(desired==='cpp'?'cpp':desired==='python'?'py':'rs');
              if(source)source.textContent=chosen===primary?'Council-verified primary':'Independently E2B-verified port';
              // Editing one version or importing from a live report never alters
              // the saved original code or the cloud report.
            }
            window.updateOverlayState=function(state){baseUpdateOverlayState(state);window.setOverlayControls(state&&(state.kind==='mcq'||state.mcq)?'mcq':'coding');if(!state||state.kind!=='mcq'){renderStoryAgents(state||{});renderHistoryContext(state||{});renderVerifiedPorts(state||{});}};
    </script></body></html>"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_distinct_quick_letter_double_taps_open_panels() {
        let start = Instant::now();
        let mut last = None;
        assert_eq!(double_tap_panel(&mut last, 1, start), None);
        assert_eq!(double_tap_panel(&mut last, 1, start + Duration::from_millis(230)), Some(1));
        // A completed pair resets; holding a key is filtered at the HID edge.
        assert_eq!(double_tap_panel(&mut last, 1, start + Duration::from_millis(400)), None);
        assert_eq!(double_tap_panel(&mut last, 2, start + Duration::from_millis(475)), None);
        assert_eq!(double_tap_panel(&mut last, 2, start + Duration::from_millis(900)), Some(2));
        assert_eq!(double_tap_panel(&mut last, 3, start + Duration::from_millis(1000)), None);
        assert_eq!(double_tap_panel(&mut last, 3, start + Duration::from_millis(1701)), None);
        assert_eq!(double_tap_panel(&mut last, 3, start + Duration::from_millis(1710)), Some(3));
    }

    #[test]
    fn combined_history_keeps_main_runs_and_both_overlay_job_types() {
        let old=history_row("job:123","Overlay","Coding","Code","local","completed",
            "2026-10-15T12:00:00Z");
        let current=history_row("job:123","Overlay","Coding","Code","cloud","completed",
            "2026-10-15T12:00:00Z");
        let mcq=history_row("job:456","Overlay","MCQ","Question","remote","completed",
            "2026-10-15T14:00:00Z");
        let main=history_row("main:123","Main app","Run","Previous main result","",
            "completed","2026-10-15T13:00:00Z");
        let rows=normalize_history(vec![old,current,mcq,main]).unwrap();
        assert_eq!(rows.len(),3);
        assert_eq!(rows[0]["id"],"job:456");
        assert_eq!(rows[1]["id"],"main:123");
        assert_eq!(rows[2]["id"],"job:123");
    }

    #[test]
    fn coding_projection_preserves_verified_port_and_real_edge_evidence() {
        let job=SubmittedJob {
            id:Uuid::new_v4().to_string(),mode:"coding".into(),mcq_model:None,
            status:"completed".into(),progress_phase:"completed".into(),
            submitted_at:now(),previews:vec![],error:None,
            events:vec![],
            report:Some(serde_json::json!({"report":{
                "winner":"A",
                "candidates":[{"letter":"A","model":"model-coding",
                    "final":{"code":"def solve(x):\n    return x","language":"python"}}],
                "presentation":{
                    "standing":"verified","code":"def solve(x):\n    return x",
                    "language":"python","approach":"Return the input",
                    "evidence":[{"letter":"A","gate":"pass","passed":3,"failed":0}]
                },
                "semanticBlueprint":{
                    "explanation":"Return the given value unchanged.",
                    "structure":{"dataStructures":["lists / dynamic arrays"],
                        "controlFlow":["explicit return values"]}
                },
                "suites":[{"language":"python","harness":
                    "assert solve([]) == []\nassert solve([1]) == [1]\nassert solve([1,1]) == [1,1]"}],
                "ports":[{"language":"rust","status":"verified","code":"fn main() {}"}]
            }})),
        };
        let projected=coding_overlay_state(&job);
        assert_eq!(projected["agents"][0]["status"],"done");
        assert_eq!(projected["agents"][0]["gate"],"pass");
        assert_eq!(projected["ports"][0]["language"],"rust");
        assert_eq!(projected["insights"]["edgeCases"].as_array().map(Vec::len),Some(3));
        assert_eq!(projected["insights"]["summary"],"Return the given value unchanged.");
        let mut no_evidence=job.clone();
        no_evidence.report=Some(serde_json::json!({"report":{
            "presentation":{"standing":"unverified","language":"python"},
            "suites":[{"language":"python","harness":"assert solve([]) == []"}]
        }}));
        let unseen=coding_overlay_state(&no_evidence);
        assert_eq!(unseen["insights"]["edgeCases"].as_array().map(Vec::len),Some(0),
            "Never present proposed harness assertions as tested without Council standing");
    }

    #[test]
    fn number_pairs_route_to_the_requested_workflow_and_capture_shape() {
        let expected = [
            (0, 0, 6),
            (1, 0, 10), (1, 1, 11), (1, 2, 12), (1, 3, 13),
            (2, 0, 20), (2, 2, 22), (2, 3, 23), (2, 4, 24), (2, 5, 25),
            (3, 1, 31), (3, 2, 32), (3, 3, 33), (3, 4, 34), (3, 5, 35),
        ];
        for (prefix, shape, command) in expected {
            assert_eq!(number_pair_command(prefix, shape), Some(command));
        }
        for invalid in [(1, 5), (2, 1), (2, 6), (3, 0), (4, 1)] {
            assert_eq!(number_pair_command(invalid.0, invalid.1), None);
        }
    }

    #[test]
    fn background_workflow_batches_and_results_are_isolated() {
        assert_ne!(pending_path_for("coding").unwrap(), pending_path_for("mcq").unwrap());
        assert_ne!(submitted_job_path_for("coding").unwrap(), submitted_job_path_for("mcq").unwrap());
    }

    #[test]
    fn snapshot_without_jobs_is_self_contained() {
        let value = read_overlay_state_snapshot("mcq", None, None);
        assert!(value.contains("mcq") || value.contains("question"));
    }
    #[test]
    fn overlay_refresh_sends_only_changed_channels() {
        let mut refresh = OverlayRefresh::default();
        assert!(refresh.script("{}", Some("[]")).contains("updateOverlayState"));
        refresh.sent_state = Some("{}".into());
        refresh.sent_previews = Some("[]".into());
        assert!(refresh.script("{}", None).is_empty());
        assert!(refresh.script(r#"{"updatedAt":"new refresh"}"#, None).is_empty());
        assert!(refresh.script("{}", Some("[]")).is_empty());
        assert_eq!(refresh.script("{\"phase\":\"running\"}", None),
            "window.updateOverlayState({\"phase\":\"running\"});");
        assert_eq!(refresh.script("{}", Some("[\"new\"]")),
            "window.updatePreviews([\"new\"]);");
    }

    #[test]
    fn preview_cache_reuses_appended_and_invalidates_changed_files() {
        let first = std::env::temp_dir().join(format!("preview-{}.png", Uuid::new_v4()));
        let second = std::env::temp_dir().join(format!("preview-{}.png", Uuid::new_v4()));
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let paths = vec![first.to_string_lossy().into_owned(), second.to_string_lossy().into_owned()];
        let mut refresh = OverlayRefresh::default();
        let initial = refresh.pending_sources(&paths[..1])[0].clone();
        assert_eq!(refresh.pending_sources(&paths)[0], initial);
        let stable = refresh.pending_sources(&paths).to_vec();
        assert_eq!(refresh.pending_sources(&paths), stable.as_slice());
        fs::write(&first, b"replacement with different length").unwrap();
        assert_ne!(refresh.pending_sources(&paths)[0], initial);
        fs::remove_file(&second).unwrap();
        assert!(refresh.pending_sources(&paths)[1].is_empty());
        fs::write(&second, b"restored").unwrap();
        assert!(!refresh.pending_sources(&paths)[1].is_empty());
        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
    }


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
                    "suites": [{ "language": "python" }], "presentation": {"standing":"verified", "code":"def solve():\n    return 42", "language":"py","provenance":"Candidate B"}
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
    fn coding_overlay_with_early_report_stays_running() {
        let job = SubmittedJob {
            id: "early-report".into(), mode: "council".into(),
            mcq_model: None, status: "running".into(),
            progress_phase: "reviewing".into(), submitted_at: now(),
            previews: vec![], error: None,
            report: Some(serde_json::json!({
                "report": {
                    "winner": "A",
                    "candidates": [{
                        "letter": "A", "model": "model-a",
                        "final": {"kind": "code", "language": "python", "code": "print(42)"}
                    }]
                }
            })),
            events: vec![],
        };
        let state = coding_overlay_state(&job);
        assert_eq!(state["phase"], "running");
        assert!(state["solution"].is_null(), "an unverified early candidate cannot appear in the code editor");
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
        assert!(state["solution"].is_null(), "worker progress must not masquerade as generated code");
        assert!(state["progress"].as_str().unwrap_or("").contains("Asking models"));
    }

    #[test]
    fn coding_overlay_presents_verified_early_code_and_upgrade_diff_history() {
        let report = serde_json::json!({"job_id":"early-1","report":{
            "stage":"provisional","winner":null,
            "provisional":{"status":"provisional","letter":"A","code":"print(1)",
                "language":"python","passed":3,"failed":0},
            "solutionHistory":[{"version":"provisional","code":"print(1)","language":"python"}]
        }});
        assert!(is_usable_cloud_report(&report,"early-1"));
        let job = SubmittedJob {
            id:"early-1".into(), mode:"council".into(), mcq_model:None,
            status:"running".into(), progress_phase:"reviewing".into(), submitted_at:now(),
            previews:vec![], error:None, report:Some(report), events:vec![]
        };
        let state = coding_overlay_state(&job);
        assert_eq!(state["solution"]["status"],"provisional");
        assert_eq!(state["solution"]["code"],"print(1)");
        assert_eq!(state["tests"][0]["status"],"passed");
        assert_eq!(state["phase"],"running");
        assert!(is_usable_cloud_report(&serde_json::json!({"report":{
            "stage":"provisional","provisional":{"status":"provisional",
            "code":"print(1)","passed":1,"failed":0}
        }}),"early-1"));
        assert!(!is_usable_cloud_report(&serde_json::json!({"report":{
            "stage":"provisional","provisional":{"status":"provisional",
            "code":"print(1)","passed":0,"failed":0}
        }}),"early-1"));
    }

    #[test]
    fn finalized_upgrade_shows_tested_winner_and_preserves_both_versions() {
        let job = SubmittedJob {
            id:"upgrade".into(),mode:"council".into(),mcq_model:None,
            status:"completed".into(),progress_phase:"completed".into(),submitted_at:now(),
            previews:vec![],error:None,events:vec![],
            report:Some(serde_json::json!({"report":{
                "stage":"final","winner":"B",
                "presentation":{"standing":"verified","code":"print(2)","language":"python"},
                "solutionHistory":[
                    {"version":"provisional","code":"print(1)","language":"python"},
                    {"version":"final","code":"print(2)","language":"python"}
                ],"upgrade":{"changed":true,"from":"A","to":"B"}
            }}))
        };
        let state = coding_overlay_state(&job);
        assert_eq!(state["solution"]["code"],"print(2)");
        assert_eq!(state["upgrade"]["changed"],true);
        assert_eq!(state["solutionHistory"].as_array().map(Vec::len),Some(2));
    }

    #[test]
    fn main_history_council_record_adapts_to_a_full_overlay_result() {
        let saved_council = serde_json::json!({
            "winner": "A",
            "candidates": [{
                "letter": "A", "model": "openai/gpt-5.6-sol",
                "final": {"kind": "code", "language": "python", "code": "print(42)",
                    "complexity": "Time: O(n); Space: O(1)"}
            }],
            "runs": {"A": {"ran": true, "ok": true, "passed": 6, "failed": 0,
                "runtime": "python3", "durationMs": 41, "note": ""}},
            "revisedRuns": {},
            "dossier": {"synthesis": {"approach": "Scan the input once."}},
            "ports": [{"language": "rust", "status": "verified", "code": "fn main() {}"}]
        });
        let report = main_council_history_report(&saved_council);
        let state = history_coding_state("saved-main-run", &report);
        assert_eq!(state["solution"]["code"], "print(42)");
        assert_eq!(state["presentation"]["approach"], "Scan the input once.");
        assert_eq!(state["tests"][0]["status"], "passed");
        assert_eq!(state["ports"][0]["language"], "rust");
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
    fn exact_job_and_legacy_list_resolve_only_the_tracked_id() {
        let single = serde_json::json!({"id":"job-1","status":"completed"});
        assert_eq!(tracked_job_row(&single, "job-1").unwrap()["status"], "completed");
        assert!(tracked_job_row(&single, "job-2").is_none());
        let list = serde_json::json!({"jobs":[{"id":"job-2","status":"running"},{"id":"job-1","status":"completed"}]});
        assert_eq!(tracked_job_row(&list, "job-1").unwrap()["status"], "completed");
        assert!(tracked_job_row(&Value::Null, "job-1").is_none());
        assert!(tracked_job_row(&serde_json::json!({"jobs":[]}), "job-1").is_none());
    }

    #[test]
    fn cloud_report_requires_matching_job_and_result() {
        assert!(!is_usable_cloud_report(&Value::Null, "job-1"));
        assert!(!is_usable_cloud_report(&serde_json::json!({}), "job-1"));
        assert!(!is_usable_cloud_report(&serde_json::json!({"job_id":"other","report":{"kind":"mcq","answer":{"label":"C"}}}), "job-1"));
        assert!(!is_usable_cloud_report(&serde_json::json!({"job_id":"job-1","report":{"job_id":"other","kind":"mcq","answer":{"label":"C"}}}), "job-1"));
        assert!(!is_usable_cloud_report(&serde_json::json!({"report":{"jobId":"other","presentation":{"code":"return 1"}}}), "job-1"));
        assert!(is_usable_cloud_report(&serde_json::json!({"job_id":"job-1","report":{"kind":"mcq","answer":{"label":"C"}}}), "job-1"));
        assert!(!is_usable_cloud_report(&serde_json::json!({"report":{"candidates":[]}}), "job-1"));
        assert!(!is_usable_cloud_report(&serde_json::json!({"report":{"presentation":{}}}), "job-1"));
        assert!(!is_usable_cloud_report(&serde_json::json!({"report":{"kind":"mcq","answer":{}}}), "job-1"));
        assert!(is_usable_cloud_report(&serde_json::json!({"report":{"presentation":{"code":"return 42"}}}), "job-1"));
        assert!(is_usable_cloud_report(&serde_json::json!({"report":{"candidates":[{"final":{"code":"print(42)"}}]}}), "job-1"));
    }

    #[test]
    fn private_snapshots_replace_complete_files() {
        let path = std::env::temp_dir().join(format!("mds-cache-{}.json", Uuid::new_v4()));
        write_private(&path, br#"{"stage":"old"}"#).expect("write old snapshot");
        write_private(&path, br#"{"stage":"new"}"#).expect("replace snapshot");
        assert_eq!(fs::read_to_string(&path).expect("read snapshot"), r#"{"stage":"new"}"#);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn pending_state_reports_upload_without_changing_overlay_layout() {
        let batch = PendingBatch {
            id: "pending-upload".into(), status: "submitting".into(),
            started_at: now(), submission_id: None, session_id: None,
            owner_id: None, settings_snapshot: None, mode: None,
            images: vec![], error: None,
        };
        assert!(mcq_pending_state(&batch)["progress"].as_str().unwrap_or("").contains("Uploading"));
        let coding = coding_pending_state(&batch);
        assert!(coding["progress"].as_str().unwrap_or("").contains("Uploading"));
        assert!(coding["solution"].is_null(), "Upload progress must not be rendered as executable solution code");
        assert!(coding["agents"].as_array().is_some_and(Vec::is_empty));
        assert!(coding["tests"].as_array().is_some_and(Vec::is_empty));
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
