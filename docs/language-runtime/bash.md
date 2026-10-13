# Council Editor: Bash harness runtime

Trusted source: https://www.gnu.org/software/bash/manual/
Runner file: main.sh
Runner command: bash main.sh
Pack revision: 2026-10-13

## Syntax and entry point
Quoting, deterministic status, no external network, bounded subprocesses.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
