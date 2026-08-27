# AI Engineering Workbench — Master README

> A multi-model AI engineering assistant that can capture problems from the user's screen, understand screenshots, reason across multiple AI models, retrieve trusted programming knowledge, solve coding and mathematical problems, execute and benchmark candidate code, repair failures, and deliver verified solutions.

## Current Status — 26 August 2026

Ticked boxes below mean *verified in the running application*, not planned or
partially wired. Where something exists but is incomplete it stays unticked and is
named here instead. This follows the project's own rule in section 67: do not mark
something done because it looks done.

**Verified in the running app**

| Area | State |
|---|---|
| Tauri + Next.js shell, tray, background operation | The window closes to the menu bar and the process survives, so the shortcuts keep working. Quit lives in the tray. |
| Global shortcuts | `Control+Option+S` screen, `Control+Option+R` region, `Control+Option+A` audit. Registered in Rust so they survive webview reloads. Confirmed firing in `~/Library/Logs/CodeAuditor/trace.log`. |
| Full-screen and region capture | Saved to `~/Pictures/Code Editor`, then loaded into the app. Whole chain confirmed: key, command, file on disk, thumbnail. |
| Screenshot handling | Up to 10 per run, thumbnails, delete, full-size preview with arrow-key navigation. |
| API keys | macOS Keychain. The webview can ask *whether* a key exists, never what it is. |
| Multi-model fan-out | Six panes — GPT, Claude, Kimi, Gemini and two free models — streaming in parallel. Each vision pane reads the image itself. |
| Routing | One `routeFor()` decides every request. Each pane shows the wire its answer came over, and its own token counts and elapsed time. |
| Vendor errors | A failing pane shows the vendor's own reason in plain English — `403 credit limit insufficient` arrived intact instead of as a blank box. |
| Consensus and judge | Camps, pairwise agreement matrix, outlier flagging, and a judge that reasons rather than counts votes. |
| A real answer, end to end | A captured coding problem went out, models answered, the FINAL blocks parsed, consensus ran, and the judge produced a verdict and a shipped solution that was read on screen. |
| Postgres | Supabase connected, schema self-applied. Session sidebar lists, renames, archives and deletes. |
| Background cloud job storage | Supabase now stores Council-only background solve jobs, ordered job screenshots, append-only job events, Council reports and notification device tokens. |
| Background helper controls | Settings can install, remove and inspect the user LaunchAgent for the dedicated helper binary. This is quiet background operation, not stealth. |
| Dedicated helper v1 | `cloud-sync-helper` owns start/capture/submit hotkeys, captures full-screen screenshots with macOS `screencapture`, stores pending batch state locally, uploads to Supabase Storage and queues Council jobs from Keychain credentials. |
| Cloud Jobs history | The desktop rail can list queued/running/completed cloud jobs, queue the current workspace screenshots, show ordered screenshot thumbnails, recent events and final report summaries. |
| Cloud worker v1 | `scripts/cloud-worker.mjs` claims queued jobs, downloads ordered screenshots, runs independent TokenRouter chat-model solvers, benchmark harness generation, local worker verification, optional Codespaces mirrors, reviewer passes, judge reports and synthesis, writes Council reports and marks jobs completed. |
| Product rename | The release bundle, window title, login screen and tray labels now ship as **Code Editor**. Internal binary and keychain identifiers remain stable for migration safety. |
| Remote ops scaffolding | cron-job.org, QStash, E2B and GitHub Actions integration entrypoints are documented and scaffolded so scheduling and heavy validation can move off the laptop. |
| Worker observability | The cloud worker has optional Sentry breadcrumbs/errors and Telegram operations alerts for failed, needs-attention and slow jobs, with screenshots/prompts/answers stripped from telemetry. |
| Packaged release | `npm run app:build` now produces `Code Editor.app` and `Code Editor_0.1.0_aarch64.dmg`; the app bundle contains the `cloud-sync-helper` sidecar. |
| Worker HTTP server | `npm run worker:serve` exposes `/api/worker-tick` for cron-job.org/QStash and `/api/register-device` for iOS APNs token registration without putting Supabase service-role credentials on the phone. |
| iOS companion foundation | `ios/CodeEditorCompanion` contains a native SwiftUI app foundation for APNs registration, Apple Watch mirrored notifications and Supabase job/event/report viewing. |

**What the last session retired**

The standing caveat — *"still unwatched: any model actually answering"* — is gone.
Models answered, the FINAL contract held on text nobody wrote for it, consensus
grouped the replies, and the judge picked a winner. Everything from the wire up to
the verdict has now been watched working rather than merely compiled.

The Supabase connection needed the *session pooler*, not the direct string.
Supabase no longer publishes an IPv4 address for `db.<ref>.supabase.co`, so on a
network without IPv6 that host does not resolve at all and the error arrives as a
DNS message that reads like a typo. The app now recognises that specific failure
and answers it with the pooler string for the project in question. The username
changes too — `postgres.<ref>` rather than `postgres` — which is the part people
miss.

**A capability table that was wrong, and what replaced it**

Kimi and Gemini failed on a screenshot that GPT and Claude read perfectly. The
obvious explanation was that they cannot accept images, and TokenRouter's own
catalogue appeared to confirm it — until the same catalogue turned out to list
`gpt-5.6-sol` and `claude-opus-5` as "Text" as well. That column describes what a
model *outputs*; models marked "Image" are image generators. It cannot answer the
question, and an earlier claim in this file that Qwen and Nemotron are text-only
rested on it. That claim is withdrawn.

Nothing published can settle it, so the app now measures it. **Settings → Test
these models** sends every model a 24×24 red PNG and asks what colour it is. Each
model gets a badge — *sees images* or *text only* — and the hover text separates
the three outcomes that matter: it read the square, it returned an HTTP error
worth reading, or the connection was dropped before it replied. That third one is
the signature of the gateway's OpenAI-compatible shim failing to translate an
`image_url` part for the backend behind it — a property of the *route*, not the
model, which is how Gemini can fail here while being natively multimodal
everywhere else.

The measurement then changes behaviour rather than decorating a badge. A pane the
probe finds blind is automatically given the transcription instead of the picture,
which is the entire reason the extraction pass exists. Only for gateway routes: a
probe of TokenRouter says nothing about calling Anthropic directly, and applying
it there would be the same mistake in the other direction. Eight tests cover the
override, including the case where the table says blind and the measurement says
otherwise.

**Every picture becomes a document — the countermeasure**

A screenshot is a capability, not a message. It only reaches a model whose route
actually carries an image, and two routes here demonstrably do not. Text has no
such requirement, so the app no longer depends on that capability.

The moment an image arrives — pasted, dropped, picked or captured — the reading
pass fires, without waiting for Run. Two vision models transcribe independently,
their readings are cross-checked, and the result is written as a Markdown
document: what the problem is, the code verbatim, the errors, the terminal, and —
before any of it — what the readers were unsure of and where they disagreed. That
document is saved beside the capture as `capture-<ms>.reading.md`, and it is what
every pane is then given. Panes whose route does carry an image get the picture as
well, so a model holding both can say the transcription is wrong, which is the
only way a bad reading is caught before it becomes the panel's answer.

Three consequences worth stating. The reading now starts while you are still
typing your note, so Run no longer waits on two vision calls. A pane that used to
fail on an image now answers from text. And when a model answers the wrong
question, the file on disk is how you tell whether the reader or the reasoner got
it wrong — a transcription you can open and correct by hand is the difference
between a black box and something debuggable.

The cost is the one this file has always named: a shared transcription means a
shared misreading. That is why two models read rather than one, why merged
confidence is the *lower* of the two and drops 40% on a disagreement that matters,
why ambiguities from either reader are carried into the prompt, and why the
document leads with its own doubt instead of burying it. Thirty-two tests cover
the renderer, including that a screenshot of Markdown cannot break out of its own
code fence, and that an empty reading declares itself empty rather than looking
valid. The Rust side has four more: the webview supplies a file *name*, never a
path, and anything with a separator or a parent segment is refused.

