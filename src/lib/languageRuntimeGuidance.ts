/**
 * Small, executable-facing summaries of the reviewed language-runtime packs.
 *
 * The canonical records live in the language registry and are mirrored by the
 * Markdown files under docs/language-runtime. These lines are intentionally
 * short: they are context for a harness author, never a replacement for the
 * compiler, the sandbox, or the mutation check.
 */
import { normalizeCodeLanguage } from "./council.ts";

const PACKS: Record<string, readonly string[]> = {
  python: [
    "Use one complete Python 3 program; define every name before use and preserve indentation.",
    "In comprehensions and closures, use the iterator actually declared; do not rely on ambient globals.",
    "Treat SyntaxError, NameError, TypeError, and IndentationError as harness diagnostics, not candidate failures.",
  ],
  cpp: [
    "Use one self-contained C++ translation unit (C++20 by default, C++23 when the runtime profile allows) with every required include and exactly one int main().",
    "Compile before execution; distinguish compiler/linker diagnostics from a failed assertion.",
  ],
  rust: [
    "Use one standalone Rust source file with imports and a single fn main(); do not assume Cargo dependencies.",
    "Keep ownership, borrowing, and trait requirements valid before judging candidate behaviour.",
  ],
  javascript: [
    "Use one deterministic Node program; do not use network, clocks, or randomness in expected results.",
    "Treat ReferenceError, SyntaxError, and TypeError as harness diagnostics, not candidate failures.",
  ],
  typescript: [
    "Use the configured Node TypeScript runtime only; do not require a separate compiler unless the runner provides one.",
    "Keep the solution splice inside a valid module, class, or function boundary and make expected results independent.",
  ],
};

/** Guidance for exactly one normalized candidate language, or an empty string when unsupported. */
export function runtimeGuidanceFor(language: string): string {
  const canonical = normalizeCodeLanguage(language);
  const lines = PACKS[canonical];
  if (!lines) return "";
  return [
    `LANGUAGE RUNTIME CONTRACT (${canonical})`,
    ...lines.map(line => `- ${line}`),
    "The generated harness must still emit PASS/FAIL lines and exit nonzero on any failed case.",
  ].join("\n");
}
