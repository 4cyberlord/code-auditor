# Solution Plan

 ## 1. Issue

 The user has a **background process** implemented in the application (a Tauri desktop app called "Council Editor"). They want:

 1. **Investigation** – understand what the background process currently does (its lifecycle, what it triggers, how it communicates).
 2. **Stealth / undetectability** – when the user clicks a global shortcut, the background process should start and run *silently* so that no other application (or OS-level process monitor) can easily detect it.
 3. **Silent image processing** – when the user sends pictures (screenshots) to the process for processing, it should work without visible UI, tray icons, or window flashes.
 4. **Telegram delivery** – the results of the processing should be sent to the user via a Telegram bot.

 The user asks: *"how can we achieve this?"*

 ## 2. Root cause / Current state

 From the evidence gathered (directory listing, README, package.json, and glob searches):

 - The project is a **Tauri v2 + Next.js** desktop application (`src-tauri/` contains the Rust backend; `src/` contains the React/Next frontend).
 - `package.json` confirms dependencies on `@tauri-apps/api`, `@tauri-apps/plugin-global-shortcut`, `@tauri-apps/plugin-shell`, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-http`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-log`, `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-autostart`.
 - The README describes the app as "Council Editor" – four frontier models read the same screenshot, solve independently in four panes, and submit answers to a solution box.
 - **Glob searches for `src/**/*background*`, `src/**/*worker*`, `src/**/*daemon*` returned no matches** – meaning there is no dedicated file named with those keywords yet. The "background process" is likely implemented as:
 - A **Tauri sidecar / external binary** (see `Dockerfile.worker` at the repo root, suggesting a worker process), OR
 - A **Tauri command / Rust thread** spawned from the main process, OR
 - A **global-shortcut-triggered hidden window** that performs the work.
 - The `src-tauri/` directory exists (confirmed by glob) but its internal files were not individually read in this session. The `Dockerfile.worker` at the root strongly implies a **separate worker binary/container** that the Tauri app shells out to.
 - There is a `scripts/` directory and `out/` directory (likely build output for the sidecar).

 **Key gap:** Without reading the actual Rust source in `src-tauri/src/` (main.rs, lib.rs, commands, etc.) and the `Dockerfile.worker`, we cannot enumerate the exact current behavior of the background process. However, the architecture is clear enough to plan the stealth + Telegram integration.

 ## 3. Evidence gathered

 | Resource | What it showed |
 |---|---|
 | `.` (root directory) | 43 entries. Key items: `src-tauri/`, `src/`, `Dockerfile.worker`, `scripts/`, `out/`, `package.json`, `README.md`, `IMPLEMENTATION_PLAN.md`, `TODO.md`, `docs/`, `ios/`, `supabase/`, `tests/`, `test-fixtures/`, `oracle/`, `council-runs/`, `bench-problems/`. Two `.p8` auth keys (Apple push). `.development.env`. |
 | `README.md` (407 lines) | App is "Council Editor". Uses `npm run app:dev` / `npm run app:build`. Tauri + Next.js. Four model panes, solution box. Mentions `npm run typecheck`. |
 | `package.json` | Confirms Tauri v2 plugins: `global-shortcut`, `shell`, `fs`, `http`, `dialog`, `log`, `updater`, `autostart`. Also `next`, `react`, `tailwindcss`, `zustand`, `lucide-react`, `@supabase/supabase-js`, `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@mistralai/mistralai`. Scripts include `app:dev`, `app:build`, `typecheck`, `worker:build`, `worker:run`. |
 | `glob: src/**/*background*` | **No matches** – no file with "background" in its name under `src/`. |
 | `glob: src/**/*worker*` | **No matches** – no file with "worker" in its name under `src/`. |
 | `glob: src/**/*daemon*` | **No matches** – no file with "daemon" in its name under `src/`. |
 | `glob: src/**/*` | Confirmed `src/` has subdirectories (app, components, lib, hooks, etc.) but no background/worker/daemon-named files. |
 | `glob: src-tauri/**/*` | Confirmed `src-tauri/` exists with Rust source, `Cargo.toml`, `tauri.conf.json`, `build.rs`, `icons/`, `capabilities/`, `gen/`, `resources/`, `sidecars/` (likely). |

 ### Exact current code regions to be changed

 Because the individual Rust files under `src-tauri/src/` were not read in this session (only the directory was confirmed to exist), the plan below references the **expected file paths** based on standard Tauri v2 project layout. The executing run should read these files first:

 - `src-tauri/src/main.rs` – entry point, window creation, plugin registration.
 - `src-tauri/src/lib.rs` – `run()` function, `tauri::Builder`, command registration.
 - `src-tauri/src/commands.rs` (or `src-tauri/src/commands/mod.rs`) – Tauri command handlers.
 - `src-tauri/tauri.conf.json` – window config (visible/hidden), bundle config, sidecar config.
 - `src-tauri/Cargo.toml` – dependencies (tokio, reqwest, serde, etc.).
 - `Dockerfile.worker` – worker build definition.
 - `scripts/` – build/run scripts for the worker.
 - `src/app/` or `src/components/` – React frontend that triggers the shortcut and displays results.

 ## 4. Changes to make

 ### Change 1 – Make the main window hidden (stealth)

 **File:** `src-tauri/tauri.conf.json`

 **Find the window configuration block** (exact text will be confirmed by reading the file). It likely looks like:

 ```json
 "windows": [
 {
 "title": "Council Editor",
 "width": 1200,
 "height": 800,
 "visible": true,
 ...
 }
 ]
 ```

 **Replace `"visible": true` with `"visible": false`** (or add `"visible": false` if absent). This makes the window invisible at launch. The user can still toggle visibility via the global shortcut if desired.

 **Why:** A visible window is the most obvious sign of a running app. Hiding it means no window appears in the taskbar/dock/mission control.

 ---

 ### Change 2 – Register a global shortcut that toggles the hidden window

 **File:** `src-tauri/src/lib.rs` (or `main.rs`)

 In the `setup` closure of `tauri::Builder`, add (or verify) the global-shortcut plugin registration:

 ```rust
 use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

 // Inside .setup(|app| { ... })
 app.global_shortcut().register(
 "cmd+shift+c", // or whatever shortcut the user prefers
 move |app_handle, shortcut, event| {
 if let ShortcutState::Pressed = event.state() {
 if let Some(window) = app_handle.get_webview_window("main") {
 if window.is_visible().unwrap_or(false) {
 let _ = window.hide();
 } else {
 let _ = window.show();
 let _ = window.set_focus();
 }
 }
 }
 },
 )?;
 ```

 **Why:** The user wants to trigger the process with a keyboard shortcut. The window stays hidden unless explicitly shown.

 ---

 ### Change 3 – Ensure the app does not show in the Dock / Taskbar

 **File:** `src-tauri/tauri.conf.json`

 Add to the window config:

 ```json
 "visibleOnAllWorkspaces": false,
 "skipTaskbar": true
 ```

 On macOS, also set the activation policy to `Accessory` (no Dock icon) in `src-tauri/src/main.rs`:

 ```rust
 #[cfg(target_os = "macos")]
 mod macos {
 use objc::runtime::Object;
 use objc::{class, msg_send, sel