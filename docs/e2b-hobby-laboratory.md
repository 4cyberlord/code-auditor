# Council Editor — Hobby-safe E2B execution labs (stacked on PR #40)

This change is based on `perf/parallel-language-harness-20261016` (PR #40).
Do not merge the stacked draft PR before its parent, and do not deploy it without
live E2B smoke checks. Neither branch changes the production database or E2B account.

## Actual runtime sequence

1. Cloud worker accepts an authenticated coding job, reads the original images,
   establishes the problem contract and selects the primary language.
2. If the primary language is Python and the operator has enabled
   `CODE_AUDITOR_E2B_PREWARM=1`, start at most four **distinct** E2B microVMs
   from the same configured template, assigned to solver seats A, B, C and D.
   This begins while those models are producing their independent solutions.
3. Reference harness preparation may overlap solving. It still has to execute
   an independent reference in E2B before candidate evaluation when available.
4. On its first E2B run each candidate consumes only its own prewarmed VM.
   An absent, expired or failed slot falls back to the existing fresh-sandbox
   path. Revisions and timeout retries always use new isolated VMs.
5. The reference, candidate tests, mutation-oracle, reviewers, judges and
   deterministic verified-winner gate are unchanged; strict oracle mode
   (documented below) is an extra opt-in check.
6. The verified primary result is saved and becomes visible before language
   ports. Only **then**, when enabled, create up to two distinct port VMs
   while translation and target harnesses proceed in parallel (PR #40).
7. Rust and C++ independently run compiled code through their own E2B
   harnesses and mutation oracles. Failed ports do not invalidate the already
   published primary result. Optional trace comparison is corroboration only.
8. Kill every consumed VM after execution. Kill unused standby VMs after
   their idle TTL and again at job cleanup. Never reuse a VM across candidates,
   jobs, users or languages.

The same image is shared across the four Python sandbox instances. Runtime
state, program files, global variables and interpreter processes are NOT shared.
We do NOT ask E2B itself to translate code; language models still perform the
translation, and E2B compiles/tests the result. E2B network egress remains off.

## Feature switches and rollback

All new expensive or correctness-affecting switches default to OFF.

| Setting | Default | Purpose |
|---|---|---|
| `CODE_AUDITOR_E2B_WORKER_CAP` | `8` | Maximum live E2B leases in one worker, including standby; never above 8 on Hobby |
| `CODE_AUDITOR_E2B_PREWARM` | `0` | Start up to four separate Python VMs during solver generation |
| `CODE_AUDITOR_E2B_PREWARM_PORTS` | `0` | Start separate Rust and C++ standby VMs **after** verified primary publication |
| `CODE_AUDITOR_E2B_WARM_IDLE_MS` | `75000` | Destroy unused standby VMs; bounds 1000–180000 ms |
| `CODE_AUDITOR_E2B_STRICT_ORACLE` | `0` | Reject final coding verification on a missing independent reference or surviving mutation |
| `CODE_AUDITOR_E2B_DIFFERENTIAL` | `0` | Request and compare optional common-fixture runtime traces |
| `CODE_AUDITOR_E2B_DIFFERENTIAL_STRICT` | `0` | Reject a port only when matching supported input traces actually disagree |
| `CODE_AUDITOR_E2B_EXTENDED_VALIDATORS` | `0` | Build-time only: preinstall pinned Python validators and clang tools |
| `CODE_AUDITOR_CPP_STANDARD` | `c++20` | Optionally test `c++23` after toolchain verification |
| `CODE_AUDITOR_E2B_TEMPLATE_REVISION` | unset | Release identifier included in reference-harness cache keys |
| `CODE_AUDITOR_PORT_PARALLEL_HARNESS` | enabled for supported contracts | Inherited from PR #40; `0` rolls back its overlap |

The existing `CODE_AUDITOR_E2B_CONCURRENCY=4` limit still controls candidate
runners. Capacity permits are also held by standby VMs. Template alias is set
through the existing `CODE_AUDITOR_E2B_TEMPLATE` variable.

## E2B Hobby cost and global concurrency

Published Hobby limit: 20 simultaneous microVMs, one-hour sessions, and
$100 **one-time**, not monthly, usage credit. E2B bills by sandbox runtime.
At the advertised default 2-vCPU + 4-GiB rates (Oct 2026), one VM costs
approximately $0.000046 per second. Four fully idle 75-second standby VMs
would therefore consume roughly $0.0138 before any additional work. Actual
total depends on model latency, execution, sandbox template and current prices.

**Important**: `E2B_WORKER_CAP` is process-local and does NOT globally enforce
20 across independently deployed worker processes or outside users of the
same E2B account. Until a transactional distributed lease service is deployed,
run only one bounded worker canary for the Hobby account, or reserve headroom
explicitly when other workers/apps use the account. Do not claim a global
Hobby account limit is implemented by this PR.

Do not hold persistent E2B sandboxes warm between jobs: an unused microVM
would continue billing. If all four AI responses are slow, 75-second
standby slots may expire and normal cold execution is intentional.

## Reference-harness cache and verification

The existing process-local independent reference cache retains its bounded
TTL. Cache fingerprints now include language pack version, E2B template name,
explicit image revision, requested C++ standard and owning account ID.
It never caches a failed reference as passing. No user-supplied code is
persisted to a new cache or to Supabase. Separate E2B candidate execution
evidence is preserved in the report and is not silently reused across users.

Harness trust is exposed under `report.e2bEvidence.harness`. Enable
`CODE_AUDITOR_E2B_STRICT_ORACLE=1` only after live canary tests show
the harness providers reliably supply independent references. A strict
failure is intentionally fail-closed; it does not rewrite test expectations
to make a candidate pass. A positive generated harness does NOT prove all
online judge hidden cases.

Report `e2bEvidence` contains per-candidate status, pass/fail counts,
provider, sandbox/execution IDs, exit attestation flag, execution duration,
peak memory, sandbox boot duration and standby age when applicable. For compiled Rust/C++, the sandbox now emits separate nested program-only
wall-clock and memory measurements; it also preserves the outer
compiler-plus-execution total. Neither reading should be promoted as a
cross-language benchmark from a single run. These measurements are not
mathematical proofs of Big-O or language-to-language performance rankings;
existing Council symbolic reasoning remains independent.

## Optional differential traces

Only when explicitly enabled, the harness author is instructed to print
`CA_DIFF_CASE {"id":"case_name","input":...,"actual":...}` for a bounded
subset of deterministic JSON-compatible test cases, alongside mandatory
PASS/FAIL assertions. This auxiliary trace is compared across the verified
primary and a target port by identical ID **and identical canonical input**.
If missing or inapplicable, status is `unavailable`/`incomparable`.
When the outputs disagree, the port is flagged; an additional explicit
strict flag can prevent publication of that divergent port.

Do NOT interpret matching traces as a mathematical equivalence proof.
Order-independent, nondeterministic, floating-tolerance and multi-answer
problems may not use this protocol; those retain their own independent
problem-specific test harnesses.

## Safe release procedure

1. Keep this stacked PR based on PR #40, and merge PR #40 first.
   When validating an intermediate stacked branch against main-only CI,
   keep the PR draft, then restore its stacked base before the final merge.
2. Run `node tests/e2bWarmPool.test.mjs`,
   `node tests/e2bEvidence.test.mjs`,
   `node tests/e2bRuntimeProfile.test.mjs`,
   `node tests/e2bDifferential.test.mjs`,
   `node tests/specFirstDelivery.test.mjs`, `npm test`, `npm run lint`
   and `npm run typecheck`, then macOS Rust/build and security CI.
3. With separate canary template alias, build the enhanced image only if
   extended tools are desired and validate the installed compiler versions.
   No image build is triggered by this PR.
4. Use a trusted private E2B key and one test worker. Compare representative
   Python coding tasks with standby off and on; include delayed model replies,
   a failed model, a deliberately failing test, a revision, missing harnesses,
   cold-fallback, and a rejected port. Check sandbox IDs, teardown and
   account concurrency in the E2B dashboard. Repeat with two output ports.
5. Inspect `e2b_prewarm_*`, `e2b_port_prewarm_*`, `execution_field_timing`,
   `harness_trust_summary` and PR #40's `port_preparation_timing` events.
   Compare p50/p95 latency and consumption, not anecdotal one-run speed.
6. Retarget the child PR to `main` **after** PR #40 merges, reconcile main
   changes, rerun checks, then merge only when the live canary is clean.
7. Roll back standby immediately with both PREWARM switches set to `0`.
   Turn strict oracle/differential and extended validators off independently
   if a regression appears. Existing fresh E2B execution must keep working.

## Deliberate limits

- No actual E2B sandboxes were started by this code change, and no cloud worker
  was deployed.
- The global cross-replica quota semaphore and a persisted/shared verified
  execution cache require separately audited infrastructure; neither is
  silently represented as implemented.
- Reproducing source semantics in Rust/C++ always requires an LLM or compiler
  translation stage and independent runtime tests. E2B alone cannot invent
  semantically correct ports, Big-O proofs or valid expected results.
- The existing main-app and overlay dimensions, UI state machine, secrets,
  sign-in behavior and production database schema are untouched.

## New E2B Build System 2.0 template and source-agent recovery (Oct 16)

`scripts/build-e2b-template.mjs` now uses E2B's **code-defined Build
System 2.0**, including `Template().fromTemplate(...).aptInstall(...)`,
`pipInstall(PINNED_PYTHON_VALIDATORS)`, and `setEnvs` for an explicit
revision. The build alias defaults to **`council-validators-v2`**, deliberately
different from any existing production runner alias. Extended validators are
included by default **only when this dedicated build script is explicitly run**;
set `CODE_AUDITOR_E2B_EXTENDED_VALIDATORS=0` to omit them. Template builds
and deployment are not triggered by the GitHub branch. After a successful
private smoke check, the worker may opt in using
`CODE_AUDITOR_E2B_TEMPLATE=council-validators-v2`, together with a matching
`CODE_AUDITOR_E2B_TEMPLATE_REVISION`.

Template installation supplies the compilers, Python packages and diagnostic
tools, but it does NOT turn E2B itself into a language model. The original
verified source solver remains a model running through the authenticated
Council gateway; E2B remains the isolated execution backend with internet
egress denied and no model API keys injected into the VM.

If Rust or C++ fails with candidate-code compilation or assertion failures,
the same model that authored the verified primary solution can attempt
**one correction per failed target language**. The two target ports are
processed concurrently by the existing bounded `parallelMap(targets,2)`,
so the model may receive two independent repair requests in parallel.
The failed source, original verified source, original problem and E2B
diagnostics are presented as evidence; **the original independently
validated harness and expected results are never altered**. The corrected
code must pass E2B again and its mutation check before publication. A
sandbox outage, canceled task, missing harness or timeout does not trigger
an expensive semantic repair request.

`CODE_AUDITOR_E2B_PORT_REPAIR` enables or disables bounded source-agent
recovery; during rollout, use `0` to return to the original translation path.
`report.ports[].repair` records the attempt and success/failure without
overwriting original evidence.

`report.ports[].analysis` contains algorithm and data-structure clues,
the model's separate time/space complexity claims where the answer supplies
them, and measured harness runtime/RSS. The values are *explicitly labelled
as model claims*, not independently proven Big-O. Compiler-inclusive time
and harness-process timing remain distinct. Measured RSS is never presented
as asymptotic space complexity.

E2B's newer pause/resume and filesystem snapshot APIs may help truly
long-lived interactive agent sessions, but are deliberately **not** used for
these short untrusted verification runs on Hobby. Stateless template-backed,
one-use sandboxes reduce state leakage and simplify cleanup. Revisit snapshots
only with verified billing, timeout, security and recovery semantics.

### CLI cancellation triage

GitHub Actions reports canceled jobs when its `cancel-in-progress`
concurrency group is superseded by a new commit or PR base update. This is
not the same as an E2B execution, compiler failure, or failing `npm test`.
Do not label the message `The operation was canceled` a code defect without
a job ID or diagnostic log. Re-run the current commit after branch writes
settle; preserve the exact workflow run link and failed step. The stacked PR
workflow can run directly against PR #40's branch without temporarily
retargeting it to main.
