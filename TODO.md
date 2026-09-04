# Council Editor — working list

What is actually left, why it matters, and what it depends on. Ordered so that
nothing here is blocked by something below it.

Kept in the repo rather than in a chat so neither of us has to reconstruct the
reasoning later. When an item is done, delete it — a list of ticked boxes stops
being read.

---

## Blocked on you

### Prove the background capture helper works

Never run once, end to end. It is the only path in the whole server migration
that has no evidence behind it.

1. Settings → Sessions → Background capture → **Authorise**
2. Card should read *authorised until \<date ~30 days out\>*
3. Quit the app completely, press the capture hotkey
4. Reopen — the job should be there

The thing to watch for: the app writes `helper-token` to the Keychain and the
*helper* reads it. Two binaries. macOS puts the creating binary on a Keychain
item's ACL, not the team, so the helper may be prompted — and a launch agent
runs headless and cannot answer a dialog. If that happens the fix is to move
that one token to a `0600` file in Application Support, which is what `gh`,
`aws` and `ssh` all do with a credential of this kind.

### Apple Developer Program enrolment

$99/yr. Blocks notarisation, the `.pkg` installer, and the updater — none of
which can start without it. Two certificates are needed, not one:

- **Developer ID Application** — signs the `.app` and every binary inside it
- **Developer ID Installer** — signs the `.pkg` itself

Apple's notarisation requirements name the certificate you have now as
unacceptable: *"Don't use a Mac Distribution, ad hoc, Apple Developer, or local
development certificate."*

Then add `APPLE_ID` and an app-specific password to config — `APPLE_TEAM_ID` is
already there — and `npm run app:build:signed` picks the Developer ID over the
development cert on its own and notarises without further changes.

---

## Next, in order

### 1. Auto-update from GitHub releases

Tauri v2's updater plugin, pointed at a static `latest.json` published as a
GitHub release asset.

- `tauri signer generate` → public key into `tauri.conf.json`,
  `TAURI_SIGNING_PRIVATE_KEY` at build time. A build-time secret, not a runtime
  one, so it does not reopen the "nothing stored on this Mac" question.
- `bundle.createUpdaterArtifacts: true`

**It does not update `.pkg` files.** On macOS the updater consumes
`Council Editor.app.tar.gz` plus a `.sig`. So a release carries *both*: the
`.pkg` for first install and the guided Installer experience, and the
`.app.tar.gz` + `.sig` + `latest.json` for every update after. One release, two
purposes. `PRODUCTION_MACOS_PKG_README.md` currently assumes a single artifact
and needs a section on this.

**Test early:** `productbuild` installs to `/Applications` as root, so the
bundle may end up `root:wheel`. The updater runs as the user and replaces the
bundle in place — if it cannot write there, updates fail for exactly the people
who installed the proper way. Either fix ownership in a post-install script or
find out on the first real update.

### 2. Sentry for crashes

`SENTRY_DSN` is already in `app_config`. Two SDKs are needed, not one:

- the browser SDK for the webview
- the Rust crate for panics — a Rust panic never reaches JavaScript

**`beforeSend` scrubbing is not optional here.** This app holds provider API
keys in memory, screenshots, and model output, and Sentry captures breadcrumbs
and local context by default. Shipping it unscrubbed would undo most of what
the server migration was for.

### 3. Feature requests → GitHub, not Sentry

Deliberately *not* Sentry. Its User Feedback is built for
*"broken permission flows, broken links, typos, misleading UX"* — bug-adjacent,
a chronological queue you resolve. No voting, no threading, no dedupe, and every
suggestion in it is noise in the one place that needs clean signal when
something is actually broken.

In-app "Suggest a feature" → opens a GitHub issue through the API. Same
convenience, none of the pollution.

Split: **crashes → Sentry automatically. "Report a problem" → Sentry User
Feedback, which carries the error context. "Suggest a feature" → GitHub.**

