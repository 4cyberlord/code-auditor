//! Screen capture.
//!
//! macOS already ships the hard part: `screencapture -i` gives the same crosshair
//! selection as Cmd-Shift-4, including window snapping and Escape to abort. We
//! shell out to it rather than reimplementing region selection, and hand the
//! frontend both a data URL and the path we wrote.
//!
//! A file rather than the clipboard, deliberately: going through the pasteboard
//! would clobber whatever the user had copied.
//!
//! The file is kept, in `~/Library/Application Support/.com.apple.mds/cache/captures`, rather than written to /tmp and
//! deleted. A capture that exists only as a base64 string in a webview is
//! invisible when something downstream fails -- you cannot tell "the grab never
//! happened" from "the grab happened and the UI dropped it". On disk, you can.

use std::path::{Path, PathBuf};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding. Hand-rolled to keep a dependency out of the
/// tree for what is twelve lines of arithmetic.
fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b1 = chunk[0] as u32;
        let b2 = *chunk.get(1).unwrap_or(&0) as u32;
        let b3 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b1 << 16) | (b2 << 8) | b3;
        out.push(B64[(n >> 18 & 63) as usize] as char);
        out.push(B64[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// What a successful grab produces: the bytes for the panes, and the file on disk
/// so the user can confirm with their own eyes that it happened.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub data_url: String,
    pub path: String,
}

/// What the grab covers.
///
/// Region is the crosshair, and needs the user to drag. Screen takes the whole
/// display with no interaction at all -- which is the one you want when the
/// problem is already on screen and you would rather not aim at it.
#[derive(Clone, Copy)]
pub enum Mode {
    Region,
    Screen,
    LeftHalf(Rect),
    RightHalf(Rect),
}

#[derive(Clone, Copy)]
pub(crate) struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Mode {
    fn flags(self) -> Vec<String> {
        match self {
            // -i interactive crosshair, same as Cmd-Shift-4. -x no shutter sound.
            Mode::Region => vec!["-i".into(), "-x".into()],
            // No -i: grab the main display immediately and silently.
            Mode::Screen => vec!["-x".into()],
            Mode::LeftHalf(rect) | Mode::RightHalf(rect) => vec![
                "-x".into(),
                format!("-R{},{},{},{}", rect.x, rect.y, rect.width, rect.height),
            ],
        }
    }
    fn label(self) -> &'static str {
        match self {
            Mode::Region => "capture_selection",
            Mode::Screen => "capture_screen",
            Mode::LeftHalf(_) => "capture_left_half",
            Mode::RightHalf(_) => "capture_right_half",
        }
    }

    fn is_interactive(self) -> bool {
        matches!(self, Mode::Region)
    }
}

