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
    dpi::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize},
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
const HUD_WIDTH: f64 = 188.0;
const HUD_GAP: f64 = 14.0;
const HUD_HEIGHT: f64 = 392.0;
const HISTORY_HUD_HEIGHT: f64 = 272.0;
// The normal capture workspace deliberately has more vertical room than the
// original HUD: screenshots, the solution, and the thought pane should not
// compete for a short window. Code-focus uses the monitor's full physical
// work area independently of this normal size.
const OVERLAY_HEIGHT: f64 = 1_060.0;
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
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::{
        event::{
            CallbackResult, CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation,
            CGEventTapOptions, CGEventTapPlacement, CGEventType,
        },
        window::{
            kCGWindowLayer, kCGWindowListExcludeDesktopElements,
            kCGWindowListOptionOnScreenOnly, kCGWindowOwnerPID, CGWindowListCopyWindowInfo,
        },
    };
    use objc2_app_kit::NSWorkspace;
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
    const HID_USAGE_KEYBOARD_K: u32 = 0x0E;
    const HID_USAGE_KEYBOARD_L: u32 = 0x0F;
    const HID_USAGE_KEYBOARD_P: u32 = 0x13;
    const HID_USAGE_KEYBOARD_R: u32 = 0x15;
    const HID_USAGE_KEYBOARD_Y: u32 = 0x1C;
    const HID_USAGE_KEYBOARD_S: u32 = 0x16;
    const HID_USAGE_KEYBOARD_RETURN: u32 = 0x28;
    const HID_USAGE_KEYBOARD_BACKSLASH: u32 = 0x31;
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
    const HID_USAGE_KEYBOARD_CAPS_LOCK: u32 = 0x39;

    fn history_open_key(usage: u32, shifted: bool) -> bool {
        usage == HID_USAGE_KEYBOARD_BACKSLASH && !shifted
    }

    // The HID observer deliberately does not consume keys, preserving typing
    // in every foreground app. On an empty Stage Manager space macOS has no
    // key window, so it sounds the alert for those same overlay commands.
    // A separate session filter drops only command key-downs on that empty
    // desktop; the HID observer still receives the physical shortcut.
    fn quiet_desktop_key(keycode: i64, shifted: bool, modified: bool) -> bool {
        if modified {
            return false;
        }
        match keycode {
            // C/M/H open panels; S/L/R/P/Y select a code reader/language.
            8 | 46 | 4 | 1 | 37 | 15 | 35 | 16 => true,
            // The number-pair capture commands do not accept Shift.
            29 | 18 | 19 | 20 | 21 | 23 => !shifted,
            // ANSI backslash opens a saved result only while History is up.
            42 => !shifted && HISTORY_VISIBLE.load(Ordering::SeqCst),
            _ => false,
        }
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(number: *const c_void, number_type: i32, value: *mut c_void) -> bool;
        fn CFRelease(value: *const c_void);
    }

    fn has_frontmost_normal_window(pid: i32) -> Option<bool> {
        let windows = unsafe {
            CGWindowListCopyWindowInfo(
                kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
                0,
            )
        };
        if windows.is_null() {
            return None;
        }
        let mut found = false;
        unsafe {
            for index in 0..CFArrayGetCount(windows.cast()) {
                let window = CFArrayGetValueAtIndex(windows.cast(), index);
                if window.is_null() {
                    continue;
                }
                let owner = CFDictionaryGetValue(window, kCGWindowOwnerPID.cast());
                let layer = CFDictionaryGetValue(window, kCGWindowLayer.cast());
                if owner.is_null() || layer.is_null() {
                    continue;
                }
                let mut owner_pid = 0_i32;
                let mut window_layer = -1_i32;
                if CFNumberGetValue(owner, 3, (&mut owner_pid as *mut i32).cast())
                    && CFNumberGetValue(layer, 3, (&mut window_layer as *mut i32).cast())
                    && owner_pid == pid
                    && window_layer == 0
                {
                    found = true;
                    break;
                }
            }
            CFRelease(windows.cast());
        }
        Some(found)
    }

    fn empty_stage_manager_desktop() -> bool {
        // NSWorkspace identifies the app that receives key events. A visible
        // layer-zero window means there is a real foreground destination;
        // fail open if macOS will not provide its window list.
        let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication();
        let Some(frontmost) = frontmost else {
            return true;
        };
        let pid = frontmost.processIdentifier();
        pid > 0 && has_frontmost_normal_window(pid) == Some(false)
    }

    pub fn register_quiet_desktop_filter() -> Result<CGEventTap<'static>, String> {
        let tap = CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::TailAppendEventTap,
            CGEventTapOptions::Default,
            vec![CGEventType::KeyDown],
            |_proxy, event_type, event: &CGEvent| {
                if !matches!(event_type, CGEventType::KeyDown) {
                    return CallbackResult::Keep;
                }
                let keycode = event.get_integer_value_field(
                    core_graphics::event::EventField::KEYBOARD_EVENT_KEYCODE,
                );
                let flags = event.get_flags();
                let shifted = flags.contains(CGEventFlags::CGEventFlagShift);
                let modified = flags.intersects(
                    CGEventFlags::CGEventFlagControl
                        | CGEventFlags::CGEventFlagAlternate
                        | CGEventFlags::CGEventFlagCommand,
                );
                if quiet_desktop_key(keycode, shifted, modified) && empty_stage_manager_desktop() {
                    CallbackResult::Drop
                } else {
                    CallbackResult::Keep
                }
            },
        )
        .map_err(|_| "macOS did not permit the quiet desktop shortcut filter (Accessibility permission may be needed)".to_string())?;
        let source = tap
            .mach_port()
            .create_runloop_source(0)
            .map_err(|_| "Could not create the quiet desktop shortcut run-loop source")?;
        CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopCommonModes });
        tap.enable();
        Ok(tap)
    }

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
    // SL/SR dock the verified code reader left or right.
    static CODE_FOCUS_COMMAND: AtomicU8 = AtomicU8::new(0);
    static LANGUAGE_KEY_HELD: AtomicU8 = AtomicU8::new(0);
    static LAST_LANGUAGE_KEY: Mutex<Option<(u32, bool, Instant)>> = Mutex::new(None);
    static OVERLAY_VISIBLE: AtomicBool = AtomicBool::new(false);
    static CODING_OVERLAY_VISIBLE: AtomicBool = AtomicBool::new(false);
    static HISTORY_VISIBLE: AtomicBool = AtomicBool::new(false);
    // 1 coding, 2 multiple-choice, 3 shared cloud history.
    static PANEL_COMMAND: AtomicU8 = AtomicU8::new(0);
    // History must remain reachable even if a screenshot picker is pending.
    static HISTORY_TOGGLE_COMMAND: AtomicBool = AtomicBool::new(false);
    // Suppress hardware key-repeat; require two distinct keydown edges.
    static PANEL_KEY_HELD: AtomicU8 = AtomicU8::new(0);
    static LAST_PANEL_KEY: Mutex<Option<(u8, bool, Instant)>> = Mutex::new(None);
    // Encoded pairs: 00 and 10-13 route to the main app, 21-25 are coding
    // overlay controls, and 31-35 are MCQ overlay controls.
    static NUMBER_COMMAND: AtomicU8 = AtomicU8::new(0);

    static CONTROL_DOWN: AtomicBool = AtomicBool::new(false);
    static SHIFT_DOWN: AtomicBool = AtomicBool::new(false);
    // The initial lock state need not be queried: paired-case equality is
    // invariant if both letters are inverted. Tracking subsequent toggles is
    // enough to reject a pair that changes case between its two keypresses.
    static CAPS_LOCK_ON: AtomicBool = AtomicBool::new(false);
    static CAPS_LOCK_HELD: AtomicBool = AtomicBool::new(false);
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

    // Physical HID usages are the same for 's'/'S', 'l'/'L' and
    // 'r'/'R'. Shift affects character output, not this command mapping.
    fn dock_pair_command(first: u32, second: u32) -> u8 {
        match (first,second) {
            (HID_USAGE_KEYBOARD_S,HID_USAGE_KEYBOARD_L)=>5,
            (HID_USAGE_KEYBOARD_S,HID_USAGE_KEYBOARD_R)=>6,
            _=>0,
        }
    }

    fn panel_key_command(usage: u32) -> Option<(u8, u8)> {
        match usage {
            HID_USAGE_KEYBOARD_C => Some((1, 1)),
            HID_USAGE_KEYBOARD_M => Some((2, 2)),
            HID_USAGE_KEYBOARD_H => Some((3, 4)),
            _ => None,
        }
    }

    fn language_pair_window(first: u32, second: u32) -> Duration {
        if dock_pair_command(first, second) != 0 {
            Duration::from_millis(1_200)
        } else {
            Duration::from_millis(650)
        }
    }

    #[cfg(test)]
    mod dock_tests {
        use super::*;
        #[test]
        fn sl_sr_use_case_independent_physical_key_usages() {
            assert_eq!(dock_pair_command(HID_USAGE_KEYBOARD_S,HID_USAGE_KEYBOARD_L),5);
            assert_eq!(dock_pair_command(HID_USAGE_KEYBOARD_S,HID_USAGE_KEYBOARD_R),6);
            assert_eq!(dock_pair_command(HID_USAGE_KEYBOARD_L,HID_USAGE_KEYBOARD_S),0);
            assert_eq!(dock_pair_command(HID_USAGE_KEYBOARD_S,HID_USAGE_KEYBOARD_S),0);
            assert_eq!(language_pair_window(HID_USAGE_KEYBOARD_S,HID_USAGE_KEYBOARD_L), Duration::from_millis(1_200));
            assert_eq!(language_pair_window(HID_USAGE_KEYBOARD_S,HID_USAGE_KEYBOARD_R), Duration::from_millis(1_200));
            assert_eq!(language_pair_window(HID_USAGE_KEYBOARD_C,HID_USAGE_KEYBOARD_P), Duration::from_millis(650));
            assert_eq!(language_pair_window(HID_USAGE_KEYBOARD_R,HID_USAGE_KEYBOARD_R), Duration::from_millis(650));
        }

        #[test]
        fn legacy_panel_pairs_keep_their_original_destinations() {
            assert_eq!(panel_key_command(HID_USAGE_KEYBOARD_C), Some((1, 1)));
            assert_eq!(panel_key_command(HID_USAGE_KEYBOARD_M), Some((2, 2)), "MM remains the MCQ panel command");
            assert_eq!(panel_key_command(HID_USAGE_KEYBOARD_H), Some((3, 4)));
        }

        #[test]
        fn idle_desktop_filter_spares_modified_keys_and_unrelated_typing() {
            assert!(quiet_desktop_key(8, false, false)); // cc
            assert!(quiet_desktop_key(8, true, false)); // CC
            assert!(quiet_desktop_key(19, false, false)); // 22
            assert!(!quiet_desktop_key(8, false, true)); // Cmd-C / Ctrl-C
            assert!(!quiet_desktop_key(19, true, false));
            assert!(!quiet_desktop_key(0, false, false)); // a
        }

        #[test]
        fn history_opens_with_backslash_not_right_arrow() {
            assert!(history_open_key(HID_USAGE_KEYBOARD_BACKSLASH, false));
            assert!(!history_open_key(HID_USAGE_KEYBOARD_RIGHT_ARROW, false));
            assert!(!history_open_key(HID_USAGE_KEYBOARD_BACKSLASH, true));
        }

        #[test]
        fn user_cases_parse_arrows_and_labelled_pairs() {
            let parsed = super::super::parse_user_cases(
                "nums = [2,7], target = 9 => [0,1]\nInput: nums = [3,3], target = 6\nOutput: [0,1]\nnoise line",
            );
            assert_eq!(parsed.len(), 2);
            assert_eq!(parsed[0].input, "nums = [2,7], target = 9");
            assert_eq!(parsed[0].output, "[0,1]");
            assert_eq!(parsed[1].output, "[0,1]");
            assert!(super::super::parse_user_cases("nothing here").is_empty());
        }
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

        // Accept all-lowercase or all-uppercase pairs, but not mixed-case
        // pairs. A double press must have a key release between taps. The
        // callback does not store keystrokes or alter foreground input.
        let uppercase = SHIFT_DOWN.load(Ordering::SeqCst)
            ^ CAPS_LOCK_ON.load(Ordering::SeqCst);
        let panel_key = panel_key_command(usage);
        if let Some((command, bit)) = panel_key {
            if !pressed {
                PANEL_KEY_HELD.fetch_and(!bit, Ordering::SeqCst);
            } else if !CONTROL_DOWN.load(Ordering::SeqCst)
                && !OPTION_DOWN.load(Ordering::SeqCst)
                && PANEL_KEY_HELD.fetch_or(bit, Ordering::SeqCst) & bit == 0
            {
                if let Ok(mut previous) = LAST_PANEL_KEY.lock() {
                    if super::double_tap_panel(&mut previous, command, uppercase, Instant::now()).is_some() {
                            if command == 3 {
                                HISTORY_TOGGLE_COMMAND.store(true, Ordering::SeqCst);
                            } else {
                                PANEL_COMMAND.store(command, Ordering::SeqCst);
                            }
                            super::trace(&format!("hotkey command={command} overlay_visible={}", OVERLAY_VISIBLE.load(Ordering::SeqCst)));
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
            HID_USAGE_KEYBOARD_S=>Some(16_u8), HID_USAGE_KEYBOARD_L=>Some(32_u8),
            _=>None,
        };
        if let Some(bit)=lang_key {
            if !pressed {LANGUAGE_KEY_HELD.fetch_and(!bit,Ordering::SeqCst);}
            else if !CONTROL_DOWN.load(Ordering::SeqCst)
                && !OPTION_DOWN.load(Ordering::SeqCst)
                // The physical S/L/R usages are identical for uppercase and
                // lowercase; Shift must not disable the requested SL/SR docks.
                && LANGUAGE_KEY_HELD.fetch_or(bit,Ordering::SeqCst)&bit==0
            {
                if let Ok(mut previous)=LAST_LANGUAGE_KEY.lock(){
                    // Let an intentional pair work at a normal typing pace;
                    // SL/SR must not require an unrealistically fast chord.
                    let pair=previous.take().filter(|(first, first_uppercase, at)|
                        super::same_letter_case(*first_uppercase, uppercase)
                            && at.elapsed() <= language_pair_window(*first, usage))
                        .map(|(first, _, _)|(first,usage));
                    *previous=Some((usage, uppercase, Instant::now()));
                    let choice=match pair {
                        Some((HID_USAGE_KEYBOARD_R,HID_USAGE_KEYBOARD_R))=>1,
                        Some((HID_USAGE_KEYBOARD_C,HID_USAGE_KEYBOARD_P))=>2,
                        Some((HID_USAGE_KEYBOARD_P,HID_USAGE_KEYBOARD_Y))=>3,
                        Some((first,second))=>dock_pair_command(first,second),
                        _=>0,
                    };
                    if choice!=0 {
                        // Preserve prior behavior: RR/CP/PY are active only
                        // while the Coding overlay is visible. Only SL/SR
                        // may open the verified code sheet from another app.
                        if choice<=3 {
                            // Both lowercase and uppercase pairs are accepted,
                            // but modifiers must not route the command elsewhere.
                            if !HISTORY_VISIBLE.load(Ordering::SeqCst)
                                && CODING_OVERLAY_VISIBLE.load(Ordering::SeqCst) {
                                LANGUAGE_COMMAND.store(choice,Ordering::SeqCst);
                            }
                        } else {
                            // 5 -> left (2), 6 -> right (3). Both work with
                            // Shift held throughout or on either letter.
                            CODE_FOCUS_COMMAND.store(choice-3,Ordering::SeqCst);
                        }
                        *previous=None;
                    }
                }
            }
        }else if pressed&&usage<HID_USAGE_KEYBOARD_LEFT_CONTROL{
            if let Ok(mut previous)=LAST_LANGUAGE_KEY.lock(){*previous=None;}
        }
        // Number pairs route into three independent destinations. The first
        // digit selects the workflow; the second selects its capture mode.
        // While the overlay is hidden these keys belong to whatever app has
        // focus, so a solution that happens to contain "22" cannot fire.
        if pressed && OVERLAY_VISIBLE.load(Ordering::SeqCst)
            && !CONTROL_DOWN.load(Ordering::SeqCst)
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
                            super::trace(&format!("pair command={command}"));
                        }
                    }
                }
            } else if usage < HID_USAGE_KEYBOARD_LEFT_CONTROL {
                if let Ok(mut previous) = LAST_DIGIT.lock() { *previous = None; }
            }
        }

        // These controls are deliberately active only while the coding overlay
        // is visible, so ordinary typing elsewhere is unaffected.
        if pressed && OVERLAY_VISIBLE.load(Ordering::SeqCst)
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
                // Backslash selects the highlighted saved run and opens its
                // full read-only Council result in the overlay.
                (key, shifted) if HISTORY_VISIBLE.load(Ordering::SeqCst) && history_open_key(key, shifted) => HISTORY_OPEN.store(true, Ordering::SeqCst),
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
            HID_USAGE_KEYBOARD_CAPS_LOCK => {
                if pressed {
                    if !CAPS_LOCK_HELD.swap(true, Ordering::SeqCst) {
                        CAPS_LOCK_ON.fetch_xor(true, Ordering::SeqCst);
                    }
                } else {
                    CAPS_LOCK_HELD.store(false, Ordering::SeqCst);
                }
            }
            HID_USAGE_KEYBOARD_LEFT_ALT | HID_USAGE_KEYBOARD_RIGHT_ALT => {
                OPTION_DOWN.store(pressed, Ordering::SeqCst)
            }
            HID_USAGE_KEYBOARD_LEFT_ARROW
            | HID_USAGE_KEYBOARD_RIGHT_ARROW
            | HID_USAGE_KEYBOARD_UP_ARROW
            | HID_USAGE_KEYBOARD_DOWN_ARROW
                if pressed
                    && OVERLAY_VISIBLE.load(Ordering::SeqCst)
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
            | HID_USAGE_KEYBOARD_S
            | HID_USAGE_KEYBOARD_RETURN
                if pressed
                    && CONTROL_DOWN.load(Ordering::SeqCst)
                    && OPTION_DOWN.load(Ordering::SeqCst) =>
            {
                match usage {
                    HID_USAGE_KEYBOARD_B => START_BATCH.store(true, Ordering::SeqCst),
                    HID_USAGE_KEYBOARD_P | HID_USAGE_KEYBOARD_S => CAPTURE.store(true, Ordering::SeqCst),
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
    pub fn take_history_toggle_command() -> bool {
        HISTORY_TOGGLE_COMMAND.swap(false, Ordering::SeqCst)
    }
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
    pub fn set_overlay_visible(value: bool) { OVERLAY_VISIBLE.store(value, Ordering::SeqCst); }
    pub fn set_coding_overlay_visible(value: bool) { CODING_OVERLAY_VISIBLE.store(value, Ordering::SeqCst); }
    pub fn take_code_focus_command() -> u8 { CODE_FOCUS_COMMAND.swap(0, Ordering::SeqCst) }
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
struct BatchCase {
    input: String,
    output: String,
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
    #[cfg(target_os = "macos")]
    let (mut quiet_desktop_tap, mut quiet_desktop_problem) = match mac_shortcuts::register_quiet_desktop_filter() {
        Ok(tap) => (Some(tap), None),
        Err(error) => {
            eprintln!("{error}");
            write_helper_status(mac_shortcuts::hotkeys_ready(), Some(&error));
            (None, Some(error))
        }
    };
    #[cfg(not(target_os = "macos"))]
    write_helper_status(true, None);

    let (mut overlay_position, overlay_height) = overlay_geometry(&event_loop);
    let (overlay, webview) = overlay_window(&event_loop, overlay_position, overlay_height)?;
    let (hud, hud_webview) = hud_window(&event_loop, overlay_position)?;
    let mut active_view = "coding".to_string();
    let mut last_hud_view = "coding".to_string();
    let mut overlay_refresh = OverlayRefresh::default();
    update_overlay(&webview, &active_view, &mut overlay_refresh)?;
    let mut overlay_visible = false;
    let mut overlay_alpha = 0.46_f64;
    // 0 = normal Council overlay, 2 = code reader left, 3 = code reader right.
    let mut code_focus_mode = 0_u8;
    // A history reader stays on that specifically opened result while docking
    // from left to right. A live reader follows only the current Coding run.
    let mut code_focus_from_history = false;
    let mut code_focus_live_run_id: Option<String> = None;
    // RR / CP / PY select a verified language port for one exact Coding run.
    // Keep that choice on the native side too: SL/SR are native shortcuts and
    // must not race the browser's 500ms state refresh when opening the reader.
    let mut code_focus_language: Option<(String, String)> = None;
    let mut history_open = false;
    let mut history_rows: Vec<Value> = Vec::new();
    let mut history_index = 0_usize;
    let mut history_detail_open = false;
    let mut history_fetch: Option<tokio::task::JoinHandle<Result<(Vec<Value>,Option<String>),String>>> = None;
    // History rows stay separate from live work.  Keep only a small, per-item
    // cache so moving through rows is immediate without allowing an earlier
    // network response to overwrite the newly selected result.
    let mut history_detail_fetch: Option<tokio::task::JoinHandle<(String, Result<Value,String>)>> = None;
    let mut history_detail_requested_id: Option<String> = None;
    let mut history_detail_cache = std::collections::HashMap::<String, Value>::new();
    // A history result remains an independent, read-only source while it is
    // opened. It lets SL/SR extract that verified result without replacing
    // it with the newest live coding job.
    let mut history_code_focus_state: Option<Value> = None;
    let mut last_job_poll = Instant::now() - Duration::from_secs(60);
    let mut last_overlay_refresh = Instant::now();
    #[cfg(target_os = "macos")]
    let mut last_reinforce = Instant::now();
    let mut last_history_refresh = Instant::now() - Duration::from_secs(60);
    let mut last_heartbeat = Instant::now();
    #[cfg(target_os = "macos")]
    let mut last_quiet_retry = Instant::now();
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
        // Global capture hotkeys do not wake Tao's event loop themselves.
        // Keep this short so the helper begins screencapture and restores the
        // click-through overlay promptly, without ever showing the overlay in
        // the image being taken.  The cloud work remains asynchronous.
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(33));
        #[cfg(target_os = "macos")]
        drain_capture_commands();
        #[cfg(target_os = "macos")]
        {
            let command = mac_shortcuts::take_number_command();
            // A new overlay action always starts from its normal task view.
            // A docked answer or opened History result must not cover the
            // next capture, submission, or fresh Coding session.
            if matches!(command, 6 | 20 | 22 | 23 | 24 | 25 | 31..=35) {
                if code_focus_mode != 0 {
                    code_focus_mode = 0;
                    code_focus_from_history = false;
                    code_focus_live_run_id = None;
                    restore_normal_geometry(&overlay, &hud, overlay_position);
                    let _ = webview.evaluate_script("window.setCodeFocusMode('normal')");
                    let _ = webview.evaluate_script("window.clearCodeFocusSolution()");
                }
                if history_open {
                    history_open = false;
                    history_detail_open = false;
                    history_code_focus_state = None;
                    if let Some(task) = history_detail_fetch.take() { task.abort(); }
                    history_detail_requested_id = None;
                    mac_shortcuts::set_history_visible(false);
                    let _ = webview.evaluate_script("window.closeSharedHistory()");
                    overlay_refresh.sent_state = None;
                    overlay_refresh.sent_previews = None;
                }
            }
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
                    let _ = show_overlay_pair(&overlay, &hud, true, code_focus_mode);
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
                        let _ = show_overlay_pair(&overlay, &hud, true, code_focus_mode);
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
                        if let Err(error) = clear_pending_capture_error(&active_view) {
                            eprintln!("could not clear prior capture diagnostic: {error}");
                        }
                        capture_active_view = Some(active_view.clone());
                        // Background-route captures open their own coding/MCQ
                        // surface after the grab so the staged images and next
                        // action are visible without leaving the source app.
                        restore_overlay_after_capture = true;
                        overlay_visible = false;
                    let _ = show_overlay_pair(&overlay, &hud, false, code_focus_mode);
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
                    let _ = show_overlay_pair(&overlay, &hud, true, code_focus_mode);
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
                        let selected_id = history_rows.get(history_index)
                            .and_then(|row| row.get("id")).and_then(Value::as_str)
                            .map(str::to_owned);
                        history_rows=rows;
                        history_index=selected_id.as_deref().and_then(|id| history_rows.iter()
                            .position(|row| row.get("id").and_then(Value::as_str)==Some(id)))
                            .unwrap_or(0);
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
                match rt.block_on(task) {
                    Ok((id, result)) => {
                        let detail = result.unwrap_or_else(|error| serde_json::json!({"error": error}));
                        if history_detail_cache.len() >= 35 {
                            history_detail_cache.clear();
                        }
                        history_detail_cache.insert(id.clone(), detail.clone());
                        let selected = history_rows.get(history_index)
                            .and_then(|row| row.get("id")).and_then(Value::as_str);
                        if history_open && history_detail_open && selected == Some(id.as_str()) {
                            history_code_focus_state = detail.get("state").cloned()
                                .filter(code_focus_state_eligible);
                            let script = format!("window.showSharedHistoryDetail({});",
                                serde_json::to_string(&detail).unwrap_or_else(|_| "{}".into()));
                            let _ = webview.evaluate_script(&script);
                        }
                    }
                    Err(error) if history_open && history_detail_open => {
                        let script = format!("window.showSharedHistoryDetail({});",
                            serde_json::json!({"error": error.to_string()}));
                        let _ = webview.evaluate_script(&script);
                    }
                    Err(_) => {}
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
            {
                if quiet_desktop_tap.is_none()
                    && last_quiet_retry.elapsed() >= Duration::from_secs(10)
                {
                    last_quiet_retry = Instant::now();
                    match mac_shortcuts::register_quiet_desktop_filter() {
                        Ok(tap) => {
                            quiet_desktop_tap = Some(tap);
                            quiet_desktop_problem = None;
                        }
                        Err(error) => quiet_desktop_problem = Some(error),
                    }
                }
                if let Some(tap) = &quiet_desktop_tap {
                    tap.enable();
                }
                write_helper_status(
                    helper_hotkeys_ready,
                    if helper_hotkeys_ready {
                        quiet_desktop_problem.as_deref()
                    } else {
                        Some("Input Monitoring permission unavailable")
                    },
                );
            }
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
                let _ = show_overlay_pair(&overlay, &hud, overlay_visible, code_focus_mode);
                let capture_view = capture_active_view.take().unwrap_or_else(|| active_view.clone());
                if let Err(error) = result {
                    eprintln!("capture failed: {error}");
                    let _ = update_pending_error(&capture_view, &error);
                }
                if !history_open {
                    let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                }
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
            // The main app can begin a new Coding question without one of the
            // helper's numeric capture commands. A code-only reader for the
            // previous run must then return to the normal Coding surface,
            // instead of keeping an empty dock that needs two more shortcuts.
            if code_focus_mode != 0 && !code_focus_from_history {
                let no_pending = matches!(read_pending_for("coding"), Ok(None));
                let job = read_submitted_job_for("coding").ok().flatten();
                let current = code_focus_live_run_id.as_deref().is_some_and(|id|
                    job.as_ref().is_some_and(|job| job.id == id && code_focus_eligible(Some(job), no_pending)));
                if !current {
                    code_focus_mode = 0;
                    code_focus_live_run_id = None;
                    restore_normal_geometry(&overlay, &hud, overlay_position);
                    let _ = webview.evaluate_script("window.setCodeFocusMode('normal')");
                    let _ = webview.evaluate_script("window.clearCodeFocusSolution()");
                    let _ = show_overlay_pair(&overlay, &hud, overlay_visible, code_focus_mode);
                }
            }
            let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
        }

        #[cfg(target_os = "macos")]
        {
            mac_shortcuts::set_overlay_visible(overlay_visible);
            if overlay_visible && last_reinforce.elapsed() >= Duration::from_millis(900) {
                last_reinforce = Instant::now();
                reinforce_overlay(&overlay);
            }
            mac_shortcuts::set_coding_overlay_visible(overlay_visible && active_view == "coding");
            // HH is its own surface; unlike the two task views it must not
            // change which batch is active. CC/MM switch surfaces in-place
            // without opening the main app, stealing application focus, or
            // changing the cloud solving engine.
            // History has its own signal and is always available, including
            // while a screenshot picker is pending. This prevents a stalled
            // picker from trapping the person away from HH.
            if mac_shortcuts::take_history_toggle_command() {
                let was_code_reader = code_focus_mode != 0;
                if was_code_reader {
                    code_focus_mode = 0;
                    code_focus_from_history = false;
                    code_focus_live_run_id = None;
                    restore_normal_geometry(&overlay, &hud, overlay_position);
                    let _ = webview.evaluate_script("window.setCodeFocusMode('normal')");
                    let _ = webview.evaluate_script("window.clearCodeFocusSolution()");
                }
                // HH is a true toggle. Repeating it closes the whole overlay
                // rather than leaving a hidden history sheet over the prior view.
                if overlay_visible && history_open {
                    history_open = false;
                    history_detail_open = false;
                    if let Some(task) = history_detail_fetch.take() { task.abort(); }
                    history_detail_requested_id = None;
                    mac_shortcuts::set_history_visible(false);
                    let _ = webview.evaluate_script("window.closeSharedHistory()");
                    overlay_visible = false;
                    let _ = show_overlay_pair(&overlay, &hud, false, code_focus_mode);
                } else {
                    // The list is server-authoritative. Start empty rather
                    // than showing stale helper data while the snapshot loads.
                    history_rows.clear();
                    history_index = 0;
                    history_open = true;
                    history_detail_open = false;
                    history_detail_requested_id = None;
                    mac_shortcuts::set_history_visible(true);
                    let rows = serde_json::to_string(&history_rows).unwrap_or_else(|_| "[]".into());
                    last_history_refresh = Instant::now();
                    history_fetch = Some(rt.spawn(fetch_unified_history()));
                    overlay_visible = true;
                    event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                    let _ = show_overlay_pair(&overlay, &hud, true, code_focus_mode);
                    let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                    let _ = webview.evaluate_script(&format!(
                        "window.showSharedHistory({rows},0,true,null)"));
                }
            }

            // Defer CC/MM during an active screenshot picker without taking
            // and discarding their atomic command.
            let panel_command = if capture_task.as_ref().is_none_or(|task| task.is_finished()) {
                mac_shortcuts::take_panel_command()
            } else {
                0
            };
            match panel_command {
                command @ (1 | 2) => {
                    let was_code_reader = code_focus_mode != 0;
                    if was_code_reader {
                        code_focus_mode = 0;
                        code_focus_from_history = false;
                        code_focus_live_run_id = None;
                        restore_normal_geometry(&overlay, &hud, overlay_position);
                        let _ = webview.evaluate_script("window.setCodeFocusMode('normal')");
                        let _ = webview.evaluate_script("window.clearCodeFocusSolution()");
                    }
                    let target_view = if command == 1 { "coding" } else { "mcq" };
                    // CC/MM close their own open surface, while a command
                    // for the other surface switches without hiding.
                    if overlay_visible && !history_open && active_view == target_view
                        && !was_code_reader {
                        overlay_visible = false;
                        let _ = show_overlay_pair(&overlay, &hud, false, code_focus_mode);
                    } else {
                        history_open = false;
                        history_detail_open = false;
                        if let Some(task) = history_detail_fetch.take() { task.abort(); }
                        history_detail_requested_id = None;
                        mac_shortcuts::set_history_visible(false);
                        let _ = webview.evaluate_script("window.closeSharedHistory()");
                        overlay_refresh.sent_state=None;
                        overlay_refresh.sent_previews=None;
                        active_view = target_view.to_string();
                        overlay_visible = true;
                        event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                    let _ = show_overlay_pair(&overlay, &hud, true, code_focus_mode);
                        let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                    }
                }
                7 => {
                    match import_clipboard_cases(&active_view) {
                        Ok(count) => log(&format!("imported {count} user test case(s)")),
                        Err(error) => eprintln!("case import failed: {error}"),
                    }
                    let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
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
                    // These are helper-overlay captures even when their
                    // shortcut is pressed from another app.  Always restore
                    // the Coding/MCQ surface when screencapture returns so
                    // the person can immediately confirm the staged image.
                    restore_overlay_after_capture = true;
                    if let Err(error) = clear_pending_capture_error(&active_view) {
                        eprintln!("could not clear prior capture diagnostic: {error}");
                    }
                    capture_active_view = Some(active_view.clone());
                    overlay_visible = false;
                    let _ = show_overlay_pair(&overlay, &hud, false, code_focus_mode);
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
                hud.set_outer_position(hud_position(overlay_position));
            }
            if overlay_visible && mac_shortcuts::take_move_right() {
                overlay_position.x += 80.0;
                overlay.set_outer_position(overlay_position);
                hud.set_outer_position(hud_position(overlay_position));
            }
            if overlay_visible && mac_shortcuts::take_move_up() {
                overlay_position.y -= 80.0;
                overlay.set_outer_position(overlay_position);
                hud.set_outer_position(hud_position(overlay_position));
            }
            if overlay_visible && mac_shortcuts::take_move_down() {
                overlay_position.y += 80.0;
                overlay.set_outer_position(overlay_position);
                hud.set_outer_position(hud_position(overlay_position));
            }
            // Match ordinary Solution scrolling exactly: ↑/↓ send the same
            // scroll function, which chooses the docked code reader whenever
            // SL/SR is active. No WebView focus or mouse interaction needed.
            let can_scroll_solution = overlay_visible && !history_open
                && (active_view == "coding" || code_focus_mode != 0);
            if can_scroll_solution && mac_shortcuts::take_scroll_up() {
                let _ = webview.evaluate_script("window.scrollSolutionBy(-260)");
            }
            if can_scroll_solution && mac_shortcuts::take_scroll_down() {
                let _ = webview.evaluate_script("window.scrollSolutionBy(260)");
            }
            if overlay_visible && mac_shortcuts::take_fade_down() {
                overlay_alpha = (overlay_alpha - 0.07).max(0.18);
                let _ = set_ghost_opacity(&overlay, overlay_alpha);
                let _ = set_ghost_opacity(&hud, overlay_alpha);
            }
            if overlay_visible && mac_shortcuts::take_fade_up() {
                overlay_alpha = (overlay_alpha + 0.07).min(0.95);
                let _ = set_ghost_opacity(&overlay, overlay_alpha);
                let _ = set_ghost_opacity(&hud, overlay_alpha);
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
                        history_detail_requested_id = None;
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
                {
                    if let Some(row) = history_rows.get(history_index).cloned() {
                        let id = row.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                        if id.is_empty() {
                            eprintln!("history item had no identifier");
                        } else {
                            let title = row.get("title").and_then(Value::as_str).unwrap_or("Saved result").to_string();
                            history_detail_open = true;
                            if let Some(detail) = history_detail_cache.get(&id) {
                                let mut detail = detail.clone();
                                if let Some(state) = detail.get_mut("state").and_then(Value::as_object_mut) {
                                    state.insert("historyTitle".into(), Value::String(title));
                                }
                                history_code_focus_state = detail.get("state").cloned()
                                    .filter(code_focus_state_eligible);
                                let _ = webview.evaluate_script(&format!(
                                    "window.showSharedHistoryDetail({});",
                                    serde_json::to_string(&detail).unwrap_or_else(|_| "{}".into())));
                            } else {
                                if let Some(task) = history_detail_fetch.take() { task.abort(); }
                                history_detail_requested_id = Some(id.clone());
                                history_detail_fetch = Some(rt.spawn(async move {
                                    let result = fetch_history_detail(row).await.map(|mut detail| {
                                        if let Some(state) = detail.get_mut("state").and_then(Value::as_object_mut) {
                                            state.insert("historyTitle".into(), Value::String(title));
                                        }
                                        detail
                                    });
                                    (id, result)
                                }));
                                let _ = webview.evaluate_script("window.showSharedHistoryDetail({loading:true});");
                            }
                        }
                    }
                }
                // Read the selected saved result ahead of an explicit open.
                // This leaves the History list visible, but makes backslash immediate
                // for recently selected rows.  A new arrow selection cancels
                // only its own stale fetch; it never touches a live Council run.
                if !history_detail_open {
                    if let Some(row) = history_rows.get(history_index).cloned() {
                        if let Some(id) = row.get("id").and_then(Value::as_str).map(str::to_owned) {
                            if !history_detail_cache.contains_key(&id)
                                && history_detail_requested_id.as_deref() != Some(id.as_str()) {
                                if let Some(task) = history_detail_fetch.take() { task.abort(); }
                                history_detail_requested_id = Some(id.clone());
                                history_detail_fetch = Some(rt.spawn(async move {
                                    let result = fetch_history_detail(row).await;
                                    (id, result)
                                }));
                            }
                        }
                    }
                }
            } else {
                let _ = mac_shortcuts::take_history_previous();
                let _ = mac_shortcuts::take_history_next();
                let _ = mac_shortcuts::take_history_open();
                let _ = mac_shortcuts::take_history_back();
                history_detail_requested_id = None;
            }
            // Handle the language pair before SL/SR.  A person can type CP
            // then SL in rapid succession; opening the reader must use C++ on
            // its very first render rather than briefly falling back to Python.
            let requested_language=mac_shortcuts::take_language_command();
            if overlay_visible&&!history_open&&active_view=="coding"&&requested_language!=0 {
                let language=match requested_language {1=>"rust",2=>"cpp",3=>"python",_=>""};
                if !language.is_empty() {
                    let current = read_submitted_job_for("coding").ok().flatten()
                        .map(|job| coding_overlay_state(&job));
                    code_focus_language = current.as_ref().and_then(code_state_id)
                        .map(|run_id| (run_id, language.to_string()));
                    let _=webview.evaluate_script(&format!("window.selectVerifiedOverlayLanguage({});",
                        serde_json::to_string(language).unwrap_or_else(|_|"\"\"".into())));
                }
            }
            // Code-only mode shares this exact capture-protected click-through window.
            // Never show unverified code or move the main app into focus.
            let focus_command=mac_shortcuts::take_code_focus_command();
            // A verified coding result opened from HH is just as safe to read
            // as the current live result. The history list itself is not: a
            // person must first open a result with backslash.
            // These are Coding-solution-only controls. They may be triggered
            // globally while Coding is the selected surface, but must never
            // hijack an active MCQ view; History permits them only after a
            // coding result itself has been opened.
            let code_focus_context =
                code_focus_shortcut_allowed(&active_view, history_open, history_detail_open);
            if focus_command != 0 && code_focus_context {
                // Fail closed if the pending-batch file cannot be read: an
                // unreadable fresh capture must never unlock an older answer.
                let no_pending_batch = matches!(read_pending_for("coding"), Ok(None));
                let current_job = read_submitted_job_for("coding").ok().flatten();
                let selected_history = history_detail_open
                    || (code_focus_mode != 0 && code_focus_from_history);
                let opened_history = selected_history.then(|| history_code_focus_state.clone()).flatten();
                let live_state = current_job.as_ref()
                    .filter(|job| code_focus_eligible(Some(job), no_pending_batch))
                    .map(coding_overlay_state);
                // A selected History result takes priority, not an unrelated
                // live batch. The same dock shortcut always lets us leave the
                // reader even if the underlying job later becomes unavailable.
                let chosen_state = if selected_history {
                    opened_history.filter(code_focus_state_eligible)
                } else { live_state };
                let returning_to_coding = code_focus_mode != 0 && focus_command == code_focus_mode;
                if returning_to_coding || chosen_state.is_some() {
                    // SL/SR select their side; repeating the same dock pair
                    // returns to the normal capture pane.
                    let next = if focus_command == code_focus_mode { 0 } else { focus_command };
                    code_focus_mode = next;
                    if next == 0 {
                        restore_normal_geometry(&overlay, &hud, overlay_position);
                    } else if let Some((point,size)) = code_focus_geometry(&overlay, event_loop_target, next) {
                        overlay.set_inner_size(size);
                        overlay.set_outer_position(point);
                        hud.set_outer_position(docked_hud_position(point, size, next, overlay.scale_factor()));
                    }
                    active_view = "coding".to_string();
                    history_open = false;
                    history_detail_open = false;
                    mac_shortcuts::set_history_visible(false);
                    let _ = webview.evaluate_script("window.closeSharedHistory()");
                    let mode = match next { 2 => "left", 3 => "right", _ => "normal" };
                    if next != 0 {
                        // Pin the exact verified solution before the screen
                        // changes. Live jobs follow newer verified revisions of
                        // this same run; opened History results remain frozen.
                        let follow_live = !selected_history;
                        code_focus_from_history = selected_history;
                        code_focus_live_run_id = if follow_live {
                            code_state_id(chosen_state.as_ref().expect("verified reader source"))
                        } else { None };
                        // Apply a port choice only when it belongs to this
                        // exact result.  A C++ choice from an earlier task
                        // cannot leak into a later Python solution.
                        let chosen_language = code_state_id(chosen_state.as_ref().expect("verified reader source"))
                            .and_then(|run_id| code_focus_language.as_ref().and_then(|(selected_run, language)|
                                (selected_run == &run_id).then(|| language.clone())))
                            .unwrap_or_default();
                        let _ = webview.evaluate_script(&format!(
                            "window.setCodeFocusSolution({},{},{});",
                            serde_json::to_string(chosen_state.as_ref().expect("verified reader source"))
                                .unwrap_or_else(|_| "null".into()),
                            follow_live,
                            serde_json::to_string(&chosen_language).unwrap_or_else(|_| "\"\"".into())
                        ));
                    } else {
                        let _ = webview.evaluate_script("window.clearCodeFocusSolution()");
                        history_code_focus_state = None;
                        code_focus_from_history = false;
                        code_focus_live_run_id = None;
                    }
                    let _ = webview.evaluate_script(&format!("window.setCodeFocusMode('{}')",mode));
                    overlay_visible = true;
                    event_loop_target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
                    let _ = show_overlay_pair(&overlay, &hud, true, code_focus_mode);
                    overlay_refresh.sent_state = None;
                    let _ = update_overlay(&webview, &active_view, &mut overlay_refresh);
                } else {
                    eprintln!("code-focus unavailable: current Coding result is not E2B-verified");
                }
            }
            // The command pill is a second native click-through window. Its
            // controls follow the active surface, but its DOM and glass frame
            // never sit inside the Coding/MCQ/History content window.
            let hud_view = if code_focus_mode != 0 { "docked" }
                else if history_open { "history" }
                else if overlay_refresh.rendered_view == "mcq" { "mcq" }
                else { active_view.as_str() };
            if hud_view != last_hud_view {
                hud.set_inner_size(LogicalSize::new(HUD_WIDTH, hud_height(hud_view)));
                let view = serde_json::to_string(hud_view).unwrap_or_else(|_| "\"coding\"".into());
                let _ = hud_webview.evaluate_script(&format!("window.setOverlayControls({view})"));
                last_hud_view = hud_view.to_string();
            }
            // HH and arrow-only History doesn't change the active solving task.
            mac_shortcuts::set_history_visible(history_open && overlay_visible);
            mac_shortcuts::set_overlay_visible(overlay_visible);
            mac_shortcuts::set_coding_overlay_visible(overlay_visible && active_view == "coding");
        }
    });
    Ok(())
}

// ─── OVERLAY (GHOST WINDOW) ───────────────────────────────────────────────────

fn overlay_geometry<T>(event_loop: &tao::event_loop::EventLoop<T>) -> (LogicalPosition<f64>, f64) {
    if let Some(monitor) = event_loop.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let pos = monitor.position();
        let group_width = OVERLAY_WIDTH + HUD_GAP + HUD_WIDTH;
        let x = (pos.x as f64 / scale)
            + ((size.width as f64 / scale - group_width) / 2.0)
            + HUD_WIDTH
            + HUD_GAP;
        // Center inside the usable area, never under the menu bar or notch.
        let (top, bottom) = screen_insets();
        let viewport = size.height as f64 / scale - top - bottom;
        let height = OVERLAY_HEIGHT.min((viewport - 16.0).max(320.0));
        let y = pos.y as f64 / scale + top + ((viewport - height) / 2.0);
        return (
            LogicalPosition::new(x.max(HUD_WIDTH + HUD_GAP), y.max(0.0)),
            height,
        );
    }
    (LogicalPosition::new(320.0, 64.0), OVERLAY_HEIGHT)
}

