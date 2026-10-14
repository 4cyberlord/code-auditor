# Council Editor: TypeScript with Node strip-types harness runtime

Trusted source: https://www.typescriptlang.org/docs/handbook/
Runner file: main.ts
Runner command: node --experimental-strip-types main.ts
Pack revision: 2026-10-13

## Syntax and entry point
Erasable TypeScript syntax only; enums and parameter properties are not guaranteed.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