**Cloud Vision as the transcriber — splitting reading from understanding**

"Read this screenshot" turned out to be two jobs wearing one name, and the app
had been paying a reasoning model to do both.

Turning pixels into characters is **transcription**. An OCR engine does it better
than a reasoning model, and Cloud Vision does it at 1,800 requests a minute on a
quota that has nothing to do with the gateway's five, in about half a second, for
roughly a tenth of a cent an image — free for the first thousand a month — taking
sixteen images in a single call, so a tiled whole-screen capture is one request
rather than six.

Deciding what the screen *is* — the language, which lines are code and which are
terminal output, where the error is, what is actually being asked — is
**comprehension**, and Cloud Vision cannot do it at all. It will never say "this
is a two-sum problem".

Split, the expensive call stops being an image call, and most of the time is not
made at all. A picture arrives, Vision transcribes it, and the document is
written. If every pane can be shown the picture, nothing else happens — the
transcription goes to disk and no model ever interprets it. Only when a pane
exists that *cannot* be shown the picture does one model read that text and say
what the problem is, and that is a text request: no image tokens, one slot out of
five instead of two.

Two things fell out of the API that no vision model could give us:

- **Measured uncertainty.** Every symbol comes back with a confidence score. The
  reading document has always had a section for characters the reader was unsure
  of, and until now it was filled by asking a model to admit doubt — the single
  thing models are reliably worst at. They are numbers now, and they go in ahead
  of anything a model says about its own confidence.
- **Layout from geometry.** Every word carries a bounding box, so indentation is
  reconstructed by measuring where lines start rather than hoped for. In Python
  that is not cosmetic, it is the semantics. The character width is taken as a
  *median* — one icon misread as a letter and boxed across half the screen would
  drag a mean far enough to flatten every indent in the file.

Fifteen Rust tests cover the assembly: words rejoining into lines, nested
indentation surviving, a whole-page gutter not being read as eight levels of
nesting, a pixel of bounding-box jitter not becoming a space, a hyphen at a line
end not splitting an identifier in two, and an invalid key reading differently
from a disabled API.

**And the routing goes back to per-capability.** Panes that can be shown the
picture read it themselves; panes that cannot get the document. That is what this
file described before the image-transport failures forced everything onto a
shared transcription — and it is safe again for two reasons: `canSee` is now
*measured* by the vision probe rather than read off a table, and the
transcription no longer comes from a vision model. A pane reading for itself is
an independent reading, so a transcription error surfaces as disagreement in the
panel instead of unanimous confidence in the wrong answer.

A screenshot with almost no text in it — a diagram, a chart, a UI mockup — comes
back with a scattering of labels, and handing eleven disconnected words to a
model as "the problem" is worse than admitting the transcriber was the wrong
tool. Under twelve words the app falls back to a vision model, which is the only
thing that can read a picture that is not text. Same fallback if the key is
missing or rejected.

**The request budget — why runs used to lose panes**

The gateway counts requests per minute, and a panel is by definition a burst of
them. Six panes, a reader and a judge is eight requests in one press; against the
free tier's five a minute, three of them came back `429 Too Many Requests` and the
comparison was missing three opinions for no reason visible on screen.

Waiting is strictly better than failing — a pane that answers forty seconds late
is a pane that answered. So gateway requests now queue through a governor in Rust:
a sliding sixty-second window that admits requests at a legal pace and makes the
rest wait their turn. Direct vendor calls are untouched; their limits are far
larger and they must not queue behind the gateway's.

Three details that matter. A 429 that arrives anyway is waited out rather than
reported — `Retry-After` when the gateway sends one, a full window when it does
not — and the budget **ratchets down on its own**, because the real limit is a
property of the plan and cannot be read from the API. The governor lives in Rust
rather than the frontend, because a limit the webview forgets on reload is a limit
that gets exceeded on the next run. And the cost is stated *before* the press:
above the Run button the app says how many requests the run is, what the budget
is, and roughly how long the last pane will wait — six panes queued behind a rate
limit look exactly like six panes hung, and only one of those is worth waiting
for.

The reader is now one model, not two. Every reading is a request, and against a
budget of five the second one costs a pane. Claude reads screenshots most
reliably of the four, so when only one model reads, it is Claude. The trade is
real and it is visible: the document says *"single reader — no cross-check"* at
the top, because a disagreement between two readers was the only signal that a
reading was wrong. Setting two extractors in Settings restores it at the cost of
one more request.

**Deliberately out of scope**

Multi-monitor. There is no second display and there will not be one; the external
monitor is used as a mirror, so `capture.rs` fingerprints every display's file and
drops the duplicates rather than targeting a second screen. Those boxes are marked
out of scope, not pending.

**Built but not yet exercised — deliberately not ticked**

Compiling is not the same as working. What follows is real code with real tests
that no run has yet put through its paces.

- **The execution sandbox (sections 24–25).** `exec.rs` runs a model's code and
  reports what happened, across eleven languages: Python, JavaScript, TypeScript,
  bash, Ruby, PHP, C, C++, Java, Go and Rust. Not yet: C#, Dart, Swift, Kotlin,
  SQL. It is deliberately free of Tauri and tokio so a plain `rustc --test` can
  compile it, and 29 tests drive it against runaway loops, unbounded allocation, a
  screaming stdout and a backgrounded child trying to outlive its parent. Two of
  them found real bugs — a pipe-buffer deadlock, and an inherited pipe that made a
  3 ms run appear to hang for thirty seconds — which is why output now goes to
  files rather than pipes.

  **Those tests have never run on this Mac,** and that distinction has already
  cost a day. `ulimit -u 64` looked correct and passed 24 tests in a Linux
  container sitting at 62 processes; on macOS the limit is *per user*, not per
  process tree, so every `fork` in the app failed and the Run button returned
  `bash: fork: Resource temporarily unavailable`. The limit is gone and a test
  asserts it never comes back — but the lesson stands, and the sandbox boxes stay
  unticked until `cd src-tauri && cargo test --lib exec` has passed here.

  **What it bounds, and what it does not.** Bounded: wall clock, CPU, address
  space, file size, output volume, environment, and a working directory deleted
  afterwards. A runaway cannot take the machine. *Not* bounded: the filesystem
  beyond `HOME` and cwd, and the network — code run here can read `~/.ssh/id_rsa`
  and open sockets. Closing those on macOS means `sandbox-exec` with a
  deny-by-default profile, which is deprecated and cannot be exercised from the
  test harness; untested security code is worse than none, because it is believed.
  So Filesystem and Network under section 25 stay unticked, a test records the
  gap, and the Run button says it plainly before the first press.

  **Latest Mac result:** `cargo test --lib exec` now passes on this Mac: 30 of
  30 exec tests. The macOS-specific gap was closed by treating fork exhaustion
  as valid containment when the run returns promptly, adding a resident-memory
  watchdog below the virtual-memory startup cap, and annotating SIGKILL/resource
  exits so the UI does not show a mysterious blank failure.

  Nothing runs automatically. This is code a language model wrote, executing on
  your own machine, and the decision to run it has to be a person's — however
  unanimous the panel was.

- **The vision pass (section 9).** Two vision models transcribe independently and
  `compareExtractions` splits their differences into ones that change the answer
  (code, errors, terminal output, the problem statement) and ones that do not
  (language, framework, file name). Merged confidence is the *lower* of the two,
  knocked down by 40% when they disagree on something that matters. It is
  demand-driven, so with the default Images mode and a panel of vision models it
  has not had to run. Section 8's boxes stay empty until a reading has been seen
  on screen.

- **The vision probe.** Shipped and typechecked, never pressed. One click on
  *Test these models* earns section 13's Capability detection and Model health.

