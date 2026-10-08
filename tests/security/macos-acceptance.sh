#!/bin/bash
# Phase 1 macOS acceptance checks. Run manually on an unlocked Mac with Docker Desktop.
# This does not replace testing the native prompt in Council Editor itself.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This test must run on macOS" >&2; exit 1
fi
if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker Desktop is not running; restricted shell must fail closed." >&2; exit 1
fi
if ! docker image inspect alpine:3.20 >/dev/null 2>&1; then
  echo "ERROR: Pre-pull alpine:3.20. The app will not pull images automatically." >&2; exit 1
fi
work="$(mktemp -d)"
name="council-coding-macos-check-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/workspace"
chmod 777 "$work/workspace"
printf 'outside-only' > "$work/secret"
docker run --rm --init --name "$name" --pull never --network none --read-only \
  --ipc none --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 512m --memory-swap 512m --cpus 1 \
  --ulimit nofile=256:256 --ulimit fsize=8388608:8388608 \
  --tmpfs /tmp:rw,nosuid,noexec,size=64m --user 1000:1000 \
  --mount "type=bind,source=$work/workspace,target=/workspace" \
  --workdir /workspace alpine:3.20 /bin/sh -ec '
    printf ok > result.txt
    test "$(cat result.txt)" = ok
    ! touch /etc/should-not-exist 2>/dev/null
    test ! -e /secret
    test ! -e /workspace/../secret
    test ! -e /sys/class/net/eth0
  '
test "$(cat "$work/workspace/result.txt")" = ok
echo "Checking macOS native AppleScript approval dialog (click Deny for the first test)."
osascript -e 'button returned of (display dialog "Council Editor security acceptance: choose Deny" with title "Native authorization test" buttons {"Deny", "Approve"} default button "Deny" giving up after 30)' | grep -qx "Deny"
echo "PASS: Native Deny action reported by macOS."
echo "Checking native dialog Approve action (click Approve for the second test)."
osascript -e 'button returned of (display dialog "Council Editor security acceptance: choose Approve" with title "Native authorization test" buttons {"Deny", "Approve"} default button "Deny" giving up after 30)' | grep -qx "Approve"
echo "PASS: Native Approve action reported by macOS."
echo "PASS: Docker Desktop restricted container filesystem/network checks."
echo ""
echo "INTERACTIVE VERIFICATION REQUIRED IN THE RUNNING APP:"
echo "1. With shell disabled: request Bash, confirm no command runs."
echo "2. Enable restricted shell mode and request a harmless 'printf test' command."
echo "3. Click Deny: confirm no command runs."
echo "4. Click Approve: confirm one command runs once."
echo "5. Cancel/dismiss approval: confirm no command runs."
echo "6. Leave prompt unanswered for 90 seconds: confirm denied."
echo "7. Start a shell that spawns a child; cancel the run and verify both stop."
echo "8. Test with Docker Desktop stopped: restricted execution must fail closed."
echo "Record results before marking Phase 1 security acceptance complete."