### 4. The `.pkg` installer

`PRODUCTION_MACOS_PKG_README.md`, now scoped to Apple Silicon only. Blocked on
the Developer ID Installer certificate.

### 5. DMG presentation

Cosmetic, and it can wait. `scripts/package-dmg.mjs` is a hand-rolled `hdiutil`
script producing a bare Finder window. Tauri's bundler does background image,
window size and icon positions from `bundle.macOS.dmg` config — which would let
that script go entirely. Only a background image needs designing.

---

## Security, unresolved

### The APNs key that was pasted into a chat

`AuthKey_N96QM6SLRV_New.p8` was pasted into a conversation and never confirmed
revoked. A `.p8` cannot be re-downloaded — only revoked and replaced — so if it
is still live it is a signing key sitting in a chat log.

Revoke it in the Apple Developer portal under Keys, create a replacement, and
update `APNS_KEY_ID`. `APNS_PRIVATE_KEY` in `.development.env` still has a line
for it.

Not urgent in the sense that nothing is using push notifications yet — the
`notification_devices` table has no rows and the iOS companion is unfinished.
Urgent in the sense that a leaked key does not become safer by waiting.

### The pepper

`COUNCIL_EDITOR_PIN_PEPPER` was rotated after being echoed to a terminal, so the
live value is fine. Confirm it is in a password manager and nowhere else. It is
the one secret in this system with no recovery path: lose it and no account can
ever sign in again, because every PIN hash was computed with it.

### The completion push goes to every account's devices

`cloud-worker.mjs:1404` reads the notification list with no owner filter:

```js
const devices = await rest("notification_devices?platform=eq.ios&enabled=eq.true");
```

The column exists — added in `migrations.sql:513`, indexed at 564 — and the
query ignores it. So a completed job pushes to every enabled iOS device in the
project, whoever owns it. The push body is only "Council job completed", so no
report content crosses accounts, but the existence and timing of another
person's work does.

Nothing is exploiting it today because `notification_devices` has no rows. It
becomes a real leak the moment the iOS companion registers a second device, and
it is the one place in the codebase where the `owner_id` discipline that holds
everywhere else was not applied.

Fix: filter on the job's owner. The job row has `owner_id`; `notify()` takes
`jobId` and would need the owner threaded through, or a lookup. Then extend
`test-tenancy.mjs` to cover it, because the two-account probe should have caught
this and did not — it checks tables reachable through the API, and the worker
reaches this one with the service role directly.

### The Telegram bot token

`docs/remote-ops-observability.md:116` records that the bot token was pasted
during development and should be treated as compromised. It has not been
regenerated. A live token means anyone holding it can read every message sent to
the bot and send messages as it.

Regenerate in BotFather, update `TELEGRAM_BOT_TOKEN` in `app_config`, and delete
the line from `.development.env`. This is a prerequisite for anything in phase
07 below — that work turns the bot from an outbound alert channel into an
inbound one that receives people's screenshots.

---

## Housekeeping and drift

### The docs describe an architecture that no longer exists

`README.md` (10 mentions) and `AI_Engineering_Workbench_MASTER_README.md` (7)
still talk about the Keychain, the connection string, `service_role` and
`sqlx`. `docs/development-secrets.md`, `docs/background-cloud-solver.md` and
`docs/remote-ops-observability.md` each carry one or two.

None of it is true any more. A README that confidently describes the wrong
design is worse than no README, because it is believed.

### Can `.development.env` go?

`npm run config:where` answers this per machine — it reports, for each of the
four bootstrap credentials, whether it came from the app or the env file, and
refuses to say "safe to delete" while anything still needs it.

### The venv that activates in every new terminal

`source .../fisk_voting_system/.venv_report/bin/activate` runs on every shell,
and it is not in any of the usual shell startup files. Almost certainly VS Code
or Cursor auto-activating a Python interpreter selected for another workspace —
Command Palette → *Python: Select Interpreter*, or Settings → `activateEnvironment`.

