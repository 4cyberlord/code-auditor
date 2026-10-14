# Council Editor: Rust stable harness runtime

Trusted source: https://doc.rust-lang.org/reference/
Runner file: main.rs
Runner command: rustc -O main.rs -o prog && ./prog
Pack revision: 2026-10-13

## Syntax and entry point
One fn main(), correct ownership, borrowing and traits; do not assume Cargo dependencies.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
