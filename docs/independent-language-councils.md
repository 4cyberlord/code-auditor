# Independent per-language Councils

The selected Settings **Code in** language (Python by default; Rust and C++ available)
is the only language solved before primary publication.

After Council verifies and publishes the primary solution:
1. The remaining supported languages each enter their own independent Council
   round, one language at a time. All available configured solver seats receive
   the original problem and explicit target language. **No primary winner source,
   code translation, algorithm blueprint, or prior candidate code is supplied.**
2. Each solver creates its own approach; a target-language E2B harness is
   independently prepared/preflight-checked, and each candidate executes.
3. Independent judges inspect only the new target-language candidate field,
   its actual E2B evidence and the question. They select the strongest verified
   target-language code. Unverified or fingerprint-mismatched code is withheld.
4. The verified result appears as an optional language entry in the existing
   report/overlay. The active view stays on the primary code until the user
   explicitly chooses `PY`, `RR`, or `CP` (or an app tab).
5. Failure of Rust or C++ independently does not invalidate the primary
   solution or the other language. New jobs cannot receive old result updates.

Two screenshot safeguards were also tightened: new early vision-evidence
readers receive original images without an OCR transcription, and cloud
judges must have an explicit successful vision probe before receiving images.
Unconfirmed screenshot examples never become authoritative E2B fixtures.

The existing E2B runtime/harness, judge aggregate, result persistence,
keyboard shortcuts, overlay geometry, and database schema are preserved.

**Validation:** CI runs TypeScript, lint, Node tests, Rust and macOS build.
Real E2B smoke requires the trusted `workflow_dispatch` job and credentials.
A CI build does not prove a live E2B sandbox execution.