fn dispatch(mode: Mode) -> Result<Option<Vec<Capture>>, String> {
    crate::trace(&format!("{} invoked", mode.label()));
    let out = capture_blocking(mode);
    crate::trace(&match &out {
        // One capture can now be several files -- one per display, minus any
        // that turned out to be a mirror of one already taken. The log records
        // all of them, because "which screens did it actually grab" is the first
        // question when a capture comes back looking wrong.
        Ok(Some(shots)) => format!(
            "{} -> saved {} file(s): {}",
            mode.label(),
            shots.len(),
            shots
                .iter()
                .map(|c| c.path.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Ok(None) => format!("{} -> cancelled (Escape, or no selection)", mode.label()),
        Err(e) => format!("{} -> error: {e}", mode.label()),
    });
    out
}

/// Interactive region capture.
///
/// Returns `Ok(None)` when the user cancels, which is an ordinary outcome and
/// not an error: `screencapture` exits non-zero and writes nothing on Escape.
#[tauri::command]
pub async fn capture_selection() -> Result<Option<Vec<Capture>>, String> {
    crate::auth::require()?;
    // `screencapture` blocks until the user finishes selecting, so it must not
    // run on an async runtime thread.
    tauri::async_runtime::spawn_blocking(|| dispatch(Mode::Region))
        .await
        .map_err(|e| format!("Capture task failed: {e}"))?
}

/// Whole-display capture, with no crosshair and nothing to aim.
#[tauri::command]
pub async fn capture_screen() -> Result<Option<Vec<Capture>>, String> {
    crate::auth::require()?;
    tauri::async_runtime::spawn_blocking(|| dispatch(Mode::Screen))
        .await
        .map_err(|e| format!("Capture task failed: {e}"))?
}

/// Captures the left half of the display containing the Council Editor window.
#[tauri::command]
pub async fn capture_left_half(
    window: tauri::WebviewWindow,
) -> Result<Option<Vec<Capture>>, String> {
    capture_window_half(window, Half::Left).await
}

/// Captures the right half of the display containing the Council Editor window.
#[tauri::command]
pub async fn capture_right_half(
    window: tauri::WebviewWindow,
) -> Result<Option<Vec<Capture>>, String> {
    capture_window_half(window, Half::Right).await
}

#[derive(Clone, Copy)]
enum Half {
    Left,
    Right,
}

async fn capture_window_half(
    window: tauri::WebviewWindow,
    half: Half,
) -> Result<Option<Vec<Capture>>, String> {
    crate::auth::require()?;
    let monitor = window
        .current_monitor()
        .map_err(|e| format!("Could not determine the Council Editor display: {e}"))?
        .ok_or("Could not determine the display containing Council Editor.")?;
    let size = monitor.size();
    if size.width < 2 || size.height == 0 {
        return Err("The current display is too small to split into left and right captures.".into());
    }
    let position = monitor.position();
    let left_width = size.width / 2;
    let rect = Rect {
        x: if matches!(half, Half::Left) {
            position.x
        } else {
            position.x + left_width as i32
        },
        y: position.y,
        width: if matches!(half, Half::Left) {
            left_width
        } else {
            size.width - left_width
        },
        height: size.height,
    };
    let mode = if matches!(half, Half::Left) {
        Mode::LeftHalf(rect)
    } else {
        Mode::RightHalf(rect)
    };
    tauri::async_runtime::spawn_blocking(move || dispatch(mode))
        .await
        .map_err(|e| format!("Capture task failed: {e}"))?
}

/// Reads a capture back off disk.
///
/// Returns `Ok(None)` when the file is gone rather than an error: a screenshot
/// can be purged deliberately, or moved, and a session whose images no longer
/// exist should still open and read correctly instead of failing to load.
#[tauri::command]
pub async fn read_capture(path: String) -> Result<Option<Capture>, String> {
    crate::auth::require()?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if !p.exists() {
            return Ok(None);
        }
        let bytes = std::fs::read(p).map_err(|e| format!("Could not read {path}: {e}"))?;
        if bytes.is_empty() {
            return Ok(None);
        }
        let mime = match p.extension().and_then(|e| e.to_str()) {
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("webp") => "image/webp",
            Some("gif") => "image/gif",
            _ => "image/png",
        };
        Ok(Some(Capture {
            data_url: format!("data:{};base64,{}", mime, base64(&bytes)),
            path: path.clone(),
        }))
    })
    .await
    .map_err(|e| format!("Read task failed: {e}"))?
}

/// Where captures land, alongside the other local support files.
#[cfg(target_os = "macos")]
/// Every file `screencapture` wrote for this run, in display order.
///
/// With more than one display attached, `screencapture` does not capture the one
/// you are looking at -- it captures them all, writing the first to the path you
/// asked for and each additional one alongside it with a number appended. Reading
/// only the requested path therefore returns the *main* display, which on a desk
/// with an external monitor is usually the wrong screen and is silently wrong:
/// you get a perfectly good screenshot of something you were not looking at.
///
/// The exact suffix has varied between macOS releases, so this matches on the
/// stem rather than assuming a format, and sorts so display order is stable.
fn siblings_of(path: &Path) -> Vec<PathBuf> {
    let Some(dir) = path.parent() else {
        return vec![path.to_path_buf()];
    };
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return vec![path.to_path_buf()];
    };

    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().and_then(|x| x.to_str()) == Some("png")
                        && p.file_stem().and_then(|s| s.to_str()).is_some_and(|s| {
                            s == stem
                                || s.starts_with(&format!("{stem} "))
                                || s.starts_with(&format!("{stem}-"))
                        })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    found.sort();
    if found.is_empty() {
        found.push(path.to_path_buf());
    }
    found
}

