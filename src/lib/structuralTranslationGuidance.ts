/**
 * A compact, semantic translation contract for the languages the Council can
 * publish as verified solutions. It distils the reviewed structural dictionary
 * into prompt-sized rules; the runtime packs and E2B executions remain the
 * authority for syntax and behaviour.
 *
 * Do not turn this into a token replacement table. A port is correct only when
 * it preserves the winning algorithm's input/output contract and passes the
 * target language's independently validated harness.
 */

export type StructuralLanguage = "python" | "cpp" | "rust";

const ALIASES: Record<string, StructuralLanguage> = {
  python: "python", py: "python", python3: "python",
  cpp: "cpp", "c++": "cpp", cxx: "cpp", cc: "cpp",
  rust: "rust", rs: "rust",
};

export function structuralLanguage(raw: string): StructuralLanguage | null {
  return ALIASES[raw.trim().toLowerCase()] ?? null;
}

const COMMON = [
  "Preserve the verified algorithm, public function/class signature, input/output format, edge cases, mutation behaviour, and asymptotic complexity. This is not permission to invent a different algorithm.",
  "Translate semantic categories, never syntax tokens mechanically: values, mutability, ownership/reference behaviour, absence versus failure, iterator laziness, and resource lifetime all need an intentional target-language representation.",
  "Infer concrete target types from the stated constraints and tested behaviour. Do not use an unsigned/index type for values that can be negative, and do not silently narrow integers.",
  "Keep the target implementation self-contained and judge-safe. No network, filesystem, randomness, or dependencies outside the target runner unless the original problem contract explicitly requires them.",
  "When this contract conflicts with the target runtime pack or compiler, follow the target runtime pack/compiler and repair the port. E2B is the final behavioural gate.",
];

const PAIRS: Partial<Record<`${StructuralLanguage}->${StructuralLanguage}`, readonly string[]>> = {
  "python->cpp": [
    "Replace Python's dynamic bindings with explicit C++23 value/reference types. Choose std::vector, std::string, unordered_map/map, optional, and variant based on the actual contract rather than Python surface spelling.",
    "Map Python None used for ordinary absence to std::optional; map recoverable failures to std::expected or an explicit error channel. Do not erase an error into an empty optional.",
    "Translate comprehensions/generators deliberately: use loops when they make ownership and materialization clear; use ranges/views only when their lifetime and laziness are safe.",
    "Use RAII for resources and explicit bounds-safe indexing. Python's module-main guard is not part of a C++ solution method; keep only the entry point the judge requires.",
  ],
  "python->rust": [
    "Choose ownership and borrowing before writing loops: pass read-only collections by reference, mutate through &mut only when the Python behaviour mutates caller-visible state, and clone only when the contract requires independent ownership.",
    "Map Python None used for ordinary absence to Option<T>; map exceptions/recoverable failure to Result<T, E> and propagate or handle it at every fallible edge. Do not conflate the two.",
    "Translate comprehensions/generators to iterator chains only when lifetimes and ownership stay clear; otherwise use explicit Vec construction or loops. Materialize with collect only when the algorithm needs storage.",
    "Use signed numeric types for potentially negative values and usize only for proven indices/counts. Keep match exhaustive and make mutable bindings explicit.",
  ],
  "cpp->python": [
    "Do not imitate C++ ownership syntax in Python. Preserve value/mutation semantics with normal Python objects, and keep copies explicit where C++ value semantics were necessary.",
    "Translate optional/error representations by meaning: normal absence becomes None, while a meaningful failure should remain an exception or an explicit result value rather than disappearing.",
    "Do not carry over C++ sentinel values, pointer-null checks, iterator invalidation assumptions, or fixed-width overflow behaviour unless the problem contract requires them.",
  ],
  "cpp->rust": [
    "Translate C++ references/pointers/smart pointers by ownership meaning, not spelling. Prefer borrowed references for reads, owned values for transfer, and shared synchronization only where the original contract truly shares mutable state.",
    "Map optional-like absence to Option and expected/error-like outcomes to Result. A C++ switch over a discriminated state often becomes an exhaustive Rust match.",
    "Replace iterator/pointer arithmetic with bounds-safe indexing or iterator APIs. Respect Rust aliasing and borrowing rules instead of forcing unsafe code.",
  ],
  "rust->python": [
    "Do not simulate the borrow checker in Python. Preserve externally visible ownership and mutation behaviour with clear copy/mutate decisions, especially for nested collections.",
    "Translate Option by meaning to None where absence is normal, and Result by meaning to exceptions or an explicit result object where failure is distinguishable from absence.",
    "Keep Rust iterator behaviour correct: generators are lazy, list/set/dict comprehensions materialize. Select the one that preserves the original algorithm's memory and repeated-use behaviour.",
  ],
  "rust->cpp": [
    "Translate Rust ownership/borrowing into explicit C++ value, reference, and RAII lifetime choices. Do not replace every owned value with a raw pointer or every borrow with a shared pointer.",
    "Map Option to std::optional and Result to std::expected or an explicit error representation when their meanings are retained. Preserve exhaustive state handling with variant visitation or explicit branches.",
    "Retain Rust's bounds-safe intent: use checked conditions or container access patterns appropriate to the algorithm, not unchecked pointer arithmetic.",
  ],
};

/**
 * Return prompt material for a supported source/target pair. An empty string
 * means this is not a Python/C++/Rust structural port and the ordinary runtime
 * packs are the only applicable language guidance.
 */
export function structuralTranslationGuidanceFor(source: string, target: string): string {
  const from = structuralLanguage(source);
  const to = structuralLanguage(target);
  if (!from || !to || from === to) return "";
  const rules = PAIRS[`${from}->${to}`];
  if (!rules) return "";
  return [
    `STRUCTURAL TRANSLATION CONTRACT (${from} -> ${to})`,
    "This contract is distilled from the reviewed Python 3.15 <-> C++23 <-> Rust 1.99 translation dictionary.",
    ...COMMON.map(rule => `- ${rule}`),
    "Pair-specific rules:",
    ...rules.map(rule => `- ${rule}`),
    "Before returning code, mentally check: signature, type ranges, absence/error semantics, aliasing/mutation, iterator materialization, and target compilation. The generated port must then pass its own independent target-language E2B harness.",
  ].join("\n");
}
