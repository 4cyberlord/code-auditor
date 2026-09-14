<p align="center">
  <img src="./public/app-icon.png" width="112" height="112" alt="Council Editor logo" />
</p>

<h1 align="center">Council Editor</h1>

<p align="center">
  A desktop workspace for solving, reviewing, and improving technical answers with a multi-model council and a dedicated coding workspace.
</p>

<p align="center">
  <strong>macOS desktop</strong> · <strong>Tauri</strong> · <strong>Next.js</strong> · <strong>Rust</strong> · <strong>TypeScript</strong>
</p>

---

## Overview

Council Editor is a private desktop application built for code review, algorithm problems, technical reasoning, and structured answer comparison. It lets multiple configured models read the same input, solve independently, compare their outputs, and produce a clearer final result.

The app is designed around two major workspaces:

- **Council**: runs multiple models in parallel, compares their answers, executes generated code when needed, reviews disagreements, and synthesizes a final answer.
- **Coding**: works against a selected local project folder, creates an implementation plan first, then applies code changes only after the plan is approved.

Secrets stay local through the macOS Keychain, and file-changing coding tools stay rooted to the project folder selected in the app.

## Features

- Multi-pane model runs for independent answers.
- Screenshot, paste, and file-based problem input.
- Consensus scoring across answer, claims, and code structure.
- Council mode with solver, reviewer, judge, and synthesis passes.
- Program execution checks for generated solutions.
- Dedicated Coding workspace with project-folder targeting.
- Plan-first coding flow with explicit approval before file mutation.
- Tool timeline, todos, diffs, pause, and continue controls.
- Local run history and background job visibility.
- macOS global shortcuts for capture and execution.
- Settings-driven model configuration.
- Keychain-backed provider and gateway credentials.
- Tauri desktop packaging for macOS.

## Workspaces

### Council

The Council workspace is for questions, screenshots, coding problems, and review tasks that benefit from independent model comparison.

Typical flow:

1. Add a screenshot, pasted image, or prompt.
2. Run the configured model panes.
3. Each pane produces its own answer.
4. The app parses structured final blocks.
5. Consensus scoring groups matching answers.
6. Optional judge and council passes review weak or conflicting outputs.
7. The final answer appears in the solution panel with supporting evidence.

For coding problems, the Council can also generate test harnesses, execute candidate code, reject failing solutions, and synthesize a stronger final implementation.

### Coding

The Coding workspace is for making changes inside a selected project folder.

Typical flow:

1. Choose the project folder in Settings.
2. Select the coding model in Settings.
3. Open the Coding workspace.
4. Ask for the change in the chat-style input.
5. Generate or refine the plan.
6. Approve the plan.
7. The coding agent reads, edits, and reports changes inside the selected project root.

The workspace keeps the experience focused: the project name is shown clearly, status is simple, and model/token controls stay in Settings.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Control+7` | Capture a screen region from anywhere |
| `Control+8` | Run the loaded task |
| `Command+Enter` | Run from the focused app window |
| `Command+,` | Open Settings |

Background capture helpers can also be configured for batch-style capture and submit workflows.

### Background helper overlay shortcuts

When the installed background helper is running, these are the overlay test shortcuts:

| Shortcut | Action |
|---|---|
| `Control+Option+C` | Toggle the coding overlay |
| `Control+Option+M` | Toggle the MCQ overlay |
| `Control+Option+B` | Start a helper capture batch |
| `Control+Option+P` | Capture the current screen into the helper batch |
| `Control+Option+Return` | Submit the helper batch |
| `Shift+Option+Arrow Keys` | Move the visible helper overlay |
| `Option+Up / Option+Down` | Scroll the visible helper overlay |

## Getting Started

### Requirements

- macOS
- Node.js 22.6 or newer
- Rust toolchain
- Xcode Command Line Tools

Install Xcode tools:

```bash
xcode-select --install
```

Install Rust:

```bash
curl https://sh.rustup.rs -sSf | sh
```

### Install

```bash
npm install
```

### Run In Development

```bash
npm run app:dev
```

This also builds the local Tauri sidecar under `src-tauri/binaries/`.
Those binaries are machine-specific generated outputs and are intentionally not
committed.
On macOS the helper is signed with `APPLE_SIGNING_IDENTITY` or
`CODESIGN_IDENTITY` when set, otherwise the scripts pick Developer ID
Application and then Apple Development. Set `CODE_AUDITOR_ALLOW_ADHOC=1` only
when you deliberately want a local-only ad-hoc helper.

### Build The Desktop App

```bash
npm run app:build
```

The packaged app and DMG are created under:

```text
src-tauri/target/release/bundle
```

For a release that can be shared with teammates on another Mac, use:

```bash
APPLE_ID="you@example.com" \
APPLE_PASSWORD="app-specific-password" \
APPLE_TEAM_ID="TEAMID1234" \
npm run app:build:signed
```

`app:build:signed` requires a Developer ID Application certificate and Apple
notarization credentials. It fails instead of producing a misleading
signed-but-unnotarized release, then verifies the built app and DMG with
`stapler` and `spctl`.

App Store Connect API credentials also work: set `APPLE_API_ISSUER`,
`APPLE_API_KEY`, and `APPLE_API_KEY_PATH` instead of the Apple ID variables.
If you saved credentials with `xcrun notarytool store-credentials`, set
`APPLE_NOTARY_PROFILE` to that profile name. The default profile name is
`notary-profile`.

## Configuration

Open Settings inside the app to configure:

- provider or gateway credentials
- enabled pane models
- Council solver and judge rosters
- Coding workspace model
- Coding project folder
- Coding token and reasoning settings
- capture and background job preferences
- local account and session settings

Credentials are stored through the macOS Keychain. The frontend can check whether a key exists, but it does not receive the raw key value.

## Security Model

- Provider keys are stored in the macOS Keychain.
- Database and model access are guarded by the Rust side of the app.
- Coding tools are constrained to the selected project root.
- File traversal and symlink escapes are blocked in the Rust tool layer.
- The app uses an explicit approve-before-edit flow for coding changes.
- Screen Recording permission is required for macOS capture.

## Scripts

| Command | Purpose |
|---|---|
| `npm run app:dev` | Start the Tauri development app |
| `npm run app:build` | Build the macOS app bundle and DMG |
| `npm run helper:sidecar:dev` | Generate the development Tauri sidecar binary |
| `npm run helper:sidecar` | Generate the release Tauri sidecar binary and static frontend |
| `npm run typecheck` | Run TypeScript checks |
| `npm run lint` | Run lint checks |
| `npm test` | Run the test suite |
| `npm run check:rust` | Run Rust checks |
| `npm run check` | Run the full validation suite |

## Project Structure

```text
src/
  app/              Application shell and global styles
  components/       Workspace panels, dialogs, input, history, and output UI
  lib/              State, model routing, parsing, consensus, and orchestration

src-tauri/
  src/              Rust bridge, providers, auth, capture, storage, and tools
  capabilities/     Tauri command permissions
  icons/            Desktop application icons

tests/              TypeScript and worker tests
public/             Public assets used by the app and README
```

## Validation

Before publishing a change, run:

```bash
npm run typecheck
npm run lint
npm test
npm run check:rust
```

For a full pass:

```bash
npm run check
```

## License

Private project.
