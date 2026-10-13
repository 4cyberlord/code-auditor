# JavaScript and TypeScript harness knowledge

Sources: [ECMAScript specification](https://tc39.es/ecma262/) and [TypeScript handbook](https://www.typescriptlang.org/docs/handbook/).  
Purpose: safe, executable E2B test harnesses. Review date: 2026-10-13.

- Run JavaScript as a single deterministic Node program; avoid network, clocks, and random values in expected results.
- Define every identifier before use; classify `ReferenceError`, `SyntaxError`, and `TypeError` as execution diagnostics.
- TypeScript harnesses must use the configured Node type-stripping/runtime path and must not depend on a separate compiler unless the E2B template provides it.
- Keep the `<<<SOLUTION>>>` splice inside a valid module/class/function boundary.
- Expected outputs must come from an independent oracle, never by calling the candidate twice.
