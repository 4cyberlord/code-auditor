# Council Editor: Node ESM JavaScript harness runtime

Trusted source: https://tc39.es/ecma262/
Runner file: main.mjs
Runner command: node main.mjs
Pack revision: 2026-10-13

## Syntax and entry point
Distinguish named exports, default exports and global variables; avoid duplicated declarations.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
