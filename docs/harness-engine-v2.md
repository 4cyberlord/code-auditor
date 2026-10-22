# Harness Engine V2 — supplied-example-first verification

## What this changes

- Question-supplied labelled Input/Output pairs are **authoritative fixtures**. The same
  exact inputs and expected outputs are used for each candidate without asking a model
  to synthesize a new reference algorithm merely to check statement examples.
- For supported contracts, src/lib/providedCaseHarness.ts compiles a deterministic
  Python test driver, executed inside existing E2B isolation. This driver:
  - calls Python class Solution methods or standalone Python functions when the
    inputs are JSON-compatible and the candidate API is recognizable;
  - compiles and runs Python, C++ and Rust stdin/stdout programs when the
    question explicitly specifies that interface and supplies labelled sample I/O;
  - enforces one real comparison per supplied case and emits machine-readable
    CA_CASE evidence, not self-reported PASS text.
- A sample-only result is identified as "provided examples", not a claim about
  hidden inputs or general algorithmic correctness.
- If the deterministic adapter can safely execute the supplied contract, it tests
  every distinct supplied example and reports exactly that sample evidence; one
  supplied case is not misrepresented as hidden-test assurance.
- If the deterministic adapter cannot handle the contract, the AI-authored fallback
  still requires at least eight distinct named checks, including the supplied examples
  and independently justified scenarios. It must derive synthetic expected outputs
  from its independent reference rather than inventing them.
- A malformed model/gateway response is separately reported as a provider/route
  failure instead of claiming the model wrote an invalid Python harness.
- E2B, independent review, mutation signals, code-digest checks and the existing
  runner error categories remain enabled.

## Registry identity

Every suite carries `harnessVersion` (bumped with each template or comparison
change) and `contractHash` (a stable digest of the question plus its exact
fixtures). Both are copied into the candidate run record, so one execution can be
reproduced and two runs can be told apart when a previously passing harness later
fails. Reusing the same contract produces the same hash; changing the statement
changes it.

## Failure taxonomy

A run records `failureKind` separately from its pass/fail result:

- `candidate` — the code produced wrong output against a sound harness.
- `harness` — the driver, its coverage or its compilation is at fault.
- `infrastructure` — E2B, the compiler or the network failed.
- `timeout` — the run exceeded its budget.
- `unknown` — evidence is insufficient to attribute the failure.

Only `candidate` is sent to the solver as a repair instruction. A harness failure
is never recorded as a wrong solution; the harness author repairs instead.

## Mutation check

A deliberately broken variant of a passing candidate is spliced into the same
harness. If the harness still passes it, the suite is reported as too weak
(`oracle` evidence) instead of the result being trusted.

## Conservative fallback

The deterministic fixture compiler intentionally refuses unsupported or ambiguous
formats. Examples include unlabeled outputs, Python code with unknown callable
interfaces, Rust/C++ class/function judge APIs without a native adapter, and
non-JSON-callable inputs. These continue through the existing multi-author E2B
reference-harness path. The spec prompt still prioritizes every supplied example,
uses an independent reference, and limits additional guesses.

The deterministic stdin wrapper uses standard subprocess compilation and runs inside
E2B with its existing timeout/resource boundaries; it never executes untrusted
candidate code in the user-facing macOS process. Passing 1–2 supplied samples is weak
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

Rust and C++ judge APIs are now handled by typed native adapters: a `Solution`
method (with or without a `&self`/`const` receiver) or a free function, using
`int`/`float`/`bool`/`string` and nested `vector`/`Vec` of those. Argument values
come from the labelled case by parameter name, the expected value is typed from
the declared return type, and unordered contracts sort before comparing. The
driver is spliced with the candidate as raw source and compiled by the same E2B
command as any other C++/Rust program.

Node types are covered in all three languages: `ListNode`/`TreeNode` are built from
the statement arrays and returns are serialized back before comparison, with the
struct injected when the starter omits it.

Field names are read from the starter (val/value, next/nxt, left/right), node and vector
arguments may be mixed, and anything outside the type set — other pointers, graphs,
maps, pairs, tuples, generics — returns null and falls back to the AI reference harness. Do not
auto-cast unknown types or claim coverage where the question supplies no reliable
output oracle.
