# AI Engineering Workbench — Master README

> A multi-model AI engineering assistant that can capture problems from the user's screen, understand screenshots, reason across multiple AI models, retrieve trusted programming knowledge, solve coding and mathematical problems, modify and execute code, test and verify solutions, and eventually evolve into a full AI-native coding IDE.

## Current Status — 25 August 2026

Ticked boxes below mean *verified in the running application*, not planned or
partially wired. Where something exists but is incomplete it stays unticked and is
named here instead. This follows the project's own rule in section 67: do not mark
something done because it looks done.

**Verified in the running app**

| Area | State |
|---|---|
| Tauri + Next.js shell, tray, background operation | The window closes to the menu bar and the process survives, so the shortcuts keep working. Quit lives in the tray. |
| Global shortcuts | `Control+Option+S` screen, `Control+Option+R` region, `Control+Option+A` audit. Registered in Rust so they survive webview reloads. Confirmed firing in `~/Library/Logs/CodeAuditor/trace.log`. |
| Full-screen and region capture | Saved to `~/Pictures/Code Auditor`, then loaded into the app. Whole chain confirmed: key, command, file on disk, thumbnail. |
| Screenshot handling | Up to 10 per run, thumbnails, delete, full-size preview with arrow-key navigation. |
| API keys | macOS Keychain. The webview can ask *whether* a key exists, never what it is. |
| Multi-model fan-out | Six panes — GPT, Claude, Kimi, Gemini and two free models — streaming in parallel. Each vision pane reads the image itself. |
| Routing | One `routeFor()` decides every request. Each pane shows the wire its answer came over, and its own token counts and elapsed time. |
| Vendor errors | A failing pane shows the vendor's own reason in plain English — `403 credit limit insufficient` arrived intact instead of as a blank box. |
| Consensus and judge | Camps, pairwise agreement matrix, outlier flagging, and a judge that reasons rather than counts votes. |
| A real answer, end to end | A captured coding problem went out, models answered, the FINAL blocks parsed, consensus ran, and the judge produced a verdict and a shipped solution that was read on screen. |
| Postgres | Supabase connected, schema self-applied. Session sidebar lists, renames, archives and deletes. |

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

  **Latest Mac result:** `cargo test --lib exec` now runs on this Mac and passes
  27 of 29 exec tests. Two failures remain and keep this section unticked:
  the fork-loop test exits early with `main.sh: fork: Resource temporarily
  unavailable` instead of proving the wall-clock/group-kill path, and the
  unbounded Python allocation succeeds despite the intended virtual-memory cap.
  That means macOS resource-limit behaviour is the next sandbox task, not a box
  to mark done.

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

**Current project checkpoint — 2026-08-25**

- The project is now initialized as a Git repository in
  `/Users/cyberlord/Downloads/code-auditor`, with build artifacts and dependency
  folders covered by `.gitignore`.
- The app shell, provider plumbing, global capture shortcuts, multi-pane answers,
  consensus, judge mode, sessions UI, local persistence wrappers, local
  Knowledge/RAG retrieval, council prompts, screenshot tiling/manifest handling,
  extraction comparison and code-runner plumbing are implemented.
- The latest knowledge-library addition is the performance-engineering layer:
  memory metric taxonomy, fair cross-language benchmark contracts, benchmark
  noise discipline, hardware counters, assembly/codegen inspection, compiler
  build flags, cache/data-layout optimization, Python runtime memory and
  optimized-candidate correctness gates.
- The strongest tested foundation today is the non-UI logic: consensus parsing,
  OCR/reading merge rules, payload shaping, bridge signatures, SQL/schema
  consistency, prompt contracts, knowledge retrieval, council gates, image
  tiling and status/probe classification.
- The main unproven surface is the real desktop workflow: live capture under
  macOS Screen Recording permissions, model probing from the settings UI, the
  remaining macOS execution-sandbox limits, screenshot-to-session wiring and
  production app packaging.

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

1. Run one live coding audit with the new Knowledge/RAG pack visible in the
   prompt path, and confirm the final answer uses the relevant pattern and
   reports runtime professionally.
2. Fix or redesign the two macOS execution-sandbox failures from
   `cargo test --lib exec`: memory limiting and the fork-loop containment proof.
   Only then should sections 24-25 move toward checked.
