# Background Cloud Solver

This document tracks the focused background solving design. The product stays a
solver workbench; it does not become a full IDE.

## What Works Now

- Supabase schema now has a persistent cloud job queue:
  `solve_jobs`, `solve_job_images`, `solve_job_events`, `council_reports` and
  `notification_devices`.
- The desktop bridge can create Council-only solve jobs, attach uploaded ordered
  screenshots, read job images, read job events and load Council reports from
  Supabase.
- Background batch rules are implemented and tested: start a batch, add up to 10
  screenshots, build a Council-only job draft, and strip secrets from settings.
- Settings can install, remove and inspect the user LaunchAgent. The installed
  helper is explicit, user-visible and removable from the app.
- `cloud-sync-helper` is the first dedicated helper
  binary. It owns start/capture/submit hotkeys, captures full-screen screenshots
  with macOS `screencapture`, stores local pending batch state under Application
  Support, uploads up to 10 screenshots to Supabase Storage, creates a background
  session and queues a Council job directly from the saved Keychain credentials.
  Default helper hotkeys are `Control+Alt+B` to start, `Control+Alt+P` to capture
  and `Control+Alt+Enter` to submit.
- The desktop rail has a Cloud Jobs panel for queued/running/completed jobs,
  ordered screenshot thumbnails, recent progress events and final report summary.
- The Cloud Jobs panel can queue the screenshots currently loaded in the
  workspace: it uploads them to Supabase Storage, creates a Council-only solve job
  with ordered job-image rows and refreshes history.
- `scripts/cloud-worker.mjs` can claim queued jobs, download ordered screenshots,
  run a compact cloud Council through TokenRouter chat models, generate benchmark
  harnesses only when runnable code candidates exist, run E2B or local-worker
  verification, optionally dispatch passing runs to GitHub Actions, collect reviewer
  passes and judge reports, write `council_reports`, mark jobs completed, record
  progress events, and send APNs notifications when APNs credentials are
  configured.
- `scripts/com.charles.codeeditor.cloud-sync-helper.plist` is the LaunchAgent
  template for the packaged helper sidecar inside `Code Editor.app`.
- `ios/CodeEditorCompanion` is the native iOS companion foundation. It registers
  APNs tokens through the worker server, reads Supabase cloud job history and
  opens job details from the same stored events/reports the desktop app reads.

## Boundaries

- Quiet/background operation is allowed.
- macOS Screen Recording permission, process visibility, network activity and
  system capture behavior are not bypassed.
- A fully quit process cannot receive hotkeys. For v1, the dedicated helper
  process owns full-screen batch hotkeys without loading the Tauri webview.
- The cloud worker's v1 Council now includes solver, benchmark, review, judge
  and synthesis phases. It still records missing revision evidence explicitly
  instead of pretending that gate has run.

## Worker Environment

```bash
export SUPABASE_URL="https://PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
export TOKENROUTER_API_KEY="..."
export GH_TOKEN="..."

# Optional native iOS / Apple Watch notifications through APNs
export APNS_KEY_ID="..."
export APNS_TEAM_ID="..."
export APNS_BUNDLE_ID="com.charles.codeeditor"
export APNS_PRIVATE_KEY_PATH="./AuthKey_XXXXXX.p8"
export APNS_ENV="sandbox" # or production

node scripts/cloud-worker.mjs --once
```

## Next Implementation Layer

1. Rename the public product from **Code Editor** to **Council Editor** before
   App Store/TestFlight packaging.
2. Package/sign the helper binary inside the release `.app` instead of relying on
   a separately built `target/*/cloud-sync-helper` during development.
3. Add a helper status/history surface that shows pending batch count and the
   latest helper log/event inside Settings.
4. Add server-side revision rounds to the worker so it matches the full in-app
   Council evidence model.
5. Turn the checked-in iOS SwiftUI companion source into a signed Xcode project
   with the final bundle id, APNs entitlement and production provisioning
   profile.
