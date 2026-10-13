# Council Editor: Python 3 harness runtime

Trusted source: https://docs.python.org/3/reference/
Runner file: main.py
Runner command: python3 main.py
Pack revision: 2026-10-13

## Syntax and entry point
Python top-level functions, indentation, defined names, and properly scoped comprehensions.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
