# Council Editor: Ruby CLI harness runtime

Trusted source: https://docs.ruby-lang.org/en/
Runner file: main.rb
Runner command: ruby main.rb
Pack revision: 2026-10-13

## Syntax and entry point
Use correct def/end, module and class syntax; avoid undeclared gems.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
