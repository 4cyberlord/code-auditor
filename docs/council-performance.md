# Council performance: bounded parallelism

Branch implementation (October 13, 2026): speed up independent work without
skipping candidate execution, mutation oracles, review, repair, re-verification,
judging or synthesis.

## Worker switches

- `CODE_AUDITOR_E2B_CONCURRENCY=4` (default): concurrent E2B candidate
  executions, maximum 9 per worker; set to 1 for serial rollback.
- `CODE_AUDITOR_HARNESS_CONCURRENCY=3` (default): parallel language
  harness generation, maximum 4; within-language model fallbacks remain serial.

Limits are per worker process and must be multiplied by deployed worker
replicas. Check E2B account quotas, rate limits and costs before increasing.
No additional E2B deployment is performed by this commit.

## Evidence and release gate

New cloud events `execution_field_timing` and
`harness_generation_timing` include measured duration and concurrency.
Per-candidate execution IDs, sandbox IDs, outputs and revised test evidence
are preserved. The final result map is ordered by candidate letter.
Desktop coordinator preflight batches its three approved coordinator probes;
original image delivery still requires independently verified vision support.

Run tests/typecheck/macOS CI together once. Evaluate p50/p95 model selection,
verification and end-to-end latency on real jobs before claiming a three-minute
SLA. Roll out to a canary worker before enabling higher concurrency generally.

## October 15: slow Council stages and verified safe overlap

The job runs independent solver seats in parallel, but downstream work
necessarily has several serialized evidence dependencies: harness generation
and E2B tests precede execution-based review; any revision must be retested
before judges see the final evidence; synthesis and the deterministic gate are
last. Do **not** remove the execution, mutation oracle, review, retest or
winner gate merely to make the progress indicator finish sooner.

The worker now overlaps two independent kinds of context lookup once the
problem contract is known: read-only topic-specific HTML pages from the
owner's personal language-documentation server and the compiled/DB knowledge
library. At the later harness phase it also fetches external HTML references
and language packs concurrently instead of waiting for one to finish before
starting the other. Session-title metadata runs alongside harness preparation
and is joined before the final report is saved.

### Which gateway is actually in the user's critical path

CleanAPIs is the primary Council gateway for this deployment. The current
worker deliberately disables TokenRouter's per-request pacer when
`gatewayId(settings) === "cleanapis"`; therefore the earlier 13-second
TokenRouter default **does not explain current CleanAPIs latency** and is
not altered in this PR.

TokenRouter/Wiro may be used for other configurations later. Those choices
should remain separate from the editor's independently configurable coding
providers. Do not change the gateway roster, credentials, retry policy or
model reasoning budgets merely to address the current Council delay.

The main post-solve costs to benchmark are reference harness generation and
preflight, E2B candidate runs plus mutation oracle, parallel review passes,
conditional revision/re-execution, parallel judges, and final synthesis.
Keep those correctness steps and capture their measured durations before any
provider-specific concurrency tuning.

### How to compare before/after

For representative jobs, inspect the existing
`council_phase_timings`, `harness_generation_timing`, and
`execution_field_timing` cloud events, then compare p50/p95 and failures by
phase: contract, solving, benchmark, reviewing, revising, reverifying, judging,
synthesizing. Benchmark includes harness preflight, E2B and mutation checks,
so it must not be conflated with model response time. Always compare the same
model roster, problem categories, E2B account and source-document set.

Run the full `npm test` and workflow validation. All correctness, source-image, runner isolation and revised-code evidence checks remain enabled. This commit does not change production environment variables or deploy the worker.


## October 16: overlap Rust/C++ port translation and harness preparation

The two requested output ports already run with bounded concurrency, but each
individual port used to wait for translation (including language documentation
and pack retrieval) before it could begin generating its E2B reference harness.

When the original problem **explicitly supplies a callable contract**, the
port worker now launches the *specification-only* target-language reference
harness alongside source-to-target translation. Reference test values must
still come from the problem, not the translated candidate. Both asynchronous
operations are joined before testing or publication. When the callable
contract is unknown, the original candidate-aware sequence is unchanged.

- A rejected or empty speculative harness falls back to candidate-aware
  generation after translation; a speculative model failure cannot overwrite
  the translator choice made at the start of the port.
- A speculative harness with a language-specific signature mismatch can be
  regenerated once, only after an E2B integration/compile error with no actual
  passing or failing cases. Genuine failed assertions are **never** retried
  merely to obtain a passing suite.
- Existing independent E2B reference preflight, candidate E2B execution,
  mutation-oracle checks, verified-only gating, bounded port concurrency,
  serialized report writes and immediate primary-source publication remain.
- Cloud event `port_preparation_timing` now exposes elapsed preparation time,
  translation time, spec-harness time, and whether the spec-first path was
  used. `port_early_harness_fallback` and `port_interface_retry` capture
  recovery without disguising it as a successful verification.
- Set `CODE_AUDITOR_PORT_PARALLEL_HARNESS=0` for immediate per-worker
  rollback to serial port harness preparation (default is on for eligible
  callable contracts). No other execution or correctness setting changes.
- The new concurrency and failure-path regression tests live in
  `tests/specFirstDelivery.test.mjs`.

No database, model-provider, API-token, live E2B quota, UI geometry or
production worker deployment change is required. Compare the same real-world
Rust/C++ problems before/after at the `port_preparation_timing` stage and
inspect the E2B pass/fail and fallback counts before calling the change faster
in production. Do not merge unless Node test, typecheck, lint and security
workflows pass; exercise live E2B separately with trusted credentials.
