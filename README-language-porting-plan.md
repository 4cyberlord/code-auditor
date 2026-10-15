# Verified Multi-Language Solution Porting

Use the following implementation brief with an AI engineering agent to upgrade
this application’s verified Python, C++, and Rust solution-porting workflow.

```text
You are a principal compiler/tooling engineer. Audit and upgrade this existing code-solution application so it can produce professionally verified equivalent implementations in Python, C++, and Rust.

Do not claim perfect source-to-source conversion. Build a reliability-first system: a language port is only displayed as verified when it passes independent validation and executable tests in its own target language.

First, inspect the entire current repository and explain the existing flow before modifying anything. Identify:
- how the winning solution is selected;
- how test harnesses are generated and executed;
- how E2B execution is queued and reported;
- how language knowledge is loaded from the external language database;
- how Python, C++, and Rust output settings and ports are currently handled;
- any existing tests, worker paths, and UI states that could be affected.

Then implement the following architecture without breaking existing main-app or overlay behavior.

1. Supported-language contract
- Support Python, C++, and Rust as the only verified port languages.
- Python is the default primary output language, configurable in Settings.
- C++ and Rust remain optional target ports.
- Preserve the language explicitly requested by the problem when necessary, but make the selected primary language visible and configurable.

2. Production language-reference layer
- Use the existing external language database as a versioned, official-reference source.
- For each target language, retrieve only relevant official language/runtime guidance: syntax, standard library, compiler/runtime version, imports, error handling, memory/ownership rules, and known unsupported patterns.
- Do not dump entire documentation into prompts.
- Create a focused “language port contract” for each requested port.
- Record source/version metadata used for each generated port.

3. Structured source analysis
- Before translating a verified winner, analyze the source code structurally.
- Extract its function signature, input/output shape, data structures, mutations, recursion/iteration, exceptions, imports, complexity target, and dependency assumptions.
- Detect Python features that cannot safely map automatically, including dynamic attribute access, eval/exec, monkey patching, reflection, runtime code generation, unsupported external packages, threads/async I/O, or framework-specific behavior.
- If unsupported behavior is found, fail closed: explain why the port is not eligible rather than pretending it is equivalent.
- Prefer real language parsers/AST analysis where practical. Do not rely on a plain-text regex-only conversion strategy.

4. Harness quality gate
- A generated harness must contain exact executable cases from the problem statement, generated edge and adversarial cases, an independent reference implementation/oracle, clear PASS/FAIL output, and a splice point for the candidate/port.
- Before any candidate or port is tested, execute the independent reference through the exact harness in E2B.
- Reject and regenerate the harness if the reference fails, if statement examples conflict, if zero runnable cases exist, or if expected values are internally inconsistent.
- Never hard-code expected values for synthetic cases when an independent oracle can compute them.
- If all independent candidates fail identical named cases, treat the harness as suspect, regenerate it once from an independent author, validate its reference again, then rerun.
- Preserve diagnostics so it is clear whether failure came from the candidate, target port, harness, compiler, or E2B.

5. Primary solve workflow
- Four selected models solve the original problem independently.
- They receive the original images/problem plus the relevant problem contract and language knowledge.
- Execute candidates concurrently in E2B once the validated harness is ready.
- Keep the existing review, revision, judge, and winner gate.
- A candidate cannot win unless its exact code passes executable verification.
- Show the verified primary answer immediately after it wins. Do not delay it for optional language ports.

6. Port workflow
- After the verified winner is known, create Python/C++/Rust equivalents only for the two other configured languages.
- A port must preserve the problem contract, function/API signature, input/output behavior, edge-case semantics, asymptotic complexity, and deterministic behavior where applicable.
- Use the target language’s official reference pack and language-port contract.
- Generate one port at a time or with controlled concurrency so the primary answer remains fast.
- For each port: generate target code; compile/lint where available; run the target-language independent reference harness; run the target port against it in E2B; compare its test outcome with the verified primary implementation; publish only if verified.
- If a port fails, retain diagnostic evidence but do not expose it as a working alternative.

7. Static and runtime checks
- Add language-appropriate preflight checks: Python syntax and safe lint/type diagnostics; C++ compilation with strict warning flags; Rust compiler checks.
- Do not treat warnings alone as correctness failures unless they indicate unsafe or invalid behavior.
- Capture compiler errors and relevant failing test names, but do not expose unbounded raw logs in the UI.

8. UI and progress
- Keep the current interface design and existing application logic intact.
- Add clear per-language status only where useful: primary solution verified, preparing/verified/not-verified C++ port, and preparing/verified/not-verified Rust port.
- Do not show all enabled models before actual model selection.
- Do not show internal timing fragments such as “contracting: 56s.”
- Do not hide a verified primary solution while ports are still running.
- Clearly distinguish verified, still processing, unsupported, and not verified.

9. Reliability and security
- Keep all model IDs sourced from the configured provider/database mappings.
- Preserve per-submission image isolation and signed Azure URLs.
- Do not weaken existing authentication, storage, E2B, or verification gates.
- Never publish a solution or translated port merely because a model says it is correct.
- Do not perform a release build; use dev/test workflows only.

10. Tests and report
- Add focused automated tests for Python default output language; Python/C++/Rust port eligibility; rejection of a harness without a passing independent reference; rejection of a port that compiles but fails behavior tests; visibility of the verified primary solution while ports run; prevention of a faulty shared harness from falsely rejecting every candidate; and unsupported Python feature detection.
- Run type-checks and relevant test suites.
- Do not modify unrelated dirty files.
- At the end, report exact files changed, architecture implemented, test commands and results, limitations that still prevent a guaranteed perfect translation, and any remaining decisions that need my approval.

Work carefully, preserve existing working behavior, and make incremental, evidence-backed changes rather than rewriting the app.
```
