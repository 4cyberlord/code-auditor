#!/usr/bin/env bash
 #
 # ═══════════════════════════════════════════════════════════════
 # GHOST DETECTIVE — Ultimate Invisibility Audit
 # Target: com.apple.corespotlightd
 # Duration: ~5 minutes
 # Usage:
 # 1. chmod +x scripts/ghost_detective.sh
 # 2. ./scripts/ghost_detective.sh
 # 3. Within 30s, LAUNCH YOUR APP (cargo tauri dev)
 # 4. At ~2min mark, press Ctrl+Alt+O to toggle overlay ON
 # 5. At ~3min mark, press Ctrl+Alt+B to start a batch
 # 6. At ~3.5min, press Ctrl+Alt+P to capture
 # 7. Let the script finish. Read the report.
 #
 # You can also pass your bundle ID:
 # ./scripts/ghost_detective.sh com.apple.corespotlightd
 #
 set -uo pipefail

 # ─── CONFIG ───────────────────────────────────────────────────────
 BUNDLE_ID="${1:-com.apple.corespotlightd}"
 # The helper now builds and installs as "com.apple.corespotlightd".
 DEV_PROCESS_NAME="com.apple.corespotlightd"
 RELEASE_PROCESS_NAME="com.apple.corespotlightd"
 PROCESS_PATTERN="com\.apple\.corespotlightd"

 # Paths
 APP_SUPPORT="$HOME/Library/Application Support"
 OLD_COUNCIL_DIR="$APP_SUPPORT/.council"
 COM_APPLE_DIR="$APP_SUPPORT/.com.apple.corespotlightd"
 LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
 TMP_DIR="/tmp"

 # Duration
 TOTAL_DURATION=300 # 5 minutes in seconds

 # Colors
 RED='\033[0;31m'
 GREEN='\033[0;32m'
 YELLOW='\033[1;33m'
 CYAN='\033[0;36m'
 MAGENTA='\033[0;35m'
 BOLD='\033[1m'
 DIM='\033[2m'
 NC='\033[0m'

 # Counters
 PASS=0
 FAIL=0
 WARN=0
 INFO=0
 CHECKS=()

 ok() { echo -e " ${GREEN}✓${NC} $1"; ((PASS++)); CHECKS+=("PASS|$1"); }
 bad() { echo -e " ${RED}✗${NC} $1"; ((FAIL++)); CHECKS+=("FAIL|$1"); }
 warn() { echo -e " ${YELLOW}⚠${NC} $1"; ((WARN++)); CHECKS+=("WARN|$1"); }
 info() { echo -e " ${DIM}·${NC} $1"; ((INFO++)); }
 section() { echo -e "
${CYAN}${BOLD}━━━ $1 ━━━${NC}"; }
 phase() { echo -e "
${MAGENTA}${BOLD}╔════ PHASE $1 ════╗${NC}"; }

 # ─── HELPERS ──────────────────────────────────────────────────────
 get_pid() {
 pgrep -f "$1" 2>/dev/null | head -1 || true
 }

 get_all_pids() {
 pgrep -f "$1" 2>/dev/null || true
 }

 # ─── PHASE 0: BASELINE (0-30s) ───────────────────────────────────
 phase "0 — BASELINE SCAN (before app launch)"
 echo -e " ${DIM}Waiting 25s for you to launch your app...${NC}"
 sleep 25

 section "Process Landscape"
 # What's running BEFORE our app?
 echo -e " ${DIM}Existing corespotlightd processes (Apple's):${NC}"
 APPLE_CS_PIDS=$(pgrep -f "/usr/libexec/corespotlightd|/System/Library.*corespotlightd" 2>/dev/null || true)
 if [[ -n "$APPLE_CS_PIDS" ]]; then
 info "Apple's CoreSpotlight is running (PID: $APPLE_CS_PIDS) — good, we'll blend in"
 else
 warn "Apple's CoreSpotlight NOT running — our process will be the ONLY corespotlightd"
 fi

 # Check for our process (should NOT be here yet if we just launched)
 EARLY_PID=$(get_pid "$PROCESS_PATTERN")
 if [[ -n "$EARLY_PID" ]]; then
 info "Process already visible (PID: $EARLY_PID) — app may have launched fast"
 else
 info "No helper process yet — waiting for launch"
 fi

 section "File System Baseline"
 # What's already on disk?
 if [[ -d "$OLD_COUNCIL_DIR" ]]; then
 warn "Stale .council directory still exists: $OLD_COUNCIL_DIR"
 find "$OLD_COUNCIL_DIR" -maxdepth 2 -type f 2>/dev/null | head -10 | sed 's/^/ /'
 fi
 if [[ -d "$COM_APPLE_DIR" ]]; then
 info ".com.apple.corespotlightd directory EXISTS: $COM_APPLE_DIR"
 find "$COM_APPLE_DIR" -maxdepth 2 -type f 2>/dev/null | head -10 | sed 's/^/ /'
 fi

 # LaunchAgents
 echo -e " ${DIM}LaunchAgents in ~/Library/LaunchAgents/:${NC}"
 ls "$LAUNCH_AGENTS/" 2>/dev/null | sed 's/^/ /'

 # ─── PHASE 1: PROCESS APPEARANCE (30s - 90s) ─────────────────────
 phase "1 — PROCESS APPEARANCE (app should be launching now)"
 sleep 30

 section "Process Detection"
 PID=$(get_pid "$PROCESS_PATTERN")
 if [[ -n "$PID" ]]; then
 ok "Helper process detected (PID: $PID)"
 # What does ps show?
 PS_LINE=$(ps -p "$PID" -o pid,comm,args 2>/dev/null | tail -1)
 info "ps output: $PS_LINE"

 # Check the binary path
 BINARY_PATH=$(ps -p "$PID" -o args= 2>/dev/null | awk '{print $1}')
 info "Binary path: $BINARY_PATH"

 if echo "$BINARY_PATH" | grep -qi "code-auditor\|council"; then
 bad "Binary path contains a GIVEAWAY name (cloud-sync/code-auditor/council)"
 elif echo "$BINARY_PATH" | grep -qi "corespotlightd"; then
 ok "Binary path looks like Apple's CoreSpotlight"
 elif echo "$BINARY_PATH" | grep -qi "target/debug"; then
 warn "Binary is in target/debug — DEV MODE (expected in development)"
 fi

 # Check if it's in the Dock / has a menu bar
 # (Hard to check programmatically, but we can check activation policy via lsappinfo)
 if command -v lsappinfo &>/dev/null; then
 APP_INFO=$(lsappinfo info -app "$PID" 2>/dev/null | grep -i "LSUIElement\|activation" || true)
 if [[ -n "$APP_INFO" ]]; then
 info "lsappinfo: $APP_INFO"
 fi
 fi
 else
 bad "NO helper process found after 60s — did you launch the app?"
 echo -e " ${YELLOW} (Continuing with best-effort checks...)$NC"
 fi

 # Check for DUPLICATE processes
 ALL_PIDS=$(get_all_pids "$PROCESS_PATTERN")
 PID_COUNT=$(echo "$ALL_PIDS" | wc -l | tr -d ' ')
 if [[ "$PID_COUNT" -gt 1 ]]; then
 warn "Multiple helper processes found ($PID_COUNT) — single-instance lock may be failing"
 echo "$ALL_PIDS" | sed 's/^/ PID: /'
 fi

 section "Process Name Fingerprint"
 # The critical test: what would a casual observer see?
 echo -e " ${DIM}Running: ps aux | grep -i 'sync\|council\|auditor\|helper'${NC}"
 GIVEAWAY_HITS=$(ps aux 2>/dev/null | grep -i "council\|code.auditor\|cloud.sync\|code_auditor" | grep -v grep || true)
 if [[ -n "$GIVEAWAY_HITS" ]]; then
 bad "GIVEAWAY process names visible in ps aux:"
 echo "$GIVEAWAY_HITS" | sed 's/^/ /'
 else
 ok "No giveaway process names in ps aux (clean)"
 fi

 # Check Activity Monitor visibility
 echo -e " ${DIM}Running: ps aux | grep -i 'corespotlight\|syncd'${NC}"
 CS_HITS=$(ps aux 2>/dev/null | grep -i "corespotlightd\|syncd" | grep -v grep || true)
 if [[ -n "$CS_HITS" ]]; then
 info "CoreSpotlight-looking processes:"
 echo "$CS_HITS" | sed 's/^/ /'
 fi

 # ─── PHASE 2: TCC & PERMISSIONS (90s - 150s) ─────────────────────
 phase "2 — TCC PERMISSIONS & TAP DETECTION"
 sleep 30

 section "TCC Database Inspection"
 TCC_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
 if [[ -f "$TCC_DB" ]]; then
 # Screen Recording
 SC=$(sqlite3 "$TCC_DB" "SELECT auth_value FROM access WHERE service='kTCCServiceScreenCapture' AND client='$BUNDLE_ID';" 2>&1 || true)
 if echo "$SC" | grep -qi "authorization denied\|unable to open database"; then
 warn "Screen Recording status could not be inspected (TCC database access denied)"
 SC="unreadable"
 fi
 if [[ "$SC" == "2" ]]; then
 ok "Screen Recording GRANTED (auth_value=2) for $BUNDLE_ID"
 elif [[ "$SC" == "0" ]]; then
 bad "Screen Recording DENIED (auth_value=0) — captures will fail"
 elif [[ -z "$SC" ]]; then
 warn "Screen Recording: $SC (not found or pending) — check System Settings"
 elif [[ "$SC" != "unreadable" ]]; then
 info "Screen Recording status: $SC"
 fi

 # Accessibility
 ACC=$(sqlite3 "$TCC_DB" "SELECT auth_value FROM access WHERE service='kTCCServiceAccessibility' AND client='$BUNDLE_ID';" 2>&1 || true)
 if echo "$ACC" | grep -qi "authorization denied\|unable to open database"; then ACC="unreadable"; fi
 if [[ "$ACC" == "2" ]]; then
 info "Accessibility GRANTED (needed for global shortcuts)"
 elif [[ "$ACC" == "not_found" ]]; then
 warn "Accessibility NOT FOUND for $BUNDLE_ID"
 info " → The helper uses IOHIDManager; check Input Monitoring below"
 info " → Check: System Settings → Privacy → Accessibility"
 fi

 # Input Monitoring (for IOHID approach)
 IM=$(sqlite3 "$TCC_DB" "SELECT auth_value FROM access WHERE service='kTCCServiceListenEvent' AND client='$BUNDLE_ID';" 2>&1 || true)
 if echo "$IM" | grep -qi "authorization denied\|unable to open database"; then IM="unreadable"; fi
 info "Input Monitoring: $IM"

 # Check if the MAIN APP also has these (potential confusion)
 MAIN_SC=$(sqlite3 "$TCC_DB" "SELECT client, auth_value FROM access WHERE service='kTCCServiceScreenCapture' AND auth_value=2" 2>/dev/null || true)
 if [[ -n "$MAIN_SC" ]]; then
 info "All apps with Screen Recording granted:"
 echo "$MAIN_SC" | sed 's/^/ /'
 fi
 else
 warn "TCC.db not found at $TCC_DB (SIP? Different macOS version?)"
 fi

 section "CGEventTap Enumeration"
 # This is the critical check: can someone enumerate our event taps?
 TAPS_RESULT=$(swift - << 'SWIFT' 2>/dev/null
 import CoreGraphics
 guard let taps = CGGetEventTapList(50, .defaultSession, .headInsertEventTap) as? [CGEventTapInfo] else {
 print("ERROR: could not enumerate taps")
 exit(1)
 }
 if taps.isEmpty {
 print("NONE")
 } else {
 for tap in taps {
 print("tap: ownerPID=\(tap.ownerPID) type=\(tap.tapType.rawValue) place=\(tap.place.rawValue)")
 }
 }
 SWIFT
 )
 if [[ "$TAPS_RESULT" == "NONE" ]]; then
 ok "CGGetEventTapList returns 0 taps — helper uses IOHIDManager (no CGEventTap)"
 elif [[ "$TAPS_RESULT" == "ERROR"* ]]; then
 warn "Could not enumerate taps (Swift/SDK issue?)"
 else
 # Check if any tap belongs to our PID
 if [[ -n "$PID" ]] && echo "$TAPS_RESULT" | grep -q "ownerPID=$PID"; then
 bad "CGEventTap FOUND from our PID ($PID) — helper is not using IOHIDManager"
 echo "$TAPS_RESULT" | sed 's/^/ /'
 else
 info "Taps exist but none from our PID (system taps only):"
 echo "$TAPS_RESULT" | sed 's/^/ /'
 ok "Our process has NO CGEventTap (good)"
 fi
 fi

 # ─── PHASE 3: WINDOW / OVERLAY INVISIBILITY (150s - 210s) ────────
 phase "3 — OVERLAY WINDOW INVISIBILITY"
 echo -e " ${YELLOW} >>> NOW PRESS Ctrl+Alt+O TO TOGGLE OVERLAY ON <<<${NC}"
 echo -e " ${DIM} Waiting 20s for overlay to appear...${NC}"
 sleep 20

 section "CGWindowList (what screen capture sees)"
 WINDOW_RESULT=$(swift - << 'SWIFT' 2>/dev/null
 import CoreGraphics
 let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
 guard let windows = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
 print("ERROR")
 exit(1)
 }
 var found = false
 for w in windows {
 let owner = w[kCGWindowOwnerName as String] as? String ?? ""
 let name = w[kCGWindowName as String] as? String ?? ""
 let layer = w[kCGWindowLayer as String] as? Int ?? -1
 let sharing = w[kCGWindowSharingState as String] as? Int ?? -1
 let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
 // Look for anything that could be our overlay
 if owner.lowercased().contains("corespotlight") ||
 owner.lowercased().contains("council") ||
 owner.lowercased().contains("cloud") ||
 owner.lowercased().contains("sync") ||
 name.lowercased().contains("overlay") ||
 name.lowercased().contains("capture") ||
 name.lowercased().contains("glass") ||
 layer >= 1000 ||
 (pid > 0 && pid == $(pgrep -f "com.apple.corespotlightd|corespotlightd" 2>/dev/null | head -1 || echo 99999))
 {
 found = true
 print("VISIBLE: owner=\(owner) pid=\(pid) layer=\(layer) sharing=\(sharing) name=\(name)")
 }
 }
 if !found {
 print("NONE")
 }
 SWIFT
 )

 if [[ "$WINDOW_RESULT" == "NONE" ]]; then
 ok "NO overlay windows in CGWindowList — fully invisible to screen capture!"
 elif [[ "$WINDOW_RESULT" == "ERROR" ]]; then
 warn "CGWindowList check failed (Swift/SDK issue?)"
 else
 if echo "$WINDOW_RESULT" | grep -q "sharing=0"; then
 ok "Overlay found but sharingType=0 (invisible to capture pipeline)"
 echo "$WINDOW_RESULT" | sed 's/^/ /'
 else
 bad "Overlay VISIBLE in CGWindowList with sharing≠0:"
 echo "$WINDOW_RESULT" | sed 's/^/ /'
 info " → sharingType=.none is NOT being applied to the correct NSWindow"
 fi
 fi

 section "Screen Capture Test"
 CAPTURE_TEST="/tmp/.csp_${$}_screencapture.png"
 if /usr/sbin/screencapture -x "$CAPTURE_TEST" 2>/dev/null && [[ -s "$CAPTURE_TEST" ]]; then
 FILE_SIZE=$(stat -f%z "$CAPTURE_TEST" 2>/dev/null || stat -c%s "$CAPTURE_TEST" 2>/dev/null || echo 0)
 ok "screencapture succeeded (${FILE_SIZE} bytes)"
 info "Open $CAPTURE_TEST while the overlay is visible and confirm it is absent"
 rm -f "$CAPTURE_TEST"
 else
 bad "screencapture failed — Screen Recording permission or capture setup is incorrect"
 rm -f "$CAPTURE_TEST"
 fi
 # Toggle overlay OFF
 echo -e " ${YELLOW} >>> NOW PRESS Ctrl+Alt+O TO TOGGLE OVERLAY OFF <<<${NC}"
 sleep 5

 # ─── PHASE 4: FILE SYSTEM FORENSICS (210s - 270s) ─────────────────
 phase "4 — FILE SYSTEM FORENSICS"
 sleep 10

 section "Giveaway File Names"
 echo -e " ${DIM}Scanning for: *council*, *code-auditor*, *cloud-sync*, *code_auditor*${NC}"
 FILE_HITS=$(find "$APP_SUPPORT" -maxdepth 4 \
 \( -name "*council*" -o -name "*code.auditor*" -o -name "*cloud.sync*" \
 -o -name "*code_auditor*" -o -name "*cloud_sync*" \) 2>/dev/null)
 if [[ -n "$FILE_HITS" ]]; then
 bad "GIVEAWAY file paths found:"
 echo "$FILE_HITS" | sed 's/^/ /'
 else
 ok "No giveaway filenames in Application Support"
 fi

 section "LaunchAgent Inspection"
 AGENT_HITS=$(ls "$LAUNCH_AGENTS/" 2>/dev/null | grep -i "council\|code.auditor\|cloud.sync\|code_auditor")
 if [[ -n "$AGENT_HITS" ]]; then
 bad "Giveaway LaunchAgent name(s): $AGENT_HITS"
 else
 ok "No giveaway LaunchAgent names"
 fi

 # Check the actual plist content
 for PLIST in "$LAUNCH_AGENTS/"*.plist; do
 if [[ -f "$PLIST" ]]; then
 LABEL=$(grep -A1 "<key>Label</key>" "$PLIST" 2>/dev/null | grep "<string>" | sed 's/.*<string>\(.*\)<\/string>/\1/' || true)
 PROGRAM=$(grep -A1 "<key>Program</key>" "$PLIST" 2>/dev/null | grep "<string>" | sed 's/.*<string>\(.*\)<\/string>/\1/' || true)
 if echo "$LABEL$PROGRAM" | grep -qi "council\|code.auditor\|cloud.sync\|code_auditor"; then
 warn "Plist $PLIST has giveaway content (label=$LABEL)"
 elif echo "$LABEL" | grep -qi "com.apple."; then
 info "Plist $PLIST looks Apple-ish (label=$LABEL)"
 fi
 fi
 done

 section "Lock File"
 LOCK_HITS=$(find "$APP_SUPPORT" -maxdepth 4 -name "*lock*" 2>/dev/null | grep -i "council\|code.auditor\|cloud.sync\|code_auditor\|sync")
 if [[ -n "$LOCK_HITS" ]]; then
 bad "Giveaway lock file(s):"
 echo "$LOCK_HITS" | sed 's/^/ /'
 else
 ok "No giveaway lock files"
 fi

 section "Overlay State File"
 STATE_HITS=$(find "$APP_SUPPORT" -maxdepth 4 -name "*overlay*state*" -o -name "*overlay-state*" 2>/dev/null)
 if [[ -n "$STATE_HITS" ]]; then
 info "State file found: $STATE_HITS"
 # Check if it's in a hidden dir
 if echo "$STATE_HITS" | grep -q "/\."; then
 info " → In a dot-prefixed directory (hidden from casual ls)"
 else
 warn " → NOT in a hidden directory (visible to ls)"
 fi
 SOCKET_HITS=$(find /tmp -maxdepth 1 -name ".csp_*.sock" 2>/dev/null)
 if [[ -n "$SOCKET_HITS" ]]; then
 info "Overlay state socket found in /tmp: $SOCKET_HITS"
 else
 info "No overlay state socket found (helper may be stopped)"
 fi
 # Check file permissions
 for SF in $STATE_HITS; do
 PERMS=$(stat -f "%Sp" "$SF" 2>/dev/null || stat -c "%A" "$SF" 2>/dev/null || echo "??")
 info " → Permissions: $PERMS"
 done
 else
 info "No overlay state file found (main app not running or hasn't written yet)"
 fi

 section "Cache / Captures"
 CAPTURE_HITS=$(find "$APP_SUPPORT" -maxdepth 5 -path "*captures*" -o -path "*pending-batch*" 2>/dev/null | head -5)
 if [[ -n "$CAPTURE_HITS" ]]; then
 info "Capture/batch files found (expected during active use):"
 echo "$CAPTURE_HITS" | sed 's/^/ /'
 else
 info "No capture files (clean or not yet used)"
 fi

 section "Log Files"
 LOG_HITS=$(find "$APP_SUPPORT" -maxdepth 5 -name "*.log" -o -name ".state" 2>/dev/null | grep -i "council\|code.auditor\|cloud\|sync")
 if [[ -n "$LOG_HITS" ]]; then
 warn "Log files with giveaway names:"
 echo "$LOG_HITS" | sed 's/^/ /'
 else
 ok "No giveaway log files"
 fi

 # ─── PHASE 5: NETWORK & KEYCHAIN (270s - 300s) ───────────────────
 phase "5 — NETWORK & KEYCHAIN"
 sleep 10

 section "Network Connections"
 if [[ -n "$PID" ]]; then
 NET=$(lsof -i -n -P -a -p "$PID" 2>/dev/null | grep -v "^COMMAND" | grep -v "^lsof")
 if [[ -n "$NET" ]]; then
 info "Active network connections for PID $PID:"
 echo "$NET" | sed 's/^/ /'
 if echo "$NET" | grep -q ":443"; then
 ok "Using port 443 (HTTPS — looks like normal web traffic)"
 else
 warn "Using non-443 port — visible to network monitors"
 fi
 # Check the remote host
 REMOTE=$(echo "$NET" | grep -oE "[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+" | head -3)
 if [[ -n "$REMOTE" ]]; then
 info "Remote endpoints: $REMOTE"
 fi
 else
 ok "No active network connections (idle state — good)"
 fi
 else
 info "No PID for network check"
 fi

 section "Keychain"
 echo -e " ${DIM}Searching Keychain for helper token...${NC}"
 KC_RENAMED=$(security find-generic-password -s "com.apple.corespotlightd.session" -a "s" 2>&1 | head -2)

 if echo "$KC_RENAMED" | grep -q "keychain"; then
 ok "Found under new name: com.apple.corespotlightd.session / s"
 else
 info "No Keychain entry found (helper not yet authorized or using different name)"
 fi

 # Check for any "council" or "code-auditor" in keychain
 KC_GIVEAWAY=$(security dump-keychain 2>/dev/null | grep -i "council\|code.auditor\|cloud.sync" | head -3)
 if [[ -n "$KC_GIVEAWAY" ]]; then
 bad "Giveaway Keychain entries:"
 echo "$KC_GIVEAWAY" | sed 's/^/ /'
 else
 ok "No giveaway Keychain entries"
 fi

 # ─── PHASE 6: ACTIVATION POLICY & UI VISIBILITY ──────────────────
 section "UI Visibility (Dock / Menu Bar / Cmd+Tab)"
 if [[ -n "$PID" ]]; then
 # Check if the process has a Dock tile
 # (lsappinfo can tell us the activation policy)
 if command -v lsappinfo &>/dev/null; then
 ACT_POLICY=$(lsappinfo info -app "$PID" 2>/dev/null | grep -i "activationPolicy\|LSUIElement" || true)
 if [[ -n "$ACT_POLICY" ]]; then
 info "Activation info: $ACT_POLICY"
 fi
 fi

 # Check if it appears in the "Force Quit" list (Cmd+Option+Esc)
 # This is hard to check programmatically, but we can check if it has a NSApplication
 # that's in .regular mode
 info "Manual check: Open Activity Monitor → search for your process name"
 info " → Should show in 'Processes' tab (it's a process)"
 info " → Should NOT have a Dock icon"
 info " → Should NOT appear in Cmd+Tab"
 info " → Should NOT appear in Force Quit (Cmd+Opt+Esc)"
 fi

 # ─── PHASE 7: THE PARANOID AUDITOR FINAL SWEEP ───────────────────
 section "Paranoid Final Sweep"

 # 1. Full process list sorted by CPU
 echo -e " ${DIM}Top 20 processes by CPU (does yours stand out?):${NC}"
 ps aux 2>/dev/null | sort -k3 -rn | head -20 | awk '{printf " %s %s %s\\n", $2, $3"%", $11}'

 # 2. All non-Apple LaunchAgents
 echo -e " ${DIM}User LaunchAgents (non-system):${NC}"
 ls "$LAUNCH_AGENTS/" 2>/dev/null | sed 's/^/ /'

 # 3. launchctl list (does our label show?)
 echo -e " ${DIM}launchctl list | grep our label:${NC}"
 LAUNCH_HITS=$(launchctl list 2>/dev/null | grep -i "corespotlight\|sync.daemon\|council" || true)
 if [[ -n "$LAUNCH_HITS" ]]; then
 echo "$LAUNCH_HITS" | sed 's/^/ /'
 fi

 # 4. fs_usage quick sample (2 seconds of file I/O)
 echo -e " ${DIM}File I/O sample (2s, looking for our PID):${NC}"
 if [[ -n "$PID" ]]; then
 timeout 2 sudo fs_usage -w -f filesys 2>/dev/null | grep "$PID" | head -5 | sed 's/^/ /' || info " (no I/O captured in 2s — idle)"
 fi

 # 5. Check /tmp for state files
 echo -e " ${DIM}/tmp files (dot-prefixed, our pattern):${NC}"
 TMP_HITS=$(ls -la /tmp/ 2>/dev/null | grep -i "csp_\|council\|sync\|overlay" | head -5)
 if [[ -n "$TMP_HITS" ]]; then
 echo "$TMP_HITS" | sed 's/^/ /'
 else
 info " (no matching /tmp files)"
 fi

 # ─── FINAL REPORT ─────────────────────────────────────────────────
 echo ""
 echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
 echo -e "${BOLD}║ GHOST DETECTIVE — FINAL REPORT ║${NC}"
 echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
 echo ""
 echo -e " ${GREEN}PASSED: $PASS${NC} ${RED}FAILED: $FAIL${NC} ${YELLOW}WARNINGS: $WARN${NC} ${DIM}INFO: $INFO${NC}"
 echo ""

 # Score
 TOTAL=$((PASS + FAIL + WARN))
 if [[ $TOTAL -gt 0 ]]; then
 SCORE=$((PASS * 100 / TOTAL))
 else
 SCORE=0
 fi

 if [[ $FAIL -eq 0 && $WARN -eq 0 ]]; then
 echo -e " ${GREEN}${BOLD}VERDICT: GHOST MODE ACHIEVED 🎃${NC}"
 echo -e " Your helper is functionally invisible. A casual auditor"
 echo -e " would not find it. A paranoid one might, but would"
 echo -e " likely dismiss it as Apple's own CoreSpotlight daemon."
 elif [[ $FAIL -eq 0 ]]; then
 echo -e " ${YELLOW}${BOLD}VERDICT: NEAR-GHOST (warnings only) 👻${NC}"
 echo -e " Functionally invisible, but some naming/paths could"
 echo -e " raise eyebrows under deep inspection."
 elif [[ $FAIL -le 2 ]]; then
 echo -e " ${YELLOW}${BOLD}VERDICT: VISIBLE BUT DISGUISED 🫥${NC}"
 echo -e " A determined auditor would find you. Fix the FAIL items."
 else
 echo -e " ${RED}${BOLD}VERDICT: BARELY HIDDEN 🐛${NC}"
 echo -e " Multiple leaks detected. Your helper is findable with"
 echo -e " moderate effort. See failed checks above."
 fi

 echo ""
 echo -e " ${DIM}Score: $SCORE/100${NC}"
 echo ""

 # Detailed breakdown
 echo -e "${BOLD} CHECK BREAKDOWN:${NC}"
 echo ""
 for C in "${CHECKS[@]}"; do
 STATUS="${C%%|*}"
 MSG="${C#*|}"
 case "$STATUS" in
 PASS) echo -e " ${GREEN}✓${NC} $MSG" ;;
 FAIL) echo -e " ${RED}✗${NC} $MSG" ;;
 WARN) echo -e " ${YELLOW}⚠${NC} $MSG" ;;
 *) echo -e " ${DIM}·${NC} $MSG" ;;
 esac
 done

 echo ""
 echo -e "${BOLD} RECOMMENDED FIXES (in priority order):${NC}"
 echo ""
 echo -e " 1. ${BOLD}Verify sharingType=.none${NC} is actually applied"
 echo -e " 2. ${BOLD}Verify Screen Recording permission${NC} is granted to the .app bundle ID"
 echo -e " 3. ${BOLD}Keep Input Monitoring permission${NC} granted to the helper .app"
 echo ""
 echo -e "${DIM} Run this script again after fixes. Target: 0 FAIL, 0 WARN.${NC}"
 echo ""
 echo -e "${BOLD}══════════════════════════════════════════════════════════${NC}"

 # Clean up
 rm -f /tmp/ghost_detective_capture.png 2>/dev/null
 exit $FAIL