/// Logical points reserved by the menu bar, notch and Dock on the main
/// display. Panels are laid out inside the remaining area so their top edge
/// never disappears behind system chrome.
fn screen_insets() -> (f64, f64) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSScreen;
        if let Some(screen) = MainThreadMarker::new().and_then(|marker| NSScreen::mainScreen(marker)) {
            let frame = screen.frame();
            let visible = screen.visibleFrame();
            let top = (frame.size.height - (visible.origin.y + visible.size.height)).max(0.0);
            let bottom = visible.origin.y.max(0.0);
            return (top, bottom);
        }
    }
    (32.0, 8.0)
}

fn hud_position(content_position: LogicalPosition<f64>) -> LogicalPosition<f64> {
    LogicalPosition::new(content_position.x - HUD_GAP - HUD_WIDTH, content_position.y)
}

// The code reader keeps its existing half-screen geometry. Place its
// click-through shortcut pill just outside that half (on the opposite side)
// so it never covers a line of verified code.
fn docked_hud_position(
    code_position: PhysicalPosition<i32>,
    code_size: PhysicalSize<u32>,
    side: u8,
    scale: f64,
) -> PhysicalPosition<i32> {
    let gap = (HUD_GAP * scale).round() as i32;
    let width = (HUD_WIDTH * scale).round() as i32;
    let x = if side == 2 {
        code_position.x.saturating_add(code_size.width as i32).saturating_add(gap)
    } else {
        code_position.x.saturating_sub(width).saturating_sub(gap)
    };
    PhysicalPosition::new(x, code_position.y)
}

