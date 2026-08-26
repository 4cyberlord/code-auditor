# Background Cloud Solver

This document tracks the focused background solving design. The product stays a
solver workbench; it does not become a full IDE.

## What Works In This Commit

- Supabase schema now has a persistent cloud job queue:
  `solve_jobs`, `solve_job_images`, `solve_job_events`, `council_reports` and
  `notification_devices`.
- The desktop bridge can read solve jobs, job events and Council reports from
  Supabase.
- Background batch rules are implemented and tested: start a batch, add up to 10
  screenshots, build a Council-only job draft, and strip secrets from settings.
- `scripts/cloud-worker.mjs` can claim queued jobs, write events, update status,
  and send APNs notifications when APNs credentials are configured.
- `scripts/com.cyberlord.code-auditor.helper.plist` is a first LaunchAgent
  template that opens the installed app hidden at login so the existing global
  shortcuts stay available when the window is closed.

## Boundaries

- Quiet/background operation is allowed.
- macOS Screen Recording permission, process visibility, network activity and
  system capture behavior are not bypassed.
- A fully quit process cannot receive hotkeys. For v1, the helper keeps the app
  available in the background; a later dedicated helper binary can own the
  hotkeys without loading the full UI.
- The cloud worker currently stops at `executor_pending` unless the Council
  executor is wired in. It records that state explicitly rather than faking a
  solved answer.

## Worker Environment

```bash
export SUPABASE_URL="https://PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
export TOKENROUTER_API_KEY="..."
export GH_TOKEN="..."

# Optional native iOS / Apple Watch notifications through APNs
export APNS_KEY_ID="..."
export APNS_TEAM_ID="..."
export APNS_BUNDLE_ID="com.cyberlord.CodeAuditor"
export APNS_PRIVATE_KEY="$(cat AuthKey_XXXXXX.p8)"
export APNS_ENV="sandbox" # or production

node scripts/cloud-worker.mjs --once
```

## Next Implementation Layer

1. Add write-side queue commands for the desktop/helper: create `solve_jobs`,
   attach uploaded `solve_job_images`, and insert initial events.
2. Replace the LaunchAgent template with a dedicated helper binary that owns the
   start/capture/submit hotkeys without relying on the Tauri webview.
3. Move enough Council orchestration out of `src/lib/store.ts` so
   `scripts/cloud-worker.mjs` can run real provider calls and Codespaces
   benchmarks server-side.
4. Add the native iOS app target that registers APNs device tokens into
   `notification_devices` and opens a job/session detail screen from a push.
