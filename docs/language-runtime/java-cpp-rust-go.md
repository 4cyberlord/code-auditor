# Compiled-language harness knowledge

Sources: [Java Language Specifications](https://docs.oracle.com/javase/specs/), [C++ reference](https://en.cppreference.com/w/), [Rust Reference](https://doc.rust-lang.org/reference/), and [Go specification](https://go.dev/ref/spec).
Purpose: safe, executable E2B test harnesses. Review date: 2026-10-13.

## Java

- A single-file runner must contain exactly one `public` class named `Main` with `public static void main(String[])`.
- Compile before running; report compiler diagnostics separately from candidate assertions.

## C and C++

- Include every required header and provide one complete translation unit.
- Compile with the configured standard and optimization flags before executing.
- Treat compiler diagnostics, linker errors, signals, and sanitizer output as execution diagnostics.

## Rust

- Provide one complete crate with a `main` entry point and all imports.
- Compile with the configured stable toolchain and optimization mode before running.

## Go

- Provide a complete package `main`, imports, and `func main()`.
- Compile or run through the configured Go toolchain; classify build errors separately from failed assertions.

For every language, expected values must be independent of the candidate, and the harness must emit structured PASS/FAIL records.
