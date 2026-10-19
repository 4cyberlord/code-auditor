//! Permission-free global shortcuts for the overlay helper. Every registered
//! key includes Control and Option; ordinary typing is never observed.

use std::{
    ffi::c_void,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Mutex, OnceLock,
    },
};

const SIGNATURE: u32 = u32::from_be_bytes(*b"MDSC");
const KEYBOARD_EVENT_CLASS: u32 = u32::from_be_bytes(*b"keyb");
const HOTKEY_PRESSED: u32 = 5;
const DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");
const HOTKEY_ID_TYPE: u32 = u32::from_be_bytes(*b"hkid");
const EVENT_NOT_HANDLED: i32 = -9874;
const CONTROL: u32 = 1 << 12;
const OPTION: u32 = 1 << 11;
const SHIFT: u32 = 1 << 9;
const COMMAND: u32 = 1 << 8;
const BASE: u32 = CONTROL | OPTION;

#[repr(C)]
#[derive(Default)]
struct EventHotKeyID {
    signature: u32,
    id: u32,
}

#[repr(C)]
struct EventTypeSpec {
    event_class: u32,
    event_kind: u32,
}

type EventRef = *mut c_void;
type EventTargetRef = *mut c_void;
type EventHotKeyRef = *mut c_void;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        handler: Option<extern "C" fn(*mut c_void, EventRef, *mut c_void) -> i32>,
        count: u32,
        types: *const EventTypeSpec,
        user_data: *mut c_void,
        out_ref: *mut *mut c_void,
    ) -> i32;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        id: EventHotKeyID,
        target: EventTargetRef,
        options: u32,
        out_ref: *mut EventHotKeyRef,
    ) -> i32;
    fn UnregisterEventHotKey(hotkey: EventHotKeyRef) -> i32;
    fn GetEventParameter(
        event: EventRef,
        name: u32,
        desired_type: u32,
        actual_type: *mut u32,
        buffer_size: u32,
        actual_size: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

#[derive(Clone, Copy)]
struct Shortcut {
    id: u32,
    key: u32,
    modifiers: u32,
    label: &'static str,
}

// Virtual key codes are from the macOS SDK's HIToolbox/Events.h.
const GLOBAL: &[Shortcut] = &[
    Shortcut { id: 1, key: 0x08, modifiers: BASE, label: "Control+Option+C" },
    Shortcut { id: 2, key: 0x2e, modifiers: BASE, label: "Control+Option+M" },
    Shortcut { id: 3, key: 0x04, modifiers: BASE, label: "Control+Option+H" },
    Shortcut { id: 6, key: 0x2d, modifiers: BASE, label: "Control+Option+N" },
    Shortcut { id: 20, key: 0x12, modifiers: BASE, label: "Control+Option+1" },
    Shortcut { id: 22, key: 0x13, modifiers: BASE, label: "Control+Option+2" },
    Shortcut { id: 23, key: 0x14, modifiers: BASE, label: "Control+Option+3" },
    Shortcut { id: 24, key: 0x15, modifiers: BASE, label: "Control+Option+4" },
    Shortcut { id: 25, key: 0x17, modifiers: BASE, label: "Control+Option+5" },
    Shortcut { id: 31, key: 0x12, modifiers: BASE | SHIFT, label: "Control+Option+Shift+1" },
    Shortcut { id: 32, key: 0x13, modifiers: BASE | SHIFT, label: "Control+Option+Shift+2" },
    Shortcut { id: 33, key: 0x14, modifiers: BASE | SHIFT, label: "Control+Option+Shift+3" },
    Shortcut { id: 35, key: 0x15, modifiers: BASE | SHIFT, label: "Control+Option+Shift+4" },
    Shortcut { id: 40, key: 0x0b, modifiers: BASE, label: "Control+Option+B" },
    Shortcut { id: 41, key: 0x23, modifiers: BASE, label: "Control+Option+P" },
    Shortcut { id: 42, key: 0x01, modifiers: BASE, label: "Control+Option+S" },
    Shortcut { id: 43, key: 0x24, modifiers: BASE, label: "Control+Option+Return" },
    Shortcut { id: 44, key: 0x25, modifiers: BASE | SHIFT, label: "Control+Option+Shift+L" },
    Shortcut { id: 45, key: 0x0f, modifiers: BASE | SHIFT, label: "Control+Option+Shift+R" },
    Shortcut { id: 50, key: 0x0f, modifiers: BASE | COMMAND, label: "Control+Option+Command+R" },
    Shortcut { id: 51, key: 0x08, modifiers: BASE | COMMAND, label: "Control+Option+Command+C" },
    Shortcut { id: 52, key: 0x23, modifiers: BASE | COMMAND, label: "Control+Option+Command+P" },
    Shortcut { id: 53, key: 0x25, modifiers: BASE | COMMAND, label: "Control+Option+Command+L" },
    Shortcut { id: 54, key: 0x0f, modifiers: BASE | COMMAND | SHIFT, label: "Control+Option+Command+Shift+R" },
];

const VISIBLE: &[Shortcut] = &[
    Shortcut { id: 60, key: 0x7b, modifiers: BASE | SHIFT, label: "Control+Option+Shift+Left" },
    Shortcut { id: 61, key: 0x7c, modifiers: BASE | SHIFT, label: "Control+Option+Shift+Right" },
    Shortcut { id: 62, key: 0x7e, modifiers: BASE | SHIFT, label: "Control+Option+Shift+Up" },
    Shortcut { id: 63, key: 0x7d, modifiers: BASE | SHIFT, label: "Control+Option+Shift+Down" },
    Shortcut { id: 64, key: 0x7e, modifiers: BASE, label: "Control+Option+Up" },
    Shortcut { id: 65, key: 0x7d, modifiers: BASE, label: "Control+Option+Down" },
    Shortcut { id: 66, key: 0x7b, modifiers: BASE, label: "Control+Option+Left" },
    Shortcut { id: 67, key: 0x2a, modifiers: BASE, label: "Control+Option+Backslash" },
    Shortcut { id: 68, key: 0x1b, modifiers: BASE, label: "Control+Option+Minus" },
    Shortcut { id: 69, key: 0x18, modifiers: BASE, label: "Control+Option+Equal" },
];

static READY: AtomicBool = AtomicBool::new(false);
static EVENT_LOOP_WAKER: OnceLock<tao::event_loop::EventLoopProxy<()>> = OnceLock::new();
static OVERLAY_VISIBLE: AtomicBool = AtomicBool::new(false);
static CODING_VISIBLE: AtomicBool = AtomicBool::new(false);
static HISTORY_VISIBLE: AtomicBool = AtomicBool::new(false);
static VISIBLE_REFS: Mutex<Vec<usize>> = Mutex::new(Vec::new());

pub static START_BATCH: AtomicBool = AtomicBool::new(false);
pub static CAPTURE: AtomicBool = AtomicBool::new(false);
pub static CAPTURE_LEFT: AtomicBool = AtomicBool::new(false);
pub static CAPTURE_RIGHT: AtomicBool = AtomicBool::new(false);
pub static SUBMIT: AtomicBool = AtomicBool::new(false);
static MOVE_LEFT: AtomicBool = AtomicBool::new(false);
static MOVE_RIGHT: AtomicBool = AtomicBool::new(false);
static MOVE_UP: AtomicBool = AtomicBool::new(false);
static MOVE_DOWN: AtomicBool = AtomicBool::new(false);
static SCROLL_UP: AtomicBool = AtomicBool::new(false);
static SCROLL_DOWN: AtomicBool = AtomicBool::new(false);
static FADE_DOWN: AtomicBool = AtomicBool::new(false);
static FADE_UP: AtomicBool = AtomicBool::new(false);
static HISTORY_PREVIOUS: AtomicBool = AtomicBool::new(false);
static HISTORY_NEXT: AtomicBool = AtomicBool::new(false);
static HISTORY_OPEN: AtomicBool = AtomicBool::new(false);
static HISTORY_BACK: AtomicBool = AtomicBool::new(false);
static LANGUAGE_COMMAND: AtomicU8 = AtomicU8::new(0);
static CODE_FOCUS_COMMAND: AtomicU8 = AtomicU8::new(0);
static PANEL_COMMAND: AtomicU8 = AtomicU8::new(0);
static HISTORY_TOGGLE_COMMAND: AtomicBool = AtomicBool::new(false);
static NUMBER_COMMAND: AtomicU8 = AtomicU8::new(0);

extern "C" fn handle_hotkey(_next: *mut c_void, event: EventRef, _data: *mut c_void) -> i32 {
    let mut hotkey = EventHotKeyID::default();
    let status = unsafe {
        GetEventParameter(
            event, DIRECT_OBJECT, HOTKEY_ID_TYPE, ptr::null_mut(),
            std::mem::size_of::<EventHotKeyID>() as u32, ptr::null_mut(),
            (&mut hotkey as *mut EventHotKeyID).cast(),
        )
    };
    if status != 0 || hotkey.signature != SIGNATURE {
        return EVENT_NOT_HANDLED;
    }
    dispatch(hotkey.id);
    0
}

fn dispatch(id: u32) {
    match id {
        1 | 2 => PANEL_COMMAND.store(id as u8, Ordering::SeqCst),
        3 => HISTORY_TOGGLE_COMMAND.store(true, Ordering::SeqCst),
        6 | 20 | 22..=25 | 31..=33 | 35 => NUMBER_COMMAND.store(id as u8, Ordering::SeqCst),
        40 => START_BATCH.store(true, Ordering::SeqCst),
        41 | 42 => CAPTURE.store(true, Ordering::SeqCst),
        43 => SUBMIT.store(true, Ordering::SeqCst),
        44 => CAPTURE_LEFT.store(true, Ordering::SeqCst),
        45 => CAPTURE_RIGHT.store(true, Ordering::SeqCst),
        50..=52 => LANGUAGE_COMMAND.store((id - 49) as u8, Ordering::SeqCst),
        53 => CODE_FOCUS_COMMAND.store(2, Ordering::SeqCst),
        54 => CODE_FOCUS_COMMAND.store(3, Ordering::SeqCst),
        60 => MOVE_LEFT.store(true, Ordering::SeqCst),
        61 => MOVE_RIGHT.store(true, Ordering::SeqCst),
        62 => MOVE_UP.store(true, Ordering::SeqCst),
        63 => MOVE_DOWN.store(true, Ordering::SeqCst),
        64 if HISTORY_VISIBLE.load(Ordering::SeqCst) => HISTORY_PREVIOUS.store(true, Ordering::SeqCst),
        64 if CODING_VISIBLE.load(Ordering::SeqCst) => SCROLL_UP.store(true, Ordering::SeqCst),
        65 if HISTORY_VISIBLE.load(Ordering::SeqCst) => HISTORY_NEXT.store(true, Ordering::SeqCst),
        65 if CODING_VISIBLE.load(Ordering::SeqCst) => SCROLL_DOWN.store(true, Ordering::SeqCst),
        66 if HISTORY_VISIBLE.load(Ordering::SeqCst) => HISTORY_BACK.store(true, Ordering::SeqCst),
        67 if HISTORY_VISIBLE.load(Ordering::SeqCst) => HISTORY_OPEN.store(true, Ordering::SeqCst),
        68 => FADE_DOWN.store(true, Ordering::SeqCst),
        69 => FADE_UP.store(true, Ordering::SeqCst),
        _ => {}
    }
    if let Some(waker) = EVENT_LOOP_WAKER.get() {
        let _ = waker.send_event(());
    }
}

pub fn set_event_loop_waker(waker: tao::event_loop::EventLoopProxy<()>) {
    let _ = EVENT_LOOP_WAKER.set(waker);
}

fn register_shortcut(target: EventTargetRef, shortcut: Shortcut) -> Result<usize, String> {
    let mut reference = ptr::null_mut();
    let status = unsafe {
        RegisterEventHotKey(
            shortcut.key, shortcut.modifiers,
            EventHotKeyID { signature: SIGNATURE, id: shortcut.id },
            target, 0, &mut reference,
        )
    };
    if status != 0 || reference.is_null() {
        return Err(format!("{} could not be registered (Carbon status {status})", shortcut.label));
    }
    Ok(reference as usize)
}

pub fn register() -> Result<(), String> {
    let target = unsafe { GetApplicationEventTarget() };
    if target.is_null() {
        return Err("Carbon application event target is unavailable".into());
    }
    let event_type = EventTypeSpec { event_class: KEYBOARD_EVENT_CLASS, event_kind: HOTKEY_PRESSED };
    let mut handler = ptr::null_mut();
    let status = unsafe {
        InstallEventHandler(target, Some(handle_hotkey), 1, &event_type, ptr::null_mut(), &mut handler)
    };
    if status != 0 {
        return Err(format!("Could not install Carbon hotkey handler (status {status})"));
    }
    let mut refs = Vec::new();
    for shortcut in GLOBAL {
        match register_shortcut(target, *shortcut) {
            Ok(reference) => refs.push(reference),
            Err(error) => {
                for reference in refs {
                    unsafe { UnregisterEventHotKey(reference as EventHotKeyRef); }
                }
                return Err(error);
            }
        }
    }
    READY.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn hotkeys_ready() -> bool { READY.load(Ordering::SeqCst) }

pub fn set_overlay_visible(visible: bool) {
    if !READY.load(Ordering::SeqCst) || OVERLAY_VISIBLE.swap(visible, Ordering::SeqCst) == visible {
        return;
    }
    let Ok(mut refs) = VISIBLE_REFS.lock() else { return };
    if visible {
        let target = unsafe { GetApplicationEventTarget() };
        for shortcut in VISIBLE {
            match register_shortcut(target, *shortcut) {
                Ok(reference) => refs.push(reference),
                Err(error) => eprintln!("overlay shortcut unavailable: {error}"),
            }
        }
    } else {
        for reference in refs.drain(..) {
            unsafe { UnregisterEventHotKey(reference as EventHotKeyRef); }
        }
    }
}

pub fn set_coding_overlay_visible(value: bool) { CODING_VISIBLE.store(value, Ordering::SeqCst); }
pub fn set_history_visible(value: bool) { HISTORY_VISIBLE.store(value, Ordering::SeqCst); }
pub fn take_start_batch() -> bool { START_BATCH.swap(false, Ordering::SeqCst) }
pub fn take_capture() -> bool { CAPTURE.swap(false, Ordering::SeqCst) }
pub fn take_capture_left() -> bool { CAPTURE_LEFT.swap(false, Ordering::SeqCst) }
pub fn take_capture_right() -> bool { CAPTURE_RIGHT.swap(false, Ordering::SeqCst) }
pub fn take_submit() -> bool { SUBMIT.swap(false, Ordering::SeqCst) }
pub fn take_panel_command() -> u8 { PANEL_COMMAND.swap(0, Ordering::SeqCst) }
pub fn take_history_toggle_command() -> bool { HISTORY_TOGGLE_COMMAND.swap(false, Ordering::SeqCst) }
pub fn take_move_left() -> bool { MOVE_LEFT.swap(false, Ordering::SeqCst) }
pub fn take_move_right() -> bool { MOVE_RIGHT.swap(false, Ordering::SeqCst) }
pub fn take_move_up() -> bool { MOVE_UP.swap(false, Ordering::SeqCst) }
pub fn take_move_down() -> bool { MOVE_DOWN.swap(false, Ordering::SeqCst) }
pub fn take_scroll_up() -> bool { SCROLL_UP.swap(false, Ordering::SeqCst) }
pub fn take_scroll_down() -> bool { SCROLL_DOWN.swap(false, Ordering::SeqCst) }
pub fn take_number_command() -> u8 { NUMBER_COMMAND.swap(0, Ordering::SeqCst) }
pub fn take_code_focus_command() -> u8 { CODE_FOCUS_COMMAND.swap(0, Ordering::SeqCst) }
pub fn take_fade_down() -> bool { FADE_DOWN.swap(false, Ordering::SeqCst) }
pub fn take_fade_up() -> bool { FADE_UP.swap(false, Ordering::SeqCst) }
pub fn take_history_previous() -> bool { HISTORY_PREVIOUS.swap(false, Ordering::SeqCst) }
pub fn take_history_next() -> bool { HISTORY_NEXT.swap(false, Ordering::SeqCst) }
pub fn take_history_open() -> bool { HISTORY_OPEN.swap(false, Ordering::SeqCst) }
pub fn take_history_back() -> bool { HISTORY_BACK.swap(false, Ordering::SeqCst) }
pub fn take_language_command() -> u8 { LANGUAGE_COMMAND.swap(0, Ordering::SeqCst) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn shortcuts_are_unique_and_require_control_and_option() {
        let mut ids = HashSet::new();
        let mut combinations = HashSet::new();
        for shortcut in GLOBAL.iter().chain(VISIBLE.iter()) {
            assert_eq!(shortcut.modifiers & BASE, BASE, "{}", shortcut.label);
            assert!(ids.insert(shortcut.id), "duplicate ID: {}", shortcut.label);
            assert!(combinations.insert((shortcut.key, shortcut.modifiers)), "duplicate keys: {}", shortcut.label);
        }
    }
}
