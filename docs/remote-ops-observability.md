# Remote Ops and Observability

This layer keeps the laptop focused on user-approved capture and viewing. Heavy
solve work belongs in the cloud worker, and cron-job.org should act only as the
remote clock that wakes that worker endpoint.

## cron-job.org Fit

cron-job.org is useful here because its REST API can create, update, list and
delete HTTPS jobs. The API uses bearer-token authentication, JSON payloads and
the endpoint `https://api.cron-job.org/`. The free default API budget is 100 API
requests per day, with per-method rate limits. Creating jobs is limited to one
request per second and five per minute, while common read/update/history methods
are limited to five requests per second.

Recommended usage:

- One cron-job.org job calls a deployed HTTPS worker tick endpoint every 5
  minutes.
- The endpoint claims queued Supabase jobs and returns quickly.
- The desktop UI never polls cron-job.org directly during normal use; it reads
  `solve_jobs`, `solve_job_events` and `council_reports` from Supabase.
- Keep the cron-job.org API key server-side only. Use IP restrictions in the
  cron-job.org console when the deployment platform has stable egress IPs.

The helper script is:

```bash
CRON_JOB_ORG_API_KEY="..." \
CODE_AUDITOR_WORKER_TICK_URL="https://worker.example.com/api/worker-tick" \
CODE_AUDITOR_WORKER_TICK_SECRET="server-side-shared-secret" \
node scripts/cron-job-org.mjs upsert
```

The deployed endpoint is provided by:

```bash
npm run worker:serve
```

It exposes:

- `GET /health`
- `POST /api/worker-tick`
- `POST /api/register-device`

Set `CODE_AUDITOR_WORKER_TICK_SECRET` and point cron-job.org or QStash at
`/api/worker-tick` with that bearer token. Set
`CODE_AUDITOR_DEVICE_REGISTRATION_SECRET` for the native iOS companion so it can
register APNs tokens without carrying the Supabase service-role key.

## What Still Uses The Laptop

Local machine requirements after packaging should be small:

- macOS captures screenshots and enforces Screen Recording permission.
- The installed helper receives user-approved hotkeys while the main window is
  closed.
- Keychain stores local Supabase desktop/helper credentials.
- The desktop app displays history, screenshots, progress and final reports.

The solve path should not depend on local Node, Rust, Python, compilers, GitHub
CLI, or model-provider CLIs once the release app and remote worker are deployed.
Generated code execution and benchmarks belong in the worker environment.

## Bundling Strategy

- The release `Council Editor.app` bundles the Tauri binary, static Next output and
  `cloud-sync-helper` sidecar.
- End users should not install Node, npm, Cargo, Rust, Tauri CLI or frontend
  packages.
- Arbitrary benchmark runtimes should be bundled into the remote worker image,
  not the Mac app. `Dockerfile.worker` installs the runtimes currently used by
  `scripts/cloud-worker.mjs`: Node, Python, bash, Ruby, PHP, C/C++, Java, Go and
  Rust.
- E2B is configured as the preferred generated-code execution backend when
  `E2B_API_KEY` is set. Use `CODE_AUDITOR_EXECUTION_PROVIDER=local` only for
  local debugging.
- GitHub Actions is configured as a heavier asynchronous benchmark path through
  `.github/workflows/cloud-benchmark.yml` and
  `scripts/github-actions-dispatch.mjs`. It is best for reproducible, slower
  validation runs, not instant answer synthesis.
- QStash can publish one-off worker ticks or create a retrying schedule through
  `scripts/qstash-dispatch.mjs`.
- Native iOS companion source lives in `ios/CodeEditorCompanion`. It registers
  APNs device tokens through the worker server and reads job history from
  Supabase with the anon key. Apple Watch receives the notification through
  normal iPhone notification mirroring.
- Secrets are never bundled. Supabase service-role, TokenRouter, APNs, Sentry,
  cron-job.org and Telegram credentials remain deployment environment variables.

## Sentry And Ops Alerts

The worker now supports optional Sentry and Telegram operations alerts.

```bash
export SENTRY_DSN="https://..."
export SENTRY_ENVIRONMENT="production"
export SENTRY_TRACES_SAMPLE_RATE="0.1"

export TELEGRAM_BOT_TOKEN="regenerated-bot-token"
export TELEGRAM_CHAT_ID="your-chat-id"
export CODE_AUDITOR_NOTIFY_COMPLETED="false"
export CODE_AUDITOR_SLOW_JOB_MS="180000"
```

Observability rules:

- Send job id, worker id, phase, status, durations and small structured metadata.
- Do not send screenshots, OCR text, prompts, answers, stdout/stderr dumps,
  API keys, DSNs, cookies or authorization headers.
- Record warning/error worker events in Sentry.
- Send Telegram alerts for failed, needs-attention and slow jobs. Completed-job
  Telegram alerts are opt-in to avoid noise.

The Telegram token pasted during development should be considered compromised.
Regenerate it in BotFather and store the new token only as `TELEGRAM_BOT_TOKEN`
on the server.

## Provider Choice

- **Plain question, MCQ, math or research:** run Council reasoning and judge
  passes, then skip code benchmarks unless candidates include runnable code.
- **Small runnable coding problem:** use local worker execution in the remote
  worker container or E2B for fast isolation.
- **Evidence-heavy coding problem:** dispatch GitHub Actions for slower
  reproducible validation after the E2B gate passes.
- **Scheduling/retries:** prefer QStash when the worker endpoint needs retry,
  delay or delivery history. cron-job.org remains fine for a simple external
  clock.
