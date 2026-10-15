# Council Editor — Primary language reference source

The cloud Council uses the owner's existing read-only HTML documentation server as the **first programming-language knowledge source**, not an optional cloud backup.

| Language | Pinned source | Notes |
| --- | --- | --- |
| Python | `http://144.24.31.129/offline-docs/python-3.15.0/python-3.15-docs-html/` | Python 3.15 documentation |
| Rust | `http://144.24.31.129/offline-docs/rust-1.99.0/` | Rust 1.99 documentation |
| C++ | `http://144.24.31.129/offline-docs/cpp-26-wg21-n5050/html/` | WG21 N5050 C++26 working draft; **not** a substitute for C++23 compiler validation |

## Cloud-side workflow

1. Once screenshots have been interpreted and the problem contract is available, `scripts/cloud-worker.mjs` identifies the relevant language.
2. `scripts/lib/authoritativeLanguageDocs.mjs` selects a small number of topic-specific, administrator-approved HTML paths and fetches them directly from the personal server. User prompts and model output never control the host or pathname.
3. The cloud worker sends bounded, plain-text excerpts with the source URL and document version to the **first solving round**.
4. For each actual coding language in the candidate field, harness generation fetches that language's corresponding reference independently. Python documentation cannot accidentally serve as C++ harness guidance.
5. The same first-solve documentation remains visible during reviewer critique, revision, judging and final synthesis.
6. Existing verified runtime packs and algorithmic knowledge complement the current reference; they remain available on outages.
7. E2B independently compiles and executes code and the exact harness. External documentation is helpful evidence, **not** proof of behavioral correctness.

The Mac app and helper do not download or index the documentation. The engine fetches only relevant pages and strips script/style markup; it never instructs E2B to make network requests. Network errors do not abort solve jobs.

## Performance and trust boundaries

- At most three allowlisted pages per language lookup, fetched concurrently with a three-second budget per page under normal execution.
- Ten-minute per-process cache (80-page upper limit) and concurrent-request coalescing to avoid repeated document downloads during multi-agent runs.
- Maximum HTML response of 512 KiB per page and maximum composed reference context of 6,500 characters.
- Remote HTML is treated as **untrusted reference data**, not instructions to the agent, database writes, execution code, or credentials.
- This server currently uses **HTTP without TLS**. The reference source is therefore not cryptographically authenticated in transit. Adding HTTPS at the existing host would be recommended before exposing it across untrusted networks; this implementation makes no unrelated server changes.
- The C++26 documentation contains features unavailable in a C++23 toolchain. Solver and harness prompts explicitly warn against treating C++26-specific syntax as valid C++23.

## Source choice

The active source is always the owner's pinned server. Nothing in this implementation requires R2, a Cloudflare upload, GitHub R2 secrets or another database migration. A future archive migration would involve adding a second administrator-approved connector, not modifying the Mac app.

## Validation

`node --check scripts/cloud-worker.mjs`

`node tests/authoritativeLanguageDocs.test.mjs`

`node tests/externalLanguageSources.test.mjs`

`node tests/languageRegistry.test.mjs`

The dedicated GitHub Actions verification workflow also performs live requests against all three documentation sites. Targeted tests and syntax validation do not replace a complete cloud worker or E2B production smoke test.