/// FNV-1a over the file's bytes.
///
/// Only ever compared against other captures taken in the same instant, so it
/// needs to catch "these two files are the same picture" and nothing more. A
/// cryptographic hash would be a dependency and a lot of work for a question
/// this small.
fn fingerprint(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

#[cfg(test)]
mod capture_file_tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ca-sib-{tag}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_single_display_returns_just_its_file() {
        let d = scratch("one");
        let p = d.join("capture-123.png");
        fs::write(&p, b"x").unwrap();
        assert_eq!(siblings_of(&p), vec![p]);
    }

    #[test]
    fn extra_displays_are_found_whatever_the_suffix() {
        // The suffix has varied between macOS releases, so both shapes count.
        let d = scratch("many");
        let p = d.join("capture-123.png");
        for name in ["capture-123.png", "capture-123 1.png", "capture-123-2.png"] {
            fs::write(d.join(name), b"x").unwrap();
        }
        let got = siblings_of(&p);
        assert_eq!(got.len(), 3, "{got:?}");
        let mut sorted = got.clone();
        sorted.sort();
        assert_eq!(
            got, sorted,
            "display order must be stable, not filesystem order"
        );
    }

    #[test]
    fn a_different_capture_is_not_swept_up() {
        // `capture-1234` is a later capture, not a second display of
        // `capture-123`. Matching on the bare prefix would attach someone's
        // previous screenshot to this run.
        let d = scratch("other");
        let p = d.join("capture-123.png");
        fs::write(&p, b"x").unwrap();
        fs::write(d.join("capture-1234.png"), b"x").unwrap();
        fs::write(d.join("capture-999.png"), b"x").unwrap();
        assert_eq!(siblings_of(&p), vec![p]);
    }

    #[test]
    fn non_png_files_are_ignored() {
        let d = scratch("mixed");
        let p = d.join("capture-123.png");
        fs::write(&p, b"x").unwrap();
        fs::write(d.join("capture-123.txt"), b"x").unwrap();
        assert_eq!(siblings_of(&p), vec![p]);
    }

    #[test]
    fn a_missing_directory_still_returns_the_path_asked_for() {
        let p = PathBuf::from("/nonexistent/place/capture-1.png");
        assert_eq!(siblings_of(&p), vec![p]);
    }
}

#[cfg(test)]
mod fingerprint_tests {
    use super::{fingerprint, reading_path};
    use std::path::Path;

    #[test]
    fn the_same_bytes_fingerprint_the_same() {
        assert_eq!(
            fingerprint(b"mirrored screen"),
            fingerprint(b"mirrored screen")
        );
    }

    #[test]
    fn a_single_changed_byte_is_a_different_picture() {
        assert_ne!(fingerprint(b"screen a"), fingerprint(b"screen b"));
    }

    #[test]
    fn length_alone_does_not_decide_it() {
        assert_ne!(fingerprint(b"ab"), fingerprint(b"ba"));
    }

    #[test]
    fn a_reading_is_named_after_its_capture() {
        let dir = Path::new("/tmp/Council Editor");
        let got = reading_path(dir, Some("capture-1756000000000.png"), 7);
        assert_eq!(got, dir.join("capture-1756000000000.reading.md"));
    }

    #[test]
    fn a_pasted_image_gets_a_timestamped_name() {
        let dir = Path::new("/tmp/Council Editor");
        assert_eq!(reading_path(dir, None, 7), dir.join("reading-7.md"));
    }

    #[test]
    fn only_a_bare_file_name_is_accepted() {
        // The whole point: the webview cannot aim this at anything it likes.
        let dir = Path::new("/tmp/Council Editor");
        for hostile in [
            "/etc/passwd",
            "../../etc/crontab",
            "..",
            "nested/shot.png",
            "/tmp/Council Editor/capture-1.png",
            "~/.ssh/authorized_keys/x",
            "",
            ".",
        ] {
            let got = reading_path(dir, Some(hostile), 7);
            assert_eq!(got, dir.join("reading-7.md"), "accepted {hostile:?}");
        }
    }

    #[test]
    fn a_name_with_dots_in_it_still_works() {
        // "my.screen.shot.png" has a perfectly good stem; only separators and
        // parent segments are the problem.
        let dir = Path::new("/tmp/Council Editor");
        assert_eq!(
            reading_path(dir, Some("my.screen.shot.png"), 7),
            dir.join("my.screen.shot.reading.md")
        );
    }

    #[test]
    fn empty_is_stable() {
        assert_eq!(fingerprint(b""), fingerprint(b""));
    }
}

/// Where a reading of the capture named `near` belongs.
///
/// Split out and pure so the rule can be tested without touching a disk.
///
/// `near` is a bare file name, never a path. It arrives from the webview, and a
/// command that writes to any path the webview names is a file-write primitive
/// wearing a helpful hat -- so the directory is decided here and the caller only
/// gets to influence the *stem*. Anything with a separator, a parent segment or
/// no usable stem falls back to a timestamped name in the same directory, which
/// is a duller file name and not a security problem.
fn reading_path(dir: &Path, near: Option<&str>, stamp: u128) -> PathBuf {
    if let Some(n) = near {
        let candidate = Path::new(n);
        let single = candidate.components().count() == 1;
        if single && !n.contains("..") {
            if let Some(stem) = candidate.file_stem().and_then(|s| s.to_str()) {
                if !stem.is_empty() {
                    // `capture-1756000000000.png` -> `capture-1756000000000.reading.md`,
                    // so the pair sorts together in Finder and it is obvious at a
                    // glance which picture a reading belongs to.
                    return dir.join(format!("{stem}.reading.md"));
                }
            }
        }
    }
    dir.join(format!("reading-{stamp}.md"))
}

