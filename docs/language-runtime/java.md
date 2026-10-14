# Council Editor: Java harness runtime

Trusted source: https://docs.oracle.com/javase/specs/
Runner file: Main.java
Runner command: javac Main.java && java Main
Pack revision: 2026-10-13

## Syntax and entry point
Exactly one public class Main; candidate helper classes must not be public top-level classes.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