fn hud_height(view: &str) -> f64 {
    if view == "history" { HISTORY_HUD_HEIGHT } else { HUD_HEIGHT }
}

fn restore_normal_geometry(overlay: &Window, hud: &Window, position: LogicalPosition<f64>) {
    let (top, bottom) = screen_insets();
    let (y, height) = overlay
        .current_monitor()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let viewport = monitor.size().height as f64 / scale - top - bottom;
            let height = OVERLAY_HEIGHT.min((viewport - 16.0).max(320.0));
            let floor = monitor.position().y as f64 / scale + top;
            let ceiling = floor + viewport - height;
            (position.y.clamp(floor, ceiling.max(floor)), height)
        })
        .unwrap_or((position.y, OVERLAY_HEIGHT));
    overlay.set_inner_size(LogicalSize::new(OVERLAY_WIDTH, height));
    overlay.set_outer_position(LogicalPosition::new(position.x, y));
    hud.set_outer_position(hud_position(LogicalPosition::new(position.x, y)));
}

/// Coordinates use the monitor holding the helper overlay, not a hard-coded
/// primary display. Geometry is logical (Tao compensates for Retina scaling).
fn code_focus_geometry<T>(
    window: &Window,
    event_loop: &tao::event_loop::EventLoopWindowTarget<T>,
    mode: u8,
) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let monitor = window.current_monitor().or_else(|| event_loop.primary_monitor())?;
    let location = monitor.position();
    let extent = monitor.size();
    // Monitor positions are already physical pixels. Passing them through a
    // LogicalPosition applies a window scale factor again on Retina/mixed-DPI
    // displays, which is why SL/SR could land in the wrong place. Keep this
    // complete path physical from monitor discovery through window placement.
    let half = extent.width / 2;
    let inset = 8_u32;
    let (top, bottom) = screen_insets();
    let scale = monitor.scale_factor();
    let top = (top * scale).round() as u32 + inset;
    let bottom = (bottom * scale).round() as u32 + inset;
    let (x, available_width) = match mode {
        2 => (location.x, half),
        3 => (location.x.saturating_add(half as i32), extent.width - half),
        _ => return None,
    };
    let inner_width = available_width.saturating_sub(inset * 2).max(260);
    let inner_height = extent.height.saturating_sub(top + bottom).max(260);
    Some((
        PhysicalPosition::new(x.saturating_add(inset as i32), location.y.saturating_add(top as i32)),
        PhysicalSize::new(inner_width, inner_height),
    ))
}

fn overlay_window<T>(
    event_loop: &tao::event_loop::EventLoop<T>,
    position: LogicalPosition<f64>,
    height: f64,
) -> Result<(Window, WebView), String> {
    let window = WindowBuilder::new()
        .with_title("mds") // Ghost: title matches process name
        .with_inner_size(LogicalSize::new(OVERLAY_WIDTH, height))
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

fn hud_window<T>(
    event_loop: &tao::event_loop::EventLoop<T>,
    position: LogicalPosition<f64>,
) -> Result<(Window, WebView), String> {
    let window = WindowBuilder::new()
        .with_title("mds controls")
        .with_inner_size(LogicalSize::new(HUD_WIDTH, HUD_HEIGHT))
        .with_position(hud_position(position))
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
        .map_err(|e| format!("Could not create ghost command HUD: {e}"))?;
    let webview = WebViewBuilder::new()
        .with_transparent(true)
        .with_html(hud_html())
        .build(&window)
        .map_err(|e| format!("Could not create ghost command HUD webview: {e}"))?;
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
        // The proctor's kiosk also sits at screen-saver level and re-raises
        // itself on focus changes; one level above wins the tie.
        ns_window.setLevel(NSScreenSaverWindowLevel + 1);
        ns_window.setHidesOnDeactivate(false);
        ns_window.setCanHide(false);
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

#[cfg(target_os = "macos")]
fn reinforce_overlay(window: &Window) {
    use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindow};
    unsafe {
        let ns_window = window.ns_window();
        if ns_window.is_null() {
            return;
        }
        let ns_window = &*ns_window.cast::<NSWindow>();
        ns_window.setLevel(NSScreenSaverWindowLevel + 1);
        ns_window.orderFrontRegardless();
    }
}

fn show_overlay(window: &Window, visible: bool) -> Result<(), String> {
    trace(&format!("show_overlay visible={visible}"));
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
        use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior};

        unsafe {
            let ns_window = window.ns_window();
            if ns_window.is_null() {
                return Err("Overlay NSWindow unavailable".into());
            }
            let ns_window = &*ns_window.cast::<NSWindow>();
            // tao's set_always_on_top drops the window to the floating level;
            // restore the screen-saver level and re-assert the Space behavior
            // on every show so a Space switch or full-screen app cannot hide it.
            ns_window.setLevel(NSScreenSaverWindowLevel + 1);
            ns_window.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
            ns_window.orderFrontRegardless();
            ns_window.displayIfNeeded();
        }
    }

    Ok(())
}

