# Harness Engine V2 — supplied-example-first verification

## What this changes

- Question-supplied labelled Input/Output pairs are **authoritative fixtures**. The same
  exact inputs and expected outputs are used for each candidate without asking a model
  to synthesize a new reference algorithm merely to check statement examples.
- For supported contracts, src/lib/providedCaseHarness.ts compiles a deterministic
  Python test driver, executed inside existing E2B isolation. This driver:
  - calls Python class Solution methods or standalone Python functions when the
    inputs are JSON-compatible and the candidate API is recognizable;
  - compiles and runs Python, C++23 and Rust stdin/stdout programs when the
    question explicitly specifies that interface and supplies labelled sample I/O;
  - enforces one real comparison per supplied case and emits machine-readable
    CA_CASE evidence, not self-reported PASS text.
- A sample-only result is identified as "provided examples", not a claim about
  hidden inputs or general algorithmic correctness.
- If the question has one supplied test, the application can honestly report one
  tested case. It no longer forces eight synthetic examples with possibly invented
  expectations. Up to two independent edge cases are optional, not required.
- A malformed model/gateway response is separately reported as a provider/route
  failure instead of claiming the model wrote an invalid Python harness.
- E2B, independent review, mutation signals, code-digest checks and the existing
  runner error categories remain enabled.

## Conservative fallback

The deterministic fixture compiler intentionally refuses unsupported or ambiguous
formats. Examples include unlabeled outputs, Python code with unknown callable
interfaces, Rust/C++ class/function judge APIs without a native adapter, and
non-JSON-callable inputs. These continue through the existing multi-author E2B
reference-harness path. The spec prompt still prioritizes every supplied example,
uses an independent reference, and limits additional guesses.

The deterministic stdin wrapper uses standard subprocess compilation and runs inside
E2B with its existing timeout/resource boundaries; it never executes untrusted
candidate code in the user-facing macOS process. Passing 1–2 samples is weak
evidence, not a proof. Problems without independently verifiable expected values
must fail closed rather than invent an answer.

## Diagnostics and regression checks

- Run node tests/providedCaseHarness.test.ts for real Python sample execution and
  optional native C++/Rust compilation smoke tests.
- npm test includes the new test before the rest of the existing suite.
- npm run typecheck and npm run lint should pass before merging.
- Before production rollout, verify an actual image with examples, a question with
  only one test, ambiguous examples, no-examples fallback, multi-language code ports,
  both gateway empty replies and E2B sandbox failures, and the saved report wording.
- This feature is branch-only until tested; no migrations, secrets, database writes,
  production worker deployments, or macOS overlay geometry changes are required.

## Limits / future improvements

Non-stdin Rust/C++ judge function APIs require exact typed adapters, not inferred
templates. They should be added as strongly typed per-signature libraries with
their own compilers and tests. Do not auto-cast unknown types or claim coverage
where the question does not supply a reliable output oracle.
