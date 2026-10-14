# Council Editor: C++20 harness runtime

Trusted source: https://en.cppreference.com/w/
Runner file: main.cpp
Runner command: c++ -std=c++20 -O2 main.cpp -o prog && ./prog
Pack revision: 2026-10-13

## Syntax and entry point
Only one int main(); all standard headers and names must be defined.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
