# Python harness knowledge

Source: [Python Language Reference](https://docs.python.org/3/reference/)  
Purpose: safe, executable E2B test harnesses. Review date: 2026-10-13.

## Required checks

- Compile the complete harness before inserting candidate code.
- Every name in an expression, comprehension, closure, and expected-value oracle must be defined in scope.
- A comprehension must use the iterator it declares: `for i in range(n)` when the expression references `i`; never mix it with `_`.
- Keep expected values independent from the candidate implementation.
- Treat `Traceback`, `NameError`, `SyntaxError`, `TypeError`, and `IndentationError` as harness/runtime diagnostics, not proof that the candidate algorithm is wrong.
- Emit one `PASS name` or `FAIL name got=... want=...` line per case and a non-zero exit when a case fails.

## Benchmark notes

`time` includes interpreter startup and harness overhead. Report it as measured process wall time, separately from theoretical complexity and peak memory.
