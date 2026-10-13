# Council Editor: Go harness runtime

Trusted source: https://go.dev/ref/spec
Runner file: main.go
Runner command: go run main.go
Pack revision: 2026-10-13

## Syntax and entry point
package main, a single func main() and all imports used.

## Verification discipline
- Insert code at precisely one SOLUTION splice marker; preserve the candidate's algorithm.
- Write independently derived expected results with named PASS or FAIL assertions.
- Exit nonzero when any case fails.
- Execute a known-good independent reference when one is available.
- Mutate a known-good implementation to ensure the harness catches deliberate faults.
- Classify harness compile failures separately from candidate compile failures.
- Respect the problem's interface, constraints and permitted dependencies.
