# Council performance: bounded parallelism

Branch implementation (October 13, 2026): speed up independent work without
skipping candidate execution, mutation oracles, review, repair, re-verification,
judging or synthesis.

## Worker switches

- `CODE_AUDITOR_E2B_CONCURRENCY=4` (default): concurrent E2B candidate
  executions, maximum 9 per worker; set to 1 for serial rollback.
- `CODE_AUDITOR_HARNESS_CONCURRENCY=2` (default): parallel language
  harness generation, maximum 3; within-language model fallbacks remain serial.

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
