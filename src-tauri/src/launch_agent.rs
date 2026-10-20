//! Background identity for the app.
//!
//! A launchd `LaunchAgent` is what makes this look like the resident login-item
//! style helper that macOS actually expects: the process is started by
//! `launchd` (parent PID 1) rather than by a terminal or Finder, it starts at
//! login, and `KeepAlive` brings it back after an unexpected death — including
//! an external `SIGKILL`.
//!
//! `SuccessfulExit: false` is deliberate. A tray Quit exits 0 after booting the
//! job out, so quitting stays quiet, while a crash or kill is restarted.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

const LABEL: &str = "com.apple.ActivityMonitor.agent";

fn uid() -> u32 {
    unsafe { libc::getuid() }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn plist_path() -> Option<PathBuf> {
    home().map(|home| {
        home.join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist"))
    })
}

fn log_path() -> Option<PathBuf> {
    home().map(|home| {
        home.join("Library/Logs")
            .join("Activity Monitor")
            .join("agent.log")
    })
}

fn domain() -> String {
    format!("gui/{}", uid())
}

fn service() -> String {
    format!("{}/{}", domain(), LABEL)
}

fn launchctl(args: &[&str]) -> Result<(), String> {
    let output = Command::new("/bin/launchctl")
        .args(args)
        .output()
        .map_err(|e| format!("Could not run launchctl: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "launchctl {} failed: {}",
        args.join(" "),
        stderr.trim()
    ))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// True when this process was re-parented onto launchd, which is the state the
/// agent exists to produce.
pub fn launched_by_launchd() -> bool {
    let ppid = unsafe { libc::getppid() };
    ppid == 1
}

pub fn is_installed() -> bool {
    plist_path().is_some_and(|path| path.exists())
}

pub fn is_loaded() -> bool {
    let service = service();
    Command::new("/bin/launchctl")
        .args(["print", service.as_str()])
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Install and load the agent, then detach this process from whatever started
/// it. Returns `Ok(true)` when the running instance came from launchd already
/// and no restart is needed.
pub fn enable() -> Result<bool, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Could not resolve the app executable: {e}"))?;

    let plist = plist_path().ok_or("HOME is not set; cannot locate LaunchAgents.")?;
    let log = log_path().ok_or("HOME is not set; cannot locate the log directory.")?;

    if let Some(dir) = plist.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create LaunchAgents: {e}"))?;
    }
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create the log directory: {e}"))?;
    }

    let body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>
"#,
        label = LABEL,
        exe = xml_escape(&exe.to_string_lossy()),
        log = xml_escape(&log.to_string_lossy()),
    );

    fs::write(&plist, body).map_err(|e| format!("Could not write the LaunchAgent: {e}"))?;

    let loaded = service();
    let domain = domain();
    let plist_arg = plist.to_string_lossy();
    let _ = launchctl(&["bootout", loaded.as_str()]);
    launchctl(&["bootstrap", domain.as_str(), plist_arg.as_ref()])
        .or_else(|_| launchctl(&["load", "-w", plist_arg.as_ref()]))?;

    Ok(launched_by_launchd())
}

/// Unload and remove the agent. Safe to call when nothing is installed.
pub fn disable() -> Result<(), String> {
    let loaded = service();
    let _ = launchctl(&["bootout", loaded.as_str()]);
    if let Some(plist) = plist_path() {
        if plist.exists() {
            fs::remove_file(&plist)
                .map_err(|e| format!("Could not remove the LaunchAgent: {e}"))?;
        }
    }
    Ok(())
}

/// Quit path: drop the job first so launchd does not restart the exit.
pub fn detach() {
    let loaded = service();
    let _ = launchctl(&["bootout", loaded.as_str()]);
}

pub fn describe() -> &'static str {
    if is_installed() {
        "Run at Login: On"
    } else {
        "Run at Login: Off"
    }
}

/// Scriptable forms of the tray toggle, so installers and smoke tests can
/// manage the agent without driving the UI. Returns `None` for an unrelated
/// argument, which lets the caller fall through to the normal app start.
pub fn cli() -> Option<i32> {
    let arg = std::env::args().nth(1)?;
    match arg.as_str() {
        "--agent-install" => match enable() {
            Ok(true) => {
                println!("agent loaded; this process is already launchd-managed");
                Some(0)
            }
            Ok(false) => {
                println!("agent loaded; the current process must exit for launchd to take over");
                Some(0)
            }
            Err(error) => {
                eprintln!("{error}");
                Some(1)
            }
        },
        "--agent-remove" => match disable() {
            Ok(()) => {
                println!("agent removed");
                Some(0)
            }
            Err(error) => {
                eprintln!("{error}");
                Some(1)
            }
        },
        "--agent-status" => {
            println!(
                "installed={} loaded={} launchd_child={}",
                is_installed(),
                is_loaded(),
                launched_by_launchd()
            );
            Some(0)
        }
        _ => None,
    }
}