Worth fixing rather than tolerating: that venv sits ahead of everything on
`PATH`, so `python3` and anything shelling out through it during a build has
been resolving through another project's environment. It makes build failures
harder to attribute, which is exactly what happened with the `NODE_ENV` one.

### The iOS companion

`ios/CodeEditorCompanion` exists and is unfinished. It has device-registration
config (`CODE_EDITOR_DEVICE_REGISTRATION_URL` / `_TOKEN`) and predates the
server API entirely — so whatever it talks to, it is not the tenancy-scoped
model everything else now uses. Needs a decision: finish it against the Edge
Function, or park it explicitly.

---

## Carried over from before the server migration

These predate all of the above and none of them are blocked.

- **`npm run test:e2b` has never run.** The C++ toolchain inside E2B is
  unverified, so benchmark runs there are an assumption.
- **The review is not persisted with runs** — there is no column for it, so a
  run's review exists only for as long as the pane holds it.
- **`benchmarkBackend` / `executionProvider` are not settable in Settings.**
  They are read from config and changeable only outside the app.
- **The reviewer does too much in one call** — a review plus three language
  ports in a single request. Splitting it would make each part checkable.
- **`knownRouterModels` in `models.ts` is orphaned.** Nothing reads it.
- **The Council panel is not in the accordion**, unlike every other panel.
- **Tooltips are native `title=` attributes** — 55 of them across twelve
  components, no custom tooltip anywhere. Fine for icon buttons; no good for
  anything needing to appear instantly, be positioned, or work on keyboard
  focus. Decide whether that is worth a real component before adding more.

---

## Multi-tenancy, phase 06

From the tenancy plan. Not needed while you are the only account, and all of it
is needed before signups open.

- **Per-user storage ceiling**, checked before upload rather than after the
  bill. Screenshots are the expensive part.
- **Retention** — purge screenshots older than *n* days, keeping the row so
  history still reads. The `purged` flag on `screenshots` already exists for
  exactly this.
- **Rate limit** on `solve_jobs` creation per user per hour.
- **A signup path.** There is none: a second account today needs a SQL insert
  plus `npm run auth:set-pin`. That is deliberate, but it is manual.

### The decision that shapes phase 03's encryption

**Can the cloud worker run while a user is logged out?**

Yes means you hold readable copies of everyone's TokenRouter and GitHub keys,
and a breach of the project is a breach of all of them. No means real envelope
encryption — their password derives a key, that key wraps a data key, the data
key encrypts their secrets — and background solving stops between sessions,
because you genuinely cannot read their key.

Much cheaper to answer before building around the other assumption.

---

## Telegram bot as a second client, phase 07

Decided, not started. Today Telegram is outbound only — `notifyOps()` in
`scripts/observability.mjs` posting ops alerts to one chat id. The feature wanted
is the other direction: send the bot a screenshot, it runs the same Council the
desktop runs, and it sends the whole result back.

The shape that makes this cheap is that it is **a second client for the API that
already exists**, not a second system. The desktop is client one. The bot calls
the same ops — `sessions.create`, `storage.uploadUrl`, `jobs.create` — and the
worker, which polls `solve_jobs` by status and has never cared who queued a row,
runs unchanged. Ingestion is plumbing. The four pieces below are what is missing.

### 1. `telegram_links`, and how a chat proves who it is

Every op is scoped by `principal.userId` from a bearer token. A Telegram update
carries a `chat_id` and nothing else. So: a table mapping one to the other, and
a flow that fills it.

```sql
create table if not exists telegram_links (
  chat_id      bigint      primary key,
  owner_id     uuid        not null references app_users (id) on delete cascade,
  linked_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz
);
```

