"use client";

/**
 * The first Knowledge/RAG slice.
 *
 * This is deliberately local and small: enough to improve coding answers today,
 * while keeping the boundary that an embedding/vector index can replace later.
 * External resources are linked and summarised; the app does not vendor whole
 * articles or books into prompts.
 */

export interface KnowledgeSource {
  title: string;
  url: string;
  note: string;
  trust?: "official" | "academic" | "reference" | "community";
}

export interface KnowledgeRecord {
  id: string;
  title: string;
  kind: "pattern" | "problem" | "runtime" | "resource";
  tags: string[];
  summary: string;
  guidance: string[];
  complexity?: string;
  targetRuntimeMs?: number;
  targetMemoryMb?: number;
  sources?: KnowledgeSource[];
}

export interface KnowledgeHit {
  record: KnowledgeRecord;
  score: number;
}

const RECORDS: KnowledgeRecord[] = [
  {
    id: "runtime-discipline",
    title: "Runtime reporting discipline",
    kind: "runtime",
    tags: ["runtime", "benchmark", "performance", "complexity", "leetcode"],
    summary:
      "Treat milliseconds as measured evidence, not a complexity claim. Prefer solutions likely to fit tight online-judge limits, but never invent a Runtime number.",
    guidance: [
      "Report asymptotic time and space for every coding answer.",
      "If a measured run exists, quote it exactly and label the environment when known.",
      "If no measured run exists, say 'Runtime: not measured' rather than fabricating a number.",
      "A displayed Runtime: 0ms is only valid when the local harness or judge actually measured and rounded it to 0; otherwise the honest target is best-known complexity plus measured evidence.",
      "Target Memory <= 10MB for coding challenge solutions by avoiding avoidable auxiliary structures, but report 'Memory: not measured' unless peak memory was measured by the runner or judge.",
      "For LeetCode-style algorithm problems, aim for an approach plausibly at or under 17ms in the target language when constraints allow it; if that is unrealistic, explain why.",
      "Prefer one-pass, union-find, prefix/suffix, binary-search, or linear-time graph/table techniques over brute force when n reaches 10^4-10^5.",
    ],
    targetRuntimeMs: 17,
    targetMemoryMb: 10,
    sources: [
      {
        title: "Rosetta Code: Runtime evaluation",
        url: "https://rosettacode.org/wiki/Runtime_evaluation",
        note:
          "Cross-language examples of evaluating code at runtime. Useful as a resource reference for runtime/evaluation concepts, not as a benchmark source.",
        trust: "reference",
      },
      {
        title: "Rosetta Code: Time a function",
        url: "https://rosettacode.org/wiki/Time_a_function",
        note:
          "Shows language-specific timing patterns. Use for measurement technique ideas; do not treat results across languages as comparable.",
        trust: "reference",
      },
    ],
  },
  {
    id: "zero-ms-memory-contract",
    title: "Zero-ms / low-memory answer contract",
    kind: "runtime",
    tags: ["runtime", "0ms", "zero-ms", "memory", "10mb", "performance", "target", "honesty"],
    summary:
      "The product should pursue judge-fast solutions, but exact 0ms and <=10MB are measured outcomes, not promises. The agent must optimise toward them and say when evidence is missing.",
    guidance: [
      "Choose the lowest asymptotic complexity that fits the constraints before tuning constants.",
      "Prefer O(1) extra memory when possible; otherwise justify each auxiliary array, map, heap, queue, table, or graph.",
      "After generating code, perform an internal budget check: expected time complexity, expected auxiliary memory, largest input, and whether the target can plausibly hit a rounded 0ms/<=10MB on an online judge.",
      "If the target is impossible for the problem constraints or language runtime, say why and give the fastest correct alternative.",
      "Never write 'Runtime: 0ms' or 'Memory: 10MB' unless those exact numbers came from a measured run or an online judge result.",
    ],
    targetRuntimeMs: 0,
    targetMemoryMb: 10,
    sources: [
      {
        title: "Rosetta Code: Runtime evaluation",
        url: "https://rosettacode.org/wiki/Runtime_evaluation",
        note: "Reference for runtime-evaluation techniques across languages.",
        trust: "reference",
      },
      {
        title: "Google Benchmark user guide",
        url: "https://google.github.io/benchmark/user_guide.html",
        note: "Official benchmark guidance for measured performance claims.",
        trust: "official",
      },
    ],
  },
  {
    id: "graph-connectivity-threshold",
    title: "Graph connectivity with threshold",
    kind: "problem",
    tags: ["graph", "connectivity", "union-find", "disjoint-set", "gcd", "divisor", "threshold", "leetcode-1627"],
    summary:
      "For cities 1..n, connect numbers sharing a divisor greater than threshold by unioning each divisor with its multiples.",
    guidance: [
      "If threshold is 0, every city is connected through divisor 1; answer every query true.",
      "For d from threshold + 1 to n, union d with 2d, 3d, ... n.",
      "Answer each query by comparing DSU roots.",
      "Do not test every pair of cities; O(n^2 log n) is too slow.",
      "Path compression plus union by size/rank keeps query checks effectively constant time.",
    ],
    complexity: "O(n log n + q alpha(n)) time, O(n) space",
    targetRuntimeMs: 17,
  },
  {
    id: "dsu-template",
    title: "Disjoint Set Union template",
    kind: "pattern",
    tags: ["union-find", "dsu", "connectivity", "component", "graph"],
    summary:
      "Use DSU for dynamic connectivity when edges are known or can be generated; compress paths and union by size/rank.",
    guidance: [
      "Keep parent and size/rank arrays indexed exactly like the problem domain to avoid off-by-one translation.",
      "find(x) should compress the path.",
      "union(a,b) should attach smaller tree to larger tree or lower rank to higher rank.",
      "Expose same(a,b) for query code so the solver logic stays readable.",
    ],
    complexity: "O(alpha(n)) amortized per union/find",
  },
  {
    id: "two-sum",
    title: "Two Sum / complement lookup",
    kind: "problem",
    tags: ["array", "hash-map", "one-pass", "two-sum", "complement"],
    summary:
      "Use a hash map from value to index and check each value's complement before inserting the current value.",
    guidance: [
      "Check complement before insert to avoid using the same index twice.",
      "Duplicates are valid when they appear at different indices.",
      "Sorting changes indices; only sort if the output does not require original positions.",
    ],
    complexity: "O(n) time, O(n) space",
    targetRuntimeMs: 17,
  },
  {
    id: "sliding-window",
    title: "Sliding window for contiguous ranges",
    kind: "pattern",
    tags: ["array", "string", "sliding-window", "two-pointers", "substring", "subarray"],
    summary:
      "Use a moving left/right window when the answer depends on a contiguous segment and the validity condition can be updated incrementally.",
    guidance: [
      "Expand right one step at a time.",
      "Shrink left while the window violates the condition or while shrinking preserves validity for minimum-length problems.",
      "Keep counts/maps in sync as endpoints move.",
      "For negative numbers in sum problems, sliding window may fail; consider prefix sums instead.",
    ],
    complexity: "Usually O(n) time, O(k) space",
    targetRuntimeMs: 17,
  },
  {
    id: "binary-search-answer",
    title: "Binary search on answer",
    kind: "pattern",
    tags: ["binary-search", "monotonic", "minimize", "maximize", "capacity", "feasible"],
    summary:
      "When a yes/no feasibility predicate is monotonic, binary search the answer and implement the predicate carefully.",
    guidance: [
      "Define exactly what true means: 'capacity x works' or 'speed x finishes'.",
      "Prove monotonicity before using binary search.",
      "Choose bounds from constraints, not guesses.",
      "Keep the feasibility check linear or near-linear; otherwise the search only hides the slow part.",
    ],
    complexity: "O(check(n) * log range)",
  },
  {
    id: "prefix-sums",
    title: "Prefix sums and difference arrays",
    kind: "pattern",
    tags: ["prefix-sum", "difference-array", "range-query", "range-update", "subarray"],
    summary:
      "Precompute cumulative information when many queries ask about ranges or when range updates can be deferred.",
    guidance: [
      "Prefix sums answer static range-sum queries in O(1) after O(n) build.",
      "Difference arrays apply many range increments in O(1) each, then reconstruct with one prefix pass.",
      "For subarray sum equals k with arbitrary signs, store counts of prior prefix sums.",
    ],
    complexity: "O(n + q) time, O(n) space in common forms",
    targetRuntimeMs: 17,
  },
  {
    id: "graph-bfs-dfs",
    title: "BFS/DFS graph traversal",
    kind: "pattern",
    tags: ["graph", "bfs", "dfs", "shortest-path", "components", "grid"],
    summary:
      "Use BFS/DFS for reachability, components, and unweighted shortest paths after building the right adjacency representation.",
    guidance: [
      "Use BFS for shortest path in unweighted graphs.",
      "Use iterative DFS/BFS when recursion depth can exceed the language stack.",
      "Mark visited when enqueuing/pushing, not when popping, to avoid duplicates.",
      "For dense implicit graphs, avoid materializing all edges if neighbors can be generated cheaply.",
    ],
    complexity: "O(V + E) time, O(V) space",
  },
  {
    id: "benchmarking-method",
    title: "Benchmarking method before optimisation",
    kind: "runtime",
    tags: ["benchmark", "measure", "runtime", "profiling", "performance", "statistics", "regression"],
    summary:
      "Optimise from measured evidence: use repeatable inputs, warmups where appropriate, wall/CPU time labels, and regression checks.",
    guidance: [
      "Separate correctness tests from benchmarks; a benchmark that can be wrong is just a fast bug.",
      "Run multiple iterations and compare medians or distributions rather than one lucky timing.",
      "Label the runtime, language, input size, machine and timeout when reporting measured results.",
      "For generated solutions, benchmark comparable candidates against the same cases and reject candidates that fail correctness first.",
      "Use the 17ms target as a product goal for coding challenge answers, not as a fabricated measurement.",
    ],
    targetRuntimeMs: 17,
    sources: [
      {
        title: "Node.js performance measurement APIs",
        url: "https://nodejs.org/api/perf_hooks.html",
        note: "Official Node APIs for precise marks, measures and performance entries.",
        trust: "official",
      },
      {
        title: "Python timeit",
        url: "https://docs.python.org/3/library/timeit.html",
        note: "Official micro-benchmark helper for small Python snippets.",
        trust: "official",
      },
      {
        title: "Google Benchmark user guide",
        url: "https://google.github.io/benchmark/user_guide.html",
        note: "Official C++ microbenchmarking guide.",
        trust: "official",
      },
    ],
  },
  {
    id: "python-performance",
    title: "Python performance and profiling",
    kind: "resource",
    tags: ["python", "profile", "profiling", "cprofile", "timeit", "runtime", "performance", "optimization"],
    summary:
      "Use cProfile for function-level profiling and timeit for focused snippets; prefer algorithmic improvements before micro-optimising Python syntax.",
    guidance: [
      "Use cProfile/pstats to find where time is actually spent.",
      "Use timeit for tight snippets, with setup separated from the measured body.",
      "For LeetCode Python, avoid O(n^2) scans at 10^5, repeated list membership checks, and excessive object churn in inner loops.",
      "Prefer lists/dicts/sets, local variables in hot loops, iterative traversal for deep graphs, and early exits from easy cases.",
    ],
    targetRuntimeMs: 17,
    sources: [
      {
        title: "Python profilers",
        url: "https://docs.python.org/3/library/profile.html",
        note: "Official cProfile/profile documentation.",
        trust: "official",
      },
      {
        title: "Python timeit",
        url: "https://docs.python.org/3/library/timeit.html",
        note: "Official timing utility for small code fragments.",
        trust: "official",
      },
    ],
  },
  {
    id: "javascript-node-performance",
    title: "JavaScript and Node.js performance measurement",
    kind: "resource",
    tags: ["javascript", "typescript", "node", "perf_hooks", "performance", "runtime", "benchmark", "memory"],
    summary:
      "Use Node's perf_hooks for measured timing and avoid benchmark noise from I/O, console logging, JIT warmup and mixed setup work.",
    guidance: [
      "Measure with performance.now(), performance.mark() and performance.measure() rather than Date for short intervals.",
      "Keep setup and assertions outside the timed section when comparing candidate solutions.",
      "Avoid console logging inside hot loops; it dominates algorithm cost.",
      "For coding problems, prefer arrays/maps/sets and avoid repeated string/array copying inside nested loops.",
    ],
    targetRuntimeMs: 17,
    sources: [
      {
        title: "Node.js perf_hooks",
        url: "https://nodejs.org/api/perf_hooks.html",
        note: "Official Node.js performance measurement API.",
        trust: "official",
      },
    ],
  },
  {
    id: "rust-performance",
    title: "Rust benchmarking and profiling",
    kind: "resource",
    tags: ["rust", "criterion", "benchmark", "profiling", "runtime", "performance", "cargo"],
    summary:
      "Use Criterion for statistically meaningful Rust microbenchmarks and profiler integration when the timing says a hot path matters.",
    guidance: [
      "Use Criterion for repeatable Rust benchmarks rather than one-off Instant timings.",
      "Keep allocation and parsing setup outside benchmark bodies unless they are part of the operation being compared.",
      "For app internals, profile before changing async/concurrency structure.",
      "Use tracing spans around model dispatch, DB reads, OCR and execution runs so slow phases become visible.",
    ],
    sources: [
      {
        title: "Criterion.rs profiling guide",
        url: "https://bheisler.github.io/criterion.rs/book/user_guide/profiling.html",
        note: "Criterion user guide for profiler integration.",
        trust: "reference",
      },
      {
        title: "criterion crate",
        url: "https://docs.rs/criterion/latest/criterion/",
        note: "Statistics-driven Rust microbenchmarking library docs.",
        trust: "official",
      },
      {
        title: "tokio tracing",
        url: "https://tokio-rs.github.io/tracing/tracing/",
        note: "Structured instrumentation useful for async performance visibility.",
        trust: "official",
      },
    ],
  },
  {
    id: "cpp-performance",
    title: "C++ benchmarking",
    kind: "resource",
    tags: ["cpp", "c++", "google-benchmark", "benchmark", "runtime", "performance", "microbenchmark"],
    summary:
      "Use Google Benchmark for C++ candidate comparison and microbenchmarks; keep correctness gates ahead of speed ranking.",
    guidance: [
      "Use a benchmark harness when comparing multiple C++ candidate implementations.",
      "Prevent the compiler from optimizing away the work under test.",
      "Measure the same input distributions for every candidate.",
      "Report compiler, optimisation flags and input scale with any runtime result.",
    ],
    sources: [
      {
        title: "Google Benchmark",
        url: "https://github.com/google/benchmark",
        note: "Official C++ microbenchmark library repository.",
        trust: "official",
      },
      {
        title: "Google Benchmark user guide",
        url: "https://google.github.io/benchmark/user_guide.html",
        note: "Official usage guide and benchmark options.",
        trust: "official",
      },
    ],
  },
  {
    id: "memory-metric-taxonomy",
    title: "Memory metric taxonomy",
    kind: "runtime",
    tags: ["memory", "rss", "peak-rss", "ru_maxrss", "vmrss", "vmhwm", "auxiliary-space", "heap", "stack", "resident-set"],
    summary:
      "Separate algorithm auxiliary memory from process memory: input storage, stack, heap payload, allocator overhead, RSS, peak RSS, virtual memory and judge-reported memory are different claims.",
    guidance: [
      "When reporting space complexity, label whether it is auxiliary algorithm memory, peak heap, peak RSS, or judge memory.",
      "Do not compare a few hundred bytes of algorithm state with a multi-megabyte process RSS as if they are the same measurement.",
      "On Linux, treat ru_maxrss and VmHWM as peak resident-set style process measurements; use VmRSS/RssAnon/RssFile/RssShmem when the breakdown matters.",
      "For interpreted runtimes, separate runtime startup footprint from objects allocated by the candidate algorithm.",
      "In memory contests, measure the same binary/runtime and input shape before ranking candidates by memory.",
    ],
    sources: [
      {
        title: "Linux getrusage(2)",
        url: "https://man7.org/linux/man-pages/man2/getrusage.2.html",
        note: "Defines ru_maxrss and other process resource-usage fields.",
        trust: "official",
      },
      {
        title: "Linux /proc filesystem documentation",
        url: "https://www.kernel.org/doc/html/latest/filesystems/proc.html",
        note: "Documents VmRSS, VmHWM and RSS breakdown fields exposed through /proc.",
        trust: "official",
      },
    ],
  },
  {
    id: "cross-language-benchmark-contract",
    title: "Cross-language benchmark contract",
    kind: "runtime",
    tags: ["benchmark", "cross-language", "cpp", "c++", "rust", "python", "fairness", "deterministic", "workload", "warmup"],
    summary:
      "Only compare C++, Rust, Python or JavaScript candidates when they execute the same workload under a written measurement contract.",
    guidance: [
      "Use identical input bytes or a shared checked fixture; do not assume different random generators produce comparable cases.",
      "Keep workload shape, repetition count, warmup policy, machine, compiler/runtime versions and optimization flags constant across candidates.",
      "Separate setup/generation/parsing from the timed body unless that work is part of the real task.",
      "Report medians or distributions from repeated runs, not a single fastest result.",
      "Reject cross-language comparisons when one candidate uses a machine-specific flag, precomputed input, or different correctness workload without disclosure.",
    ],
    sources: [
      {
        title: "Google Benchmark user guide",
        url: "https://google.github.io/benchmark/user_guide.html",
        note: "C++ benchmark framework with repetitions, statistics, warmups and machine context.",
        trust: "official",
      },
      {
        title: "Criterion.rs analysis model",
        url: "https://bheisler.github.io/criterion.rs/book/analysis.html",
        note: "Explains warmup, measurement, analysis and comparison phases for Rust benchmarking.",
        trust: "reference",
      },
      {
        title: "pyperf benchmark execution",
        url: "https://pyperf.readthedocs.io/en/latest/run_benchmark.html",
        note: "Python benchmarking tool that uses worker processes and repeated measurements.",
        trust: "official",
      },
    ],
  },
  {
    id: "optimization-correctness-gate",
    title: "Optimization correctness gate",
    kind: "runtime",
    tags: ["correctness", "optimization", "benchmark", "property-testing", "differential-testing", "hypothesis", "proptest", "rapidcheck", "bruteforce"],
    summary:
      "An optimized candidate may enter runtime ranking only after it matches a simple reference implementation and passes edge, random and maximum-constraint tests.",
    guidance: [
      "Build or keep a slow obvious reference for small cases before trusting a clever optimized solution.",
      "Use property-based or differential tests to compare optimized code against the reference over randomized inputs.",
      "Run edge-case suites before benchmark suites: empty/minimal input, duplicate values, limits, overflow boundaries and adversarial shapes.",
      "A candidate that is faster because it skips work, relies on undefined behavior, or changes semantics loses before timing is considered.",
      "Rank by runtime only after correctness, identical workload, repeated measurements and memory budget checks pass.",
    ],
    sources: [
      {
        title: "Hypothesis",
        url: "https://hypothesis.readthedocs.io/",
        note: "Python property-based testing library useful for reference-vs-optimized equivalence checks.",
        trust: "official",
      },
      {
        title: "Rust proptest",
        url: "https://docs.rs/proptest/latest/proptest/",
        note: "Rust property-testing crate for randomized correctness checks.",
        trust: "official",
      },
      {
        title: "RapidCheck",
        url: "https://github.com/emil-e/rapidcheck",
        note: "C++ property-based testing library.",
        trust: "community",
      },
    ],
  },
  {
    id: "benchmark-noise-control",
    title: "Benchmark noise control",
    kind: "runtime",
    tags: ["benchmark", "noise", "warmup", "cpu-affinity", "statistics", "median", "pyperf", "variance", "performance"],
    summary:
      "Treat short runtimes as noisy measurements; use warmups, repeated processes, CPU/system tuning and statistical summaries before claiming a speedup.",
    guidance: [
      "Prefer median and distribution summaries over best-of-one timings.",
      "Run enough iterations to detect variance and benchmark harness warnings.",
      "Minimize background load, power-state changes, thermal throttling and unrelated I/O during performance runs.",
      "Keep cache-state assumptions explicit: cold-cache and warm-cache benchmarks answer different questions.",
      "When a speedup is within noise, call it inconclusive and gather more evidence instead of crowning a winner.",
    ],
    sources: [
      {
        title: "pyperf system tuning",
        url: "https://pyperf.readthedocs.io/en/stable/system.html",
        note: "Documents CPU affinity, system tuning and noise controls for benchmarks.",
        trust: "official",
      },
      {
        title: "pyperf benchmark execution",
        url: "https://pyperf.readthedocs.io/en/latest/run_benchmark.html",
        note: "Explains worker processes, calibration and repeated benchmark runs.",
        trust: "official",
      },
    ],
  },
  {
    id: "hardware-counter-profiling",
    title: "Hardware counter profiling",
    kind: "runtime",
    tags: ["profiling", "perf", "hardware-counters", "cycles", "instructions", "ipc", "cache-misses", "branch-misses", "page-faults"],
    summary:
      "Use hardware counters to explain performance with cycles, instructions, IPC, cache misses, branches, page faults and context switches instead of guessing from source code.",
    guidance: [
      "After a benchmark shows a real difference, inspect counters to learn whether the winner executes fewer instructions, misses fewer caches, or avoids branch penalties.",
      "Use cycles and instructions to compute IPC and distinguish front-end, back-end, memory and branch bottlenecks.",
      "Compare counters on the same input and same build mode; mixed workloads produce misleading explanations.",
      "Treat hardware-counter results as machine-specific evidence, not universal truth.",
    ],
    sources: [
      {
        title: "Linux perf wiki",
        url: "https://perfwiki.github.io/main/",
        note: "Reference for Linux perf events and hardware-counter profiling.",
        trust: "reference",
      },
      {
        title: "Google Benchmark user guide",
        url: "https://google.github.io/benchmark/user_guide.html",
        note: "Documents benchmark counters and performance-counter integration.",
        trust: "official",
      },
    ],
  },
  {
    id: "assembly-codegen-inspection",
    title: "Assembly and codegen inspection",
    kind: "resource",
    tags: ["assembly", "codegen", "compiler", "llvm-ir", "mir", "godbolt", "compiler-explorer", "vectorization", "inlining", "bounds-checks"],
    summary:
      "Inspect generated assembly, LLVM IR or Rust MIR when source-level reasoning cannot explain a tight-loop performance result.",
    guidance: [
      "Check whether hot functions inline, bounds checks disappear, loops vectorize, and redundant loads/stores remain.",
      "Compare release builds with the exact flags used by the benchmark; debug assembly is usually irrelevant for performance ranking.",
      "Use codegen inspection to form hypotheses, then verify them with benchmarks or counters.",
      "Do not optimize for one compiler output if it makes the source fragile and the measured gain is not real.",
    ],
    sources: [
      {
        title: "Compiler Explorer",
        url: "https://godbolt.org/",
        note: "Interactive compiler-output explorer for C++, Rust, LLVM IR, Rust MIR and optimization views.",
        trust: "reference",
      },
    ],
  },
  {
    id: "machine-code-throughput-analysis",
    title: "Machine-code throughput analysis",
    kind: "resource",
    tags: ["llvm-mca", "throughput", "ipc", "latency", "dependency-chain", "execution-ports", "machine-code", "assembly"],
    summary:
      "Use machine-code throughput tools to estimate instruction latency, dependency chains, IPC and execution-port pressure for tight loops.",
    guidance: [
      "Use llvm-mca after assembly inspection suggests a loop is limited by instruction throughput or dependencies.",
      "Compare predicted throughput with measured benchmark results; disagreement is a prompt to inspect memory, branches or measurement setup.",
      "Treat microarchitecture models as explanatory aids, not as replacements for real execution on the target machine.",
    ],
    sources: [
      {
        title: "LLVM llvm-mca",
        url: "https://llvm.org/docs/CommandGuide/llvm-mca.html",
        note: "LLVM machine-code analyzer for throughput, IPC and processor-resource pressure.",
        trust: "official",
      },
    ],
  },
  {
    id: "compiler-build-optimization",
    title: "Compiler and build optimization",
    kind: "runtime",
    tags: ["compiler", "build", "optimization", "lto", "pgo", "target-cpu", "codegen-units", "panic-abort", "clang", "gcc", "rust"],
    summary:
      "Choose build flags deliberately: optimization level, LTO, codegen units, target CPU, panic/runtime settings, allocator choice and PGO can change both speed and memory.",
    guidance: [
      "Report compiler version and flags with benchmark results; flags are part of the experiment.",
      "Use judge-safe portable flags for online submissions; reserve target-cpu=native and CPU-specific tuning for local/product binaries.",
      "For Rust release builds, evaluate opt-level, LTO, codegen-units=1, panic=abort, allocator choice and target-cpu only with measurement.",
      "Use PGO only with representative workloads; profiling easy or unbalanced cases can train the compiler toward the wrong branch layout and inlining decisions.",
      "Rebenchmark after build-flag changes because smaller binaries, faster code and lower memory do not always move together.",
    ],
    sources: [
      {
        title: "Rust Performance Book: build configuration",
        url: "https://nnethercote.github.io/perf-book/build-configuration.html",
        note: "Rust guidance on codegen units, LTO, target-cpu, allocators and PGO.",
        trust: "reference",
      },
      {
        title: "Clang Users Manual",
        url: "https://clang.llvm.org/docs/UsersManual.html",
        note: "Official Clang documentation including optimization and profile-guided optimization.",
        trust: "official",
      },
      {
        title: "GCC optimization options",
        url: "https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html",
        note: "Official GCC optimization-flag reference.",
        trust: "official",
      },
      {
        title: "GCC instrumentation options",
        url: "https://gcc.gnu.org/onlinedocs/gcc/Instrumentation-Options.html",
        note: "Official GCC profiling and instrumentation options including PGO workflows.",
        trust: "official",
      },
    ],
  },
  {
    id: "cache-data-layout-optimization",
    title: "Cache and data-layout optimization",
    kind: "runtime",
    tags: ["cache", "locality", "data-layout", "aos", "soa", "simd", "branch-prediction", "prefetch", "microarchitecture", "allocation"],
    summary:
      "At low runtimes, contiguous data layout, cache locality, branch predictability, smaller payloads and allocation count often matter more than surface syntax.",
    guidance: [
      "Prefer contiguous arrays and compact numeric state over pointer-heavy object graphs in hot loops.",
      "Choose array-of-structs or struct-of-arrays based on the fields touched together in the hot path.",
      "Use smaller integer widths only when they are safe and actually reduce bandwidth/cache pressure.",
      "Reserve or preallocate when growth is predictable; avoid allocation churn inside inner loops.",
      "Treat SIMD, prefetching and branch layout as measured optimizations after the algorithm and data representation are right.",
    ],
    sources: [
      {
        title: "Intel 64 and IA-32 optimization resources",
        url: "https://www.intel.com/content/www/us/en/developer/articles/technical/intel64-and-ia32-architectures-optimization.html",
        note: "Intel optimization references for cache, SIMD, branch prediction and memory access.",
        trust: "official",
      },
      {
        title: "AMD Developer Documentation",
        url: "https://docs.amd.com/",
        note: "AMD processor and optimization documentation.",
        trust: "official",
      },
      {
        title: "Agner Fog optimization manuals",
        url: "https://www.agner.org/optimize/",
        note: "Independent optimization references for C++, assembly, vectorization and instruction behavior.",
        trust: "reference",
      },
    ],
  },
  {
    id: "python-runtime-memory",
    title: "Python runtime memory",
    kind: "runtime",
    tags: ["python", "memory", "tracemalloc", "rss", "pymalloc", "mimalloc", "allocator", "heap", "runtime"],
    summary:
      "Python object allocations, tracemalloc totals and process RSS answer different questions; compare Python memory only after defining which metric matters.",
    guidance: [
      "Use tracemalloc for Python-managed allocation traces, not as a complete process RSS measurement.",
      "Do not count the Python interpreter startup footprint as auxiliary algorithm space unless the benchmark contract defines process RSS as the metric.",
      "For memory-sensitive Python solutions, reduce object count: prefer lists/arrays of primitives, indices, tuples only where needed, and streaming where possible.",
      "When allocator choice is part of the experiment, report PYTHONMALLOC or runtime allocator settings beside the result.",
    ],
    sources: [
      {
        title: "Python tracemalloc",
        url: "https://docs.python.org/3/library/tracemalloc.html",
        note: "Official Python documentation for tracing Python memory blocks.",
        trust: "official",
      },
      {
        title: "Python command-line and environment",
        url: "https://docs.python.org/3/using/cmdline.html#envvar-PYTHONMALLOC",
        note: "Official documentation for PYTHONMALLOC and allocator-related runtime settings.",
        trust: "official",
      },
    ],
  },
  {
    id: "rag-storage-supabase",
    title: "RAG storage on Supabase/Postgres",
    kind: "resource",
    tags: ["rag", "retrieval", "supabase", "postgres", "pgvector", "embedding", "hybrid-search", "knowledge"],
    summary:
      "Store knowledge chunks in Postgres, combine keyword search with vector search, and keep source metadata with every retrieved chunk.",
    guidance: [
      "Start with Postgres full-text search for exact algorithm terms, errors, function names and library names.",
      "Add pgvector embeddings for semantic matches like 'connect components' matching 'union-find'.",
      "Use hybrid search so exact words and semantic meaning both contribute.",
      "Store title, URL, license/source note, tags, content hash and updated_at for every chunk.",
      "Keep retrieved chunks short and cite their source in the prompt so agents know what they are relying on.",
    ],
    sources: [
      {
        title: "Supabase AI & Vectors",
        url: "https://supabase.com/docs/guides/ai",
        note: "Supabase guide covering semantic, keyword and hybrid search.",
        trust: "official",
      },
      {
        title: "Supabase Hybrid Search",
        url: "https://supabase.com/docs/guides/ai/hybrid-search",
        note: "Official guide to combining keyword and semantic retrieval.",
        trust: "official",
      },
      {
        title: "pgvector",
        url: "https://github.com/pgvector/pgvector",
        note: "Postgres vector similarity extension.",
        trust: "official",
      },
      {
        title: "PostgreSQL text search controls",
        url: "https://www.postgresql.org/docs/current/textsearch-controls.html",
        note: "Official tsquery/tsvector ranking and search documentation.",
        trust: "official",
      },
    ],
  },
  {
    id: "next-react-tauri-performance",
    title: "App performance for Next.js, React and Tauri",
    kind: "resource",
    tags: ["nextjs", "react", "tauri", "bundle", "startup", "render", "performance", "ui"],
    summary:
      "Keep the desktop app fast by measuring bundle size, limiting re-renders, using Tauri's native strengths, and instrumenting slow phases.",
    guidance: [
      "Use Next bundle analysis to identify oversized dependencies before adding UI packages.",
      "Use React memoization only after profiling shows a render calculation or prop churn is costly.",
      "Keep large generated reports in scrollable containers and memoize expensive parsing/rendering.",
      "For Tauri, optimise release settings deliberately and avoid bundling unused media/runtime assets.",
      "Instrument OCR, model dispatch, DB load, execution and render-heavy panels as separate phases.",
    ],
    sources: [
      {
        title: "Next.js package bundling",
        url: "https://nextjs.org/docs/app/guides/package-bundling",
        note: "Official guide to package import and bundle optimization.",
        trust: "official",
      },
      {
        title: "Next.js bundle analyzer",
        url: "https://nextjs.org/docs/14/pages/building-your-application/optimizing/bundle-analyzer",
        note: "Official bundle analysis plugin guide.",
        trust: "official",
      },
      {
        title: "React useMemo",
        url: "https://react.dev/reference/react/useMemo",
        note: "Official React note: use as performance optimisation after correctness.",
        trust: "official",
      },
      {
        title: "Tauri app size",
        url: "https://v2.tauri.app/concept/size/",
        note: "Official release-size and optimisation settings.",
        trust: "official",
      },
    ],
  },
  {
    id: "competitive-programming-library",
    title: "Competitive programming algorithm references",
    kind: "resource",
    tags: ["competitive-programming", "algorithms", "data-structures", "complexity", "cp-algorithms", "usaco"],
    summary:
      "Use concise algorithm references to select the right family before coding: DSU, graph traversal, shortest paths, DP, prefix sums, segment trees and number theory.",
    guidance: [
      "Match constraints to algorithm family before writing code.",
      "If n is 10^5, reject quadratic approaches unless the input has a special bound.",
      "Prefer proven templates for DSU, graph traversal, binary search and prefix sums, then adapt them cleanly.",
      "Use problem-specific tests from constraints, not only the examples.",
    ],
    targetRuntimeMs: 17,
    sources: [
      {
        title: "CP-Algorithms",
        url: "https://cp-algorithms.com/index.html",
        note: "Competitive-programming algorithm and data-structure reference.",
        trust: "reference",
      },
      {
        title: "CP-Algorithms: Disjoint Set Union",
        url: "https://cp-algorithms.com/data_structures/disjoint_set_union.html",
        note: "DSU with path compression and union by size/rank.",
        trust: "reference",
      },
      {
        title: "USACO Guide: Disjoint Set Union",
        url: "https://usaco.guide/gold/dsu",
        note: "Connectivity queries with amortized inverse-Ackermann operations.",
        trust: "reference",
      },
    ],
  },
  {
    id: "trusted-algorithm-source-catalog",
    title: "Trusted algorithm source catalog",
    kind: "resource",
    tags: ["trusted", "sources", "algorithms", "data-structures", "mit", "stanford", "usaco", "kactl", "cp-algorithms"],
    summary:
      "Prefer official, academic and contest-tested references when retrieving optimisation advice for algorithmic code problems.",
    guidance: [
      "Use MIT OCW and Stanford CS166 for foundational algorithm/data-structure reasoning.",
      "Use CP-Algorithms, USACO Guide and KACTL for contest-tested implementation patterns.",
      "Use official language/runtime docs for measurement and low-level performance claims.",
      "Treat blogs and forums as hints only unless they are backed by source, tests, or official documentation.",
    ],
    sources: [
      {
        title: "MIT OCW 6.006 Introduction to Algorithms",
        url: "https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/",
        note: "Academic course covering algorithmic modelling, common algorithms, data structures and performance analysis.",
        trust: "academic",
      },
      {
        title: "MIT OCW 6.006 Lecture Notes",
        url: "https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/pages/lecture-notes/",
        note: "Official lecture notes for sorting, hashing, trees, graph algorithms and dynamic programming.",
        trust: "academic",
      },
      {
        title: "Stanford CS166 Advanced Data Structures",
        url: "https://web.stanford.edu/class/cs166/",
        note: "Academic course on advanced data structures, amortization and specialised structures.",
        trust: "academic",
      },
      {
        title: "Algorithms by Jeff Erickson",
        url: "https://jeffe.cs.illinois.edu/teaching/algorithms/",
        note: "Free academic algorithms textbook and lecture notes from UIUC.",
        trust: "academic",
      },
      {
        title: "KACTL",
        url: "https://github.com/kth-competitive-programming/kactl",
        note: "KTH ICPC team reference with copy-pasteable, contest-tested C++ implementations.",
        trust: "reference",
      },
      {
        title: "Princeton Competitive Programming Resources",
        url: "https://competitive-programming.cs.princeton.edu/resources",
        note: "Curated competitive programming references and fast-I/O guidance.",
        trust: "academic",
      },
    ],
  },
  {
    id: "constraint-to-complexity-playbook",
    title: "Constraint-to-complexity optimisation playbook",
    kind: "pattern",
    tags: ["constraints", "complexity", "optimization", "runtime", "memory", "leetcode", "interview"],
    summary:
      "Map input constraints to the fastest plausible algorithm family before writing code.",
    guidance: [
      "n <= 20 often invites bitmask DP, meet-in-the-middle, or backtracking with pruning.",
      "n <= 1e3 may allow O(n^2), but look for sorting, prefix sums, or graph structure before accepting it.",
      "n <= 1e5 usually requires O(n), O(n log n), DSU, heap, monotonic stack/queue, or logarithmic data structures.",
      "q <= 1e5 usually requires preprocessing, prefix/difference arrays, DSU, Fenwick/segment tree, sparse table, or offline sorting.",
      "Large coordinate ranges with sparse data usually call for hashing or coordinate compression.",
      "Memory target <= 10MB favours primitive arrays, in-place mutation, compressed state, and avoiding full adjacency matrices.",
    ],
    targetRuntimeMs: 0,
    targetMemoryMb: 10,
    sources: [
      {
        title: "MIT OCW 6.006 Introduction to Algorithms",
        url: "https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/",
        note: "Foundational performance analysis and algorithm-design course.",
        trust: "academic",
      },
      {
        title: "CP-Algorithms Navigation",
        url: "https://cp-algorithms.com/navigation.html",
        note: "Broad index of competitive-programming algorithm families and optimizations.",
        trust: "reference",
      },
    ],
  },
  {
    id: "hashing-and-counting-optimization",
    title: "Hashing and counting optimisation",
    kind: "pattern",
    tags: ["hash-map", "hash-set", "counting", "frequency", "deduplicate", "lookup", "optimization"],
    summary:
      "Replace repeated scans with O(1)-average lookups or fixed-size counting arrays when the key space allows it.",
    guidance: [
      "Use a hash map/set for membership, complements, first/last positions, and frequency counts.",
      "Use fixed arrays instead of maps for small bounded alphabets or integer ranges.",
      "For memory-sensitive answers, store counts or indices rather than full grouped lists when only aggregate data is needed.",
      "Watch collision/pathological-key risks in adversarial settings; sorting can be safer when deterministic bounds matter.",
    ],
    complexity: "Usually O(n) expected time; O(k) memory for distinct keys",
    targetRuntimeMs: 0,
    targetMemoryMb: 10,
    sources: [
      {
        title: "MIT OCW 6.006 Lecture Notes",
        url: "https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/pages/lecture-notes/",
        note: "Includes hashing and data structure notes.",
        trust: "academic",
      },
    ],
  },
  {
    id: "sorting-sweep-greedy-optimization",
    title: "Sorting, sweep line and greedy optimisation",
    kind: "pattern",
    tags: ["sorting", "sweep-line", "greedy", "interval", "events", "optimization"],
    summary:
      "Sort once to expose order, then sweep with local state when direct quadratic comparison is too slow.",
    guidance: [
      "Sort intervals/events by start, end, or delta point to turn pairwise overlap checks into a sweep.",
      "Use greedy only after identifying the exchange argument: why the locally best choice cannot hurt the global optimum.",
      "For memory <=10MB, represent events compactly as numeric tuples and sort in place where the language allows.",
      "Prefer O(n log n) sorting plus O(n) scan over O(n^2) pair checks for n near 1e5.",
    ],
    complexity: "Usually O(n log n) time, O(1)-O(n) extra space depending on sort/events",
    sources: [
      {
        title: "CP-Algorithms",
        url: "https://cp-algorithms.com/index.html",
        note: "Reference for sorting-adjacent techniques, greedy and sweep patterns.",
        trust: "reference",
      },
      {
        title: "Algorithms by Jeff Erickson",
        url: "https://jeffe.cs.illinois.edu/teaching/algorithms/",
        note: "Academic greedy and graph algorithm notes.",
        trust: "academic",
      },
    ],
  },
  {
    id: "monotonic-structures-optimization",
    title: "Monotonic stack and queue optimisation",
    kind: "pattern",
    tags: ["monotonic-stack", "monotonic-queue", "stack", "queue", "next-greater", "sliding-window-maximum"],
    summary:
      "Use monotonic stacks/queues to remove dominated elements and turn nested nearest-neighbour/window scans into linear time.",
    guidance: [
      "Use a monotonic stack for next/previous greater/smaller, histogram rectangles, and span problems.",
      "Use a monotonic deque for sliding window maximum/minimum.",
      "Each element should be pushed and popped at most once; that is the proof of O(n).",
      "Store indices instead of values when window expiry or distance matters.",
    ],
    complexity: "O(n) time, O(n) worst-case auxiliary space",
    targetRuntimeMs: 0,
    targetMemoryMb: 10,
    sources: [
      {
        title: "CP-Algorithms Navigation",
        url: "https://cp-algorithms.com/navigation.html",
        note: "Index for data-structure and sequence optimization topics.",
        trust: "reference",
      },
    ],
  },
  {
    id: "tree-range-query-optimization",
    title: "Fenwick, segment tree and sparse table optimisation",
    kind: "pattern",
    tags: ["fenwick", "binary-indexed-tree", "segment-tree", "sparse-table", "range-query", "range-update", "optimization"],
    summary:
      "Use the lightest range-query data structure that supports the update/query mix the problem needs.",
    guidance: [
      "Use prefix sums for immutable sums; do not reach for a tree when O(1) query after O(n) build is enough.",
      "Use Fenwick tree for point updates with prefix/range sums when operations are invertible.",
      "Use segment tree for range min/max/sum with updates or custom associative merges.",
      "Use sparse table for static idempotent range queries such as min/gcd in O(1) query after O(n log n) build.",
      "For <=10MB, prefer Fenwick over segment tree when it fits: one array beats four.",
    ],
    complexity: "O(log n) per Fenwick/segment-tree operation; sparse table O(1) query after O(n log n) build",
    targetMemoryMb: 10,
    sources: [
      {
        title: "CP-Algorithms Navigation",
        url: "https://cp-algorithms.com/navigation.html",
        note: "Reference index for Fenwick tree, segment tree, sparse table and sqrt decomposition.",
        trust: "reference",
      },
      {
        title: "Stanford CS166 Advanced Data Structures",
        url: "https://web.stanford.edu/class/cs166/",
        note: "Academic background for advanced data-structure tradeoffs.",
        trust: "academic",
      },
    ],
  },
  {
    id: "graph-shortest-path-optimization",
    title: "Graph connectivity and shortest-path optimisation",
    kind: "pattern",
    tags: ["graph", "bfs", "dfs", "dijkstra", "topological", "shortest-path", "mst", "scc", "dsu"],
    summary:
      "Pick the graph algorithm from edge weights and query shape: BFS for unweighted, Dijkstra for non-negative weights, DSU for connectivity, topological DP for DAGs.",
    guidance: [
      "Use BFS for unweighted shortest paths and reachability by layers.",
      "Use Dijkstra with a heap for non-negative weighted graphs; avoid it for negative weights.",
      "Use DSU for offline/static connectivity and Kruskal-style merging.",
      "Use topological order for DAG reachability/DP when edges are directed and acyclic.",
      "Avoid adjacency matrices unless n is small or dense-matrix operations are explicitly intended.",
    ],
    complexity: "BFS/DFS O(V+E); Dijkstra with heap O((V+E) log V); DSU near O(alpha(n)) per op",
    targetMemoryMb: 10,
    sources: [
      {
        title: "CP-Algorithms graph algorithms",
        url: "https://cp-algorithms.com/index.html",
        note: "Reference for graph traversal, shortest paths, MST and connectivity algorithms.",
        trust: "reference",
      },
      {
        title: "MIT OCW 6.006 Lecture Notes",
        url: "https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/pages/lecture-notes/",
        note: "Academic notes covering graph algorithms.",
        trust: "academic",
      },
    ],
  },
  {
    id: "dynamic-programming-optimization",
    title: "Dynamic programming optimisation",
    kind: "pattern",
    tags: ["dynamic-programming", "dp", "memoization", "tabulation", "knuth", "divide-and-conquer-dp", "bitmask", "optimization"],
    summary:
      "Use DP to remove repeated subproblems, then compress state or apply known optimizations when naive DP is too large.",
    guidance: [
      "Define the state, transition, base cases and answer extraction before coding.",
      "Memoize top-down recursion only when recursion depth and cache shape are safe; tabulate when order is simple.",
      "Compress dimensions when each row depends only on the previous row or small window of rows.",
      "Consider bitmask DP for n around 20, tree DP for hierarchical constraints, and digit DP for numeric bounds.",
      "Only use Knuth/divide-and-conquer DP optimizations when their monotonicity/quadrangle conditions hold.",
    ],
    complexity: "State count times transition cost; optimized forms vary by recurrence",
    targetMemoryMb: 10,
    sources: [
      {
        title: "USACO Guide: Introduction to DP",
        url: "https://usaco.guide/gold/intro-dp",
        note: "Competitive-programming DP introduction and practice path.",
        trust: "reference",
      },
      {
        title: "CP-Algorithms: Introduction to Dynamic Programming",
        url: "https://cp-algorithms.com/dynamic_programming/intro-to-dp.html",
        note: "Reference introduction to memoization and bottom-up DP.",
        trust: "reference",
      },
      {
        title: "MIT OCW 6.006 Lecture Notes",
        url: "https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/pages/lecture-notes/",
        note: "Academic DP lecture notes.",
        trust: "academic",
      },
    ],
  },
  {
    id: "string-algorithm-optimization",
    title: "String algorithm optimisation",
    kind: "pattern",
    tags: ["string", "kmp", "z-function", "rolling-hash", "trie", "suffix-array", "aho-corasick"],
    summary:
      "Avoid repeated substring scans/copies by using linear-time string matching, hashing, tries or suffix structures.",
    guidance: [
      "Use KMP or Z-function for exact pattern matching in O(n+m).",
      "Use rolling hash for many substring comparisons, with collision awareness.",
      "Use tries for prefix dictionaries and Aho-Corasick for many-pattern matching.",
      "Avoid creating substrings in inner loops when indices or hashes are enough.",
      "For memory <=10MB, prefer arrays over object-heavy nodes when alphabet is small and bounds are known.",
    ],
    complexity: "Often O(total string length) time with O(pattern/state) memory",
    targetMemoryMb: 10,
    sources: [
      {
        title: "CP-Algorithms string processing",
        url: "https://cp-algorithms.com/index.html",
        note: "Reference for prefix function, Z-function, hashing and suffix structures.",
        trust: "reference",
      },
      {
        title: "KACTL",
        url: "https://github.com/kth-competitive-programming/kactl",
        note: "Contest-tested C++ string algorithm templates.",
        trust: "reference",
      },
    ],
  },
  {
    id: "math-number-theory-optimization",
    title: "Math and number-theory optimisation",
    kind: "pattern",
    tags: ["math", "number-theory", "gcd", "sieve", "modular-arithmetic", "combinatorics", "prime", "divisor"],
    summary:
      "Use mathematical structure to avoid enumerating impossible states: gcd, divisors, sieves, modular arithmetic and combinatorics often collapse brute force.",
    guidance: [
      "Use Euclid's algorithm for gcd and reduce ratio/state by gcd when equivalence is divisibility based.",
      "Use sieves or divisor enumeration by multiples when many numbers share factor constraints.",
      "Precompute factorials/inverses for repeated combinatorics under a prime modulus.",
      "Use fast exponentiation for powers and modular powers.",
      "Avoid floating point when integer arithmetic or modular arithmetic gives exact answers.",
    ],
    complexity: "Varies; gcd O(log n), sieve-like multiple loops often O(n log log n) or O(n log n)",
    targetMemoryMb: 10,
    sources: [
      {
        title: "CP-Algorithms algebra and number theory",
        url: "https://cp-algorithms.com/index.html",
        note: "Reference for gcd, primes, modular arithmetic and combinatorics.",
        trust: "reference",
      },
      {
        title: "KACTL",
        url: "https://github.com/kth-competitive-programming/kactl",
        note: "Contest-tested number-theory implementations.",
        trust: "reference",
      },
    ],
  },
];

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "you",
  "your",
  "must",
  "given",
  "return",
  "where",
  "there",
  "some",
  "into",
  "than",
  "then",
  "have",
  "been",
  "what",
  "when",
]);

function tokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/leetcode\s*#?\s*(\d+)/g, "leetcode-$1")
        .split(/[^a-z0-9+#._-]+/)
        .map((x) => x.trim())
        .filter((x) => x.length > 2 && !STOP.has(x))
    )
  );
}

function scoreRecord(record: KnowledgeRecord, query: string[]): number {
  if (!query.length) return record.id === "runtime-discipline" ? 1 : 0;
  const hay = tokens([record.title, record.summary, record.tags.join(" "), record.guidance.join(" ")].join(" "));
  const set = new Set(hay);
  let score = 0;
  for (const q of query) {
    if (record.tags.includes(q)) score += 4;
    else if (set.has(q)) score += 2;
    else if (hay.some((h) => h.includes(q) || q.includes(h))) score += 0.8;
  }
  if (record.kind === "runtime") score += 1.25;
  return score;
}

export function retrieveKnowledge(queryText: string, limit = 5): KnowledgeHit[] {
  const query = tokens(queryText);
  return RECORDS.map((record) => ({ record, score: scoreRecord(record, query) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.record.title.localeCompare(b.record.title))
    .slice(0, limit);
}

export function renderKnowledgePack(hits: KnowledgeHit[]): string {
  if (!hits.length) return "";
  const out = [
    "Use this local Knowledge/RAG pack as guidance. It is not a substitute for checking the problem constraints or measured execution.",
  ];
  for (const { record } of hits) {
    out.push(`\n## ${record.title}`);
    out.push(record.summary);
    if (record.complexity) out.push(`Complexity: ${record.complexity}`);
    if (record.targetRuntimeMs != null) {
      out.push(
        record.targetRuntimeMs === 0
          ? "Runtime target: pursue a judge-rounded 0ms result only through optimal complexity and measurement; never fabricate 0ms."
          : `Runtime target: aim for <= ${record.targetRuntimeMs}ms when the judge/runtime makes that realistic; otherwise report why not.`
      );
    }
    if (record.targetMemoryMb != null) {
      out.push(`Memory target: aim for <= ${record.targetMemoryMb}MB auxiliary/peak memory when realistic; otherwise report why not.`);
    }
    out.push("Guidance:");
    for (const g of record.guidance) out.push(`- ${g}`);
    if (record.sources?.length) {
      out.push("Resources:");
      for (const s of record.sources) out.push(`- ${s.title}: ${s.url}${s.trust ? ` [${s.trust}]` : ""} (${s.note})`);
    }
  }
  return out.join("\n");
}

export function knowledgePackFor(queryText: string, limit = 5): string {
  return renderKnowledgePack(retrieveKnowledge(queryText, limit));
}

export function allKnowledgeRecords(): KnowledgeRecord[] {
  return RECORDS.map((r) => ({ ...r, tags: [...r.tags], guidance: [...r.guidance], sources: r.sources?.map((s) => ({ ...s })) }));
}
