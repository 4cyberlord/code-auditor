# Code Auditor

Four frontier models read the same screenshot, solve it independently in four panes,
and submit their answers to a solution box that tells you whether they agree.

Works for coding problems and for ordinary questions. Each agent decides which it is
looking at, or you can force the mode.

---

## Running it

```bash
npm install
npm run app:dev        # dev build with hot reload
npm run app:build      # produces a .app and a .dmg in src-tauri/target/release/bundle

npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # the consensus suite
```

Requirements: Node 22.6+ (the test suite runs TypeScript directly, with no build step),
Rust (`curl https://sh.rustup.rs -sSf | sh`), and Xcode command line tools
(`xcode-select --install`). Nothing else — the icons and Tauri config are already in the
repo.

If a `next` upgrade leaves `next dev` failing with `data did not match any variant of
untagged enum Config`, the `.next` cache was written by the previous SWC binary:
`rm -rf .next` and start again.

`package.json` carries two `overrides`. Next 15.5 pins `postcss` to 8.4.31 and admits
`sharp` below 0.35, both of which have high-severity advisories against them. Neither is
reachable here — the only CSS in the project is written by hand, and `sharp` exists to
serve `next/image`, which is off (`images.unoptimized`) and unused in a static export —
but they still fail `npm audit`. The overrides are patch bumps inside the same major,
which is a much smaller change than the `next@16` major that `npm audit fix --force`
proposes. Drop them once Next ships a release that has moved on.

First launch: press `⌘,` and paste in the API keys you have. Any agent without a key
sits out; the app runs fine on two or three.

| Provider | Where to get a key | Default model |
|---|---|---|
| OpenAI | platform.openai.com/api-keys | `gpt-5.6-sol` |
| Moonshot (Kimi) | platform.moonshot.ai | `kimi-k3` |
| Anthropic | console.anthropic.com | `claude-opus-5` |
| Google | aistudio.google.com/apikey | `gemini-3.7-flash` |

Model IDs are free-text fields in Settings. When a vendor ships something new, type the
new ID — no rebuild.

---

## Using it

Drop a screenshot on the well, paste one with `⌘V`, or click to browse. Add a note if
the picture needs context. `⌘⏎` runs everything.

Or never touch the window at all:

| Key | What it does |
|---|---|
| `⌃7` | Crosshair region grab, from anywhere, app hidden or not |
| `⌃8` | Run every configured agent on whatever is loaded |
| `⌘,` | Settings |
| `⌘⏎` | Run, when the window has focus |

Note `⌃` and not `⌘`: Control-7 and Control-8. Both are also in the menu bar icon, for
when another app has claimed the accelerator. Two keys rather than one is deliberate —
it leaves room to grab a second region or type a note before spending four API calls.

The accelerators are registered in Rust, not from the webview. A hotkey registered in a
React effect lives and dies with that mount: Strict Mode runs every effect twice, and
`unregister` takes an accelerator name rather than a listener handle, so the first pass's
cleanup can revoke the registration the second pass just made. Both keys then do nothing,
with nothing logged. Registering once per process cannot lose that race.

**Screen Recording permission is required**, and this is the thing most likely to make
`⌃7` look broken. `screencapture` exits non-zero and writes no file both when the user
presses Escape and when macOS refuses, so the exit code cannot tell those apart; the
capture reads stderr to separate them, because reporting a refusal as a cancel is exactly
what makes a working hotkey look like a dead key.

Grant it under System Settings › Privacy & Security › Screen & System Audio Recording.
Under `app:dev` there may be nothing there to grant: `tauri dev` runs the bare binary at
`src-tauri/target/debug/code-auditor`, which has no bundle identifier for TCC to attach a
grant to, so the prompt often never appears and any approval lands on the terminal that
launched it instead. Run `npm run app:build` and launch the bundled app if the shortcut
refuses to capture. The global shortcuts also only exist while the app is running — from
a dev server, that means only while the terminal is open.

All four agents get the **raw image**, not a shared transcription. That is deliberate:
if one model transcribes the image first and the rest work from its text, its OCR
mistakes become everyone's mistakes and the whole comparison is worthless. Four
independent readings mean a misread character shows up as disagreement instead of
propagating silently.

---

## How the comparison works

Each agent ends its reply with a `FINAL` block — kind, language, answer, claims,
confidence, code. The solution box parses those and compares every pair on three axes:

- **Code** — comments, strings and layout stripped, then identifiers masked so `seen`
  and `d` count as the same variable. Two correct solutions match; a hash map and a
  nested loop do not.
- **Claims** — each supporting claim finds its best partner in the other answer.
- **Answer** — the one-line answer, stemmed so "applies"/"apply" match.

Agents that agree get merged into camps, and the verdict is unanimous, majority, split,
or none. The threshold slider moves the bar if the default is too loose or too strict
for your problems.

### What this does not tell you