The link flow reuses the identity that already exists rather than inventing a
second one — the same move `auth.helperToken` makes. The desktop, already signed
in, mints a short-lived single-use code through a new op (`telegram.linkCode`);
the user sends `/link ABC123`; the webhook redeems it and writes the row. A
"Link Telegram" panel in Settings alongside the helper authorisation.

**The PIN must never be typed into Telegram.** Not as a convenience, not as a
fallback. Telegram messages sit in plaintext on Telegram's servers and in the
history on every device signed into that account, and a four-digit PIN in a chat
log cannot be un-leaked. The link code exists precisely so the PIN never travels
that path.

An unlinked chat gets exactly one reply — how to link — and nothing else. Anyone
can find a bot and message it, so the unauthenticated surface has to be as
boring as `PUBLIC_OPS` is.

Decided: available to any Council Editor user, not just the owner. That is what
the multi-tenant schema was built for, and a bot that only one person can use
does not justify the webhook.

### 2. `supabase/functions/telegram-webhook`

A second Edge Function. Telegram needs a public HTTPS URL, which Supabase gives
free. Deployed `--no-verify-jwt`, because Telegram will not send an `apikey`
header — authenticated instead by the `X-Telegram-Bot-Api-Secret-Token` header
set at `setWebhook` time, compared against a function secret.

It must acknowledge fast. Telegram retries an update it does not see a 200 for
within about a minute, and a Council run is minutes. Queue and return; never
await the result. The current architecture already does the right thing here —
the note is so nobody later decides to "simplify" it by waiting.

### 3. Photo in

`getFile` → download from `api.telegram.org/file/bot<token>/<path>` → PUT to
Storage at `${userId}/telegram/${uuid}.png` → `sessions.create` →
`jobs.create`. The path prefix is not cosmetic: `ops.ts:919` refuses an upload
path that does not start with the caller's own id, and that guard is what stops
a bug in the webhook from writing into someone else's prefix.

Two limits worth knowing before writing it:

- Telegram re-encodes anything sent as a **photo** — downscaled, JPEG-crushed.
  For screenshots of code that degrades OCR badly. Treat `message.document` with
  an image mime as the good path and tell people to send "as file"; accept
  `message.photo` (largest size) but expect worse extraction confidence.
- `getFile` will not serve a file over 20 MB to a bot.

### 4. Everything comes back

Decided: the bot returns what the desktop returns. Not a summary — the winner,
the standing and its reason, the synthesis, the reading and agreement, the
benchmark evidence, complexity analysis where the problem had one. If the
desktop shows it, the chat gets it.

Telegram caps a text message at 4096 characters and a council report is far
longer, so the transport is: a short text reply with winner and standing so the
chat is readable at a glance, plus the **complete** `council_reports.markdown`
as a `sendDocument` attachment. The attachment is the deliverable and nothing is
trimmed out of it. Do not attempt MarkdownV2 formatting on report text — its
escaping rules will fight the content constantly, and the document sidesteps
them entirely.

Routing needs the worker to know where a job came from:

```sql
alter table solve_jobs add column if not exists origin text not null default 'desktop';
alter table solve_jobs add column if not exists origin_ref jsonb not null default '{}'::jsonb;
```

`origin_ref` holds `{ chatId, messageId }`. Resist putting it in
`settings_snapshot` to dodge the migration — that field is a snapshot of
provider settings and gets fed to the council; delivery routing does not belong
in it.

Then one branch in the worker on `completed`, `needs_attention` and `failed`.
**Write it filtered by owner from the start** — the bug recorded above under
"Security, unresolved" is exactly what this branch would reproduce if it were
modelled on `notify()`.

### Build order

Each step is independently testable and nothing before step 4 changes existing
behaviour.

1. `telegram_links` + `telegram.linkCode` + `/link`. Ship alone and confirm the
   mapping before a single photo moves.
2. The `origin` / `origin_ref` migration.
3. The webhook's photo path, replying "queued".
4. The worker's delivery branch.