- **The Knowledge/RAG first slice (sections 16-19, 51).** A local coding
  knowledge library now exists in `src/lib/knowledge.ts`, with retrieval tests in
  `tests/knowledge.test.ts`. It includes competitive-programming patterns
  (union-find, sliding window, prefix sums, binary search on answer, BFS/DFS),
  a specific entry for LeetCode 1627 / Graph Connectivity With Threshold, and a
  runtime-reporting discipline that tells models to optimise toward a <=17ms
  target when realistic but never invent measured milliseconds. The retrieved
  pack now also includes a performance-engineering layer for memory metrics
  (RSS vs auxiliary space), fair cross-language benchmarks, benchmark noise,
  hardware counters, generated assembly/codegen, compiler flags, cache/data
  layout and correctness gates for optimized candidates. The pack is injected
  into solver, judge, council, test-spec, review and synthesis prompts. Rosetta
  Code's Runtime Evaluation page is linked as a resource entry, not copied into
  the app. It stays unticked until a live audit is observed producing a better
  answer because of the retrieved knowledge.

**Exists but incomplete — deliberately not ticked**

- **Screenshots are not attached to sessions.** This is the largest gap that looks
  closed. `screenshot_add`, `screenshot_remove`, `screenshot_reorder` and
  `screenshots_purge` all exist in Rust, all have TypeScript wrappers, and the
  `screenshots` table has `position`, `captured_at`, dimensions and a `monitor`
  column waiting. **Nothing calls them.** So Add, Remove and Reorder screenshots
  under section 7, Session association under section 6, and Screenshot ID and
  Timestamp with it, are all unticked — the plumbing is laid and not connected.
- **Runs are saved; test and runtime results are not.** `persistRun` writes every
  agent response, its FINAL block, token counts, latency and the verdict. There is
  nowhere yet for an execution result to go.
- **Model router, half done.** Selection, token tracking, latency tracking and
  provider-failure reporting are ticked. Capability detection and model health are
  built and unpressed. Fallback, cost tracking and a retry the user can see are
  not written — `send_with_retry` retries transport failures silently, which is
  not the same thing.
- **Production build.** `npm run app:build` is wired but has never been run.
- **Environment configuration.** Only the three accelerator overrides exist.
- **Execution and privacy settings.** No panels yet. Settings has tabs — Models,
  Reading, Capture, Sessions, Limits — so there is somewhere for them to go.
- **Navigation, problem workspace.** Still one screen, though it has a session
  list down the left, draggable splitters, and a pane grid that follows how many
  providers are switched on.
- **Supabase Storage upload.** Screenshots are recorded by path and stay on local
  disk. Uploading them needs the project URL and a service key, which is a
  different credential from the Postgres connection string.

**What the automated checks actually cover**

The Node/TypeScript suite passes with `npm test` on this machine, and the current
tree also passes `npm run typecheck` and `npm run lint`. Two of the test files
exist because this project has two boundaries no compiler watches.
`tests/sql.test.ts` reads the Rust and the schema together and checks that every
`sqlx::query` binds exactly as many values as it has placeholders, that every
column named in Rust exists, and that every insert lists as many columns as
values — sqlx is only asked at runtime, so a mismatch would compile cleanly and
fail on a real capture. `tests/bridge.test.ts` does the same for the
TypeScript-to-Rust crossing: every `invoke` call site is matched against the
command signature it targets, field by field, optionality included. Both were
mutation-tested — rename a Rust parameter or misspell a column and they fail —
because a check that cannot fail is worse than no check. `db.rs` carries eight
unit tests of its own through a standalone `rustc` harness: a password containing
an `@` must not confuse the host parse, and a pooler URL must never be
misdiagnosed as the broken direct one.

**Current project checkpoint — 2026-08-26**

- The project is initialized as a Git repository in
  `/Users/cyberlord/Downloads/code-auditor`, with build artifacts and dependency
  folders covered by `.gitignore`, and pushed to the private GitHub repository
  `4cyberlord/code-auditor`.
- The app shell, provider plumbing, global capture shortcuts, multi-pane answers,
  consensus, judge mode, sessions UI, local persistence wrappers, local
  Knowledge/RAG retrieval, council prompts, screenshot tiling/manifest handling,
  extraction comparison and code-runner plumbing are implemented.
- The latest knowledge-library addition is the performance-engineering layer:
  memory metric taxonomy, fair cross-language benchmark contracts, benchmark
  noise discipline, hardware counters, assembly/codegen inspection, compiler
  build flags, cache/data-layout optimization, Python runtime memory and
  optimized-candidate correctness gates.
- The macOS code execution sandbox has been hardened with resident-memory
  watchdog checks below the virtual-memory ceiling, clearer resource-limit exit
  classification, and tests that accept macOS's fork-refusal path as containment
  rather than a false failure.
- GitHub Codespaces benchmarking is wired through the GitHub CLI. The prepared
  remote benchmark environment is `turbo-cod-qr9p57v5x5ph6wpj`, with Python,
  Node, C/C++, Java, Go, Ruby, PHP and Rust available over noninteractive
  `gh codespace ssh`.
- The background cloud solver foundation is in place: Supabase queue tables for
  Council jobs, ordered job screenshots, progress events, Council reports and
  iOS notification devices; typed desktop read APIs for job history; a tested
  background batch contract; and a worker scaffold that claims jobs and records
  `executor_pending` until cloud Council execution is wired.
- The settings dialog was recovered after an accidental pasted search-output
  overwrite, and the app now builds cleanly again.
- The strongest tested foundation today is the non-UI logic: consensus parsing,
  OCR/reading merge rules, payload shaping, bridge signatures, SQL/schema
  consistency, prompt contracts, knowledge retrieval, council gates, image
  tiling and status/probe classification.
- The current verification sweep passes `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run build`, `cargo check --manifest-path
  src-tauri/Cargo.toml`, `cargo test --manifest-path src-tauri/Cargo.toml --lib
  codespaces`, and the focused `cargo test --lib exec` sandbox suite.
- The next unproven surface is the real desktop workflow: live capture under
  macOS Screen Recording permissions, model probing from the settings UI, a
  smoke Run with Council off, then a full Council run with Codespaces benchmark
  evidence enabled. After that, the next implementation layer is write-side
  background job submission and real cloud Council execution.

**The architectural fork, now resolved**

Section 9 says vision models extract and text models reason. The app did the
opposite: every agent received the raw image and read it independently. That was
chosen so one model's OCR mistake could not become everyone's — a misread showed
up as disagreement instead of propagating silently. The cost was real: text-only
models were excluded entirely, image tokens were paid for repeatedly, and RAG had
no structured context to search against.

Both are now available, and which one runs is a setting rather than a decision
baked into the code:

| Context mode | What the agents get |
|---|---|
| **Images** (default) | The screenshot. Every agent reads it itself. No shared transcription, so no shared misreading. This is the proven path. |
| **Reading** | Two vision models transcribe independently, the two readings are compared, and the agents work from the agreed text. A model with no vision can now sit on the panel. |
| **Both** | The screenshot and the reading. An agent that can see gets to catch the transcription being wrong. |

Every run records which mode produced it, the reading the agents worked from, and
whether the two readers agreed. Comparing the modes against each other later is
only possible because that was written down.

**The next three things, in order**

1. Verify Settings in the running desktop app: gateway key, model probes,
   context mode, reader route, Council roster and Codespaces name.
2. Run one live coding audit with Council off, confirm the Knowledge/RAG pack is
   visible in the prompt path, and confirm the final answer reports runtime
   professionally.
3. Run one full Council audit with Codespaces benchmarks enabled, then use that
   evidence trail as the baseline for the automatic repair loop.

---

## Table of Contents