3. Wire screenshots into sessions end to end: call `screenshot_add`,
   `screenshot_remove`, `screenshot_reorder` and `screenshots_purge` from the UI,
   then persist the screenshot IDs with each run record.

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
9. [Phase 4 — Multi-Model AI](#9-phase-4--multi-model-ai)
10. [Phase 5 — AI Consensus & Judge](#10-phase-5--ai-consensus--judge)
11. [Phase 6 — Knowledge Engine](#11-phase-6--knowledge-engine)
12. [Phase 7 — Coding Intelligence](#12-phase-7--coding-intelligence)
13. [Phase 8 — Code Execution & Verification](#13-phase-8--code-execution--verification)
14. [Phase 9 — Automatic Repair](#14-phase-9--automatic-repair)
15. [Phase 10 — Final Results](#15-phase-10--final-results)
16. [Phase 11 — Project Intelligence](#16-phase-11--project-intelligence)
17. [Phase 12 — AI Agent](#17-phase-12--ai-agent)
18. [Phase 13 — Full Coding Editor — Secondary Roadmap](#18-phase-13--full-coding-editor--secondary-roadmap)
19. [Phase 14 — Language & Library Intelligence](#19-phase-14--language--library-intelligence)
20. [Phase 15 — Advanced Autonomous Engineering](#20-phase-15--advanced-autonomous-engineering)
21. [Programming Knowledge Library](#21-programming-knowledge-library)
22. [Data Structures & Algorithms](#22-data-structures--algorithms)
23. [Mathematics Engine](#23-mathematics-engine)
24. [Agriculture Intelligence](#24-agriculture-intelligence)
25. [Security](#25-security)
26. [Privacy](#26-privacy)
27. [Model & API Architecture](#27-model--api-architecture)
28. [Database & Storage](#28-database--storage)
29. [UI/UX](#29-uiux)
30. [Testing](#30-testing)
31. [Performance](#31-performance)
32. [Project Structure](#32-project-structure)
33. [Master Feature Checklist](#33-master-feature-checklist)
34. [Definition of Done](#34-definition-of-done)
35. [Ultimate Product Vision](#35-ultimate-product-vision)

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

Eventually, the application should also become a **full AI-native coding environment** where an entire software project can be opened and understood.

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
├── AI Agent
├── Project Intelligence
└── Future Full IDE
```

The **Full Coding Editor/IDE is intentionally a secondary/later feature**.

The initial product should focus on the AI engineering workflow.

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

- [ ] Create session
- [ ] Rename session
- [ ] Delete session
- [ ] Archive session
- [ ] Restore session
- [ ] Add screenshots
- [ ] Remove screenshots
- [ ] Reorder screenshots
- [ ] Add text context
- [ ] Add notes
- [ ] Preserve AI responses
- [ ] Preserve final solution
- [ ] Preserve test results
- [ ] Preserve runtime results

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

- [ ] Language
- [ ] Framework
- [ ] File name
- [ ] File path
- [ ] Code
- [ ] Line numbers
- [ ] Functions
- [ ] Classes
- [ ] Imports
- [ ] Variables
- [ ] Errors

### Terminal

- [ ] Commands
- [ ] Output
- [ ] Error messages
- [ ] Stack traces
- [ ] Exit codes

### Browser

- [ ] URL
- [ ] Visible page
- [ ] Errors
- [ ] Application state

### Other

- [ ] Tables
- [ ] Diagrams
- [ ] Mathematical expressions
- [ ] Database output
- [ ] Logs
- [ ] UI designs

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

# 35. Phase 11 — Project Intelligence

This is the bridge toward your future IDE.

The user should eventually be able to:

```text
Open Project
```

and have the application understand it.

The system scans:

```text
Files
Dependencies
Architecture
Git
Tests
Configuration
Database
APIs
Documentation
```

---

# 36. Project Brain

Every project gets a persistent:

```text
PROJECT BRAIN
```

Containing:

```text
Architecture
Dependencies
Coding conventions
Important files
APIs
Database
Known issues
Previous solutions
Tests
Documentation
Project decisions
```

The AI doesn't start from zero every time.

---

# 37. Project Graph

Create relationships:

```text
File
Class
Function
Component
API
Database
Package
```

Connections:

```text
imports
calls
uses
extends
implements
renders
queries
depends-on
```

Example:

```text
LoginPage
   ↓
AuthService
   ↓
API
   ↓
Database
```

---

# 38. AI Project Agent

Add a right-side AI agent:

```text
┌──────────────────────────────┐
│        AI PROJECT AGENT      │
├──────────────────────────────┤
│                              │
│ I understand this project.   │
│                              │
│ Files indexed: 342           │
│ Dependencies: 47             │
│ Tests: 126                   │
│                              │
│ What should I do?            │
│                              │
│ Analyze                      │
│ Fix                          │
│ Explain                      │
│ Refactor                     │
│ Test                         │
└──────────────────────────────┘
```

---

# 39. Project-Wide Questions

Eventually users can ask:

> Where is authentication handled?

> Where is this API called?

> What files depend on this class?

> What happens when a user logs in?

> Which files use Stripe?

> Can I safely delete this function?

> Why is this component rendering twice?

> Explain the architecture of this application.

---

# 40. Phase 12 — AI Agent

The agent should support:

### Ask

Read-only.

### Suggest

Propose changes.

### Agent

Perform approved changes.

### Autonomous

Work through a defined task within strict boundaries.

---

# 41. Agent Tools

Eventually provide tools such as:

```text
read_file
write_file
search_project
search_symbol
run_command
run_tests
run_build
inspect_git
apply_patch
create_file
delete_file
query_knowledge
query_documentation
benchmark
```

Every dangerous operation should have appropriate permissions.

---

# 42. Agent Plan Mode

Before making large changes:

```text
PLAN

1. Inspect project
2. Identify affected files
3. Understand dependencies
4. Design solution
5. Implement
6. Test
7. Verify
```

Then:

```text
Approve Plan
```

---

# 43. Phase 13 — Full Coding Editor — SECONDARY ROADMAP

> **This phase should come later. It is NOT required for the first versions of the product.**

The goal is eventually to allow the user to open and work on an entire software project inside your application.

---

# 44. Full Editor

Eventually support:

- [ ] Open Folder
- [ ] Open Project
- [ ] File explorer
- [ ] Tabs
- [ ] Multiple editors
- [ ] Split editors
- [ ] Search
- [ ] Search/replace
- [ ] Go to definition
- [ ] Find references
- [ ] Go to symbol
- [ ] Code folding
- [ ] Syntax highlighting
- [ ] Autocomplete
- [ ] Diagnostics
- [ ] Code actions
- [ ] Terminal
- [ ] Git
- [ ] Diff
- [ ] Debugging
- [ ] Extensions/plugin architecture

The goal is eventually to provide **the important capabilities developers expect from modern professional editors**, while not attempting to reproduce every feature on day one.

---

# 45. Editor Visual Customization

Your editor should have its own identity.

### Folder colors

Allow:

```text
📁 src
📁 components
📁 database
📁 services
📁 tests
```

to have customizable colors.

### Folder icons

Allow custom icons.

### File icons

Use language-aware icons.

### Status indicators

Examples:

```text
✓ Tested
⚠ Warning
● Modified
🤖 AI Working
🔐 Security-sensitive
```

---

# 46. Editor AI

The AI panel can sit beside the editor.

User can select code and ask:

```text
Explain
Fix
Refactor
Optimize
Test
Document
Security Review
```

The AI automatically receives:

```text
Selected code
Current file
Related symbols
Relevant project context
Relevant documentation
```

---

# 47. AI-Aware Code Navigation

Eventually:

> "Show me where this function is used."

The AI can navigate the editor to the relevant locations.

Or:

> "Open the code responsible for authentication."

The editor can locate the appropriate files.

---

# 48. Project-Wide AI Refactoring

Eventually support:

```text
AI → Refactor Project
```

The agent:

```text
Analyze
 ↓
Create plan
 ↓
Identify affected files
 ↓
Apply changes
 ↓
Run tests
 ↓
Repair
 ↓
Show diff
```

---

# 49. Phase 14 — Language & Library Intelligence

This can be expanded alongside the editor.

Each language gets:

```text
Syntax Intelligence
Semantic Intelligence
LSP
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

# 50. Phase 15 — Advanced Autonomous Engineering

Long-term features:

- [ ] Autonomous coding tasks
- [ ] Project-wide refactoring
- [ ] Automatic test generation
- [ ] Automatic documentation
- [ ] Dependency upgrades
- [ ] Security audits
- [ ] Performance optimization
- [ ] Architecture analysis
- [ ] Continuous verification
- [ ] Model performance learning
- [ ] Intelligent model routing
- [ ] Long-running engineering tasks

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
- [ ] Screenshot sessions
- [ ] Screenshot history

## 🟢 PHASE 3 — Vision

- [ ] Vision model
- [ ] OCR/context extraction
- [ ] Code recognition
- [ ] Error recognition
- [ ] Terminal recognition
- [ ] Multi-image reasoning
- [ ] Confidence

## 🟢 PHASE 4 — Multi-AI

- [x] GPT
- [x] Claude
- [x] Kimi
- [x] Gemini
- [ ] Codex
- [ ] DeepSeek
- [ ] Qwen
- [ ] Model router
- [ ] Model capability system
- [x] AI comparison
- [x] Master judge

## 🟢 PHASE 5 — Knowledge

- [ ] Open programming resources
- [ ] Documentation
- [ ] Books metadata
- [ ] RAG
- [ ] Data structures
- [ ] Algorithms
- [ ] Mathematics
- [ ] Security
- [ ] Agriculture

## 🟢 PHASE 6 — Coding Intelligence

- [ ] Language detection
- [ ] Framework detection
- [ ] Dependency detection
- [ ] Library intelligence
- [ ] Documentation lookup
- [ ] Project context

## 🟢 PHASE 7 — Execution

- [ ] Sandbox
- [ ] Terminal
- [ ] Build
- [ ] Run
- [ ] Tests
- [ ] Lint
- [ ] Typecheck
- [ ] Runtime analysis
- [ ] Benchmarking

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
- [ ] Runtime
- [ ] Tests
- [ ] Security
- [x] Confidence
- [ ] Learning

## 🟡 PHASE 10 — Project Intelligence

- [ ] Open projects
- [ ] Project indexing
- [ ] Project graph
- [ ] Project Brain
- [ ] Dependency graph
- [ ] Architecture analysis
- [ ] Project-wide questions

## 🟡 PHASE 11 — AI Agent

- [ ] Read files
- [ ] Search project
- [ ] Apply patches
- [ ] Create files
- [ ] Run commands
- [ ] Run tests
- [ ] Git
- [ ] Plan mode
- [ ] Agent mode

## 🔵 PHASE 12 — FULL CODING EDITOR — LATER

- [ ] Open Folder
- [ ] Full file explorer
- [ ] Tabs
- [ ] Split editors
- [ ] Syntax highlighting
- [ ] Autocomplete
- [ ] LSP
- [ ] Go-to-definition
- [ ] Find references
- [ ] Code actions
- [ ] Diagnostics
- [ ] Terminal
- [ ] Git
- [ ] Debugging
- [ ] Diff
- [ ] Editor themes
- [ ] Folder colors
- [ ] Folder icons
- [ ] Custom workspace appearance
- [ ] Extensions

## 🟣 PHASE 13 — ADVANCED IDE INTELLIGENCE

- [ ] PHP intelligence
- [ ] Python intelligence
- [ ] TypeScript intelligence
- [ ] JavaScript intelligence
- [ ] Rust intelligence
- [ ] Go intelligence
- [ ] Dart intelligence
- [ ] Java intelligence
- [ ] C/C++ intelligence
- [ ] Framework intelligence
- [ ] Library intelligence
- [ ] Documentation intelligence

## 🔴 PHASE 14 — AUTONOMOUS ENGINEERING

- [ ] Autonomous coding
- [ ] Large refactoring
- [ ] Test generation
- [ ] Documentation generation
- [ ] Dependency upgrades
- [ ] Security auditing
- [ ] Performance optimization
- [ ] Architecture optimization
- [ ] Long-running tasks
- [ ] Intelligent model selection

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
- [ ] Sessions
- [ ] Screenshot history

## 👁️ Vision

- [ ] Image understanding
- [ ] OCR
- [ ] Code extraction
- [ ] Error extraction
- [ ] Terminal extraction
- [ ] Context reconstruction
- [ ] Confidence

## 🤖 AI

- [x] GPT
- [x] Claude
- [x] Kimi
- [x] Gemini
- [ ] Codex
- [ ] DeepSeek
- [ ] Qwen
- [ ] Router
- [x] Consensus
- [x] Judge

## 📚 Knowledge

- [ ] Programming books
- [ ] Open resources
- [ ] Official documentation
- [ ] Research
- [ ] Algorithms
- [ ] Data structures
- [ ] Mathematics
- [ ] Agriculture
- [ ] Security

## 🧪 Verification

- [ ] Sandbox
- [ ] Build
- [ ] Run
- [ ] Test
- [ ] Lint
- [ ] Typecheck
- [ ] Runtime
- [ ] Benchmark
- [ ] Security
- [ ] Repair
- [ ] Verification

## 🧠 Project Intelligence

- [ ] Project indexing
- [ ] Project graph
- [ ] Project Brain
- [ ] Dependency intelligence
- [ ] Library intelligence
- [ ] Framework intelligence
- [ ] Documentation intelligence

## 🤖 Agent

- [ ] Read
- [ ] Search
- [ ] Plan
- [ ] Edit
- [ ] Create
- [ ] Delete
- [ ] Run
- [ ] Test
- [ ] Repair
- [ ] Verify

## 💻 Future IDE

- [ ] Full editor
- [ ] File explorer
- [ ] Tabs
- [ ] Split view
- [ ] LSP
- [ ] Autocomplete
- [ ] Diagnostics
- [ ] Git
- [ ] Terminal
- [ ] Debugger
- [ ] Folder colors
- [ ] Folder icons
- [ ] Themes
- [ ] Extensions

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
   SCREENSHOT ENGINE        KNOWLEDGE ENGINE          PROJECT ENGINE
          │                        │                         │
          ▼                        ▼                         ▼
       VISION                   BOOKS                    PROJECT
          │                    DOCS                     GRAPH
          │                    RFCs                     FILES
          │                    RESEARCH                 DEPENDENCIES
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
                       AI AGENT
                          │
                          ▼
                     CODE ENGINE
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

> **An AI-native engineering workbench that can see what you're seeing, understand your project, consult multiple AI experts and trusted technical knowledge, solve problems, write and execute code, test and repair it, and ultimately verify the result — with a full professional coding environment added later.**

---

# 70. Priority Order

## 🔥 Build NOW

```text
1. Tauri + Next.js foundation
2. Ctrl+7 screenshot capture
3. Multiple screenshot sessions
4. Vision/context extraction
5. Ctrl+8 solve workflow
6. GPT/Claude/Kimi/Gemini integration
7. Multi-model comparison
8. Master Judge
9. Knowledge/RAG system
10. Code solution generation
11. Execution
12. Testing
13. Runtime checks
14. Automatic repair
15. Final verified result
```

## 🟡 Build NEXT

```text
16. Project indexing
17. Project Brain
18. Project graph
19. Library intelligence
20. Framework intelligence
21. AI project agent
22. File editing
23. Git integration
24. Agent Plan Mode
25. Security analysis
```

## 🔵 Build LATER

```text
26. Full coding editor
27. Folder/file customization
28. LSP
29. Autocomplete
30. Debugger
31. Full terminal
32. Advanced project navigation
33. Extensions
34. PHP/Python/etc. deep intelligence
```

## 🚀 Build LAST / ADVANCED

```text
35. Autonomous engineering
36. Project-wide refactoring
37. Automatic dependency upgrades
38. Continuous verification
39. Intelligent model routing
40. Long-running autonomous agents
41. Advanced performance optimization
42. Advanced model-selection learning
```

---

# 71. Final Architectural Principle

**Do not build the full VS Code replacement first.**

Build the **AI engineering brain first**.

Then make the coding editor a second layer around that brain.

```text
                    YOUR AI BRAIN
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   Screenshot         Project           Knowledge
   Intelligence      Intelligence       Intelligence
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                    AI AGENT
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
         FUTURE EDITOR          TERMINAL
              │                     │
              └──────────┬──────────┘
                         ▼
                    EXECUTION
                         │
                         ▼
                    VERIFICATION
```

The editor should eventually become a **window into the intelligence already built**, rather than the entire project being dependent on first recreating VS Code.

This gives the project a clear development path: build the core AI engineering system first, then progressively add project intelligence, agent capabilities, and finally the full professional coding environment.
