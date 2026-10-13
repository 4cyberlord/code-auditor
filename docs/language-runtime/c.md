# Council Editor: C17 harness runtime

Trusted source: https://www.open-std.org/jtc1/sc22/wg14/
Runner file: main.c
Runner command: cc -std=c17 -O2 main.c -o prog -lm && ./prog
Pack revision: 2026-10-13

## Syntax and entry point
One main entry point, explicit includes and prototypes, respect pointer ownership.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