fn show_overlay_pair(content: &Window, hud: &Window, visible: bool, code_focus_mode: u8) -> Result<(), String> {
    // A separate click-through command pill follows both the ordinary overlay
    // and the SL/SR code reader, with view-specific labels. Hide both on capture.
    let show_hud = visible && matches!(code_focus_mode, 0 | 2 | 3);
    if !show_hud {
        show_overlay(hud, false)?;
    }
    show_overlay(content, visible)?;
    if show_hud {
        show_overlay(hud, true)?;
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

fn trace(message: &str) {
    let Ok(dir) = log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("overlay-trace.log"))
    {
        use std::io::Write;
        let _ = writeln!(file, "{} {}", now(), message);
    }
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

fn is_coding_history_job(item: &Value) -> bool {
    item.get("mode").and_then(Value::as_str) != Some("mcq")
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
        // HH is the Coding overlay's history for now. Keep MCQ jobs
        // independent; they must not appear in this list or affect its count.
        if !is_coding_history_job(item) { continue; }
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
fn archived_history_job(job_id: &str) -> Option<SubmittedJob> {
    Uuid::parse_str(job_id).ok()?;
    for view in ["coding", "mcq"] {
        if let Ok(Some(job)) = read_submitted_job_for(view) {
            if job.id == job_id {
                return Some(job);
            }
        }
    }
    let path = cache_dir().ok()?.join("job-history").join(format!("{job_id}.json"));
    let job: SubmittedJob = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (job.id == job_id).then_some(job)
}

/// A history result may show only the helper's own, bounded capture cache.
/// Cloud image URLs remain private to the model pipeline and are never exposed
/// from history as anonymous blob links.
fn history_preview_sources(job: &SubmittedJob) -> Vec<String> {
    let root = match cache_dir().map(|path| path.join("captures")).and_then(|path| {
        path.canonicalize().map_err(|error| error.to_string())
    }) {
        Ok(root) => root,
        Err(_) => return Vec::new(),
    };
    job.previews.iter().take(4).filter_map(|preview| {
        if preview.starts_with("data:image/png;base64,") && preview.len() <= 1_400_000 {
            return Some(preview.clone());
        }
        let path = Path::new(preview).canonicalize().ok()?;
        if !path.starts_with(&root) || path.extension().and_then(|value| value.to_str()) != Some("png") {
            return None;
        }
        let metadata = fs::metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() > 1_000_000 {
            return None;
        }
        let bytes = fs::read(path).ok()?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }).collect()
}

async fn fetch_history_detail(row: Value) -> Result<Value, String> {
    let id = row.get("id").and_then(Value::as_str).unwrap_or("");
    if let Some(job_id) = id.strip_prefix("job:") {
        // History is deliberately server-authoritative: do not allow an old
        // local helper snapshot to hide a newer completed Council report.
        let report = api("reports.get", serde_json::json!({"jobId": job_id})).await?;
        let body = report.get("report").unwrap_or(&report);
        let previews = archived_history_job(job_id)
            .map(|job| history_preview_sources(&job)).unwrap_or_default();
        return Ok(serde_json::json!({
            "state": history_coding_state(job_id, body),
            "historyPreviews": previews,
        }));
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

/// A new capture is a fresh attempt at collecting the current batch.  Do not
/// leave a diagnostic from a cancelled selection or an earlier capture error
/// painted over the new screenshot.  Submission errors are still retained
/// until the person starts another capture or explicitly changes the batch.
fn clear_pending_capture_error(view: &str) -> Result<(), String> {
    if let Some(mut batch) = read_pending_for(view)? {
        if batch.error.take().is_some() {
            if batch.status != "submitting" {
                batch.status = if batch.images.is_empty() {
                    "collecting".to_string()
                } else {
                    "ready".to_string()
                };
            }
            save_pending_for(view, &batch)?;
        }
    }
    Ok(())
}

fn user_cases_path(view: &str) -> Result<PathBuf, String> {
    Ok(support_root_dir()?.join("cache").join(format!("user-cases-{view}.json")))
}

fn read_user_cases(view: &str) -> Vec<BatchCase> {
    user_cases_path(view).ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Vec<BatchCase>>(&text).ok())
        .unwrap_or_default()
}

/// One case per line, either "input => expected" or an Input:/Output: pair.
fn parse_user_cases(raw: &str) -> Vec<BatchCase> {
    let mut out = Vec::new();
    let mut pending_input: Option<String> = None;
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some((left, right)) = line.split_once("=>").or_else(|| line.split_once("->")) {
            if !left.trim().is_empty() && !right.trim().is_empty() {
                out.push(BatchCase { input: left.trim().to_string(), output: right.trim().to_string() });
                pending_input = None;
                continue;
            }
        }
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("input:").or_else(|| lower.strip_prefix("args:")) {
            let _ = rest;
            pending_input = Some(line.split_once(':').map(|(_, value)| value.trim().to_string()).unwrap_or_default());
        } else if let Some(rest) = lower.strip_prefix("output:").or_else(|| lower.strip_prefix("expected:")) {
            let _ = rest;
            if let Some(input) = pending_input.take() {
                let output = line.split_once(':').map(|(_, value)| value.trim().to_string()).unwrap_or_default();
                if !input.is_empty() && !output.is_empty() {
                    out.push(BatchCase { input, output });
                }
            }
        }
    }
    out.truncate(24);
    out
}

fn import_clipboard_cases(view: &str) -> Result<usize, String> {
    let output = Command::new("/usr/bin/pbpaste").output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    let cases = parse_user_cases(&text);
    if cases.is_empty() {
        return Err("No cases on the clipboard. Copy lines like `nums = [2,7], target = 9 => [0,1]`.".into());
    }
    let path = user_cases_path(view)?;
    if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
    write_private(&path, serde_json::to_vec(&cases).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(cases.len())
}

fn start_batch(view: &str) -> Result<(), String> {
    // Do not orphan screenshots when the start shortcut is pressed twice.
    // The existing ordered batch remains available until it is submitted.
    if let Some(existing) = read_pending_for(view)? {
        if !existing.images.is_empty() {
            return Err(format!("Batch {} already contains {} screenshot(s). Submit it before starting another.", existing.id, existing.images.len()));
        }
    }
    let _ = fs::remove_file(user_cases_path(view).unwrap_or_default());
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
fn double_tap_panel(
    previous: &mut Option<(u8, bool, Instant)>,
    key: u8,
    uppercase: bool,
    at: Instant,
) -> Option<u8> {
    let matched = previous.as_ref().is_some_and(|(last, last_uppercase, time)|
        *last == key
            && same_letter_case(*last_uppercase, uppercase)
            && at.saturating_duration_since(*time) <= Duration::from_millis(1_200)
    );
    *previous = if matched { None } else { Some((key, uppercase, at)) };
    if matched { Some(key) } else { None }
}

fn same_letter_case(first_uppercase: bool, second_uppercase: bool) -> bool {
    first_uppercase == second_uppercase
}

fn code_focus_shortcut_allowed(active_view: &str, history_open: bool, history_detail_open: bool) -> bool {
    if history_open {
        history_detail_open
    } else {
        active_view == "coding"
    }
}

fn number_pair_command(first: u8, second: u8) -> Option<u8> {
    match first {
        0 if second == 0 => Some(6),
        1 if second <= 4 => Some(10 + second),
        2 if second == 0 || (2..=5).contains(&second) => Some(20 + second),
        3 if (1..=3).contains(&second) || second == 5 => Some(30 + second),
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

    let user_cases = read_user_cases(active_view);
    if !user_cases.is_empty() {
        user_settings["userCases"] = serde_json::to_value(&user_cases).unwrap_or(Value::Null);
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

/// A final primary result is not the whole cloud report until its target
/// language ports have reached their own terminal verification states.
fn report_has_preparing_ports(report: &Value) -> bool {
    report.get("report").unwrap_or(report).get("ports")
        .and_then(Value::as_array)
        .is_some_and(|ports| ports.iter().any(|port|
            matches!(port.get("status").and_then(Value::as_str),
                Some("preparing" | "pending" | "running"))))
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
                || (job.status == "completed" && job.report.as_ref()
                    .is_some_and(|report| !report_has_preparing_ports(report))) { continue; }
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
            && !report_has_preparing_ports(report)
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
    rendered_view: String,
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
    refresh.rendered_view = serde_json::from_str::<Value>(&state).ok()
        .filter(|value| value.get("kind").and_then(Value::as_str) == Some("mcq")
            || value.get("mcq").is_some_and(|mcq| !mcq.is_null()))
        .map(|_| "mcq".to_string())
        .unwrap_or_else(|| active_view.to_string());
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
    let early=body.get("provisional").unwrap_or(&Value::Null);
    let summary=blueprint.get("explanation").and_then(Value::as_str)
        .filter(|s|!s.trim().is_empty())
        .or_else(||early.get("answer").and_then(Value::as_str))
        .unwrap_or("");
    let approach=p.get("approach").and_then(Value::as_str)
        .filter(|s|!s.trim().is_empty())
        .unwrap_or(summary);
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
    let tests=if tests.is_empty() && early.get("status").and_then(Value::as_str)==Some("provisional") {
        format!("Candidate {} · {} passed / {} failed in E2B (Council review pending)",
            early.get("letter").and_then(Value::as_str).unwrap_or("?"),
            early.get("passed").and_then(Value::as_u64).unwrap_or(0),
            early.get("failed").and_then(Value::as_u64).unwrap_or(0))
    } else { tests };
    serde_json::json!({
        "summary":summary.chars().take(480).collect::<String>(),
        "approach":approach.chars().take(800).collect::<String>(),
        "structures":structures,"controlFlow":control,"edgeCases":cases,
        "testing":tests,"edgeCoverageKnown":!cases.is_empty()
    })
}

fn coding_overlay_state(job: &SubmittedJob) -> Value {
    let body = job.report.as_ref().map(|r| r.get("report").unwrap_or(r));
    let candidates: Vec<Value> = body.and_then(|b| b.get("candidates"))
        .and_then(Value::as_array).cloned().unwrap_or_default();
    let winner = body.and_then(|b| b.get("winner")).and_then(Value::as_str)
        .unwrap_or("").trim();
    let solution = body.and_then(|b| coding_solution_from_report(b, winner, &candidates));
    let completed_without_solution = job.status == "completed" && solution.is_none();
    let phase = match job.status.as_str() {
        "failed" | "needs_attention" | "cancelled" => "error",
        "completed" if completed_without_solution => "error",
        "completed" => "done",
        _ => "running",
    };
    let fallback_error = completed_without_solution.then_some(
        "Council finished without producing a verified primary solution. No unverified code is being shown.");
    let progress = if completed_without_solution {
        fallback_error.unwrap_or_default().to_string()
    } else {
        job_progress_message(job)
    };
    let agents = if candidates.is_empty() {
        coding_agents_from_events(job)
    } else {
        candidates.iter()
        // Coding Trusty is independent, not one of the four selected seats.
        .filter(|candidate| candidate.get("codingTrusty").and_then(Value::as_bool) != Some(true))
        .take(4).map(|candidate| {
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
            let candidate_error = if completed_without_solution && !has_code {
                Some("No complete runnable code returned")
            } else if completed_without_solution && error.is_none() && gate!="fail" {
                Some("No candidate passed verification")
            } else { error };
            let status = if error.is_some() || gate=="fail" || completed_without_solution { "error" }
                else if has_code { "done" } else { "pending" };
            let detail = if error.is_some() { "Solver failed" }
                else if completed_without_solution && !has_code { "No complete runnable code returned" }
                else if completed_without_solution && gate=="fail" { "Candidate generated · E2B verification failed" }
                else if completed_without_solution { "Candidate not verified · no solution is shown" }
                else if gate=="pass" && letter.eq_ignore_ascii_case(winner) {"Council winner · E2B passed"}
                else if gate=="pass" {"E2B tests passed · Council reviewed"}
                else if gate=="fail" {"Answer generated · E2B failed"}
                else if has_code {"Answer generated · validation pending"}
                else {"Awaiting model answer"};
            serde_json::json!({
                "id": letter, "label": model.rsplit('/').next().unwrap_or(model),
                "model": model, "status": status, "error": candidate_error,
                "detail": detail, "gate": gate,
            })
        }).collect()
    };
    let tests = body.map(|body| {
        // A verified provisional result is the current source until the
        // Council selects a final winner. Its saved run is real E2B evidence,
        // not a fabricated summary or an unrelated solver's measurements.
        let case_letter = if winner.is_empty() {
            body.pointer("/provisional/letter").and_then(Value::as_str).unwrap_or("")
        } else { winner };
        coding_tests_from_report(body, case_letter)
    }).unwrap_or_default();
    // Every selected port owns its own independent test evidence. Do not
    // present Python cases as if a Rust/C++ translation had run them.
    let port_cases: Vec<Value> = body.and_then(|body| body.get("ports"))
        .and_then(Value::as_array)
        .into_iter().flatten()
        .filter(|port| port.get("status").and_then(Value::as_str) == Some("verified")
            && port.get("code").and_then(Value::as_str)
                .is_some_and(|code| !code.trim().is_empty())
            && port.pointer("/run/ran").and_then(Value::as_bool) == Some(true)
            && port.pointer("/run/ok").and_then(Value::as_bool) == Some(true)
            && port.pointer("/run/failed").and_then(Value::as_u64) == Some(0))
        .map(|port| serde_json::json!({
            "language": port.get("language"),
            "tests": actual_case_rows(port.pointer("/run/stdout")
                .and_then(Value::as_str).unwrap_or(""))
        }))
        .collect();
    let coding_trusty = job.events.iter().rev().find_map(|event| {
        let phase = event.get("phase").and_then(Value::as_str)?;
        let status = match phase {
            "coding_trusty_started" => "solving",
            "coding_trusty_self_review" => "validating",
            "coding_trusty_testing" => "testing",
            "coding_trusty_e2b_passed" => "ready",
            "coding_trusty_unavailable" => "unavailable",
            "coding_trusty_failed" => "failed",
            _ => return None,
        };
        Some(serde_json::json!({
            "status": status,
            "model": event.pointer("/payload/model").and_then(Value::as_str).unwrap_or("claude-fable-5.1"),
            "message": event.get("message").and_then(Value::as_str).unwrap_or(""),
            "error": event.pointer("/payload/error").and_then(Value::as_str),
        }))
    });
    let report_trusty = body.and_then(|body| body.pointer("/provisional/codingTrusty").and_then(Value::as_bool));
    let coding_trusty = coding_trusty.or_else(|| report_trusty.filter(|value| *value).map(|_| serde_json::json!({
        "status": "ready", "model": "claude-fable-5.1",
        "message": "Coding Trusty passed E2B; Council review is pending.", "error": Value::Null,
    })));
    serde_json::json!({
        "runId": job.id, "updatedAt": now(), "kind": "coding",
        "phase": phase, "status": if completed_without_solution { "needs_attention" } else { job.status.as_str() },
        "progress": progress, "error": job.error.as_deref().or(fallback_error),
        "agents": agents, "solution": solution, "tests": tests,
        "codingTrusty": coding_trusty,
        "portCases": port_cases,
        "presentation": body.and_then(|b| b.get("presentation")).cloned(),
        "insights": body.map(coding_sidebar_evidence),
        "ports": body.and_then(|b|b.get("ports")).cloned().unwrap_or_else(||Value::Array(Vec::new())),
        "progressPhase": job.progress_phase,
        "upgrade": body.and_then(|b| b.get("upgrade")).cloned(),
        "solutionHistory": body.and_then(|b| b.get("solutionHistory")).cloned(),
        "postJudgeUpgrade": body.and_then(|b| b.get("postJudgeUpgrade")).cloned()
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
    let coding_recovery_exhausted = job.events.iter().any(|event|
        event.get("phase").and_then(Value::as_str) == Some("coding_no_usable_solution"));

    models.into_iter().take(4).enumerate().map(|(index, model)| {
        let event = job.events.iter().rev().find(|event| {
            event.pointer("/payload/model").and_then(Value::as_str) == Some(model.as_str())
                && matches!(event.get("phase").and_then(Value::as_str), Some("solver_done") | Some("solver_failed"))
        });
        let failed = event.is_some_and(|event| event.get("phase").and_then(Value::as_str) == Some("solver_failed"));
        let done = event.is_some_and(|event| event.get("phase").and_then(Value::as_str) == Some("solver_done"));
        let error = failed.then(|| event.and_then(|event| event.get("message").and_then(Value::as_str)).unwrap_or("Model failed.").to_string());
        let no_code = coding_recovery_exhausted && done && !failed;
        let status = if failed || no_code { "error" } else if done { "done" } else if job.status == "queued" { "pending" } else { "running" };
        let detail = if no_code { "No complete runnable code returned.".to_string() }
            else if failed { error.clone().unwrap_or_default() }
            else if done { "Answer ready; Council is continuing review.".to_string() }
            else if job.status == "queued" { "Waiting for Council to select eligible agents.".to_string() }
            else { "Generating candidate answer.".to_string() };
        let error = if no_code { Some("No complete runnable code returned.".to_string()) } else { error };
        let label = model.rsplit('/').next().unwrap_or(&model).replace('-', " ");
        serde_json::json!({ "id": format!("seat-{}", index + 1), "label": label, "model": model,
            "status": status, "detail": detail, "error": error })
    }).collect()
}

/// Eligibility for SL/SR is derived from the exact current Coding job.
/// An agent's generated candidate, a failed run, or a prior batch's solution
/// must not unlock the global code-only shortcut.
fn code_focus_eligible(job: Option<&SubmittedJob>, no_pending_batch: bool) -> bool {
    if !no_pending_batch { return false; }
    let Some(job) = job else { return false; };
    if job.mode != "council"
        || matches!(job.status.as_str(), "failed" | "needs_attention" | "cancelled")
    { return false; }
    code_focus_state_eligible(&coding_overlay_state(job))
}

/// The reader accepts only the exact normalized coding state which already
/// passed the E2B-backed solution gate. This is also used for a result opened
/// from the Coding overlay's history, never for an unselected history row.
fn code_state_id(state: &Value) -> Option<String> {
    state.get("runId").and_then(Value::as_str).filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn code_focus_state_eligible(state: &Value) -> bool {
    let verified = matches!(state.pointer("/solution/status").and_then(Value::as_str),
        Some("provisional" | "reviewed"));
    verified && state.pointer("/solution/code").and_then(Value::as_str)
        .is_some_and(|code| !code.trim().is_empty())
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
        let source = if early.get("codingTrusty").and_then(Value::as_bool) == Some(true) {
            "Coding Trusty · Claude Fable 5.1 · E2B verified".to_string()
        } else {
            format!("Candidate {letter} · E2B verified")
        };
        return Some(serde_json::json!({
            "title": format!("solution.{lang}"), "language": lang, "code": code,
            "source": source, "status": "provisional"
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

/// Only true per-case stdout traces from the executed winner are shown as
/// test cases. Candidate gate totals and synthetic "Harness N" descriptions
/// are NOT test inputs or observed outputs.
fn actual_case_rows(stdout: &str) -> Vec<Value> {
    stdout.lines()
        .filter_map(|line| line.trim().strip_prefix("CA_CASE "))
        .take(48)
        .filter_map(|record| serde_json::from_str::<Value>(record).ok())
        .filter_map(|record| {
            let input = record.get("input")?;
            let expected = record.get("expected")?;
            let actual = record.get("actual")?;
            let id = record.get("id").and_then(Value::as_str).unwrap_or("Case");
            // Never display an alleged PASS when the actual and expected differ.
            let passed = actual == expected;
            let status = if passed { "passed" } else { "failed" };
            Some(serde_json::json!({
                "name": id.chars().take(80).collect::<String>(),
                "input": input,
                "expected": expected,
                "actual": actual,
                "status": status,
                "source": "executed-harness"
            }))
        })
        .collect()
}

fn coding_tests_from_report(body: &Value, winner: &str) -> Vec<Value> {
    // Use the same deterministic winner that supplied the displayed code.
    // For a revised winner, only the rerun is authoritative.
    let revised = body.get("revisedRuns").and_then(|runs| runs.get(winner));
    let normal = body.get("runs").and_then(|runs| runs.get(winner));
    // A present revised candidate supersedes its original run. In that
    // situation, never substitute old pre-repair cases as verification for
    // the revised code shown to the user.
    let selected = revised.or(normal);
    let run = selected.filter(|run| run.get("ran").and_then(Value::as_bool) == Some(true));
    if let Some(stdout) = run.and_then(|run| run.get("stdout")).and_then(Value::as_str) {
        let rows = actual_case_rows(stdout);
        if !rows.is_empty() {
            return rows;
        }
    }
    // Legacy or provisional report: it has verified aggregate counts but no
    // captured per-case input/output. Never manufacture examples from totals.
    vec![]
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

fn hud_html() -> &'static str {
    r#"<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
      body{box-sizing:border-box;color:rgba(255,255,255,.94);font:700 11px -apple-system,BlinkMacSystemFont,sans-serif}
      #hudbar{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;gap:10px;padding:11px;border:1px solid rgba(255,255,255,.26);border-radius:18px;background:radial-gradient(circle at 50% 18%,rgba(205,222,239,.10),transparent 28%),linear-gradient(135deg,rgba(255,255,255,.105),rgba(255,255,255,.03)),rgba(10,16,24,.13);box-shadow:0 0 0 1px rgba(255,255,255,.09),inset 0 1px 0 rgba(255,255,255,.22),0 18px 48px rgba(0,0,0,.16);backdrop-filter:blur(20px) saturate(1.22);-webkit-backdrop-filter:blur(20px) saturate(1.22)}
      .hud-head{display:flex;align-items:center;justify-content:center;gap:9px;min-height:32px;padding-bottom:9px;border-bottom:1px solid rgba(255,255,255,.28)}
      .hud-logo{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.14);font-size:10px;font-weight:900;box-shadow:inset 0 1px 0 rgba(255,255,255,.28)}
      .hud-pause{display:grid;place-items:center;width:30px;height:26px;border-radius:8px;background:rgba(255,255,255,.13);box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
      .hud-meter{display:inline-flex;align-items:end;gap:2px;height:18px}.hud-meter i{display:block;width:3px;border-radius:3px;background:rgba(205,224,242,.7);box-shadow:0 0 9px rgba(190,215,235,.18)}.hud-meter i:nth-child(1){height:7px}.hud-meter i:nth-child(2){height:12px}.hud-meter i:nth-child(3){height:9px}
      #hud-shortcuts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:6px;min-height:0}
      .hud-command{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-width:0;min-height:52px;padding:5px 2px;border:1px solid rgba(255,255,255,.13);border-radius:10px;background:rgba(255,255,255,.055)}
      .hud-key{box-sizing:border-box;display:grid;place-items:center;min-width:29px;max-width:100%;height:23px;padding:0 6px;border-radius:7px;background:rgba(255,255,255,.15);box-shadow:inset 0 1px 0 rgba(255,255,255,.09);font:800 10px SFMono-Regular,Menlo,monospace;white-space:nowrap}
      .hud-name{display:block;max-width:100%;color:rgba(255,255,255,.76);font-size:9px;font-weight:700;line-height:1.15;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    </style></head><body><div id="hudbar"><div class="hud-head"><span class="hud-logo">CA</span><span class="hud-pause">||</span><span class="hud-meter"><i></i><i></i><i></i></span></div><div id="hud-shortcuts"></div></div><script>
      window.setOverlayControls=function(view){
        const host=document.getElementById('hud-shortcuts');if(!host)return;
        const controls=view==='docked'
          ? [['Coding','cc'],['MCQ','mm'],['History','hh'],['New','00'],['Cases','kk'],['Capture','20'],['Submit','24'],['Scroll code','↑↓'],['Ports','rr/cp/py'],['Left / Back','sl'],['Right / Back','sr']]
          : view==='history'
          ? [['Coding','cc'],['MCQ','mm'],['History','hh'],['Previous','↑'],['Next','↓']]
          : view==='mcq'
          ? [['MCQ','mm'],['Coding','cc'],['History','hh'],['Full','31 · ⌃⌥0'],['Left','32 · ⌃⌥2'],['Right','33 · ⌃⌥3'],['Submit','35 · ⌃⌥5']]
          : [['Coding','cc'],['MCQ','mm'],['History','hh'],['New','00'],['Cases','kk'],['Capture','20'],['Submit','24'],['Scroll','↑↓'],['Ports','rr/cp/py'],['Dock code','sl/sr']];
        const fingerprint=controls.map(([name,key])=>name+key).join('|');
        if(host.dataset.shortcutSet===fingerprint)return;
        host.dataset.shortcutSet=fingerprint;host.replaceChildren();
        controls.forEach(([name,key])=>{
          const tile=document.createElement('div');tile.className='hud-command';
          const badge=document.createElement('span');badge.className='hud-key';badge.textContent=key;
          const label=document.createElement('span');label.className='hud-name';label.textContent=name;
          tile.append(badge,label);host.appendChild(tile);
        });
      };
      window.setOverlayControls('coding');
    </script></body></html>"#
}

fn overlay_html() -> &'static str {
    r#"<!doctype html><html><head><meta charset="utf-8"><style>
      :root{color-scheme:dark;--text:rgba(255,255,255,.98);--muted:rgba(255,255,255,.78);--panel-line:rgba(255,255,255,.18);--panel-a:rgba(255,255,255,.105);--panel-b:rgba(255,255,255,.03);--panel-base:rgba(10,16,24,.13);--panel-shadow:rgba(0,0,0,.16);--pane-line:rgba(255,255,255,.28);--title-shadow:rgba(0,0,0,.24);--dash-line:rgba(255,255,255,.52);--soft-fill:rgba(255,255,255,.085);--chip-fill:rgba(255,255,255,.05);--box-fill:rgba(255,255,255,.045);--editor-bg:rgba(2,7,13,.68);--tests-bg:rgba(2,7,13,.42);--code-text:#e6f1ff;--kw:#ff7b72;--fn:#d2a8ff;--arg:#ffa657;--num:#79c0ff;--str:#a5d6ff;--built:#7ee787;--op:#ffdf5d;--cm:#8b949e}
      @media (prefers-color-scheme:light){:root{color-scheme:light;--text:rgba(18,24,33,.96);--muted:rgba(42,52,66,.78);--panel-line:rgba(20,30,42,.18);--panel-a:rgba(255,255,255,.46);--panel-b:rgba(255,255,255,.22);--panel-base:rgba(235,241,248,.36);--panel-shadow:rgba(12,20,28,.12);--pane-line:rgba(20,30,42,.2);--title-shadow:rgba(255,255,255,.48);--dash-line:rgba(20,30,42,.38);--soft-fill:rgba(255,255,255,.38);--chip-fill:rgba(255,255,255,.3);--box-fill:rgba(255,255,255,.32);--editor-bg:rgba(4,10,18,.74);--tests-bg:rgba(4,10,18,.55);--code-text:#eef6ff}}
      html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
	      body{box-sizing:border-box;padding:16px 22px 22px;color:var(--text);font:600 14px -apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column}
	      #panel{box-sizing:border-box;width:100%;flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.75fr);border:1px solid rgba(255,255,255,.26);border-radius:18px;background:radial-gradient(circle at 50% 18%,rgba(205,222,239,.10),transparent 28%),linear-gradient(135deg,var(--panel-a),var(--panel-b)),var(--panel-base);box-shadow:0 0 0 1px rgba(255,255,255,.09),inset 0 1px 0 rgba(255,255,255,.22),0 18px 48px var(--panel-shadow);backdrop-filter:blur(20px) saturate(1.22);overflow:hidden}
            .pane{min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:18px;overflow:hidden}.pane+ .pane{border-left:1px solid var(--pane-line)}
            .pictures-pane{align-items:flex-start}
            .title{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.95;text-shadow:0 1px 2px var(--title-shadow)}
	            .picture-list{box-sizing:border-box;width:100%;min-height:48px;display:flex;flex-direction:row;align-items:center;gap:5px;padding:5px;border:1.5px dashed var(--dash-line);border-radius:10px;background:var(--soft-fill);overflow-x:auto;overflow-y:hidden}
            .picture-pill{position:relative;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
            .picture-count{position:absolute;right:4px;bottom:4px;padding:2px 5px;border-radius:5px;background:rgba(0,0,0,.58);color:rgba(255,255,255,.95);font-size:10px;font-weight:700;line-height:1}
	            img{display:block;width:44px;height:33px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,.36)}
            .divider{width:100%;height:1px;margin:8px 0 2px;background:var(--pane-line)}
            .solution-status{box-sizing:border-box;width:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
            .council-monitor{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:8px;flex:0 0 auto}
            .thought-pane .council-monitor{padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.16)}
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
	            .code-lines{flex:1;min-height:0;margin:0;padding:15px 0;color:var(--code-text);font:530 14.5px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:auto;counter-reset:code-line}
	            .code-lines li{display:grid;grid-template-columns:48px minmax(0,1fr);min-height:24px;padding:0 17px 0 0;list-style:none;counter-increment:code-line}
	            .code-lines li:before{content:counter(code-line);padding-right:12px;text-align:right;color:rgba(255,255,255,.3)}
	            .code-lines code{display:block;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
            .code-lines .code-indent,#code-focus-code .code-indent{display:inline-block;white-space:pre;vertical-align:baseline;background:repeating-linear-gradient(90deg,rgba(123,165,208,.34) 0 1px,transparent 1px var(--indent-step,4ch));tab-size:4}
            .kw{color:var(--kw)}.fn{color:var(--fn)}.arg{color:var(--arg)}.num{color:var(--num)}.str{color:var(--str)}.built{color:var(--built)}.op{color:var(--op)}.cm{color:var(--cm)}
	            .tests{box-sizing:border-box;width:100%;min-height:58px;max-height:180px;border:1px solid var(--panel-line);border-radius:9px;background:var(--tests-bg);overflow-y:auto;overflow-x:hidden}
	            .case-list{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:9px}
	            .case{min-width:0;padding:10px 11px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.045);font-size:11.5px;color:rgba(255,255,255,.88);line-height:1.5}
            .case b{display:block;margin-bottom:4px;color:rgba(255,255,255,.95)}
            .case code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font:530 11.5px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d5f5ff}
            .case[data-status="failed"]{border-color:rgba(255,112,112,.55)}
            .case[data-status="passed"]{border-color:rgba(102,218,159,.36)}
            .case .case-field{display:grid;grid-template-columns:74px minmax(0,1fr);gap:9px;align-items:start}
            .case .case-field b{color:rgba(255,255,255,.6);font-size:10.5px;font-weight:700;margin:0}
            .case .case-field code{min-width:0}
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
            .solution-toolbar{display:inline-flex;align-items:center;gap:8px}
            .overlay-port-list{display:flex;align-items:center;gap:6px;padding:6px 8px;flex-wrap:wrap}
            .overlay-port-chip{padding:4px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);font-size:10px;color:rgba(255,255,255,.74)}
            .overlay-port-chip[data-selected="true"]{border-color:rgba(184,224,245,.7);background:rgba(184,224,245,.17);color:#fff}
            .overlay-port-chip[data-available="false"]{opacity:.44}
            .overlay-port-dock-hint{padding:0 8px 8px;color:rgba(218,238,255,.76);font-size:10px;font-weight:700;letter-spacing:.02em}

            .overlay-diff-toggle{background:rgba(201,228,245,.12);border:1px solid rgba(201,228,245,.45);color:var(--text);padding:4px 8px;border-radius:7px;font:inherit;cursor:pointer}
            .code-lines li[data-change="remove"]{background:rgba(240,83,83,.18);border-left:3px solid rgba(240,83,83,.7)}
            .code-lines li[data-change="add"]{background:rgba(65,200,120,.16);border-left:3px solid rgba(65,200,120,.7)}
            .code-lines li[data-change="same"]{border-left:3px solid transparent}
            .code-lines li[data-change] code{overflow-wrap:anywhere}
            /* SL/SR use a standalone reader rather than a squeezed capture
               HUD, each in a monitor-anchored half-screen window. */
            body[data-code-focus="left"],body[data-code-focus="right"]{padding:0;gap:0}
            body[data-code-focus]:not([data-code-focus="normal"]) #panel{display:none!important}
            #code-focus-sheet{position:fixed;inset:0;box-sizing:border-box;display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid rgba(255,255,255,.26);border-radius:18px;background:radial-gradient(circle at 50% 18%,rgba(205,222,239,.10),transparent 28%),linear-gradient(135deg,var(--panel-a),var(--panel-b)),var(--panel-base);box-shadow:0 0 0 1px rgba(255,255,255,.09),inset 0 1px 0 rgba(255,255,255,.22),0 18px 48px var(--panel-shadow);backdrop-filter:blur(20px) saturate(1.22);-webkit-backdrop-filter:blur(20px) saturate(1.22);overflow:hidden}
            #code-focus-sheet[hidden]{display:none}
            .code-focus-header{box-sizing:border-box;flex:0 0 auto;min-height:58px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 21px;border-bottom:1px solid rgba(173,203,234,.18);background:rgba(8,15,25,.78)}
            .code-focus-file{display:flex;align-items:center;gap:11px;min-width:0}
            .code-focus-icon{flex:0 0 auto;width:30px;height:30px;display:grid;place-items:center;border:1px solid rgba(116,179,245,.35);border-radius:8px;background:rgba(76,143,220,.14);color:#8dc4ff;font:800 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
            .code-focus-file-info{min-width:0;display:flex;flex-direction:column;gap:3px}
            #code-focus-file{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#eff6ff;font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
            #code-focus-lang{color:#8fa9c2;font-size:10px;font-weight:650;letter-spacing:.04em}
            .code-focus-meta{display:flex;align-items:center;gap:11px;flex:0 0 auto;color:#98acc0;font:650 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
            .code-focus-status{display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid rgba(85,218,154,.28);border-radius:999px;background:rgba(44,166,108,.11);color:#a9f1c8}
            .code-focus-status::before{content:"";width:6px;height:6px;border-radius:50%;background:#64dda0;box-shadow:0 0 8px rgba(100,221,160,.65)}
            .code-focus-status[data-stage="provisional"]{border-color:rgba(112,184,255,.35);background:rgba(52,123,210,.13);color:#a9d7ff}
            .code-focus-status[data-stage="provisional"]::before{background:#7dbdff;box-shadow:0 0 8px rgba(125,189,255,.62)}
            .code-focus-diff-toggle{border:1px solid rgba(125,189,255,.4);border-radius:7px;padding:6px 9px;background:rgba(52,123,210,.14);color:#c7e2ff;font:650 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}
            .code-focus-diff-toggle:hover{background:rgba(52,123,210,.24)}
            #code-focus-code{box-sizing:border-box;flex:1;min-width:0;min-height:0;width:100%;margin:0;padding:15px 0 28px;background:rgba(3,9,17,.88);color:var(--code-text);font:530 14.5px/1.7 "Cascadia Code Variable","Cascadia Code",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:auto;counter-reset:code-line;scrollbar-width:thin;scrollbar-color:rgba(147,180,214,.4) transparent}
            #code-focus-code li{box-sizing:border-box;display:grid;grid-template-columns:58px max-content;min-width:100%;width:max-content;min-height:25px;padding-right:28px;list-style:none;counter-increment:code-line}
            #code-focus-code li:nth-child(even){background:rgba(141,174,207,.025)}
            #code-focus-code li::before{content:counter(code-line);position:sticky;left:0;z-index:1;box-sizing:border-box;width:58px;padding-right:13px;border-right:1px solid rgba(153,183,212,.12);background:#091522;color:#60758d;text-align:right;user-select:none}
            #code-focus-code code{display:block;min-width:max-content;padding-left:19px;white-space:pre;overflow-wrap:normal;tab-size:4}
            #code-focus-code li[data-change="remove"]{border-left:3px solid rgba(240,83,83,.8);background:rgba(240,83,83,.2);color:#ffc0c0}
            #code-focus-code li[data-change="add"]{border-left:3px solid rgba(65,200,120,.82);background:rgba(65,200,120,.19);color:#baf4ce}
            #code-focus-code li[data-change="remove"]::before{background:rgba(92,31,39,.96);color:#f0a4aa}
            #code-focus-code li[data-change="add"]::before{background:rgba(24,66,48,.96);color:#9be1b7}
            #code-focus-code li[data-change="summary"]{border-left:3px solid rgba(125,189,255,.68);background:rgba(52,123,210,.12);color:#c7e2ff}
            @media(prefers-reduced-motion:reduce){body[data-code-focus] #panel{transition:none}}
        </style></head><body><div id="panel"><div class="pane pictures-pane"><div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title">Solution</div><div class="solution-editor"><div class="editor-head"><b id="solution-title">solution</b><span class="solution-toolbar"><span id="solution-source">waiting</span><button type="button" class="overlay-diff-toggle" id="overlay-diff-toggle" hidden>Show final</button></span></div><ol class="code-lines" id="solution-code"></ol></div><div class="tests"><div class="tests-head"><b>Test cases</b><span id="tests-count">real data</span></div><div class="case-list" id="tests"></div></div></div><div class="pane thought-pane"><section class="council-monitor"><div class="solution-status" id="agents"></div></section><div class="title">Thought process</div><div class="thought-list"><div class="thought-item"><div class="thought-heading">Approach/algorithm</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Functions</div><div class="thought-space function-notes" id="function-notes"></div></div><div class="thought-item"><div class="thought-heading">Data structures</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Time complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Space complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Edge cases</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Testing</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Trade-offs</div><div class="thought-space"></div></div></div></div></div><section id="code-focus-sheet" hidden><div class="code-focus-header"><div class="code-focus-file"><span class="code-focus-icon" aria-hidden="true">{ }</span><div class="code-focus-file-info"><span id="code-focus-file">solution.py</span><span id="code-focus-lang">Python · read only</span></div></div><div class="code-focus-meta"><button type="button" id="code-focus-diff-toggle" class="code-focus-diff-toggle" hidden>Show update diff</button><span id="code-focus-count">0 lines</span><span id="code-focus-status" class="code-focus-status">Verified</span></div></div><ol id="code-focus-code" aria-label="Solution code"></ol></section><script>
	            // HUD labels come from the numeric command table handled by mac_shortcuts.
            // Keep the overlay's real capture controls, not generic demo shortcuts.
            // The reader always starts with the E2B-gated state selected by
            // Rust. It never borrows potentially stale normal-pane markup.
            const focusVerified=state=>state&&state.solution&&
              ['provisional','reviewed'].includes(state.solution.status)&&
              String(state.solution.code||'').trim();
            function readerSelectedSolution(state){
              const primary=state.solution;
              const desired=window.__overlayDesiredLanguage;
              if(!desired||canonicalPortLanguage(primary.language)===desired)return primary;
              const ports=Array.isArray(state.ports)?state.ports:[];
              const port=ports.find(item=>item&&item.status==='verified'&&
                String(item.code||'').trim()&&canonicalPortLanguage(item.language)===desired);
              return port||primary; // Never display an unverified translation.
            }
            function codeFocusDiff(state,chosen){
              if(!state||!chosen)return null;
              const repair=chosen.repair;
              if(repair&&repair.status==='verified'&&String(repair.beforeCode||'').trim()&&
                String(repair.beforeCode)!==String(chosen.code||''))
                return {before:String(repair.beforeCode),after:String(chosen.code||''),kind:'repair'};
              const history=Array.isArray(state.solutionHistory)?state.solutionHistory:[];
              const provisional=history.find(item=>item&&item.version==='provisional');
              const final=history.find(item=>item&&item.version==='final');
              if(chosen.status==='reviewed'&&provisional&&final&&provisional.code&&final.code&&
                canonicalPortLanguage(provisional.language)===canonicalPortLanguage(chosen.language)&&
                canonicalPortLanguage(final.language)===canonicalPortLanguage(chosen.language)&&
                String(chosen.code)===String(final.code)&&String(provisional.code)!==String(final.code))
                return {before:String(provisional.code),after:String(final.code),kind:'council'};
              const judged=state.postJudgeUpgrade;
              if(chosen.status==='reviewed'&&judged&&judged.beforeCode&&judged.afterCode&&
                String(judged.afterCode)===String(chosen.code)&&String(judged.beforeCode)!==String(judged.afterCode))
                return {before:String(judged.beforeCode),after:String(judged.afterCode),kind:'judge'};
              return null;
            }
            window.renderCodeFocusSheet=function(){
              const target=document.getElementById('code-focus-code');
              const state=window.__overlayCodeFocusState;
              if(!target)return;
              const chosen=focusVerified(state)?readerSelectedSolution(state):null;
              const code=chosen?String(chosen.code):'';
              const language=chosen?String(chosen.language||''):'';
              const kind=canonicalPortLanguage(language);
              const extension=kind==='rust'?'rs':kind==='cpp'?'cpp':'py';
              const label=kind==='rust'?'Rust':kind==='cpp'?'C++':'Python';
              document.getElementById('code-focus-file').textContent='solution.'+extension;
              document.getElementById('code-focus-lang').textContent=label+' · read only';
              const diff=codeFocusDiff(state,chosen);
              const diffButton=document.getElementById('code-focus-diff-toggle');
              const diffKey=diff?String(state.runId||'')+'\u0000'+language+'\u0000'+diff.before+'\u0000'+diff.after:'';
              if(diffButton){
                diffButton.hidden=!diff;
                diffButton.textContent=diff?(window.__overlayCodeFocusDiffHidden?'Show verified code':'Show update diff'):'Show update diff';
                diffButton.title=diff?(diff.kind==='repair'?'View the verified port repair':diff.kind==='judge'?'View the judge-approved E2B-tested improvement':'View the final Council winner against its provisional solution'):'';
              }
              if(diff&&window.__overlayCodeFocusDiffKey!==diffKey){
                // As in the regular solution pane, make a newly published,
                // verified revision visible immediately in the standalone reader.
                window.__overlayCodeFocusDiffKey=diffKey;
                window.__overlayCodeFocusDiffHidden=false;
              }
              const showDiff=Boolean(diff&&!window.__overlayCodeFocusDiffHidden);
              if(!diff)window.__overlayCodeFocusDiffKey='';
              const lines=(showDiff?diff.after:code)?(showDiff?diff.after:code).split('\n').length:0;
              document.getElementById('code-focus-count').textContent=lines+' line'+(lines===1?'':'s');
              const status=document.getElementById('code-focus-status');
              status.dataset.stage=chosen&&chosen.status==='provisional'?'provisional':'reviewed';
              status.textContent=status.dataset.stage==='provisional'?'E2B tested':'Verified';
              const fingerprint=String(state&&state.runId||'')+'\u0000'+language+'\u0000'+code+'\u0000'+diffKey+'\u0000'+showDiff;
              // A 500ms cloud refresh must not keep jumping the reader back
              // to line one when the verified code itself has not changed.
              if(target.dataset.renderedCode===fingerprint)return;
              target.dataset.renderedCode=fingerprint;
              if(showDiff)renderOverlayDiff(target,diff.before,diff.after,language);
              else if(code)renderFocusCodeLines(target,code,language);
              else target.replaceChildren();
              target.scrollTop=0;
            };
            window.setCodeFocusSolution=function(state,followLive,language){
              window.__overlayCodeFocusState=focusVerified(state)?state:null;
              window.__overlayCodeFocusLiveRunId=followLive&&state?String(state.runId||''):null;
              const desired=canonicalPortLanguage(language);
              if(['python','rust','cpp'].includes(desired)&&state){
                // Native SL/SR supplies the exact port selected by RR/CP/PY.
                // Mark the matching run too so a normal pane refresh cannot
                // clear the choice between docking and the first render.
                window.__overlayDesiredLanguage=desired;
                window.__overlayLanguageRunId=String(state.runId||'');
              }
              window.renderCodeFocusSheet();
            };
            window.clearCodeFocusSolution=function(){
              window.__overlayCodeFocusState=null;
              window.__overlayCodeFocusLiveRunId=null;
              const target=document.getElementById('code-focus-code');
              if(target)target.dataset.renderedCode='';
              window.__overlayCodeFocusDiffKey='';
              window.__overlayCodeFocusDiffHidden=false;
            };
            document.addEventListener('click',function(event){
              if(event.target&&event.target.id==='code-focus-diff-toggle'){
                window.__overlayCodeFocusDiffHidden=!window.__overlayCodeFocusDiffHidden;
                window.renderCodeFocusSheet();
              }
            });
            window.setCodeFocusMode=function(mode){
              const previous=document.body.dataset.codeFocus||'normal';
              const next=['left','right'].includes(mode)?mode:'normal';
              if(previous==='normal'&&next!=='normal'){
                window.__overlayDiffBeforeCodeFocus=window.__overlayDiffHidden===true;
                // The standalone reader owns a separate revision-diff toggle;
                // preserve only the normal pane's toggle state here.
                window.__overlayDiffHidden=true;
              }else if(previous!=='normal'&&next==='normal'){
                window.__overlayDiffHidden=window.__overlayDiffBeforeCodeFocus===true;
              }
              document.body.dataset.codeFocus=next;
              const sheet=document.getElementById('code-focus-sheet');
              if(sheet)sheet.hidden=next==='normal';
              if(next!=='normal')window.renderCodeFocusSheet();
            };
            const esc=(s)=>String(s||'').replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
	            window.scrollSolutionBy=function(delta){const reading=document.body.dataset.codeFocus&&document.body.dataset.codeFocus!=='normal';const el=document.getElementById(reading?'code-focus-code':'solution-code');if(el)el.scrollTop+=delta;};
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
            function indentGuideStep(rows){
              let step=4;
              for(const line of rows){
                const prefix=line.match(/^[ \t]*/)[0];
                if(!line.trim()||!prefix)continue;
                let width=0;
                for(const char of prefix)width+=char==='\t'?4-width%4:1;
                step=Math.min(step,Math.max(2,width));
              }
              return step;
            }
            function appendGuidedCode(content,line,lang,syntax=true){
              // Guides paint the original leading whitespace; they never add
              // or replace source characters in either code presentation.
              const prefix=line.match(/^[ \t]*/)[0];
              if(prefix){
                const indent=document.createElement('span');
                indent.className='code-indent';
                indent.textContent=prefix;
                content.appendChild(indent);
              }
              const source=document.createElement('span');
              const rest=line.slice(prefix.length)||' ';
              if(syntax)source.innerHTML=highlight(rest,lang);
              else source.textContent=rest;
              content.appendChild(source);
            }
            function renderCodeLines(target,code,lang){
              const rows=codeWithReferenceComment(code,lang).split('\n');
              target.style.setProperty('--indent-step',indentGuideStep(rows)+'ch');
              target.replaceChildren();
              const fragment=document.createDocumentFragment();
              for(const line of rows){
                const li=document.createElement('li');
                const content=document.createElement('code');
                appendGuidedCode(content,line,lang);
                li.appendChild(content);
                fragment.appendChild(li);
              }
              target.appendChild(fragment);
            }
            function renderFocusCodeLines(target,code,lang){renderCodeLines(target,code,lang);}
		            function detectedFunctionNames(code){const found=[];String(code||'').replace(/\b([A-Za-z_]\w*)\s*\(/g,(_,name)=>{if(!found.includes(name)&&!['if','for','while','switch','return','def','function'].includes(name))found.push(name);return _;});return found;}
		            function renderFunctionNotes(code){const target=document.getElementById('function-notes');if(!target)return;const meanings={set:'stores unique values for quick membership checks',sum:'adds numeric values together',max:'returns the largest value',min:'returns the smallest value',len:'counts items',range:'creates a numeric loop sequence',enumerate:'loops with index and value',append:'adds an item to a list',sort:'orders a list in place',sorted:'returns ordered values',print:'writes debug output',useState:'stores React component state',useEffect:'runs React side effects',fetch:'requests network data',map:'transforms each item',filter:'keeps matching items',reduce:'combines items into one result'};const found=detectedFunctionNames(code);target.innerHTML='';found.slice(0,5).forEach((name)=>{const row=document.createElement('div');row.textContent=name+': '+(meanings[name]||'function call used by the solution');target.appendChild(row);});if(!target.children.length){const row=document.createElement('div');row.textContent='No function calls detected yet.';target.appendChild(row);}}
		            function functionExample(name){const examples={sum:'sum([18, 9]) -> 27',set:'set([18, 9, 18]) -> {18, 9}',max:'max([18, 9]) -> 18',min:'min([18, 9]) -> 9',len:'len([18, 9]) -> 2',range:'range(0, 5) -> 0..4',enumerate:'enumerate(items) -> index + value',append:'outliers.append(18) -> adds 18',sort:'values.sort() -> in-place order',sorted:'sorted(values) -> ordered copy',print:'print(result) -> console output',useState:'useState(false) -> state + setter',useEffect:'useEffect(fn, []) -> run side effect',fetch:'fetch(url) -> request data',map:'items.map(fn) -> transformed items',filter:'items.filter(fn) -> matching items',reduce:'items.reduce(fn, seed) -> one value'};return examples[name]||name+'(exampleInput) -> expected output';}
		            function renderSmartTests(target,count,code,stateTests){
              target.replaceChildren();const cases=Array.isArray(stateTests)?stateTests:[];
              count.textContent=cases.length?cases.length+' executed test case'+(cases.length===1?'':'s'):'no per-case I/O';
              if(!cases.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='This harness did not preserve individual inputs and outputs. No test values are invented.';target.appendChild(empty);return;}
              const printable=value=>typeof value==='string'?value:JSON.stringify(value);
              cases.slice(0,20).forEach((item,index)=>{
                const card=document.createElement('div');card.className='case';card.dataset.status=item.status||'';
                const name=document.createElement('b');name.textContent='Test case '+(index+1)+(item.name?' · '+String(item.name):'')+(item.status==='passed'?' · ✓':item.status==='failed'?' · ✕':'');
                card.appendChild(name);
                [['Input',item.input],['Expected',item.expected],['Output',item.actual]].forEach(([label,value])=>{
                  const row=document.createElement('div');row.className='case-field';
                  const title=document.createElement('b');title.textContent=label;
                  const data=document.createElement('code');data.textContent=printable(value);
                  row.append(title,data);card.appendChild(row);
                });
                target.appendChild(card);
              });
            }
            // Show the Council worker's exact E2B-tested candidate first. When
            // the deterministic judges publish a changed final winner, render
            // an actual red/green line diff in the EXISTING code window.
            function overlayDiffRows(before,after){
              const a=String(before||'').split('\n'),b=String(after||'').split('\n'),out=[];
              if(a.length*b.length>90000||String(before||'').length+String(after||'').length>98304)
                return [['summary','The code versions differ. This diff is too large to render safely; use the button to view verified code.']];
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
            function renderOverlayDiff(target,before,after,language){
              const rows=overlayDiffRows(before,after);
              target.style.setProperty('--indent-step',indentGuideStep(rows.map(([,line])=>line))+'ch');
              target.replaceChildren();
              rows.forEach(([change,line])=>{
                const li=document.createElement('li');li.dataset.change=change;
                const code=document.createElement('code');
                const marker=document.createElement('span');
                marker.textContent=change==='remove'?'- ':change==='add'?'+ ':'  ';
                code.appendChild(marker);
                appendGuidedCode(code,line,language,false);
                li.append(code);target.append(li);
              });
            }
            function renderOverlayCodeResult(target,state){
              const current=state.solution||{},history=Array.isArray(state.solutionHistory)?state.solutionHistory:[];
              const previous=history.find(entry=>entry.version==='provisional');
              const final=history.find(entry=>entry.version==='final');
              // Source of truth is persisted E2B-backed version history.
              // This must also detect a judge-approved upgrade when the
              // first Council winner matched Trusty's provisional code.
              const changed=current.status==='reviewed'&&previous&&final&&
                previous.code&&final.code&&previous.language===final.language&&
                current.code===final.code&&previous.code!==final.code;
              if(window.__overlayDiffRunId!==state.runId){window.__overlayDiffRunId=state.runId;window.__overlayDiffHidden=false;}
              const button=document.getElementById('overlay-diff-toggle');
              if(button){button.hidden=!changed;button.textContent=window.__overlayDiffHidden?'View changes':'Show final';}
              if(!changed||window.__overlayDiffHidden){renderCodeLines(target,current.code,current.language);return;}
              renderOverlayDiff(target,previous.code,final.code,current.language);
            }
            window.toggleOverlayCodeDiff=function(){
              const state=window.__overlayCurrentState;
              if(!state||!state.solution)return;
              window.__overlayDiffHidden=!window.__overlayDiffHidden;
              renderOverlayCodeResult(document.getElementById('solution-code'),state);
              renderVerifiedPorts(state);
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
		            function restoreCodingShell(){if(document.getElementById('agents'))return;document.getElementById('panel').innerHTML='<div class="pane pictures-pane"><div class="title">Pictures</div><div class="picture-list" id="pictures"></div><div class="divider"></div><div class="title">Solution</div><div class="solution-editor"><div class="editor-head"><b id="solution-title">solution</b><span class="solution-toolbar"><span id="solution-source">waiting</span><button type="button" class="overlay-diff-toggle" id="overlay-diff-toggle" hidden>Show final</button></span></div><ol class="code-lines" id="solution-code"></ol></div><div class="tests"><div class="tests-head"><b>Test cases</b><span id="tests-count">real data</span></div><div class="case-list" id="tests"></div></div></div><div class="pane thought-pane"><section class="council-monitor"><div class="solution-status" id="agents"></div></section><div class="title">Thought process</div><div class="thought-list"><div class="thought-item"><div class="thought-heading">Approach/algorithm</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Functions</div><div class="thought-space function-notes" id="function-notes"></div></div><div class="thought-item"><div class="thought-heading">Data structures</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Time complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Space complexity</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Edge cases</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Testing</div><div class="thought-space"></div></div><div class="thought-item"><div class="thought-heading">Trade-offs</div><div class="thought-space"></div></div></div></div>';window.updatePreviews(window.__lastPreviews||[]);}
		            window.updateOverlayState=function(state){state=state||{agents:[],tests:[],solution:null,phase:'idle'};window.__overlayCurrentState=state;if(state.kind==='mcq'||state.mcq){renderMcq(state);return;}restoreCodingShell();const agents=document.getElementById('agents');agents.innerHTML='';if(!state.agents||!state.agents.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No active model run';agents.appendChild(empty);}else{state.agents.slice(0,5).forEach((a)=>{const chip=document.createElement('div');chip.className='model-chip';chip.dataset.state=stateTone(a.status);const dot=document.createElement('span');dot.className='dot';const name=document.createElement('b');name.textContent=a.label||a.id;const status=document.createElement('span');status.textContent=a.status==='error'?(a.error||'error'):a.status;chip.title=[a.model,a.error].filter(Boolean).join(' — ');chip.appendChild(dot);chip.appendChild(name);chip.appendChild(status);agents.appendChild(chip);});}const title=document.getElementById('solution-title');const source=document.getElementById('solution-source');const code=document.getElementById('solution-code');const tests=document.getElementById('tests');const count=document.getElementById('tests-count');if(state.solution&&state.solution.code){title.textContent=state.solution.title||'solution';const isTrusty=String(state.solution.source||'').includes('Coding Trusty');source.textContent=state.solution.status==='reviewed'?'Council verified':state.solution.status==='provisional'?(isTrusty?'Coding Trusty · Claude Fable 5.1 · E2B passed; Council reviewing':'E2B passed · Council reviewing'):('candidate · '+(state.solution.source||''));renderOverlayCodeResult(code,state);renderFunctionNotes(state.solution.code);renderSmartTests(tests,count,state.solution.code,state.tests);renderCouncilInsights(state.presentation,state);}else{title.textContent='solution';source.textContent=state.phase==='idle'?'idle':'waiting';const waiting=state.phase==='idle'?'No run yet.':'Waiting for solution...';renderCodeLines(code,waiting,'');renderFunctionNotes(waiting);renderSmartTests(tests,count,waiting,state.tests);renderCouncilInsights(state.presentation,state);}};
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
                root.innerHTML='<header class="history-heading"><div><div class="history-eyebrow">Council Editor / Coding Overlay</div><div class="history-title">History</div><div class="history-description">Coding overlay results only</div></div><div class="history-counter" id="history-counter">0 sessions</div></header><div class="history-list" id="history-list"></div><footer class="history-footer"><span>↑ / ↓ Navigate · \\ Open result</span><span>cc Coding · hh History</span></footer>';
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
                empty.textContent=error?'Could not load cloud history: '+error:loading?'Loading Coding history…':'No saved Coding runs yet. Your next Coding capture will appear here.';
                list.appendChild(empty);
              }else if(error){
                const warning=document.createElement('div');warning.className='history-empty';
                warning.textContent='History is temporarily unavailable: '+error;
                list.prepend(warning);
              }
              const counter=root.querySelector('#history-counter');
              counter.textContent=root.__rows.length+' saved'+(loading?' · syncing':'');
              window.selectSharedHistoryRow(selected||0);
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
            };
            window.showSharedHistoryDetail=function(detail){
              if(detail&&detail.state){window.closeSharedHistory();window.updateOverlayState(detail.state);if(Array.isArray(detail.historyPreviews))window.updatePreviews(detail.historyPreviews);return;}
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
            function friendlyModelFailure(value){
              const raw=String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,' ')
                .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ')
                .replace(/<[^>]+>/g,' ').replace(/&(?:nbsp|amp|lt|gt|quot);/gi,' ')
                .replace(/\s+/g,' ').trim();
              if(/(?:\b524\b|upstream model timed out)/i.test(raw))return 'Model timed out upstream; Council retried it.';
              if(/empty model response/i.test(raw))return 'Model returned no usable answer.';
              if(/no complete runnable code|no usable .*code after recovery/i.test(raw))return 'Model returned no usable solution code.';
              if(/no verified primary solution|no candidate passed verification/i.test(raw))return 'No candidate passed verification; unverified code remains hidden.';
              if(/timed out|timeout/i.test(raw))return 'Model timed out.';
              return raw?('Model failed: '+raw.slice(0,160)):'Model failed.';
            }
            function agentStatusText(agent){
              if(agent.error)return friendlyModelFailure(agent.error);
              if(agent.detail)return String(agent.detail);
              const labels={done:'Answer ready',running:'Generating answer',streaming:'Generating answer',reviewing:'Reviewing answer',pending:'Queued for Council',cancelled:'Cancelled'};
              return labels[agent.status]||String(agent.status||'Waiting');
            }
            function renderStoryAgents(state){
              const agents=document.getElementById('agents');if(!agents)return;
              const monitor=agents.closest('.council-monitor');if(!monitor)return;
              const oldHeader=monitor.querySelector('.agent-header');if(oldHeader)oldHeader.remove();
              const oldProgress=monitor.querySelector('.overlay-progress');if(oldProgress)oldProgress.remove();
              const oldDiagnostics=monitor.querySelector('.overlay-diagnostics');if(oldDiagnostics)oldDiagnostics.remove();
              const header=document.createElement('div');header.className='agent-header';
              const heading=document.createElement('div');heading.className='title';heading.textContent='Selected Council agents';
              const summary=document.createElement('span');summary.className='agent-summary';
              const selected=Array.isArray(state.agents)?state.agents.slice(0,4):[];
              const ready=selected.filter((agent)=>agent.status==='done').length;
              summary.textContent=selected.length?(ready+'/'+selected.length+' answers ready'):'Waiting for the Council roster';
              header.appendChild(heading);header.appendChild(summary);
              monitor.insertBefore(header,agents);
              agents.innerHTML='';
              if(!selected.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='The selected Council agents will appear here.';agents.appendChild(empty);}else{selected.forEach((agent)=>{const card=document.createElement('div');card.className='model-chip';card.dataset.state=stateTone(agent.status);const dot=document.createElement('span');dot.className='dot';const name=document.createElement('b');name.textContent=agent.label||agent.id||'Council agent';const model=document.createElement('span');model.className='agent-model';model.textContent=agent.model||'Council';const detail=document.createElement('span');detail.textContent=agentStatusText(agent);card.title=[agent.model,agent.error].filter(Boolean).join(' — ');card.append(dot,name,model,detail);agents.appendChild(card);});}
              const trusty=state.codingTrusty;if(trusty&&trusty.status&&trusty.status!=='idle'){const card=document.createElement('div');card.className='model-chip coding-trusty-chip';card.dataset.state=trusty.status==='ready'?'done':trusty.status==='failed'?'error':trusty.status==='unavailable'?'pending':'working';const dot=document.createElement('span');dot.className='dot';const name=document.createElement('b');name.textContent='Coding Trusty';const model=document.createElement('span');model.className='agent-model';model.textContent='Claude Fable 5.1 · Clean API (separate preflight)';const detail=document.createElement('span');detail.textContent=trusty.status==='ready'?'E2B passed · Council review continues':trusty.status==='failed'?'Preflight unavailable: '+friendlyModelFailure(trusty.error||trusty.message):trusty.status==='unavailable'?'Clean API credential unavailable':trusty.status==='testing'?'Answer ready · E2B testing':'Solving and self-reviewing';card.title=trusty.message||'Separate from the four selected Council agents';card.append(dot,name,model,detail);agents.appendChild(card);}
              const progress=document.createElement('div');progress.className='overlay-progress';const waiting=state.phase==='idle'?'Capture screenshots to begin.':state.progress||'Council is selecting eligible agents.';const stages={queued:'Waiting for the cloud worker',contracting:'Reading the problem contract',
                reading:'Understanding screenshots',solving:'Generating candidate solutions',
                speccing:'Preparing independent E2B tests',benchmarking:'Running E2B cases',
                verifying:'Running E2B verification',reviewing:'Reviewing candidates',
                revising:'Repairing eligible solutions',reverifying:'Re-testing repaired code',
                judging:'Independent Council judges',synthesizing:'Selecting verified winner',
                porting:'Independently solving other languages',completed:'Council completed'};
              const stage=stages[state.progressPhase]||waiting;
              const verifiedNames=Array.isArray(state.ports)?state.ports
                .filter(port=>port&&port.status==='verified'&&String(port.code||'').trim())
                .map(port=>canonicalPortLanguage(port.language)==='cpp'?'C++':
                  canonicalPortLanguage(port.language)==='rust'?'Rust':'Python'):[];
              const primaryReady=Boolean(state.solution&&String(state.solution.code||'').trim());
              progress.textContent=state.phase==='done'
                ? (verifiedNames.length?'Council completed. Primary verified; independently verified languages: '+verifiedNames.join(', ')+'.':primaryReady?'Council completed. The verified primary solution is available; other languages have not been verified yet.':'Council finished without a verified primary solution.'):
                state.phase==='error'?'Council needs attention. See the diagnostic below.':
                stage+(state.progress&&stage!==state.progress?' · '+String(state.progress).slice(0,145):'');
              agents.after(progress);
              const failures=selected.filter((agent)=>agent.error).map((agent)=>(agent.label||agent.id||'Council agent')+': '+friendlyModelFailure(agent.error));
              if(failures.length||state.phase==='error'){const diagnostic=document.createElement('div');diagnostic.className='overlay-diagnostics';const label=document.createElement('b');label.textContent='Run diagnostics';const message=document.createElement('span');message.textContent=failures.join(' · ')||friendlyModelFailure(state.error)||'The Council run reported an issue. The captured images and any available answer remain available.';diagnostic.append(label,message);progress.after(diagnostic);}
            }
            function renderHistoryContext(state){
              const old=document.getElementById('overlay-history-context');if(old)old.remove();
              const title=state&&String(state.historyTitle||'').trim();if(!title)return;
              const shown=title.length>72?title.slice(0,69)+'…':title;
              const pane=document.querySelector('.council-monitor');if(!pane)return;
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
              const reading=document.body.dataset.codeFocus&&document.body.dataset.codeFocus!=='normal';
              const state=(reading&&window.__overlayCodeFocusState)||window.__overlayCurrentState;
              if(!state||state.kind==='mcq'||!state.solution)return false;
              const desired=canonicalPortLanguage(language);
              if(!['python','rust','cpp'].includes(desired))return false;
              window.__overlayDesiredLanguage=desired;
              window.__overlayDiffHidden=false;
              renderVerifiedPorts(state);
              if(reading)window.renderCodeFocusSheet();
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
              const summary=document.createElement('span');summary.textContent=validated.length+' independently E2B-verified solutions';
              const header=document.createElement('div');header.className='tests-head';header.append(label,summary);section.append(header);
              const list=document.createElement('div');list.className='overlay-port-list';
              const desired=window.__overlayDesiredLanguage;
              const primaryLang=canonicalPortLanguage(primary.language);
              const keyPairs=[['python','py'],['rust','rr'],['cpp','cp']];
              for(const [lang,key] of keyPairs){
                const available=lang===primaryLang||validated.some(port=>canonicalPortLanguage(port.language)===lang);
                const unfinished=ports.find(port=>canonicalPortLanguage(port.language)===lang);
                const chip=document.createElement('span');chip.className='overlay-port-chip';
                chip.dataset.available=available?'true':'false';chip.dataset.selected=desired===lang?'true':'false';
                const label=lang==='cpp'?'C++':lang[0].toUpperCase()+lang.slice(1);
                chip.textContent=label+' · '+key+(available?' ✓':unfinished&&unfinished.status==='failed'?' ✕':' …');
                chip.title=available?'E2B verified · type '+key+' to select':
                  unfinished&&unfinished.status==='failed'?'E2B verification failed: '+String(unfinished.error||'unspecified failure').slice(0,200):
                  'Independent E2B verification pending';
                list.append(chip);
              }
              section.append(list);editor.after(section);
              const dockHint=document.createElement('div');dockHint.className='overlay-port-dock-hint';
              dockHint.textContent='Dock selected verified solution: SL left · SR right';
              section.append(dockHint);
              if(!desired)return;
              const chosen=primaryLang===desired?primary:
                validated.find(port=>canonicalPortLanguage(port.language)===desired);
              const source=document.getElementById('solution-source'),title=document.getElementById('solution-title');
              if(!chosen){
                const candidate=ports.find(port=>canonicalPortLanguage(port.language)===desired);
                const name=desired==='cpp'?'C++':desired==='rust'?'Rust':'Python';
                const primaryName=primaryLang==='cpp'?'C++':primaryLang==='rust'?'Rust':'Python';
                if(source){
                  source.textContent=candidate?.status==='failed'
                    ? name+' · E2B failed · showing '+primaryName
                    : name+' · verification pending · showing '+primaryName;
                  source.title=candidate?.error?String(candidate.error).slice(0,350):'';
                }
                return;
              }
              const code=document.getElementById('solution-code');
              const repaired=chosen!==primary&&chosen.repair&&chosen.repair.status==='verified'&&
                String(chosen.repair.beforeCode||'').trim()&&chosen.repair.beforeCode!==chosen.code;
              const diffButton=document.getElementById('overlay-diff-toggle');
              if(diffButton&&chosen!==primary){
                diffButton.hidden=!repaired;
                diffButton.textContent=window.__overlayDiffHidden?'View repair changes':'Show corrected code';
              }
              if(code){
                if(repaired&&!window.__overlayDiffHidden)
                  renderOverlayDiff(code,chosen.repair.beforeCode,chosen.code,chosen.language||desired);
                else renderCodeLines(code,String(chosen.code||''),String(chosen.language||desired));
                code.scrollTop=0;
              }
              if(title)title.textContent='solution.'+(desired==='cpp'?'cpp':desired==='python'?'py':'rs');
              if(source)source.textContent=chosen===primary?'Council-verified primary':'Independently E2B-verified solution';
              const cases=chosen===primary?state.tests:
                (Array.isArray(state.portCases)?state.portCases.find(entry=>canonicalPortLanguage(entry.language)===desired)?.tests:[]);
              const caseTarget=document.getElementById('tests'),caseCount=document.getElementById('tests-count');
              if(caseTarget&&caseCount)renderSmartTests(caseTarget,caseCount,String(chosen.code||''),cases);
              // Editing one version or importing from a live report never alters
              // the saved original code or the cloud report.
            }
            window.updateOverlayState=function(state){
              baseUpdateOverlayState(state);
              if(!state||state.kind!=='mcq'){
                renderStoryAgents(state||{});
                renderHistoryContext(state||{});
                renderVerifiedPorts(state||{});
              }
              if(document.body.dataset.codeFocus&&document.body.dataset.codeFocus!=='normal'){
                const watched=window.__overlayCodeFocusLiveRunId;
                if(watched!==null&&watched!==undefined){
                  // Follow updated verified code/ports for the SAME question.
                  // Never carry the previous question into a new capture/run.
                  window.__overlayCodeFocusState=state&&String(state.runId||'')===watched&&
                    focusVerified(state)?state:null;
                }
                window.renderCodeFocusSheet();
              }
            };
    </script></body></html>"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_reader_uses_verified_current_state_and_preserves_click_through() {
        let html=overlay_html();
        assert!(html.contains("window.setCodeFocusSolution=function(state,followLive,language)"));
        assert!(html.contains("window.__overlayDesiredLanguage=desired"));
        assert!(html.contains("String(state.runId||'')===watched"));
        assert!(html.contains("port.status==='verified'") || html.contains("item.status==='verified'"));
        assert!(html.contains("#code-focus-sheet[hidden]{display:none}"));
        assert!(html.contains("window.renderCodeFocusSheet=function()"));
        assert!(html.contains("function codeFocusDiff(state,chosen)"));
        assert!(html.contains("id=\"code-focus-diff-toggle\""));
        assert!(html.contains("#code-focus-code li[data-change=\"remove\"]"));
        assert!(html.contains("#code-focus-code li[data-change=\"add\"]"));
        assert!(html.contains("window.__overlayCodeFocusDiffHidden=false"));
        assert!(html.contains("target.dataset.renderedCode===fingerprint"));
        assert!(html.contains("next=['left','right'].includes(mode)"));
    }

    #[test]
    fn coding_overlay_places_council_monitor_above_thought_process() {
        let html = overlay_html();
        let solution = html.find("<div class=\"title\">Solution</div>").unwrap();
        let monitor = html.find("<section class=\"council-monitor\">").unwrap();
        let thought = html.find("<div class=\"title\">Thought process</div>").unwrap();
        assert!(solution < monitor && monitor < thought);
        assert!(!html.contains("<div class=\"title\">Solution</div><div class=\"solution-status\" id=\"agents\""));
    }

    #[test]
    fn command_rail_is_separate_from_the_coding_panel() {
        let content = overlay_html();
        let controls = hud_html();
        assert!(content.contains("<body><div id=\"panel\">"));
        assert!(!content.contains("id=\"hudbar\""));
        assert!(controls.contains("id=\"hudbar\""));
        assert!(controls.contains("tile.append(badge,label)"), "names belong below their keys");
        let point = hud_position(LogicalPosition::new(250.0, 20.0));
        assert_eq!(point.x, 250.0 - HUD_GAP - HUD_WIDTH);
        assert_eq!(point.y, 20.0);
        assert!(hud_height("history") < hud_height("coding"));
    }

    #[test]
    fn docked_code_reader_uses_regular_arrow_scrolling_and_shows_its_shortcuts() {
        let content = overlay_html();
        let controls = hud_html();
        assert!(content.contains("reading?'code-focus-code':'solution-code'"),
            "the same solution scroll helper must choose the docked code reader");
        assert!(controls.contains("view==='docked'"));
        assert!(controls.contains("['Scroll code','↑↓']"));
        assert!(controls.contains("['Left / Back','sl']"));
        assert!(controls.contains("['Right / Back','sr']"));
        let code = PhysicalPosition::new(10_i32, 10_i32);
        let size = PhysicalSize::new(600_u32, 700_u32);
        let left = docked_hud_position(code, size, 2, 1.0);
        let right = docked_hud_position(code, size, 3, 1.0);
        assert!(left.x >= 610, "SL HUD must be beside, not over, code");
        assert!(right.x < code.x, "SR HUD must be beside, not over, code");
        assert_eq!(left.y, code.y);
        assert_eq!(right.y, code.y);
    }

    #[test]
    fn only_distinct_quick_letter_double_taps_open_panels() {
        let start = Instant::now();
        let mut last = None;
        assert_eq!(double_tap_panel(&mut last, 1, false, start), None);
        assert_eq!(double_tap_panel(&mut last, 1, false, start + Duration::from_millis(230)), Some(1));
        // A completed pair resets; holding a key is filtered at the HID edge.
        assert_eq!(double_tap_panel(&mut last, 1, false, start + Duration::from_millis(400)), None);
        assert_eq!(double_tap_panel(&mut last, 2, false, start + Duration::from_millis(475)), None);
        assert_eq!(double_tap_panel(&mut last, 2, false, start + Duration::from_millis(900)), Some(2));
        assert_eq!(double_tap_panel(&mut last, 3, true, start + Duration::from_millis(1000)), None);
        assert_eq!(double_tap_panel(&mut last, 3, true, start + Duration::from_millis(1700)), Some(3));
        assert_eq!(double_tap_panel(&mut last, 3, false, start + Duration::from_millis(2_301)), None);
        assert_eq!(double_tap_panel(&mut last, 3, false, start + Duration::from_millis(3_602)), None);
        assert_eq!(double_tap_panel(&mut last, 3, false, start + Duration::from_millis(3_610)), Some(3));
    }

    #[test]
    fn letter_shortcuts_accept_uniform_case_and_reject_mixed_case() {
        let start = Instant::now();
        let mut last = None;
        assert_eq!(double_tap_panel(&mut last, 1, false, start), None);
        assert_eq!(double_tap_panel(&mut last, 1, true, start + Duration::from_millis(100)), None);
        assert_eq!(double_tap_panel(&mut last, 1, true, start + Duration::from_millis(200)), Some(1));

        assert!(same_letter_case(false, false), "cc is a uniform-case pair");
        assert!(same_letter_case(true, true), "CC is a uniform-case pair");
        assert!(!same_letter_case(false, true), "cC is mixed case and must not dispatch");
        assert!(!same_letter_case(true, false), "sL is mixed case and must not dispatch");
    }

    #[test]
    fn code_docks_do_not_switch_or_replace_the_mcq_overlay() {
        assert!(code_focus_shortcut_allowed("coding", false, false));
        assert!(!code_focus_shortcut_allowed("mcq", false, false));
        assert!(!code_focus_shortcut_allowed("coding", true, false), "history list is not a solution");
        assert!(code_focus_shortcut_allowed("mcq", true, true), "opened coding history result may be read");
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
    fn coding_history_excludes_only_mcq_jobs() {
        assert!(is_coding_history_job(&serde_json::json!({"mode":"coding"})));
        assert!(is_coding_history_job(&serde_json::json!({"mode":"council"})));
        assert!(is_coding_history_job(&serde_json::json!({})));
        assert!(!is_coding_history_job(&serde_json::json!({"mode":"mcq"})));
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
                "ports":[{"language":"rust","status":"verified","code":"fn main() {}",
                    "repair":{"status":"verified","beforeCode":"fn main() { broken() }"}}]
            }})),
        };
        let projected=coding_overlay_state(&job);
        assert_eq!(projected["agents"][0]["status"],"done");
        assert_eq!(projected["agents"][0]["gate"],"pass");
        assert_eq!(projected["ports"][0]["language"],"rust");
        assert_eq!(projected["ports"][0]["repair"]["beforeCode"],"fn main() { broken() }");
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
            (3, 1, 31), (3, 2, 32), (3, 3, 33), (3, 5, 35),
        ];
        for (prefix, shape, command) in expected {
            assert_eq!(number_pair_command(prefix, shape), Some(command));
        }
        for invalid in [(1, 5), (2, 1), (2, 6), (3, 0), (3, 4), (4, 1)] {
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
                    "suites": [{ "language": "python" }],
                    "runs": {"B":{"ran":true,"ok":true,"passed":1,"failed":0,
                        "stdout": r#"PASS example
CA_CASE {"id":"statement example","input":{"n":4},"expected":6,"actual":6,"status":"passed"}"#}},
                    "presentation": {"standing":"verified", "code":"def solve():\n    return 42", "language":"py","provenance":"Candidate B"}
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
    fn coding_overlay_surfaces_fable_trusty_as_a_separate_verified_preflight() {
        let job = SubmittedJob {
            id: "trusty-job".into(), mode: "council".into(), mcq_model: None,
            status: "running".into(), progress_phase: "judging".into(),
            submitted_at: now(), previews: vec![], error: None,
            report: Some(serde_json::json!({"report":{
                "stage":"provisional",
                "provisional":{"status":"provisional","letter":"T","model":"claude-fable-5.1",
                    "codingTrusty":true,"language":"python","code":"def solve():\\n    return 42",
                    "answer":"Return the requested value.","passed":3,"failed":0},
                "candidates":[{"letter":"T","model":"claude-fable-5.1",
                    "codingTrusty":true,"final":{"kind":"code","code":"def solve():\\n    return 42"}}],
                "runs":{"T":{"ran":true,"ok":true,"passed":3,"failed":0,
                    "stdout":r#"CA_CASE {"id":"example 1","input":1,"expected":2,"actual":2,"status":"passed"}"#}}
            }})),
            events: vec![serde_json::json!({"phase":"coding_trusty_e2b_passed",
                "message":"Claude Fable 5.1 passed the E2B test suite.",
                "payload":{"model":"claude-fable-5.1","letter":"T"}})],
        };
        let state = coding_overlay_state(&job);
        assert_eq!(state["codingTrusty"]["status"], "ready");
        assert_eq!(state["codingTrusty"]["model"], "claude-fable-5.1");
        assert_eq!(state["solution"]["status"], "provisional");
        assert!(state["solution"]["source"].as_str().unwrap_or("").contains("Coding Trusty · Claude Fable 5.1"));
        assert_eq!(state["agents"].as_array().map(|agents| agents.len()), Some(0),
            "Trusty must not be counted as one of the selected Council seats");
        assert_eq!(state["tests"].as_array().map(|tests| tests.len()), Some(1),
            "Actual provisional E2B case results must appear before judges finish");
        assert_eq!(state["tests"][0]["status"], "passed");
        assert!(state["insights"]["summary"].as_str().unwrap_or("")
            .contains("Return the requested value"));
        assert!(state["insights"]["testing"].as_str().unwrap_or("")
            .contains("3 passed"));
    }

    #[test]
    fn code_only_hotkeys_require_the_current_verified_coding_solution() {
        let make_job = |status: &str, mode: &str, report: Option<Value>| SubmittedJob {
            id: "current-coding-run".into(),
            mode: mode.into(),
            mcq_model: None,
            status: status.into(),
            progress_phase: "reviewing".into(),
            submitted_at: now(),
            previews: vec![],
            error: None,
            report,
            events: vec![],
        };
        assert!(!code_focus_eligible(None, true), "no current job");
        assert!(!code_focus_eligible(
            Some(&make_job("queued", "council", None)), true),
            "queued job has no verified answer");
        let generated_only = serde_json::json!({"report":{
            "winner":"A",
            "candidates":[{"letter":"A","final":{"kind":"code","code":"print(123)"}}]
        }});
        assert!(!code_focus_eligible(
            Some(&make_job("running", "council", Some(generated_only))), true),
            "AI-generated code alone cannot unlock SS/SL/SR");

        let unverified = serde_json::json!({"report":{
            "stage":"provisional",
            "provisional":{"status":"provisional","code":"print(4)",
                "passed":0,"failed":1}
        }});
        assert!(!code_focus_eligible(
            Some(&make_job("running", "council", Some(unverified))), true),
            "failed E2B test cannot unlock code only");
        let verified_early = serde_json::json!({"report":{
            "stage":"provisional",
            "provisional":{"status":"provisional","code":"print(6)",
                "passed":3,"failed":0,"language":"Python"}
        }});
        let reviewing = make_job("running", "council", Some(verified_early.clone()));
        assert!(code_focus_eligible(Some(&reviewing), true),
            "verified early code is ready even while Council judges are reviewing");
        assert!(!code_focus_eligible(Some(&reviewing), false),
            "a fresh/pending capture must block showing the previous answer");
        for status in ["failed", "needs_attention", "cancelled"] {
            assert!(!code_focus_eligible(
                Some(&make_job(status, "council", Some(verified_early.clone()))), true),
                "terminal failed job must not enable code only");
        }
        assert!(!code_focus_eligible(
            Some(&make_job("running", "mcq", Some(verified_early))), true),
            "MCQ output cannot enable coding shortcuts");

        let final_verified = serde_json::json!({"report":{
            "winner":"B",
            "presentation":{"standing":"verified","code":"def solve(n): return n",
                "language":"Python","provenance":"candidate B"}
        }});
        assert!(code_focus_eligible(
            Some(&make_job("completed", "council", Some(final_verified))), true),
            "completed Council-verified primary solution enables all code-only keys");

        let final_without_proof = serde_json::json!({"report":{
            "winner":"B",
            "presentation":{"standing":"pending","code":"print('unverified')"}
        }});
        assert!(!code_focus_eligible(
            Some(&make_job("completed", "council", Some(final_without_proof))), true),
            "prose or unverified presentation is not sufficient");

        let saved_history_state = serde_json::json!({
            "kind":"coding",
            "solution":{"status":"reviewed","code":"fn solve() {}","language":"rust"}
        });
        assert!(code_focus_state_eligible(&saved_history_state),
            "an explicitly opened, E2B-verified history result is readable");
        let saved_unverified = serde_json::json!({
            "kind":"coding",
            "solution":{"status":"candidate","code":"fn solve() {}","language":"rust"}
        });
        assert!(!code_focus_state_eligible(&saved_unverified),
            "an unverified history result cannot unlock code focus");
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
    fn overlay_case_rows_show_only_real_executed_inputs_expected_and_actual() {
        let trace = [
            "PASS example one",
            r#"CA_CASE {"id":"example 1","input":{"n":4},"expected":6,"actual":6,"status":"passed"}"#,
            r#"CA_CASE {"id":"example 2","input":{"n":9},"expected":12,"actual":154,"status":"passed"}"#,
            "PASS summary without I/O",
            "CA_CASE not valid json",
        ].join("\n");
        let report = serde_json::json!({
            "winner": "B",
            "runs": {"A":{"ran":true,"stdout":r#"CA_CASE {"input":0,"expected":0,"actual":0}"#},
                     "B":{"ran":true,"stdout": trace}},
        });
        let rows = coding_tests_from_report(&report, "B");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["input"]["n"], 4);
        assert_eq!(rows[0]["expected"], 6);
        assert_eq!(rows[0]["actual"], 6);
        assert_eq!(rows[0]["status"], "passed");
        // An incorrect status claimed by a generator cannot hide a mismatch.
        assert_eq!(rows[1]["status"], "failed");
        assert_eq!(rows[1]["actual"], 154);
        assert_eq!(rows[1]["expected"], 12);
        assert!(coding_tests_from_report(&report, "A").is_empty() == false);
        assert!(coding_tests_from_report(&report, "C").is_empty());
    }

    #[test]
    fn overlay_keeps_port_cases_separate_from_primary_language_evidence() {
        let job = SubmittedJob {
            id: "port-evidence".into(), mode: "council".into(), mcq_model: None,
            status: "completed".into(), progress_phase: "completed".into(),
            submitted_at: now(), previews: vec![], error: None, events: vec![],
            report: Some(serde_json::json!({"report": {
                "winner": "A",
                "presentation": {"standing": "verified", "language": "Python",
                    "code": "def solve(n): return n", "provenance": "candidate A"},
                "runs": {"A": {"ran": true,
                    "stdout": r#"CA_CASE {"id":"primary","input":{"n":2},"expected":2,"actual":2}"#}},
                "ports": [{
                    "language": "Rust", "status": "verified", "code": "fn solve(n:i32)->i32{n}",
                    "run": {"ran": true, "ok": true, "failed": 0,
                        "stdout": r#"CA_CASE {"id":"port","input":{"n":8},"expected":8,"actual":8}"#}
                }]
            }})),
        };
        let state = coding_overlay_state(&job);
        assert_eq!(state["tests"][0]["input"]["n"], 2);
        assert_eq!(state["portCases"][0]["language"], "Rust");
        assert_eq!(state["portCases"][0]["tests"][0]["input"]["n"], 8);
        assert_eq!(state["portCases"][0]["tests"][0]["status"], "passed");
    }

    #[test]
    fn completed_cloud_reports_with_preparing_ports_still_require_refresh() {
        assert!(report_has_preparing_ports(&serde_json::json!({
            "report":{"stage":"final","ports":[{"language":"rust","status":"preparing"}]}
        })));
        assert!(!report_has_preparing_ports(&serde_json::json!({
            "report":{"stage":"final","ports":[
                {"language":"rust","status":"verified","code":"fn main() {}"},
                {"language":"c++","status":"failed"}
            ]}
        })));
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
        assert!(state["tests"].as_array().unwrap().is_empty(),
            "Aggregate provisional totals must not masquerade as executed case I/O");
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
                ],"upgrade":{"changed":true,"from":"A","to":"B"},
                "postJudgeUpgrade":{"beforeCode":"print(2)","afterCode":"print(3)","reason":"verified improvement","passed":2}
            }}))
        };
        let state = coding_overlay_state(&job);
        assert_eq!(state["solution"]["code"],"print(2)");
        assert_eq!(state["upgrade"]["changed"],true);
        assert_eq!(state["solutionHistory"].as_array().map(Vec::len),Some(2));
        assert_eq!(state["postJudgeUpgrade"]["afterCode"],"print(3)");
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
        assert!(state["tests"].as_array().unwrap().is_empty(),
            "Legacy candidate pass totals are not individual case evidence");
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
