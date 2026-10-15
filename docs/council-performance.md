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

### Most likely throttle when solver selection is quick

TokenRouter and Wiro currently pace new model requests globally. The defaults
are `CODE_AUDITOR_TOKENROUTER_MIN_DELAY_MS=13000` and
`CODE_AUDITOR_TOKENROUTER_JITTER_MS=1500`. Therefore issuing
`Promise.all` for four solver/reviewer seats does not make them all *start*
together: the global pacer spaces gateway requests.

To keep existing rate-limit behavior, `CODE_AUDITOR_TOKENROUTER_PACING_SCOPE`
defaults to `global`. If and **only if** the gateway/account permits
separate per-model concurrency, an operator can set it to `per_model` on one
canary worker and verify 429 responses, queue depth, spend, and end-to-end
latency before rolling out. Requests for each individual model retain the
existing minimum spacing and jitter; other models may begin in independent
lanes. Unknown values use the safe `global` mode.

Reducing `CODE_AUDITOR_TOKENROUTER_MIN_DELAY_MS` is another existing
operator override, but should not be done without observed quota headroom.
Raising request concurrency will not improve cases that are bottlenecked by
model reasoning time or E2B startup; it may make rate limits worse.

### How to compare before/after

For representative jobs, inspect the existing
`council_phase_timings`, `harness_generation_timing`, and
`execution_field_timing` cloud events, then compare p50/p95 and failures by
phase: contract, solving, benchmark, reviewing, revising, reverifying, judging,
synthesizing. Benchmark includes harness preflight, E2B and mutation checks,
so it must not be conflated with model response time. Always compare the same
model roster, problem categories, E2B account and source-document set.

Targeted check: `node tests/gatewayPacer.test.mjs`; the full `npm test`
command includes it. All correctness, source-image, runner isolation and
revised-code evidence checks remain enabled. This commit does not change
production environment variables or deploy the worker.
