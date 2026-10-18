# CleanAPI multimodal vision validation

This feature branch preserves the current four independent Council solver seats, Python-first solution policy, overlay geometry, and database schema. Rust/C++ independent Councils remain disabled until Python passes live E2B validation.

## Supported, configured models

Use the current authenticated CleanAPI catalog rather than assuming a provider's public model list is proof of account access. The preferred independent readers are Gemini 3.1 Pro, Claude Opus 5.5, then GPT 5.6 Sol. Gemini 4 Argon is intentionally not added because it was not present in the saved approved roster.

## Image verification and evidence

A catalog entry is not an image test. The desktop performs a real native red-square PNG probe through the active gateway using the configured image transport (signed Azure URL for CleanAPI), evaluates the returned color, and records a nonzero measured duration. Old green 0 ms catalog assertions never authorize reading screenshot pixels and are not displayed as verified.

Two independent specialist models examine the ORIGINAL screenshot, not prior OCR or solution text. Each returns a JSON object with literal examples and uncertainties. The parser rejects incomplete or type-invalid fixtures. If the first two readers disagree or provide incomplete evidence, one third independent model is consulted. Only exact input/output pairs with at least two independent confirming votes become authoritative supplied fixtures. Conflicts remain visible to judges. Models must not infer expected outputs.

The original screenshot stays available to image-verified solvers and judges. The current E2B harness, real per-case traces, fingerprint protection, and judge-upgrade gates remain responsible for correctness. JSON-mode guarantees parsing shape at most; it does not prove image correctness.

## Validation before production

1. Run node tests/visionModelPolicy.test.ts and node tests/problemEvidence.test.ts.
2. Run npm run typecheck, npm run lint, npm test and npm run check:rust.
3. With the connected CleanAPI key and the authenticated desktop, run actual image probes for the three specialist routes. Each must return a positive-duration real image check; no model should become image-verified from catalog listing.
4. Submit real screenshots containing code, exact sample pairs, a graph, and distracting non-question UI. Verify two-reader extraction, third-reader disagreement recovery, uncertainty disclosure, correct example preservation, and no false positives.
5. Verify Python output, each CA_CASE trace, same-suite E2B retesting for repairs, and preservation of the last verified Python winner. Do not re-enable Rust/C++ from this change.

Real CleanAPI inference and E2B smoke require live credentials/environment; source-level unit tests alone cannot establish live deployment readiness.
