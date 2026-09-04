# Solution Plan

 ## 1. Issue

 The user wants the in-app display name of the product to read **"Council Editor 0.1.0"** (i.e. the version number `0.1.0` appended to the full product name) wherever the app shows its own name *inside the running application*.

 Explicit constraint: **do not** change the name that appears on the macOS application bundle / window title bar (the "docker" = the macOS app shell). Only the text rendered *within* the app UI should gain the `0.1.0` suffix.

 Observed symptom: the app currently shows "Council Editor" (no version) in its internal UI surfaces (boot screen, page header, etc.).

 ## 2. Root cause

 The product name is hard-coded as the string `"Council Editor"` in several places. The version `0.1.0` lives in `src-tauri/tauri.conf.json` (`"version": "0.1.0"`) but is never interpolated into the in-app display strings. The two in-app surfaces that render the product name to the user are:

 - `src/app/layout.tsx` line 70 — the boot-screen wordmark `<p className="boot-name">Council Editor</p>` (shown before React hydrates, painted server-side).
 - `src/app/page.tsx` line 118 — the main page header text `Council Editor`.

 The macOS window title is set separately by Tauri via `src-tauri/tauri.conf.json` (`"productName": "Council Editor"` and `"title": "Council Editor"`), which is the "docker" name the user wants left alone.

 ## 3. Evidence gathered

 ### `src-tauri/tauri.conf.json` (macOS app shell — DO NOT CHANGE)
 ```json
 {
 "productName": "Council Editor",
 ...
 "title": "Council Editor",
 "version": "0.1.0",
 ...
 }
 ```
 This drives the `.app` bundle name, the window title bar, and the DMG name (`Council Editor_0.1.0_aarch64.dmg`). Leave untouched.

 ### `src/app/layout.tsx` (in-app boot screen — CHANGE)
 Current relevant lines:
 ```tsx
 export const metadata: Metadata = {
 title: "Council Editor",
 description: "Independent multi-model solving, benchmarking, and consensus.",
 };
 ```
 and the boot screen markup:
 ```tsx
 <p className="boot-name">Council Editor</p>
 <p className="boot-note">Starting up…</p>
 ```
 The `metadata.title` sets the browser tab / document title (not the macOS window chrome, which Tauri overrides), so it is safe to update for consistency, but the user's explicit ask is the visible in-app name. The boot-screen `boot-name` paragraph is the clearest "on top of the app" in-app name.

 ### `src/app/page.tsx` (in-app main header — CHANGE)
 Line 118 contains the literal text `Council Editor` rendered as the page's primary heading/header inside the workbench UI. This is the most prominent in-app name the user sees after boot.

 ### Other occurrences (intentionally NOT changed)
 - `src/components/HelperCard.tsx:122` — prose sentence "The capture hotkeys work while Council Editor is closed…" (descriptive copy, not a name label).
 - `login-preview.html` — standalone preview file, not part of the shipped app build.
 - `out/*` — build artifacts, regenerated on next build.
 - `ios/CodeEditorCompanion/*` — separate iOS companion, out of scope.
 - `scripts/*` — worker/server display strings, out of scope.

 ## 4. Changes to make

 ### Change 1 — `src/app/page.tsx` (main in-app header)

 - **File:** `src/app/page.tsx`
 - **Exact existing code to replace (line 118 context):**
 ```
 Council Editor
 ```
 (the standalone text node on line 118 that renders the app's main header)
 - **Replacement code:**
 ```
 Council Editor 0.1.0
 ```
 - **Why:** This is the primary in-app name the user sees in the workbench. Adding `0.1.0` makes the displayed name "Council Editor 0.1.0" as requested.

 ### Change 2 — `src/app/layout.tsx` (boot-screen wordmark)

 - **File:** `src/app/layout.tsx`
 - **Exact existing code to replace (line 70):**
 ```tsx
 <p className="boot-name">Council Editor</p>
 ```
 - **Replacement code:**
 ```tsx
 <p className="boot-name">Council Editor 0.1.0</p>
 ```
 - **Why:** The boot screen is the first thing visible "on top of" the app window before hydration. Updating it keeps the in-app name consistent from the moment the window opens.

 ### Change 3 (optional, for tab-title consistency) — `src/app/layout.tsx` metadata

 - **File:** `src/app/layout.tsx`
 - **Exact existing code to replace (line 6):**
 ```tsx
 title: "Council Editor",
 ```
 - **Replacement code:**
 ```tsx
 title: "Council Editor 0.1.0",
 ```
 - **Why:** Keeps the document/tab title aligned with the visible in-app name. In Tauri the window title is overridden by `tauri.conf.json`, so this does not affect the macOS chrome. If the user considers this out of scope, it can be reverted independently.

 ## 5. Order of operations

 1. Edit `src/app/page.tsx` — replace the line-118 `Council Editor` text node with `Council Editor 0.1.0`.
 2. Edit `src/app/layout.tsx` — replace `<p className="boot-name">Council Editor</p>` with `<p className="boot-name">Council Editor 0.1.0</p>`.
 3. (Optional) Edit `src/app/layout.tsx` — replace `title: "Council Editor",` with `title: "Council Editor 0.1.0",`.
 4. Rebuild the static output so the Tauri bundle picks up the new strings: `npm run build` (or `npm run app:build` for a full macOS bundle).

 No new files need to be created.

 ## 6. Verification

 1. **Static check** — confirm the strings are present in source:
 ```bash
 grep -n "Council Editor 0.1.0" src/app/page.tsx src/app/layout.tsx
 ```
 Expected: one match in `page.tsx` (line ~118) and one or two matches in `layout.tsx` (boot-name and/or metadata title).

 2. **Confirm macOS chrome unchanged:**
 ```bash
 grep -n '"productName"\|"title"' src-tauri/tauri.conf.json
 ```
 Expected: still `"productName": "Council Editor"` and `"title": "Council Editor"` (no `0.1.0` suffix).

 3. **Build & visual check:**
 ```bash
 npm run app:build
 open "src-tauri/target/release/bundle/macos/Council Editor.app"
 ```
 - The macOS window title bar should still read **Council Editor** (no version).
 - The boot screen and the main workbench header should read **Council Editor 0.1.0**.

 4. **Rebuild static output** (if only doing a web preview):
 ```bash
 npm run build
 grep -o "Council Editor 0.1.0" out/index.html
 ```
 Expected: at least one match.

 ## 7. Risks and rollback

 - **Risk:** If any CSS or layout assumes a fixed width for the name, the extra ` 0.1.0` could wrap or overflow. Mitigation: the `boot-name` and page header are plain text paragraphs/headings with no fixed-width constraint observed in the inspected code; visually verify in step 6.3.
 - **Risk:** The `out/` directory contains stale build artifacts. They will be regenerated by `npm run build`; no manual edit needed.
 - **Rollback:** Revert each edit by removing the ` 0.1.0` suffix (three one-line edits). No structural changes, so `git diff` will show exactly the touched lines.

 ## 8. Out of scope

 - `src-tauri/tauri.conf.json` — controls the macOS `.app` bundle name, window title, and DMG filename. User explicitly said not to change the "docker" (macOS app) name.
 - `login-preview.html` — standalone HTML preview, not shipped in the Tauri bundle.
 - `ios/CodeEditorCompanion/*` — separate iOS companion app.
 - `scripts/*.mjs` — background worker / cron / DMG packaging scripts; their log strings are operational, not user-facing in-app names.
 - `src/components/HelperCard.tsx` — descriptive prose mentioning "Council Editor" in a sentence, not a name label.
 - `out/*` — build artifacts, regenerated automatically.
 - All README / docs files — documentation, not runtime UI.