### Prerequisites

- Regenerate the bot token (see "Security, unresolved"). Non-negotiable before
  the bot receives anyone's screenshots.
- Fix the `notification_devices` owner filter, so the delivery branch is written
  against a correct example rather than the wrong one.

### Open, not yet decided

- Rate limiting. A linked chat that sends fifty photos queues fifty Council runs
  against that account's TokenRouter key. Some per-chat ceiling is needed; where
  it lives (webhook, `app_config`, per-user) is not settled.
- Whether `/status` and `/cancel` are worth having, or whether the app stays the
  only place to manage a running job.
- Group chats. A `chat_id` can be a group, and linking one means every member
  queues jobs against one person's key. Simplest first answer is to refuse any
  non-private chat.

---

## AI glasses as a capture source, phase 08

Researched August 2026 against `RayBan_Meta_iOS_Capture_Pipeline_Research_README.md`,
which is accurate and should be read alongside this. Not started.

That document's conclusion is that the SDK path is primary and the Photos-library
path is the fallback. **For Council Editor specifically that ordering is
backwards**, for one reason the document flags in section 9 but does not connect
to what this app does.

### The number that decides it

Council Editor reads *text off screens* — code, problem statements, stack
traces. It is the most resolution-sensitive workload a camera can be pointed at,
because monospace OCR fails on exactly the characters that matter: `l` / `1` /
`I`, `O` / `0`, `.` / `,`.

| Path | Output | Pixels |
|---|---|---|
| Glasses native sensor | 3024 × 4032 | 12.2 MP |
| DAT `capturePhoto()` | 1080 × 1440 | 1.56 MP |
| DAT, reported elsewhere | 720 × 1280 | 0.92 MP |

A Meta maintainer confirmed in discussion #127 *why*: "the way to capture images
with the Device Access Toolkit is by capturing frames of the video stream,
that's why the resolution is lower than photos you would take with the glasses."
`capturePhoto()` is a frame grab off a Bluetooth video stream. It is not a
photograph. No commitment was given to exposing native capture; discussion #119,
which proposes an async `captureNativePhoto()`, has no Meta reply at all.

Work it through. A screen filling half the frame height, showing forty lines of
code:

- **DAT:** 1440 × 0.5 ÷ 40 ≈ **18 px per line** — cap height around 9 px.
- **Native:** 4032 × 0.5 ÷ 40 ≈ **50 px per line** — cap height around 26 px.

Reliable OCR wants roughly 20 px of cap height and degrades badly below about
12. So the DAT path lands under the floor for the one thing this app exists to
do, and native lands comfortably over it. That gap is 2.8× linear and it is not
closeable by prompting, by better readers, or by a nicer queue.

Estimates, not measurements — but this project already owns the instrument to
settle it. `runReading()` computes an extraction confidence and, with two
readers, an agreement score; `reading_done` logs both per job. Photograph the
same screen both ways, queue both, compare `reading.confidence` and
`reading.agreement.agree`. No benchmark harness needed.

### The reframe

Once resolution is the binding constraint, the trade the research document
describes inverts — and the native path turns out to shed both blockers too.

**Native capture → Meta AI auto-import → Photos → PhotoKit**

- 12 MP, the full sensor.
- No DAT dependency, so no `com.meta.ar.wearable` entry under
  `UISupportedExternalAccessoryProtocols`, so **no MFi rejection**. Issue #149 is
  a developer whose app was refused with "the app has not been authorized by the
  accessory manufacturer" and got no answer. That rejection is caused by linking
  the SDK. Not linking it avoids it entirely.
- Not bound by the developer-preview publishing restriction, because it uses no
  preview SDK. Shippable to the App Store now, to anyone, on shipping glasses.
- The physical button is the trigger — which for this app is *correct*, not a
  limitation. You look at a problem on a screen and press the button. There is
  nothing for `capturePhoto()` to add; the app was never going to decide when to
  photograph.