It measures **agreement, not correctness**. Four models can agree and be wrong
together, so nothing in the UI says "verified".

The comparison is also lexical, which means it is much sharper on code than on prose.
Two research answers can mean exactly the same thing while sharing barely a word — the
test suite has a case where genuine paraphrases score 0.00 on the answer axis and only
the code carries the verdict. So:

- Prose-only runs are flagged as low reliability in the solution box.
- The **judge** pass sends every FINAL block to one model and asks it to work out who is
  actually right, checking the reasoning rather than counting votes.
- Judge mode defaults to **When prose** — it runs itself automatically on exactly the
  runs where the word-overlap check is weakest, and stays out of the way otherwise.

---

## The council

Settings › Council promotes the panel into an engineering council. It changes what Run
means, and it is off unless you switch it on, because a council run can spend roughly
three dozen requests past the pane answers.

When armed, a run does this after the panes settle:

1. **Solve.** The visible panel's answers are always candidates. The council adds
   gateway-only solvers from a roster (ten by default) to fill the bench out — a declared
   model that is already a pane is never re-asked, because a pane's answer *is* its seat.
2. **Spec.** One model writes a machine-runnable test harness per language the field is
   written in, with a `<<<SOLUTION>>>` splice point where each candidate's own code goes.
   Harnesses that arrive without the marker are refused, because a harness that re-types
   the solution under test defeats the point.
3. **Execute.** Round-1 candidates run against that harness in the same sandboxed
   `run_code` path the Run button uses. A candidate that fails is **rejected at the gate**
   — no amount of panel agreement rescues it.
4. **Review.** Every solver then reviews the whole anonymised field (letters, never names)
   and its own work, alike. Reviews arrive with the measured results attached, and the
   prompt is explicit that the measurements override intuition.
5. **Revise.** Each solver gets one more pass, seeing the full field and only the reviews
   addressed to it. Revisions are verified the same way the originals were.
6. **Judge.** Up to seven judges each re-solve and re-review the whole record — originals,
   revisions, reviews, and both rounds of measurements — with an emphasis (algorithms,
   correctness, performance, engineering, security). The emphasis narrows attention, not
   scope: every judge reads everything.
7. **Synthesize.** One model assembles the final answer from the evidence table. It names
   a winner, lists what was rejected and why, and ships a corrected implementation.

The council's state, its gate table, and the full evidence trail are one click away in the
solution column. A cancelled council writes its partial record — three of five judges
deliberating is still evidence.

The roster lives in Settings as two free-text lists, one gateway model id per line. Any
model the key can reach works; nothing is recompiled when you change it.

---

## Keys and privacy

API keys go into the macOS Keychain under `com.charles.codeauditor`. The Rust side reads
them when it builds a request; the JavaScript can only ask *whether* a key exists, never
what it is. Every network call happens in Rust, which also sidesteps browser CORS —
Anthropic in particular refuses direct calls from a webview without an explicit opt-in.

Your images and prompts go to the providers you enable. Nowhere else. There is no
backend.

---

## Layout

```
src/
  app/            Next.js static export (the whole UI is one screen)
  components/     AgentPane, ConsensusPanel, CouncilPanel, InputBar, SettingsDialog, Markdown
  lib/
    models.ts     provider catalogue and default model IDs
    prompts.ts    the agent contract and the FINAL block spec
    parse.ts      FINAL block parser, with salvage for malformed replies
    consensus.ts  similarity, clustering, verdict
    council.ts    the council: candidates, harness parsing, prompts, the gate
    bridge.ts     typed wrapper over the Rust commands and events
    store.ts      zustand state, run orchestration, the council pipeline
    image.ts      downscale, flatten, re-encode before the payload is built
    shortcuts.ts  listens for the hotkey and tray events
    useAgentEvents.ts  four token streams coalesced into one frame's state
src-tauri/
  src/lib.rs        tray icon and menu, global shortcuts, close-hides-not-quits
  src/keychain.rs   Keychain read/write, key never returned to JS
  src/capture.rs    interactive region capture via screencapture(1)
  src/providers.rs  SSE streaming for all four providers, cancellation, usage
  capabilities/     the ACL: every window command the frontend calls needs naming
                    here, since core:window:default grants only read-only getters
```

Adding a fifth provider means one entry in `models.ts` and one arm in `build_request`
plus `extract_delta` in `providers.rs`. If it speaks the OpenAI wire format, reuse the
`openai | moonshot` arm and just set a base URL.

---

## Tests

The consensus engine has a standalone suite covering unanimous, majority, split,
degraded input, and paraphrase cases:

```bash
npm test
```

---

## Toward iOS

Tauri v2 targets iOS from the same codebase. `src-tauri/src/providers.rs` and the whole
`src/` tree carry over unchanged. Two things need work: the Keychain crate is
desktop-only, so key storage swaps to the iOS keychain API, and the 2×2 grid needs to
become a swipeable pager on a phone-sized screen. Neither touches the consensus engine.
