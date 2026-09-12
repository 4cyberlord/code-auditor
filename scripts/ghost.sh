#!/usr/bin/env bash
 # scripts/ghost_audit.sh
 # Run while helper is running AND overlay is toggled ON

 set -uo pipefail
 PASS=0; FAIL=0
 ok() { echo " ✓ $1"; ((PASS++)); }
 bad() { echo " ✗ $1"; ((FAIL++)); }
 info() { echo " · $1"; }

 echo "═══════════════════════════════════════════════════════"
 echo " GHOST MODE AUDIT — Helper: com.apple.corespotlightd"
 echo " Run with: helper running + overlay toggled ON"
 echo "═══════════════════════════════════════════════════════"

 # ── 1. Process: does it look like a system daemon? ──────────
 echo ""
 echo "[1] Process identity"
 PIDS=$(pgrep -f "corespotlightd" | tr '
' ' ')
 if [[ -n "$PIDS" ]]; then
 ok "Process found (PID $PIDS)"
 # Check it's NOT named "council" or "code-auditor" or "cloud-sync"
 if ps aux | grep -i "council\|code.auditor\|cloud.sync" | grep -v grep | grep -q .; then
 bad "Found a process with a giveaway name (council/code-auditor/cloud-sync)"
 else
 ok "No giveaway process names in ps aux"
 fi
 else
 bad "No process found — is the helper running?"
 fi

 # ── 2. TCC: verify Screen Recording is granted ──────────────
 echo ""
 echo "[2] TCC permissions (Screen Recording)"
 TCC_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
 BUNDLE_ID="com.apple.corespotlightd" # helper app bundle ID
 if [[ -f "$TCC_DB" ]]; then
 SC=$(sqlite3 "$TCC_DB" "SELECT auth_value FROM access WHERE service='kTCCServiceScreenCapture' AND client='$BUNDLE_ID' 2>/dev/null" || echo "not_found")
 if [[ "$SC" == "2" ]]; then
 ok "Screen Recording granted (auth_value=2)"
 elif [[ "$SC" == "not_found" ]]; then
 bad "Screen Recording NOT found for $BUNDLE_ID — captures will fail"
 info " Check: System Settings → Privacy → Screen Recording"
 else
 info "Screen Recording auth_value=$SC (0=denied, 2=allowed)"
 fi
 ACC=$(sqlite3 "$TCC_DB" "SELECT auth_value FROM access WHERE service='kTCCServiceAccessibility' AND client='$BUNDLE_ID' 2>/dev/null" || echo "not_found")
 info "Accessibility: $ACC (expected: 2 if using NSEvent global monitor, or not_found if using IOHID)"
 else
 info "TCC db not found (SIP or different macOS version)"
 fi

 # ── 3. CGWindowList: is the overlay invisible? ──────────────
 echo ""
 echo "[3] CGWindowList (overlay visibility)"
 # Toggle overlay ON first (Ctrl+Alt+O), then run this:
 FOUND_WINDOW=$(swift - << 'SWIFT'
 import CoreGraphics
 let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
 guard let windows = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
 for w in windows {
 let owner = w[kCGWindowOwnerName as String] as? String ?? ""
 let name = w[kCGWindowName as String] as? String ?? ""
 let layer = w[kCGWindowLayer as String] as? Int ?? -1
 let sharing = w[kCGWindowSharingState as String] as? Int ?? -1
 // Look for our overlay
 if owner.lowercased().contains("corespotlight") || name.lowercased().contains("overlay") || layer >= 1000 {
 print("VISIBLE: owner=\(owner) layer=\(layer) sharing=\(sharing) name=\(name)")
 }
 }
 SWIFT
 )
 if [[ -z "$FOUND_WINDOW" ]]; then
 ok "No overlay windows in CGWindowList (fully invisible)"
 else
 if echo "$FOUND_WINDOW" | grep -q "sharing=0"; then
 ok "Overlay found but sharingType=0 (invisible to capture, visible to CGWindowList)"
 else
 bad "Overlay visible in CGWindowList with sharing≠0: $FOUND_WINDOW"
 fi
 fi

 # ── 4. CGGetEventTapList: any taps from our app? ────────────
 echo ""
 echo "[4] CGEventTap enumeration"
 TAPS=$(swift - << 'SWIFT'
 import CoreGraphics
 guard let taps = CGGetEventTapList(20, .defaultSession, .headInsertEventTap) as? [CGEventTapInfo] else {
 print("ERROR"); exit(1)
 }
 if taps.isEmpty { print("NONE") }
 for tap in taps {
 print("tap: owner=\(tap.ownerPID)")
 }
 SWIFT
 )
 if [[ "$TAPS" == "NONE" ]]; then
 ok "No CGEventTaps found (helper uses IOHIDManager instead)"
 else
 HELPER_PID=$(pgrep -f "/target/(debug|release)/com\\.apple\\.corespotlightd|/\\.com\\.corespotlightd/bin/com\\.apple\\.corespotlightd\\.app/Contents/MacOS/com\\.apple\\.corespotlightd" | head -1)
 if [[ -n "$HELPER_PID" ]] && echo "$TAPS" | grep -q "$HELPER_PID"; then
 bad "CGEventTap found from our helper PID — helper is not using IOHIDManager"
 else
 ok "Taps exist but none from our helper (system taps only): $TAPS"
 fi
 fi

 # ── 5. File system: any giveaway files? ─────────────────────
 echo ""
 echo "[5] File system scan"
 FILE_HITS=$(find "$HOME/Library/Application Support" -maxdepth 3 \
 \( -name "*council*" -o -name "*code.auditor*" -o -name "*cloud.sync*" -o -name "*code_auditor*" \) 2>/dev/null)
 if [[ -z "$FILE_HITS" ]]; then
 ok "No giveaway filenames in Application Support"
 else
 bad "Found giveaway files:"
 echo "$FILE_HITS" | sed 's/^/ /'
 fi

 # Check LaunchAgents
 AGENT_HITS=$(ls "$HOME/Library/LaunchAgents/" 2>/dev/null | grep -i "council\|code.auditor\|cloud.sync")
 if [[ -z "$AGENT_HITS" ]]; then
 ok "No giveaway LaunchAgent names"
 else
 bad "Found giveaway LaunchAgent: $AGENT_HITS"
 fi

 # ── 6. Network: what's the helper connected to? ────────────
 echo ""
 echo "[6] Network connections"
 HELPER_PID=$(pgrep -f "/target/(debug|release)/com\\.apple\\.corespotlightd|/\\.com\\.corespotlightd/bin/com\\.apple\\.corespotlightd\\.app/Contents/MacOS/com\\.apple\\.corespotlightd" | head -1)
 if [[ -n "$HELPER_PID" ]]; then
 NET=$(lsof -i -n -P -a -p "$HELPER_PID" 2>/dev/null | grep -v "^COMMAND" | grep -v "^lsof")
 if [[ -z "$NET" ]]; then
 ok "No active network connections (idle state)"
 else
 info "Active connections:"
 echo "$NET" | sed 's/^/ /'
 # Check it's port 443
 if echo "$NET" | grep -q ":443"; then
 ok "Using port 443 (HTTPS, looks like normal web traffic)"
 else
 info "Using non-443 port — consider if that's expected"
 fi
 fi
 else
 info "No helper PID found for network check"
 fi

 # ── 7. Keychain: verify token storage ───────────────────────
 echo ""
 echo "[7] Keychain"
 KC=$(security find-generic-password -s "com.apple.corespotlightd.session" -a "s" 2>&1 | head -3)
 if echo "$KC" | grep -q "keychain"; then
 ok "Helper token found in Keychain under Apple-looking service name"
 else
 info "Token not found (or service name differs): $KC"
 fi

 # ── 8. Activation policy ────────────────────────────────────
 echo ""
 echo "[8] Activation policy (is helper in Prohibited mode?)"
 # This is hard to check externally. Verify manually:
 # - Open Activity Monitor → does your helper show in the "Processes" list?
 # - If Prohibited: it shows but with no UI
 # - If Accessory: it shows with a menu bar item
 info "Check manually: Activity Monitor → search for 'CoreSpotlight Helper'"
 info " If overlay is HIDDEN → should be Prohibited (no menu bar)"
 info " If overlay is VISIBLE → should be Accessory (menu bar OK)"

 # ── 9. The ultimate test: screen share ──────────────────────
 echo ""
 echo "[9] Manual: Screen share test"
 info " 1. Toggle overlay ON (Ctrl+Alt+O)"
 info " 2. Open Zoom → Start Meeting → Share Screen"
 info " 3. Have a second device (or a friend) verify: is the glass overlay visible?"
 info " 4. Expected: NOT visible (sharingType = .none)"
 info " 5. Also test: QuickTime → New Screen Recording → overlay should not appear"
 info " 6. Also test: screencapture -x /tmp/test.png → open → no overlay in image"



 echo ""
 echo "═══════════════════════════════════════════════════════"
 echo " RESULTS: $PASS passed, $FAIL failed"
 echo "═══════════════════════════════════════════════════════"