What it costs, stated plainly:

- **Latency is not yours to control.** `PHPhotoLibraryChangeObserver` fires while
  the app is live; iOS suspends apps and makes no promise a terminated app wakes
  for every import. Realistic behaviour is "processed when the app next gets
  runtime", not "instant". Tolerable when a council run takes minutes anyway,
  and a real UX cost if you wanted true hands-free.
- **Identifying which photos came from the glasses.** Read EXIF `TIFF.Model` off
  the asset via `requestImageDataAndOrientation`, or watch whatever album
  auto-import writes to. Both need confirming against one real photo before
  anything is built on them — this is the first thing to test.
- **Full photo-library permission** draws genuine App Store review scrutiny. The
  justification has to be written before the app is submitted, not after.
- **Auto-import can be switched off**, and the feature dies silently when it is.
  Detect it and say so.

### Where DAT still earns a place

Not discarded — deferred, and used for what it is actually good at. Live 720p
frames are the right tool for *aiming*: a preview that confirms the screen is in
frame and roughly in focus before the shutter, and a "sharpen up, that was
blurry" signal after. Cheap, and it fixes the worst failure of a
button-triggered capture, which is finding out ten minutes later that the OCR
read nothing because the shot was tilted.

Revisit DAT as the capture path when Meta ships native capture and answers the
MFi question. Watch discussions #119, #127, #134 and issue #149 — those four
threads are the whole gate.

### How it lands on what already exists

Almost none of this is new backend. A glasses capture is a job with
`origin = 'glasses'` on the phase 07 columns.

```text
glasses → Meta AI auto-import → Photos → PhotoKit observer
        → CodeEditorCompanion → storage.uploadUrl → PUT
        → sessions.create → jobs.create
        → worker (unchanged) → council_reports
        → APNs → watch
```

Reused unchanged: Storage, `sessions.create`, `jobs.create`, the worker, the
council, `council_reports`, and the `origin` / `origin_ref` routing. New: the
capture-watching code inside `ios/CodeEditorCompanion`, which already reads job
history from Supabase and registers for APNs, and a watchOS target.

The research document's queue design (sections 6, 7, 12) is right and should be
kept — persistent, not in memory; unique capture ids; retry with limits;
duplicate detection; backpressure. It applies unchanged to the PhotoKit path,
where the queue holds `PHAsset` local identifiers instead of `PhotoData`. Its
capture state machine maps cleanly onto `solve_jobs.status`.

Note the app must upload to `${userId}/glasses/${uuid}.jpg` — `ops.ts:919`
refuses any path not prefixed with the caller's own account id.

### The watch end

`ios/CodeEditorCompanion/README.md` says Watch support comes through iPhone
notification mirroring and no watchOS app is needed for v1. True for a
*notification*; not true for reading an answer — mirroring shows the push, not
the report.

A watch target gets its own APNs device token, and the topic must be the
`...watchkitapp` bundle id rather than `...watchkitapp.extension`; using the
extension is the usual cause of `DeviceTokenNotForTopic`, and it fails silently.

And be honest about the screen: synthesis, standing, reading agreement,
benchmark evidence and complexity analysis is not a watch document. Verdict on
the wrist — winner, standing, one line, job state — full report on phone and
desktop.

### Build order

Steps 1 and 2 are an afternoon and they decide whether the rest is worth doing.
Do not skip to step 3.

1. **Take two photographs.** One with the glasses' physical button, one through
   a throwaway DAT app. Same screen, same code, same distance. Queue both. Read
   `reading.confidence` and `reading.agreement.agree` off the `reading_done`
   events. If the native shot does not clear the bar either, the whole phase is
   dead and that is worth knowing on day one.
2. **Confirm the photos are identifiable.** One glasses photo, dumped EXIF. If
   `TIFF.Model` does not distinguish it and auto-import writes to no distinct
   album, the PhotoKit path needs a different discriminator before anything
   else is built.