1. [Project Vision](#1-project-vision)
2. [Core Product](#2-core-product)
3. [Primary Workflow](#3-primary-workflow)
4. [Architecture](#4-architecture)
5. [Phase 0 — Foundation](#5-phase-0--foundation)
6. [Phase 1 — Screenshot Capture](#6-phase-1--screenshot-capture)
7. [Phase 2 — Screenshot Sessions](#7-phase-2--screenshot-sessions)
8. [Phase 3 — Vision & Context Extraction](#8-phase-3--vision--context-extraction)
9. [Structured Problem Context](#9-structured-problem-context)
10. [Multi-Screenshot Understanding](#10-multi-screenshot-understanding)
11. [Phase 4 — Multi-Model AI](#11-phase-4--multi-model-ai)
12. [Model Capability Registry](#12-model-capability-registry)
13. [Model Router](#13-model-router)
14. [Phase 5 — AI Consensus & Judge](#14-phase-5--ai-consensus--judge)
15. [AI Debate](#15-ai-debate)
16. [Phase 6 — Knowledge Engine](#16-phase-6--knowledge-engine)
17. [Programming Books & Resources](#17-programming-books--resources)
18. [Documentation Intelligence](#18-documentation-intelligence)
19. [Retrieval-Augmented Generation](#19-retrieval-augmented-generation)
20. [Phase 7 — Coding Intelligence](#20-phase-7--coding-intelligence)
21. [Language Intelligence](#21-language-intelligence)
22. [Framework Intelligence](#22-framework-intelligence)
23. [Library Intelligence](#23-library-intelligence)
24. [Phase 8 — Code Execution & Verification](#24-phase-8--code-execution--verification)
25. [Execution Sandbox](#25-execution-sandbox)
26. [Build & Test Pipeline](#26-build--test-pipeline)
27. [Runtime Analysis](#27-runtime-analysis)
28. [Benchmarking](#28-benchmarking)
29. [Complexity Analysis](#29-complexity-analysis)
30. [Phase 9 — Automatic Repair](#30-phase-9--automatic-repair)
31. [Phase 10 — Final Results](#31-phase-10--final-results)
32. [Result Tabs](#32-result-tabs)
33. [Explanation System](#33-explanation-system)
34. [Learning System](#34-learning-system)
35. [Phase 11 — Solution Context](#35-phase-11--solution-context)
36. [Solution Workspace](#36-solution-workspace)
37. [Phase 12 — Solver Agent](#37-phase-12--solver-agent)
38. [Solver Tools](#38-solver-tools)
39. [Repair Plan Mode](#39-repair-plan-mode)
40. [Phase 13 — Language & Library Intelligence](#40-phase-13--language--library-intelligence)
41. [Phase 14 — Advanced Solving Automation](#41-phase-14--advanced-solving-automation)
42. [Out of Scope](#42-out-of-scope)
43. [Master Feature Checklist](#66-master-feature-checklist)
44. [Definition of Done](#67-definition-of-done)
45. [Ultimate Product Vision](#68-ultimate-product-vision)

---

# 1. Project Vision

The goal is to build an **AI Engineering Workbench**, not simply an AI chatbot.

The application should eventually allow a user to:

- capture anything currently visible on their screen
- collect multiple screenshots into one problem
- have AI understand the screenshots
- extract code, errors, terminal output, diagrams, mathematical problems, etc.
- send the extracted context to multiple AI models
- compare their solutions
- consult programming books and documentation
- reason about the problem
- produce a solution
- modify code when appropriate
- execute the code
- run tests
- benchmark it
- detect failures
- automatically repair the implementation
- verify the result
- explain the solution
- preserve the entire history

The application is intentionally **not** a full programming IDE. Its editor-like
surface is a solution workspace: enough space to inspect, edit, run and verify a
candidate answer, not a replacement for VS Code, Cursor or Xcode.

---

# 2. Core Product

The product consists of several major engines.

```text
AI ENGINEERING WORKBENCH
│
├── Screenshot Engine
├── Vision Engine
├── Context Engine
├── Multi-Model Engine
├── Consensus Engine
├── Knowledge Engine
├── Coding Intelligence
├── Execution Engine
├── Testing Engine
├── Verification Engine
├── Repair Engine
├── Solver Agent
└── Solution Context
```

The product should stay centered on the solving workflow. Project context is
allowed only when it improves a specific captured problem or candidate solution.

---

# 3. Primary Workflow

## Control+Option+S — Capture

> **Changed from Ctrl+7.** macOS reserves Control+1 through Control+9 for Mission
> Control's "Switch to Desktop N". Apple ships them unchecked, but where Spaces
> switching has been enabled the keystroke is consumed upstream and never reaches
> the app - registration still reports success, so the failure is silent.
> Control+Option plus a letter is unclaimed by macOS, and the letters are mnemonic.

The user presses:

```text
Control+Option+S     Screen   - whole display, silent
Control+Option+R     Region   - crosshair, drag a box
```

Both are overridable at runtime without a rebuild, via `CODE_AUDITOR_SCREEN_KEY`,
`CODE_AUDITOR_CAPTURE_KEY` and `CODE_AUDITOR_SOLVE_KEY`.

The application:

```text
Capture entire screen
        ↓
Store screenshot
        ↓
Attach to current session
```

No manual screenshot workflow should be required.

## Control+Option+A — Audit

> **Changed from Ctrl+8**, for the reason above.

The user presses:

```text
Control+Option+A
```

The application:

```text
Collect screenshots
        ↓
Understand screenshots
        ↓
Extract context
        ↓
Identify problem
        ↓
Retrieve relevant knowledge
        ↓
Ask multiple AI models
        ↓
Compare solutions
        ↓
Select strongest solution
        ↓
Implement if applicable
        ↓
Execute
        ↓
Test
        ↓
Repair failures
        ↓
Verify
        ↓
Present final solution
```

---

# 4. Architecture

The high-level architecture should be:

```text
┌─────────────────────────────────────────────────────────────┐
│                     NEXT.JS APPLICATION                     │
│                                                             │
│  Dashboard   Problem   AI   Results   Knowledge   Settings  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         TAURI / RUST                        │
│                                                             │
│ Global Shortcuts                                            │
│ Screen Capture                                              │
│ Filesystem                                                  │
│ Process Management                                          │
│ Secure Storage                                              │
│ Native OS Integration                                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        SCREEN ENGINE      AI ENGINE       EXECUTION ENGINE
              │                │                │
              ▼                ▼                ▼
         Screenshots       Models             Sandbox
              │                │                │
              ▼                ▼                ▼
          Vision          Consensus          Runtime
              │                │                │
              └───────────────┼────────────────┘
                              ▼
                       VERIFICATION ENGINE
                              │
                              ▼
                       FINAL SOLUTION
```

---

# 5. Phase 0 — Foundation

## Goal

Build the basic desktop application infrastructure.

### Technology

- [x] Tauri
- [x] Next.js
- [x] TypeScript architecture cleanup
- [x] Rust command architecture
- [x] Frontend/backend communication
- [ ] Environment configuration
- [ ] Production build
- [ ] Auto-update architecture

### Application shell

- [x] Main window
- [ ] Navigation
- [x] Settings
- [ ] Problem workspace
- [x] AI workspace
- [x] Results workspace
- [ ] Session manager

### Configuration

- [x] Provider configuration
- [x] Model configuration
- [x] API key configuration
- [x] Capture settings
- [x] AI settings
- [ ] Execution settings
- [ ] Privacy settings

---

# 6. Phase 1 — Screenshot Capture

## Goal

Create the application's unique capture workflow.

### Control+Option+S / Control+Option+R

- [x] Global keyboard shortcut
- [x] Capture entire screen
- [x] Capture primary monitor
- [ ] Capture secondary monitor — *out of scope: no second display, see status note*
- [ ] Multi-monitor support — *out of scope: no second display, see status note*
- [x] Optional region capture
- [x] No manual screenshot editor
- [x] No unnecessary screenshot preview
- [x] Automatic storage
- [ ] Screenshot ID
- [ ] Timestamp
- [ ] Monitor metadata

### Background operation

The capture component should be able to remain available while the main UI is hidden/minimized.

The design should respect operating-system screen-recording/capture permissions and privacy indicators.

**Do not attempt to bypass OS security or privacy mechanisms.**

### Screenshot management

- [x] Screenshot thumbnails
- [x] Delete
- [ ] Replace
- [ ] Reorder
- [x] Zoom
- [x] Full-size viewer
- [x] Metadata
- [ ] Session association

---

# 7. Phase 2 — Screenshot Sessions

A screenshot should not exist by itself.

It belongs to a:

```text
Problem Session
```

Example:

```text
Session #0042

Screenshot 001
Screenshot 002
Screenshot 003
Screenshot 004
...
```

### Session features

- [x] Create session
- [x] Rename session
- [x] Delete session
- [x] Archive session
- [ ] Restore session
- [x] Add screenshots
- [x] Remove screenshots
- [x] Reorder screenshots
- [x] Add text context
- [x] Add notes
- [x] Preserve AI responses
- [x] Preserve final solution
- [x] Preserve test results
- [x] Preserve runtime results

---

# 8. Phase 3 — Vision & Context Extraction

## Goal

Turn screenshots into useful engineering information.

```text
Screenshot
     ↓
Vision Model
     ↓
Structured Context
```

The vision system should recognize:

### Code

- [x] Language
- [x] Framework
- [x] File name
- [x] File path
- [x] Code
- [x] Line numbers
- [x] Functions
- [x] Classes
- [x] Imports
- [x] Variables
- [x] Errors

### Terminal

- [x] Commands
- [x] Output
- [x] Error messages
- [x] Stack traces
- [x] Exit codes

### Browser

- [x] URL
- [x] Visible page
- [x] Errors
- [x] Application state

### Other

- [x] Tables
- [x] Diagrams
- [x] Mathematical expressions
- [x] Database output
- [x] Logs
- [x] UI designs

---

# 9. Structured Problem Context

The vision engine should convert visual information into structured information.

Example:

```json
{
  "project": {
    "language": "TypeScript",
    "framework": "Next.js"
  },
  "files": [],
  "errors": [],
  "terminal": {},
  "observations": [],
  "problem_summary": "",
  "confidence": 0.94
}
```

The important principle is:

> **Vision models understand the image; text models can then reason over the extracted context.**

This means the entire model ecosystem doesn't need to support images.

---

# 10. Multi-Screenshot Understanding

The system must understand that:

```text
Screenshot 1
Screenshot 2
Screenshot 3
```

may all describe one problem.

It should combine them into:

```text
ONE ENGINEERING CONTEXT
```

It should identify:

- [ ] Duplicate information
- [ ] Contradictions
- [ ] Related errors
- [ ] File relationships
- [ ] Timeline/order
- [ ] Missing information
- [ ] Confidence

---

# 11. Phase 4 — Multi-Model AI

Your initial UI can continue to use four major AI panels:

```text
┌──────────────────┬──────────────────┐
│       GPT        │      Claude      │
├──────────────────┼──────────────────┤
│       Kimi       │      Gemini      │
└──────────────────┴──────────────────┘
```

But internally, the system should support many models.

Potential roles:

### GPT

General reasoning and engineering reasoning.

### Claude

Code review, architecture, and independent reasoning.

### Kimi

Long-context reasoning and alternative solutions.

### Gemini

Vision/multimodal analysis where appropriate.

### Codex

Coding and implementation.

### DeepSeek

Algorithms, mathematics, optimization, and alternative coding approaches.

### Qwen

Independent coding/reasoning.

---

# 12. Model Capability Registry

Never assume a model supports something.

Maintain:

```typescript
interface ModelCapabilities {
  textInput: boolean;
  imageInput: boolean;
  audioInput: boolean;
  videoInput: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  longContext: boolean;
}
```

The router decides:

```text
Image
 ↓
Vision-capable model

Text context
 ↓
Any compatible reasoning model
```

---

# 13. Model Router

Create a central:

```text
Model Router
```

Responsibilities:

- [x] Model selection
- [ ] Capability detection
- [ ] Fallback
- [ ] Retry
- [ ] Timeout
- [x] Token tracking
- [ ] Cost tracking
- [x] Latency tracking
- [ ] Model health
- [x] Provider failures

Eventually:

```text
Problem Type
      ↓
Best Model
```

---

# 14. Phase 5 — AI Consensus & Judge

Each model should independently analyze the problem.

```text
                    Problem
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
       GPT           Claude          Kimi
        │              │              │
        ▼              ▼              ▼
    Solution A      Solution B     Solution C
        │              │              │
        └──────────────┼──────────────┘
                       ▼
                  Master Judge
                       │
                       ▼
                Final Solution
```

Do not simply count votes.

The system should compare:

- correctness
- reasoning
- complexity
- maintainability
- security
- compatibility
- testability
- project conventions

---

# 15. AI Debate

Provide a view showing:

### Where models agree

```text
GPT ✓
Claude ✓
Kimi ✓
DeepSeek ✓
```

### Where they disagree

```text
GPT → Approach A

Claude → Approach B

Kimi → Approach A

DeepSeek → Approach C
```

### Judge decision

Explain why one approach was selected.

---

# 16. Phase 6 — Knowledge Engine

Create a searchable engineering knowledge base.

```text
Knowledge Engine
│
├── Books
├── Official Documentation
├── RFCs
├── Standards
├── Research Papers
├── Open Source Documentation
├── Algorithms
├── Data Structures
├── Mathematics
├── Security
└── Agriculture
```

---

# 17. Programming Books & Resources

The application should prioritize resources that are legally available for integration.

Examples of open resources include:

- **Structure and Interpretation of Computer Programs**
- **Eloquent JavaScript**
- **You Don't Know JS Yet**
- **Software Engineering at Google**
- **Architecture of Open Source Applications**
- **500 Lines or Less**
- **Producing Open Source Software**
- **Open Advice**

Also include legitimate references to important commercial works such as:

- Clean Code
- Clean Architecture
- Design Patterns
- Refactoring
- Effective Java
- The Pragmatic Programmer
- Introduction to Algorithms
- Designing Data-Intensive Applications

For copyrighted books, do **not** bundle or redistribute unauthorized copies.

Instead use:

- licensed content
- legitimate links
- metadata
- permitted excerpts
- user-provided licensed copies where legally appropriate

---

# 18. Documentation Intelligence

The knowledge engine should prioritize:

```text
1. Official documentation
2. Standards
3. Primary sources
4. Research
5. Trusted books
6. Community material
```

Example:

```text
Next.js problem
      ↓
Next.js documentation
      ↓
Relevant version
      ↓
AI reasoning
```

---

# 19. Retrieval-Augmented Generation

Do not send entire books to models.

Instead:

```text
Problem
   ↓
Knowledge Search
   ↓
Relevant documents
   ↓
Relevant sections
   ↓
AI
```

This makes the system:

- faster
- cheaper
- more accurate
- easier to maintain

---

# 20. Phase 7 — Coding Intelligence

This is where the application begins understanding actual programming concepts.

### Core languages

- [ ] JavaScript
- [ ] TypeScript
- [ ] Python
- [ ] PHP
- [ ] Java
- [ ] C
- [ ] C++
- [ ] C#
- [ ] Go
- [ ] Rust
- [ ] Dart
- [ ] Swift
- [ ] Kotlin
- [ ] Ruby
- [ ] SQL
- [ ] Shell

---

# 21. Language Intelligence

The system should understand:

```text
Syntax
Types
Functions
Classes
Interfaces
Modules
Imports
Dependencies
Errors
Runtime behavior
```

Eventually add:

```text
Language Server Protocol
```

for:

- autocomplete
- diagnostics
- go-to-definition
- find references
- rename
- hover
- code actions

---

# 22. Framework Intelligence

Support major ecosystems.

### JavaScript / TypeScript

- [ ] React
- [ ] Next.js
- [ ] Vue
- [ ] Node.js
- [ ] Express

### PHP

- [ ] Laravel
- [ ] Symfony
- [ ] Composer
- [ ] PHPUnit
- [ ] PHPStan

### Python

- [ ] Django
- [ ] Flask
- [ ] FastAPI
- [ ] Pydantic
- [ ] NumPy
- [ ] Pandas
- [ ] PyTorch

### Other ecosystems

Expand over time.

---

# 23. Library Intelligence

The application should inspect:

```text
package.json
composer.json
requirements.txt
pyproject.toml
Cargo.toml
go.mod
pom.xml
```

and determine:

```text
Library
Version
Dependencies
Documentation
Known APIs
```

This allows the AI to answer:

> "How does this application use Stripe?"

or:

> "Which version of Laravel are we using?"

or:

> "Is this API deprecated?"

---

# 24. Phase 8 — Code Execution & Verification

This is a major differentiator.

AI should not simply generate code and declare:

> "Done."

Instead:

```text
Generate
   ↓
Execute
   ↓
Test
   ↓
Measure
   ↓
Verify
```

---

# 25. Execution Sandbox

Use a controlled environment for AI-generated code.

Control:

- [ ] CPU
- [ ] Memory
- [ ] Runtime
- [ ] Filesystem
- [ ] Network
- [ ] Processes
- [ ] Environment variables
- [ ] Package installation
- [ ] Disk usage

Never expose sensitive host resources unnecessarily.

---

# 26. Build & Test Pipeline

Automatically detect project tools.

```text
Code
 ↓
Build
 ↓
Lint
 ↓
Typecheck
 ↓
Unit Tests
 ↓
Integration Tests
 ↓
E2E
```

---

# 27. Runtime Analysis

For applicable programs:

```text
Execution time
Memory
CPU
Exit code
Output
Errors
```

For web applications:

```text
Build time
Startup time
Request time
Database query performance
Bundle size
```

---

# 28. Benchmarking

For multiple solutions:

```text
Solution A
Solution B
Solution C
```

Run them under comparable conditions.

Report:

```text
Runtime
Memory
Complexity
Correctness
```

Then select the best practical solution.

---

# 29. Complexity Analysis

Automatically analyze:

```text
Time Complexity
Space Complexity
```

Examples:

```text
O(1)
O(log n)
O(n)
O(n log n)
O(n²)
O(2ⁿ)
```

---

# 30. Phase 9 — Automatic Repair

The agent should be capable of:

```text
Implement
   ↓
Run
   ↓
Failure
   ↓
Read failure
   ↓
Reason
   ↓
Modify
   ↓
Run again
```

Maximum retries should be configurable.

Example:

```text
Maximum repair attempts: 5
```

Never permit an uncontrolled infinite loop.

---

# 31. Phase 10 — Final Results

Every completed problem should produce a final result.

Example:

```text
╔══════════════════════════════════╗
║       VERIFIED SOLUTION ✓        ║
╚══════════════════════════════════╝

Problem:
...

Root Cause:
...

Solution:
...

Files:
...

Tests:
47 / 47 PASS

Build:
PASS

Runtime:
184ms

Security:
No critical issues detected
```

---

# 32. Result Tabs

Every problem should have:

```text
Final Solution
Explanation
AI Debate
Code Changes
Tests
Runtime
Knowledge
Security
History
```

---

# 33. Explanation System

The user should be able to ask:

> "Explain everything that happened."

The application responds with:

```text
What was wrong?
Why was it wrong?
What changed?
Why does the solution work?
What alternatives were considered?
Why was this solution selected?
What tests were performed?
What should I learn?
```

---

# 34. Learning System

Every solved problem can generate:

```text
Concepts learned
```

Example:

```text
Promises
Async/Await
Authentication
HTTP
TypeScript
Error Handling
```

Then provide:

- simple explanation
- technical explanation
- examples
- related knowledge
- exercises

---

# 35. Phase 11 — Solution Context

Solution context is intentionally narrower than project intelligence.

The app may inspect or store context only when it helps solve a specific problem:

```text
Problem statement
Screenshots
User notes
Candidate code
Compiler/runtime output
Test failures
Relevant docs
Retrieved knowledge
Prior attempts in the same session
```

It should not try to index an entire project, maintain a project graph, answer
general project-wide questions, or become the user's source-code navigator. Those
jobs belong to a real IDE.

---

# 36. Solution Workspace

The code surface exists to work on candidate answers.

It should support:

- [x] show generated code
- [x] preserve the final solution
- [x] run candidate code in the sandbox
- [x] show stdout, stderr, exit status and runtime
- [x] benchmark accepted candidates locally or in Codespaces
- [ ] edit a candidate solution before rerun
- [ ] compare original, revised and winning candidates
- [ ] save verified solution history

It should not support:

- opening folders as projects
- file explorers
- tabs or split editors
- LSP, autocomplete or debugger integration
- project-wide refactoring
- extension/plugin marketplaces
- Git workflows beyond preserving this app's own repository

---

# 37. Phase 12 — Solver Agent

The solver agent is not a general coding agent. It operates inside one problem
session and has one job: move from proposed answer to verified answer.

It can:

### Ask

Ask clarifying questions or request missing context.

### Suggest

Explain a candidate change before it is tested.

### Repair

Use failures, tests, benchmarks and council feedback to revise a candidate.

### Verify

Run the verification chain and label the result honestly.

---

# 38. Solver Tools

Provide tools that support the solution lifecycle:

```text
query_knowledge
query_documentation
run_candidate
run_tests
benchmark
compare_candidates
inspect_failure
repair_candidate
save_verified_solution
```

The agent does not need general-purpose file write/delete tools for the focused
solver product.

---

# 39. Repair Plan Mode

Before changing a candidate solution:

```text
REPAIR PLAN

1. Read failure evidence
2. Identify the likely defect
3. Choose the smallest correction
4. Rerun tests
5. Rerun benchmark if performance matters
6. Report whether the candidate is verified
```

The plan is scoped to the candidate answer, not to an arbitrary source tree.

---

# 40. Phase 13 — Language & Library Intelligence

This supports generated solutions and captured debugging problems, not a full
editor.

Each language gets:

```text
Syntax Intelligence
Semantic Intelligence
Documentation
Package Intelligence
Framework Intelligence
Testing Intelligence
AI Prompts
```

Example:

```text
PHP
├── PHP language
├── Composer
├── Laravel
├── Symfony
├── PHPUnit
└── PHPStan
```

Python:

```text
Python
├── Python language
├── pip
├── Poetry
├── Django
├── FastAPI
├── pytest
└── mypy
```

---

# 41. Phase 14 — Advanced Solving Automation

Long-term features:

- [ ] Automatic test generation for candidate answers
- [ ] Automatic counterexample search
- [ ] Automatic repair from failing tests
- [ ] Multi-language solution comparison
- [ ] Local and Codespaces benchmark comparison
- [ ] Security checks for generated code
- [ ] Performance optimization
- [ ] Continuous verification inside the session
- [ ] Model performance learning
- [ ] Intelligent model routing
- [ ] Long-running Council deliberations

---

# 42. Out of Scope

These are intentionally removed from the product direction:

- full coding editor
- opening and managing whole projects
- folder/file customization
- project graph and persistent project brain
- source-tree navigation
- LSP
- autocomplete
- debugger
- full terminal
- extension marketplaces
- autonomous project-wide refactoring
- dependency-upgrade agent
- architecture-analysis agent

---

# 51. Data Structures & Algorithms

Dedicated intelligence for:

### Data Structures

- [ ] Arrays
- [ ] Linked lists
- [ ] Stacks
- [ ] Queues
- [ ] Hash tables
- [ ] Trees
- [ ] BST
- [ ] AVL
- [ ] Red-black trees
- [ ] Heaps
- [ ] Graphs
- [ ] Tries
- [ ] Union-Find
- [ ] Bloom filters

### Algorithms

- [ ] Sorting
- [ ] Searching
- [ ] Graph traversal
- [ ] Dynamic programming
- [ ] Greedy algorithms
- [ ] Divide and conquer
- [ ] Backtracking
- [ ] Graph algorithms
- [ ] String algorithms
- [ ] Optimization

---

# 52. Mathematics Engine

Support:

- [ ] Algebra
- [ ] Calculus
- [ ] Probability
- [ ] Statistics
- [ ] Discrete mathematics
- [ ] Linear algebra
- [ ] Number theory
- [ ] Graph theory
- [ ] Optimization
- [ ] Numerical methods

Pipeline:

```text
Problem
 ↓
Mathematical reasoning
 ↓
Algorithm
 ↓
Implementation
 ↓
Execution
 ↓
Verification
```

---

# 53. Agriculture Intelligence

Create a dedicated domain:

```text
Agriculture
│
├── Agronomy
├── Soil Science
├── Crop Science
├── Irrigation
├── Fertilizers
├── Pest Management
├── Plant Diseases
├── Agricultural Economics
├── Farm Management
├── Livestock
├── GIS
├── Remote Sensing
└── Precision Agriculture
```

The system should eventually combine:

```text
Agriculture
+
Mathematics
+
Programming
+
Data
+
AI
```

Example:

> Build a crop-yield prediction system.

The application could reason about both the agricultural problem and the software implementation.

---

# 54. Security Engine

Every code solution can optionally receive a security review.

Check for:

- [ ] SQL injection
- [ ] XSS
- [ ] CSRF
- [ ] Authentication problems
- [ ] Authorization problems
- [ ] Secret exposure
- [ ] Command injection
- [ ] Path traversal
- [ ] SSRF
- [ ] Unsafe deserialization
- [ ] Dependency vulnerabilities
- [ ] Sensitive data exposure

---

# 55. Dependency Intelligence

Automatically detect:

```text
package.json
composer.json
requirements.txt
pyproject.toml
Cargo.toml
go.mod
pom.xml
```

Then:

- [ ] Identify packages
- [ ] Identify versions
- [ ] Identify outdated dependencies
- [ ] Identify vulnerabilities
- [ ] Explain upgrade risks
- [ ] Propose upgrades
- [ ] Test upgrades

---

# 56. Git Integration

Eventually:

- [ ] Git status
- [ ] Git diff
- [ ] Branches
- [ ] Commit
- [ ] Revert
- [ ] Stash
- [ ] History
- [ ] AI commit messages
- [ ] AI-generated change summaries

Before major agent modifications:

```text
Create checkpoint
```

---

# 57. Privacy & Security

The application may see highly sensitive material.

Therefore:

- [x] Secure API key storage
- [x] OS keychain integration
- [ ] Secret redaction
- [ ] Session deletion
- [ ] Local data controls
- [ ] Encryption where appropriate
- [ ] Permission controls
- [ ] Network restrictions
- [ ] Sandbox
- [ ] Audit logging

Never intentionally bypass operating-system security/privacy protections.

---

# 58. API Architecture

Do not permanently couple the application to one provider.

Use:

```text
AIProvider
```

with adapters for providers such as:

```text
TokenRouter
OpenAI
Anthropic
Google
Moonshot
DeepSeek
Qwen
```

Then:

```text
Application
     ↓
AI Provider Interface
     ↓
Model Router
     ↓
Provider
     ↓
Model
```

This protects the project from vendor lock-in.

---

# 59. Cost Management

Not every problem requires every model.

### Simple problem

```text
Vision
 ↓
One reasoning model
 ↓
Answer
```

### Medium problem

```text
Vision
 ↓
GPT + Codex
 ↓
Judge
 ↓
Test
```

### Difficult problem

```text
Vision
 ↓
GPT
Claude
Kimi
DeepSeek
Qwen
Codex
 ↓
Judge
 ↓
Implementation
 ↓
Testing
 ↓
Repair
```

---

# 60. Model Performance Tracking

Track:

```text
Model
Problem Type
Latency
Cost
Success
Test Results
Human Feedback
```

Eventually learn:

```text
React debugging → Model X
Algorithms → Model Y
Code review → Model Z
Vision → Model A
```

The router can become increasingly intelligent.

---

# 61. UI/UX Structure

Recommended main navigation:

```text
┌─────────────────────────────────────────────────────┐
│ Project | Problems | AI | Knowledge | Settings      │
├─────────────────────────────────────────────────────┤
│                                                     │
│                    WORKSPACE                        │
│                                                     │
├─────────────────────────────────────────────────────┤
│ Terminal | Tests | Runtime | Changes | AI Activity  │
└─────────────────────────────────────────────────────┘
```

For each problem:

```text
Problem
Analysis
AI Debate
Changes
Runtime
Tests
Knowledge
Security
Explanation
Final Solution
History
```

---

# 62. Status System

Every operation should show a clear state:

```text
CAPTURING
ANALYZING
UNDERSTANDING
RETRIEVING
REASONING
IMPLEMENTING
EXECUTING
TESTING
REPAIRING
VERIFYING
COMPLETED
FAILED
```

---

# 63. Confidence System

Never say "verified" just because an AI said the answer looks correct.

Use:

```text
PROPOSED
```

when AI has only suggested something.

```text
IMPLEMENTED
```

when code was changed.

```text
TESTED
```

when tests were actually executed.

```text
VERIFIED
```

when the relevant verification pipeline passes.

Example:

```text
Solution Confidence: 96%

✓ Multiple models agree
✓ Code implemented
✓ Build passed
✓ Tests passed
✓ Runtime checked
✓ Security review completed
```

---

# 64. Project History

Store:

```text
Problem
Screenshots
AI conversations
Model responses
Knowledge retrieved
Code changes
Tests
Runtime
Final solution
```

Allow users to revisit previous problems.

---

# 65. Master Development Phases

## 🟢 PHASE 1 — Core Foundation

- [x] Tauri
- [x] Next.js
- [x] Application shell
- [x] Settings
- [x] AI provider system
- [x] API configuration

## 🟢 PHASE 2 — Screenshot System

- [x] Ctrl+7
- [x] Global shortcut
- [x] Full-screen capture
- [ ] Multi-monitor — *out of scope: no second display, see status note*
- [x] Multiple screenshots
- [x] Screenshot sessions
- [x] Screenshot history

## 🟢 PHASE 3 — Vision

- [x] Vision model
- [x] OCR/context extraction
- [x] Code recognition
- [x] Error recognition
- [x] Terminal recognition
- [x] Multi-image reasoning
- [x] Confidence

## 🟢 PHASE 4 — Multi-AI

- [x] GPT
- [x] Claude
- [x] Kimi
- [x] Gemini
- [ ] Codex
- [ ] DeepSeek
- [ ] Qwen
- [x] Model router
- [x] Model capability system
- [x] AI comparison
- [x] Master judge

## 🟢 PHASE 5 — Knowledge

- [x] Open programming resources
- [x] Documentation
- [ ] Books metadata
- [x] RAG
- [x] Data structures
- [x] Algorithms
- [x] Mathematics
- [x] Security
- [ ] Agriculture

## 🟢 PHASE 6 — Coding Intelligence

- [x] Language detection
- [x] Framework detection
- [ ] Dependency detection
- [ ] Library intelligence
- [x] Documentation lookup
- [x] Project context

## 🟢 PHASE 7 — Execution

- [x] Sandbox
- [ ] Terminal
- [x] Build
- [x] Run
- [x] Tests
- [x] Lint
- [x] Typecheck
- [x] Runtime analysis
- [x] Benchmarking

## 🟢 PHASE 8 — Automatic Repair

- [ ] Failure detection
- [ ] Error analysis
- [ ] AI repair
- [ ] Retry
- [ ] Test again
- [ ] Verification

## 🟢 PHASE 9 — Final Results

- [x] Final solution
- [x] Explanation
- [x] AI debate
- [x] Runtime
- [x] Tests
- [x] Security
- [x] Confidence
- [ ] Learning

## 🟡 PHASE 10 — Solution Context

- [x] Problem sessions
- [x] Screenshot history
- [x] User notes
- [x] Candidate answer history
- [x] Runtime evidence
- [x] Benchmark evidence
- [ ] Editable candidate workspace
- [ ] Candidate diff view
- [ ] Verified solution library

## 🟡 PHASE 11 — Solver Agent

- [ ] Ask for missing problem context
- [ ] Propose candidate repairs
- [ ] Explain repair plan
- [x] Run candidate code
- [x] Run tests
- [x] Use Git for this app repository
- [ ] Compare candidates
- [ ] Repair from failures
- [x] Verify with evidence

## 🔵 PHASE 12 — LANGUAGE INTELLIGENCE

- [ ] PHP intelligence
- [ ] Python intelligence
- [ ] TypeScript intelligence
- [ ] JavaScript intelligence
- [ ] Rust intelligence
- [ ] Go intelligence
- [ ] Dart intelligence
- [ ] Java intelligence
- [ ] C/C++ intelligence
- [ ] Framework-specific solving packs
- [x] Library/documentation retrieval
- [x] Performance intelligence
- [x] Security intelligence

## 🔴 PHASE 13 — ADVANCED SOLVING AUTOMATION

- [ ] Automatic test generation
- [ ] Automatic counterexample search
- [ ] Automatic repair from failures
- [ ] Multi-language solution comparison
- [ ] Local and Codespaces benchmark comparison
- [ ] Security checks for generated code
- [x] Performance optimization knowledge
- [ ] Long-running Council deliberations
- [ ] Intelligent model routing

## ⚪ OUT OF SCOPE — FULL IDE

- [ ] Open folders as editable projects
- [ ] File explorer
- [ ] Tabs and split editors
- [ ] LSP
- [ ] Autocomplete
- [ ] Debugger
- [ ] Full terminal
- [ ] Extension marketplace
- [ ] Project-wide refactoring

---

# 66. Master Feature Checklist

## 🖥️ Desktop

- [x] Tauri
- [x] Next.js
- [x] Global shortcuts
- [x] Background operation
- [x] Secure storage
- [ ] Multi-monitor — *out of scope: no second display, see status note*

## 📸 Capture

- [x] Ctrl+7
- [x] Full-screen capture
- [ ] Multi-screen — *out of scope: no second display, see status note*
- [x] Multiple screenshots
- [x] Sessions
- [x] Screenshot history

## 👁️ Vision

- [x] Image understanding
- [x] OCR
- [x] Code extraction
- [x] Error extraction
- [x] Terminal extraction
- [x] Context reconstruction
- [x] Confidence

## 🤖 AI

- [x] GPT
- [x] Claude
- [x] Kimi
- [x] Gemini
- [ ] Codex
- [ ] DeepSeek
- [ ] Qwen
- [x] Router
- [x] Consensus
- [x] Judge
- [x] Council

## 📚 Knowledge

- [ ] Programming books
- [x] Open resources
- [x] Official documentation
- [x] Research
- [x] Algorithms
- [x] Data structures
- [x] Mathematics
- [ ] Agriculture
- [x] Security

## 🧪 Verification

- [x] Sandbox
- [x] Build
- [x] Run
- [x] Test
- [x] Lint
- [x] Typecheck
- [x] Runtime
- [x] Benchmark
- [x] Security
- [ ] Repair
- [x] Verification

## 🧠 Solution Context

- [x] Problem sessions
- [x] Screenshot history
- [x] Notes
- [x] Runtime evidence
- [x] Benchmark evidence
- [x] Library intelligence
- [x] Documentation intelligence
- [ ] Editable candidate workspace
- [ ] Candidate comparison view
- [ ] Verified solution library

## 🤖 Solver Agent

- [ ] Ask for missing context
- [ ] Plan candidate repair
- [ ] Explain proposed repair
- [x] Run
- [x] Test
- [ ] Repair
- [x] Verify

## 🚫 Out of Scope

- [x] Full IDE removed from roadmap
- [x] Project-wide refactoring removed from roadmap
- [x] LSP/autocomplete/debugger removed from roadmap
- [x] File explorer/full terminal removed from roadmap

---

# 67. Definition of Done

A problem should **not** be marked:

```text
✓ VERIFIED
```

just because the AI produced code.

The minimum verification chain should be:

```text
Problem understood
       ↓
Solution selected
       ↓
Implementation completed
       ↓
Build passed
       ↓
Tests passed
       ↓
Runtime checked
       ↓
Security checked where applicable
       ↓
Final review
       ↓
VERIFIED
```

If only an answer was generated:

```text
⚠ PROPOSED
```

If code was changed but not tested:

```text
⚠ IMPLEMENTED — NOT VERIFIED
```

If tests passed:

```text
✓ TESTED
```

If the full verification process passed:

```text
✓ VERIFIED
```

---

# 68. Ultimate Product Vision

The final architecture becomes:

```text
                         AI ENGINEERING WORKBENCH
                                   │
          ┌────────────────────────┼─────────────────────────┐
          │                        │                         │
          ▼                        ▼                         ▼
   SCREENSHOT ENGINE        KNOWLEDGE ENGINE        SOLUTION EVIDENCE
          │                        │                         │
          ▼                        ▼                         ▼
       VISION                   DOCS                    RUNS
          │                    RFCs                     TESTS
          │                    RESEARCH                 BENCHMARKS
          │                    PATTERNS                 FAILURES
          └───────────────┬───────────────┬───────────────┘
                          ▼               ▼
                     CONTEXT ENGINE
                          │
                          ▼
                   MULTI-MODEL ENGINE
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
       GPT              Claude              Kimi
        ▼                 ▼                  ▼
      Codex            DeepSeek             Qwen
        └─────────────────┼──────────────────┘
                          ▼
                     MASTER JUDGE
                          │
                          ▼
                    SOLVER AGENT
                          │
                          ▼
                 SOLUTION WORKSPACE
                          │
                          ▼
                       SANDBOX
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
            BUILD        TEST        RUN
              │           │           │
              └───────────┼───────────┘
                          ▼
                    VERIFICATION
                          │
                    ┌─────┴─────┐
                    ▼           ▼
                  FAIL         PASS
                    │           │
                    ▼           ▼
                 REPAIR       FINAL
                    │           │
                    └────►      ▼
                         EXPLANATION
                              │
                              ▼
                       VERIFIED RESULT
```

---

# 69. The Product in One Sentence

> **An AI-native solving workbench that can see the problem in front of you, consult multiple AI experts and trusted technical knowledge, execute and benchmark candidate code, repair failures, and deliver a verified answer with evidence.**

---

# 70. Priority Order

## 🔥 Build NOW

```text
1. [done] Tauri + Next.js foundation
2. [done] Ctrl+7 screenshot capture
3. [done] Multiple screenshot sessions
4. [done] Vision/context extraction
5. [done] Ctrl+8 solve workflow
6. [done] GPT/Claude/Kimi/Gemini integration
7. [done] Multi-model comparison
8. [done] Master Judge
9. [done] Knowledge/RAG system
10. [done] Code solution generation
11. [done] Execution
12. [done] Testing
13. [done] Runtime checks
14. [done] Background cloud job schema and desktop history
15. [done] Dedicated macOS helper binary with start/capture/submit batch hotkeys
16. [done] Cloud worker v1 solver/benchmark/review/judge/synthesis Council reports
17. [next] Final verified result from live Council + Codespaces run
```

## 🟡 Build NEXT

```text
18. Live settings/model probe verification
19. Live smoke Run with Council off
20. Live Council Run with Codespaces benchmark evidence
21. Package/sign helper binary inside the release app bundle
22. Cloud worker revision rounds
23. Native iOS APNs companion foundation
24. Automatic repair loop
25. Candidate comparison view
```

## 🔵 Keep Out Of Scope

```text
26. Full coding editor
27. Opening folders as editable projects
28. File explorer
29. LSP
30. Autocomplete
31. Debugger
32. Full terminal
33. Extension marketplace
34. Project-wide refactoring
```

## 🚀 Build LAST / ADVANCED

```text
35. Continuous session verification
36. Intelligent model routing
37. Long-running Council deliberations
38. Advanced performance optimization
39. Advanced model-selection learning
```

---

# 71. Final Architectural Principle

**Do not build a VS Code replacement.**

Build the **solver brain** and keep the interface wrapped around solving.

```text
                    SOLVER BRAIN
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   Screenshot        Candidate          Knowledge
   Intelligence      Evidence           Intelligence
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                  SOLVER AGENT
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
     SOLUTION WORKSPACE       SANDBOX
              │                     │
              └──────────┬──────────┘
                         ▼
                    EXECUTION
                         │
                         ▼
                    VERIFICATION
```

The workspace should make candidate answers easier to inspect and verify. It
should never become the product's center of gravity.
