# Cloud thin-client migration: Phase 1 audit

## Verified code paths (2026-10-11)
- `scripts/cloud-worker.mjs` already owns queued screenshot solving using Supabase Storage and database rows, server-side provider credentials, Council reasoning, MCQ workflow and E2B/GitHub execution paths.
- `src/lib/cloudJobs.ts` defines cloud job image manifests and validates submissions (at most 10 screenshots); its settings snapshot removes secrets.
- `src/lib/serverApi.ts` provides an additive authenticated Supabase Edge Function API client. Its comments explicitly warn that desktop paths still use direct Storage/Postgres access and that individual calls must be migrated incrementally.
- `src-tauri/src/bin/mds.rs` owns the local background-helper UI, screenshot forwarding, persistent status and local filesystem operations. Preserve capture, immediate preview and independent helper recovery locally.
- `src-tauri/src/overlay.rs` owns macOS overlay window operations.
- PR #19 has been merged and adds image preview caching, content-aware updates, durable submission identifiers, account-bound snapshots and retry/recovery behavior. Do not reimplement or regress those changes.

## Phase 1 change in this PR
- Reject duplicate storage objects among a cloud job's attachments and reject unsafe/fractional byte counts before submission.
- Add regression tests; keep behavior otherwise unchanged. No new cloud deployment or runtime switch.

## Phase 2: audited server boundary
1. Inventory all direct desktop DB/storage operations (`src-tauri/src/storage.rs`, `mds.rs`, frontend call sites); classify authorization and payload sizes.
2. Route authenticated create/upload/finalize/read through the existing `council-editor-api` function; use short-lived per-object upload grants where supported and enforce account ownership and file limits server-side.
3. Keep local capture, immediate image preview, image tray and overlay compositing; upload only immutable files once. Avoid base64 in refresh loops. The cloud analyzes originals.
4. Keep current durable job IDs and deduplication; ensure idempotent retries, bounded concurrent uploads and explicit cancellation.

## Phase 3: results and isolation
1. Retain the current cloud worker and queue; extend only missing status/result endpoints.
2. Use authenticated real-time notification when possible, backed by bounded polling/reconciliation after disconnect/restart. Never make WebSocket events the only source of truth.
3. Scope every job, image object and result to its user, encrypt at rest/in transit, define retention/deletion; prevent cross-account provider-secret fallback.
4. Run code only inside sandboxes, not the worker process.

## Phase 4: verification and rollout
- Run existing JS/TS/Rust suites, CI on macOS, and screenshot/multi-image upload and forced-restart recovery scenarios as one consolidated batch.
- Check memory, CPU, upload bandwidth, screenshot-to-preview latency, end-to-end solve latency and inference/storage costs against baseline.
- Gate each cutover with a feature flag and server-health check; preserve rollback. Do not remove working local paths until live on-device tests pass.
- Confirm Supabase migration and Edge Function deployment independently: merged code alone is not a deployed service.

## Out-of-scope
- No second intelligence engine, mass cloud infrastructure rewrite, or assumption that moving instant previews over the network improves responsiveness.