3. PhotoKit observer in `CodeEditorCompanion` — enqueue, upload, `jobs.create`,
   with the persistent queue from the research document's section 12.
4. `origin = 'glasses'` end to end, verified against a real council report.
5. watchOS target: verdict card plus its own APNs registration.
6. Optional DAT preview for aiming, once everything above works.

### Prerequisites

- Apple Developer Program enrolment — already blocking the signed desktop
  release, and blocking two targets here.
- The `notification_devices` owner filter under "Security, unresolved". Do not
  add a watch as a second push target to a path that currently notifies every
  account in the project.
- Phase 07 first. Telegram exercises the same `origin` / `origin_ref` routing
  with no hardware, no Apple enrolment and no platform approval, and it can be
  tested from a laptop. Getting it wrong there is cheap.

---

## Small and loose

Nothing here is hard. They are written down so they stop being remembered.

### There is no CI

`.github/workflows/` has only `cloud-benchmark.yml`. `npm run check` already
runs typecheck, lint, the JS suites and `cargo check` — nothing runs it but a
person.

This is worth more than it sounds. Over this migration a *cached* `cargo check`
reported "Finished" in 2.59s and I read it as a pass; the real failure only
surfaced when `tauri dev` rebuilt. A workflow running `npm run check` on push
would have caught that, and several like it.

### Three one-shot SQL files have served their purpose

`supabase/auth-functions.sql`, `tenancy-orphans.sql` and
`tenancy-constrain.sql` have all been applied. The first duplicates what is in
`migrations.sql`; the other two are genuinely one-shot. Decide whether they stay
as a record or go — an applied migration sitting loose in a folder invites
someone to run it again.

### Stale rows in `app_config`

`NODE_ENV`, `PORT` and `CODE_AUDITOR_ADMIN` are still stored. All three are
inert now — the config loader refuses to inject the first two, and the seed
constants that used the third are deleted — but stale config is config someone
will eventually believe.

### Two storage path shapes

Screenshots uploaded before the migration are at `{session_id}/{file}`;
everything since is at `{owner_id}/{session_id}/{file}`. Both work, because the
row carries its own path and `storage.sign` checks the row rather than the
shape. Not a bug, but worth knowing before anyone writes something that assumes
one layout.

### Vestigial code left deliberately

- `server_api::available()` can no longer return false — the endpoint is
  compiled in. Every caller still checks it. Harmless, and honest about a
  fallback that no longer has anywhere to fall to; collapsing it would be a
  wide, low-value diff.
- `config::value()` is `#[allow(dead_code)]`. Nothing calls it yet; it is the
  only non-command path to a secret and will be wanted the moment Rust needs
  one directly.
- `lock_seconds_for` / `FREE_ATTEMPTS` are dead but kept as the written
  specification of the lockout the SQL enforces, with the tests that argue why
  four digits is defensible. If the two ever disagree, one is wrong.

### Branches and origin

Thirteen commits ahead of `origin/main`, unpushed, across four local branches:
`server-api-migration`, `tenancy-orphan-fix`, `todo-and-arm64-scope`. Merge and
push, or the only copy of this work is one laptop — which is a strange place to
end a migration about not depending on one laptop.

---

## Done, so it does not get re-done

- Every read and write goes through the Council Editor API. No `sqlx` in the
  app, no Postgres connection, no connection string.
- Nothing is stored on the Mac except the helper's 30-day session token —
  revocable from the database, rotated on every renewal.
- Sign-in is username and PIN verified in Postgres against bcrypt, peppered by
  a secret the Mac has never held, with the lockout enforced beside the
  comparison.
- `owner_id` on every table, mandatory and cascading, with a lint and a
  two-account probe proving nothing crosses between accounts.
- Configuration lives in `app_config`, per user, with a platform tier.
- The app builds signed for arm64.