/// Writes the Markdown reading of a screenshot next to the screenshot.
///
/// The reading is the artefact that outlives the run. A screenshot only reaches a
/// model whose route carries images, and this project has watched two routes fail
/// to carry one; text has no such requirement. Keeping the reading on disk beside
/// the picture means the transcription can be read, corrected and re-fed by hand
/// when a model gets it wrong -- which is the difference between a black box and
/// something you can debug.
#[tauri::command]
pub fn save_reading(markdown: String, near: Option<String>) -> Result<String, String> {
    crate::auth::require()?;
    use std::time::{SystemTime, UNIX_EPOCH};

    if markdown.trim().is_empty() {
        return Err("Nothing to save: the reading is empty.".into());
    }

    let dir = capture_dir()?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = reading_path(&dir, near.as_deref(), stamp);

    std::fs::write(&path, markdown)
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

fn capture_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("No HOME in the environment")?;
    let dir = std::path::Path::new(&home)
        .join("Library")
        .join("Application Support")
        .join(".com.apple.mds")
        .join("cache")
        .join("captures");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

#[cfg(target_os = "macos")]
fn capture_blocking(mode: Mode) -> Result<Option<Vec<Capture>>, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let dir = capture_dir()?;
    // Milliseconds, not seconds: two interactive drags cannot finish in the same
    // millisecond, so a capture can never silently overwrite the one before it.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("capture-{stamp}.png"));

    let out = std::process::Command::new("/usr/sbin/screencapture")
        .args(mode.flags())
        .arg(&path)
        .output()
        .map_err(|e| format!("Could not run screencapture: {e}"))?;

    if !out.status.success() || !path.exists() {
        let _ = std::fs::remove_file(&path);

        // Escape and "macOS refused" both exit non-zero with no file written, so
        // the exit code cannot tell them apart -- and reporting a refusal as a
        // cancel is what makes a broken hotkey look like a dead key. stderr is
        // the difference: a cancel is silent, a refusal explains itself.
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !mode.is_interactive() && stderr.is_empty() {
            // Nothing to cancel in this mode, so an empty-handed exit is a
            // refusal that simply did not explain itself.
            return Err(
                "screencapture produced nothing. This is almost always a missing Screen \
                 Recording permission -- grant it in System Settings > Privacy & Security > \
                 Screen & System Audio Recording, then restart the app."
                    .into(),
            );
        }
        if !stderr.is_empty() {
            return Err(format!(
                "screencapture refused: {stderr}. This is usually a missing Screen \
                 Recording permission -- grant it in System Settings > Privacy & \
                 Security > Screen & System Audio Recording, then restart the app."
            ));
        }
        return Ok(None);
    }

    // Every display, not just the main one. A second monitor is captured too,
    // and it was previously written to disk and then ignored -- so the app both
    // returned the wrong screen and quietly littered the folder with the right
    // one.
    let mut shots = Vec::new();
    let mut seen: Vec<u64> = Vec::new();
    for file in siblings_of(&path) {
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        if bytes.is_empty() {
            // Do not leave a zero-byte file to be mistaken later for a capture
            // that worked.
            let _ = std::fs::remove_file(&file);
            continue;
        }

        // Mirrored displays show the same thing, and `screencapture` still writes
        // a file for each of them. Sending both would double the image bill of
        // every run to say the same thing twice, so identical content is kept
        // once and the duplicate file is cleaned up rather than left behind.
        let digest = fingerprint(&bytes);
        if seen.contains(&digest) {
            let _ = std::fs::remove_file(&file);
            continue;
        }
        seen.push(digest);

        shots.push(Capture {
            data_url: format!("data:image/png;base64,{}", base64(&bytes)),
            path: file.to_string_lossy().into_owned(),
        });
    }

    if shots.is_empty() {
        return Ok(None);
    }
    Ok(Some(shots))
}

#[cfg(not(target_os = "macos"))]
fn capture_blocking(_mode: Mode) -> Result<Option<Vec<Capture>>, String> {
    Err("Screen capture is only wired up for macOS in this build.".into())
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_matches_the_reference_vectors() {
        // RFC 4648 section 10, which pins every padding case.
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_covers_the_whole_alphabet() {
        let all: Vec<u8> = (0u8..=255).collect();
        let encoded = base64(&all);
        assert_eq!(encoded.len(), 344);
        assert!(encoded.starts_with("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g"));
        assert!(encoded.ends_with("+/w=="));
    }
}
