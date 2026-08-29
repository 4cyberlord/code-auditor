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
