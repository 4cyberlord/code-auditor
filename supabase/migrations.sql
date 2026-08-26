-- Additive migrations.
--
-- schema.sql only runs when a table is missing, which is right for creating the
-- world but wrong for changing it: a database created two phases ago has all
-- five tables and would never see a new column. Everything here is written to be
-- safe to run on every single connect -- `if not exists` throughout, no data
-- movement, no drops -- so the app can keep growing its own schema without ever
-- asking anyone to paste SQL into a console.
--
-- Rules for anything added below:
--   * idempotent, always;
--   * additive only -- a column this build stops using is left alone, because an
--     older build may still be reading it;
--   * cheap, because this runs on every launch.

-- Phase 3 (section 9): the vision pass. How a run was conducted is part of the
-- result -- an answer reasoned from a transcription is a different kind of
-- evidence than one reasoned from the picture, and comparing the two later is
-- only possible if we wrote down which it was.
alter table if exists runs
  add column if not exists context_mode text not null default 'images';

alter table if exists runs
  add column if not exists extracted_context text not null default '';

-- Null when no vision pass ran; false when the two readers disagreed on
-- something that mattered, which is the case worth going back and looking at.
alter table if exists runs
  add column if not exists extraction_agreed boolean;

-- Phase 4: app settings. Model choices, council rosters, thresholds and UI
-- toggles need to travel with the session history. Secrets still live in the
-- OS Keychain; this table is only for non-secret configuration.
create table if not exists settings (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists settings_touch on settings;
create trigger settings_touch before update on settings
  for each row execute function touch_updated_at();

-- Phase 5: embedded intelligence/RAG library. The TypeScript knowledge pack is
-- the instant local fallback; these tables give the same trusted source spine a
-- database home for future semantic/hybrid retrieval.
create table if not exists intelligence_sources (
  id          text primary key,
  title       text        not null,
  url         text        not null unique,
  trust       text        not null
                check (trust in ('official', 'academic', 'reference', 'community')),
  note        text        not null default '',
  tags        text[]      not null default '{}',
  updated_at  timestamptz not null default now()
);

create table if not exists intelligence_records (
  id               text primary key,
  title            text        not null,
  kind             text        not null
                     check (kind in ('pattern', 'problem', 'runtime', 'resource')),
  summary          text        not null,
  guidance         jsonb       not null default '[]'::jsonb,
  tags             text[]      not null default '{}',
  complexity        text,
  target_runtime_ms integer,
  target_memory_mb  integer,
  source_urls       text[]      not null default '{}',
  content_hash      text,
  updated_at        timestamptz not null default now()
);

create index if not exists intelligence_records_tags_idx
  on intelligence_records using gin (tags);

create index if not exists intelligence_sources_tags_idx
  on intelligence_sources using gin (tags);

drop trigger if exists intelligence_sources_touch on intelligence_sources;
create trigger intelligence_sources_touch before update on intelligence_sources
  for each row execute function touch_updated_at();

drop trigger if exists intelligence_records_touch on intelligence_records;
create trigger intelligence_records_touch before update on intelligence_records
  for each row execute function touch_updated_at();

-- Phase 11: background capture-to-council jobs. The desktop app can be closed
-- while an approved helper uploads captures and a cloud worker claims queued
-- work. The queue records progress and evidence; secrets stay in Keychain or
-- server-side worker environment variables, never in these rows.
create table if not exists solve_jobs (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid        not null references sessions (id) on delete cascade,
  mode              text        not null default 'council'
                      check (mode in ('council')),
  status            text        not null default 'queued'
                      check (status in ('queued', 'running', 'needs_attention',
                                        'failed', 'completed', 'cancelled')),
  progress_phase    text        not null default 'queued',
  settings_snapshot jsonb       not null default '{}'::jsonb,
  error             text,
  result_summary    text        not null default '',
  created_at        timestamptz not null default now(),
  claimed_at        timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists solve_jobs_status_created_idx
  on solve_jobs (status, created_at);

create index if not exists solve_jobs_session_idx
  on solve_jobs (session_id, created_at desc);

create table if not exists solve_job_images (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid        not null references solve_jobs (id) on delete cascade,
  session_id     uuid        not null references sessions (id) on delete cascade,
  position       integer     not null,
  storage_bucket text        not null,
  storage_path   text        not null,
  file_name      text        not null,
  bytes          integer     not null default 0,
  mime           text        not null default 'image/png',
  width          integer,
  height         integer,
  captured_at    timestamptz not null default now(),
  unique (job_id, position)
);

create index if not exists solve_job_images_job_idx
  on solve_job_images (job_id, position);

create table if not exists solve_job_events (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid        not null references solve_jobs (id) on delete cascade,
  level      text        not null default 'info'
               check (level in ('info', 'warn', 'error')),
  phase      text        not null default 'queued',
  message    text        not null,
  payload    jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists solve_job_events_job_idx
  on solve_job_events (job_id, created_at);

create table if not exists council_reports (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid        not null unique references solve_jobs (id) on delete cascade,
  session_id uuid        not null references sessions (id) on delete cascade,
  winner     text,
  synthesis  text        not null default '',
  markdown   text        not null default '',
  report     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists council_reports_session_idx
  on council_reports (session_id, created_at desc);

create table if not exists notification_devices (
  id           uuid primary key default gen_random_uuid(),
  platform     text        not null check (platform in ('ios')),
  device_token text        not null unique,
  label        text        not null default '',
  enabled      boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists solve_jobs_touch on solve_jobs;
create trigger solve_jobs_touch before update on solve_jobs
  for each row execute function touch_updated_at();

drop trigger if exists notification_devices_touch on notification_devices;
create trigger notification_devices_touch before update on notification_devices
  for each row execute function touch_updated_at();

insert into intelligence_sources (id, title, url, trust, note, tags)
values
  ('node-perf-hooks', 'Node.js perf_hooks', 'https://nodejs.org/api/perf_hooks.html', 'official', 'Official Node.js performance measurement API.', array['node', 'javascript', 'benchmark', 'runtime']),
  ('python-profile', 'Python profilers', 'https://docs.python.org/3/library/profile.html', 'official', 'Official Python cProfile/profile documentation.', array['python', 'profile', 'runtime']),
  ('python-timeit', 'Python timeit', 'https://docs.python.org/3/library/timeit.html', 'official', 'Official Python micro-benchmarking utility.', array['python', 'benchmark', 'runtime']),
  ('google-benchmark', 'Google Benchmark', 'https://github.com/google/benchmark', 'official', 'Official C++ microbenchmark library repository.', array['cpp', 'benchmark', 'runtime']),
  ('google-benchmark-guide', 'Google Benchmark user guide', 'https://google.github.io/benchmark/user_guide.html', 'official', 'Official usage guide for Google Benchmark.', array['cpp', 'benchmark', 'runtime']),
  ('mit-6006', 'MIT OCW 6.006 Introduction to Algorithms', 'https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/', 'academic', 'Academic course on algorithmic modelling, common algorithms, data structures and performance analysis.', array['algorithms', 'data-structures', 'complexity']),
  ('mit-6006-notes', 'MIT OCW 6.006 Lecture Notes', 'https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/pages/lecture-notes/', 'academic', 'Official lecture notes for core algorithms and data structures.', array['algorithms', 'notes', 'complexity']),
  ('stanford-cs166', 'Stanford CS166 Advanced Data Structures', 'https://web.stanford.edu/class/cs166/', 'academic', 'Academic course on advanced data structures and amortized analysis.', array['data-structures', 'advanced', 'optimization']),
  ('jeff-erickson-algorithms', 'Algorithms by Jeff Erickson', 'https://jeffe.cs.illinois.edu/teaching/algorithms/', 'academic', 'Free academic algorithms textbook and lecture notes.', array['algorithms', 'graphs', 'dp', 'greedy']),
  ('cp-algorithms', 'CP-Algorithms', 'https://cp-algorithms.com/index.html', 'reference', 'Competitive-programming algorithm and data-structure reference.', array['competitive-programming', 'algorithms']),
  ('cp-algorithms-nav', 'CP-Algorithms Navigation', 'https://cp-algorithms.com/navigation.html', 'reference', 'Broad index of competitive-programming algorithm families and optimizations.', array['competitive-programming', 'algorithms', 'index']),
  ('usaco-dsu', 'USACO Guide: Disjoint Set Union', 'https://usaco.guide/gold/dsu', 'reference', 'Connectivity and DSU reference with amortized inverse-Ackermann operations.', array['dsu', 'union-find', 'graph']),
  ('usaco-dp', 'USACO Guide: Introduction to DP', 'https://usaco.guide/gold/intro-dp', 'reference', 'Competitive-programming dynamic programming introduction.', array['dp', 'dynamic-programming']),
  ('kactl', 'KACTL', 'https://github.com/kth-competitive-programming/kactl', 'reference', 'KTH ICPC team reference with contest-tested C++ templates.', array['cpp', 'templates', 'competitive-programming']),
  ('supabase-ai', 'Supabase AI & Vectors', 'https://supabase.com/docs/guides/ai', 'official', 'Supabase guide covering semantic, keyword and hybrid search.', array['supabase', 'rag', 'vectors']),
  ('supabase-hybrid-search', 'Supabase Hybrid Search', 'https://supabase.com/docs/guides/ai/hybrid-search', 'official', 'Official guide to combining keyword and semantic retrieval.', array['supabase', 'rag', 'hybrid-search']),
  ('pgvector', 'pgvector', 'https://github.com/pgvector/pgvector', 'official', 'Postgres vector similarity extension.', array['postgres', 'vectors', 'rag']),
  ('postgres-fts', 'PostgreSQL text search controls', 'https://www.postgresql.org/docs/current/textsearch-controls.html', 'official', 'Official PostgreSQL full-text search controls.', array['postgres', 'fts', 'search']),
  ('linux-getrusage', 'Linux getrusage(2)', 'https://man7.org/linux/man-pages/man2/getrusage.2.html', 'official', 'Defines ru_maxrss and process resource-usage fields.', array['linux', 'memory', 'rss']),
  ('linux-proc-memory', 'Linux /proc filesystem documentation', 'https://www.kernel.org/doc/html/latest/filesystems/proc.html', 'official', 'Documents VmRSS, VmHWM and resident-set breakdown fields.', array['linux', 'memory', 'rss', 'proc']),
  ('criterion-analysis', 'Criterion.rs analysis model', 'https://bheisler.github.io/criterion.rs/book/analysis.html', 'reference', 'Rust benchmarking analysis model covering warmup, measurement and comparison.', array['rust', 'benchmark', 'statistics']),
  ('pyperf-run', 'pyperf benchmark execution', 'https://pyperf.readthedocs.io/en/latest/run_benchmark.html', 'official', 'Python benchmark execution with worker processes and repeated measurements.', array['python', 'benchmark', 'noise']),
  ('pyperf-system', 'pyperf system tuning', 'https://pyperf.readthedocs.io/en/stable/system.html', 'official', 'System tuning guidance for more stable benchmark measurements.', array['benchmark', 'noise', 'cpu-affinity']),
  ('linux-perf', 'Linux perf wiki', 'https://perfwiki.github.io/main/', 'reference', 'Reference for Linux perf events and hardware-counter profiling.', array['profiling', 'perf', 'hardware-counters']),
  ('compiler-explorer', 'Compiler Explorer', 'https://godbolt.org/', 'reference', 'Interactive generated assembly, IR and compiler-output explorer.', array['assembly', 'compiler', 'codegen']),
  ('llvm-mca', 'LLVM llvm-mca', 'https://llvm.org/docs/CommandGuide/llvm-mca.html', 'official', 'LLVM machine-code analyzer for throughput, IPC and processor-resource pressure.', array['llvm', 'assembly', 'throughput']),
  ('rust-perf-build-config', 'Rust Performance Book: build configuration', 'https://nnethercote.github.io/perf-book/build-configuration.html', 'reference', 'Rust guidance for LTO, codegen units, target CPU, allocators and PGO.', array['rust', 'compiler', 'optimization']),
  ('clang-users-manual', 'Clang Users Manual', 'https://clang.llvm.org/docs/UsersManual.html', 'official', 'Official Clang documentation including optimization and PGO.', array['clang', 'compiler', 'pgo']),
  ('gcc-optimize-options', 'GCC optimization options', 'https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html', 'official', 'Official GCC optimization-flag reference.', array['gcc', 'compiler', 'optimization']),
  ('gcc-instrumentation-options', 'GCC instrumentation options', 'https://gcc.gnu.org/onlinedocs/gcc/Instrumentation-Options.html', 'official', 'Official GCC profiling and instrumentation options.', array['gcc', 'compiler', 'pgo']),
  ('intel-optimization', 'Intel 64 and IA-32 optimization resources', 'https://www.intel.com/content/www/us/en/developer/articles/technical/intel64-and-ia32-architectures-optimization.html', 'official', 'Intel optimization references for cache, SIMD, branch prediction and memory access.', array['intel', 'cache', 'simd', 'microarchitecture']),
  ('amd-docs', 'AMD Developer Documentation', 'https://docs.amd.com/', 'official', 'AMD processor and optimization documentation.', array['amd', 'microarchitecture', 'optimization']),
  ('agner-fog-optimize', 'Agner Fog optimization manuals', 'https://www.agner.org/optimize/', 'reference', 'Independent references for C++, assembly, vectorization and instruction behavior.', array['assembly', 'optimization', 'microarchitecture']),
  ('hypothesis', 'Hypothesis', 'https://hypothesis.readthedocs.io/', 'official', 'Python property-based testing library.', array['python', 'property-testing', 'correctness']),
  ('rust-proptest', 'Rust proptest', 'https://docs.rs/proptest/latest/proptest/', 'official', 'Rust property-testing crate.', array['rust', 'property-testing', 'correctness']),
  ('rapidcheck', 'RapidCheck', 'https://github.com/emil-e/rapidcheck', 'community', 'C++ property-based testing library.', array['cpp', 'property-testing', 'correctness']),
  ('python-tracemalloc', 'Python tracemalloc', 'https://docs.python.org/3/library/tracemalloc.html', 'official', 'Official Python documentation for tracing Python memory blocks.', array['python', 'memory', 'allocator']),
  ('python-malloc', 'Python PYTHONMALLOC', 'https://docs.python.org/3/using/cmdline.html#envvar-PYTHONMALLOC', 'official', 'Official allocator-related Python runtime settings.', array['python', 'memory', 'allocator'])
on conflict (id) do update set
  title = excluded.title,
  url = excluded.url,
  trust = excluded.trust,
  note = excluded.note,
  tags = excluded.tags;

insert into intelligence_records (
  id, title, kind, summary, guidance, tags, complexity,
  target_runtime_ms, target_memory_mb, source_urls
)
values
  (
    'memory-metric-taxonomy',
    'Memory metric taxonomy',
    'runtime',
    'Separate algorithm auxiliary memory from process memory: input storage, stack, heap payload, allocator overhead, RSS, peak RSS, virtual memory and judge-reported memory are different claims.',
    '["Label memory results as auxiliary algorithm memory, peak heap, peak RSS or judge memory.", "Do not compare tiny algorithm state with multi-megabyte process RSS as if they are the same metric.", "Use ru_maxrss, VmHWM, VmRSS and RSS breakdown fields deliberately on Linux.", "For interpreted runtimes, separate runtime startup footprint from algorithm allocations."]'::jsonb,
    array['memory', 'rss', 'peak-rss', 'ru_maxrss', 'vmrss', 'vmhwm', 'auxiliary-space'],
    null,
    null,
    null,
    array['https://man7.org/linux/man-pages/man2/getrusage.2.html', 'https://www.kernel.org/doc/html/latest/filesystems/proc.html']
  ),
  (
    'cross-language-benchmark-contract',
    'Cross-language benchmark contract',
    'runtime',
    'Only compare C++, Rust, Python or JavaScript candidates when they execute the same workload under a written measurement contract.',
    '["Use identical input bytes or a shared checked fixture.", "Keep workload shape, repetitions, warmups, machine, compiler/runtime versions and optimization flags constant.", "Separate setup from the timed body unless setup is part of the task.", "Reject comparisons built from different random generators or undisclosed machine-specific tuning."]'::jsonb,
    array['benchmark', 'cross-language', 'cpp', 'rust', 'python', 'fairness', 'deterministic', 'workload'],
    null,
    null,
    null,
    array['https://google.github.io/benchmark/user_guide.html', 'https://bheisler.github.io/criterion.rs/book/analysis.html', 'https://pyperf.readthedocs.io/en/latest/run_benchmark.html']
  ),
  (
    'optimization-correctness-gate',
    'Optimization correctness gate',
    'runtime',
    'An optimized candidate may enter runtime ranking only after it matches a simple reference implementation and passes edge, random and maximum-constraint tests.',
    '["Keep a slow obvious reference for small cases.", "Use property-based or differential tests to compare optimized code against the reference.", "Run edge-case suites before benchmark suites.", "A fast candidate that changes semantics or relies on undefined behavior loses before timing is considered."]'::jsonb,
    array['correctness', 'optimization', 'benchmark', 'property-testing', 'differential-testing', 'bruteforce'],
    null,
    null,
    null,
    array['https://hypothesis.readthedocs.io/', 'https://docs.rs/proptest/latest/proptest/', 'https://github.com/emil-e/rapidcheck']
  ),
  (
    'benchmark-noise-control',
    'Benchmark noise control',
    'runtime',
    'Treat short runtimes as noisy measurements; use warmups, repeated processes, CPU/system tuning and statistical summaries before claiming a speedup.',
    '["Prefer median and distribution summaries over best-of-one timings.", "Minimize background load, power-state changes and unrelated I/O.", "Keep cold-cache and warm-cache assumptions explicit.", "Call speedups within noise inconclusive and gather more evidence."]'::jsonb,
    array['benchmark', 'noise', 'warmup', 'cpu-affinity', 'statistics', 'median', 'variance'],
    null,
    null,
    null,
    array['https://pyperf.readthedocs.io/en/stable/system.html', 'https://pyperf.readthedocs.io/en/latest/run_benchmark.html']
  ),
  (
    'hardware-counter-profiling',
    'Hardware counter profiling',
    'runtime',
    'Use hardware counters to explain performance with cycles, instructions, IPC, cache misses, branches, page faults and context switches instead of guessing from source code.',
    '["Inspect counters after benchmarks show a real difference.", "Use cycles and instructions to compute IPC and distinguish likely bottlenecks.", "Compare counters on the same input and same build mode.", "Treat hardware-counter results as machine-specific evidence."]'::jsonb,
    array['profiling', 'perf', 'hardware-counters', 'cycles', 'instructions', 'ipc', 'cache-misses'],
    null,
    null,
    null,
    array['https://perfwiki.github.io/main/', 'https://google.github.io/benchmark/user_guide.html']
  ),
  (
    'assembly-codegen-inspection',
    'Assembly and codegen inspection',
    'resource',
    'Inspect generated assembly, LLVM IR or Rust MIR when source-level reasoning cannot explain a tight-loop performance result.',
    '["Check inlining, removed bounds checks, vectorization and redundant loads/stores.", "Compare release builds with the exact benchmark flags.", "Use codegen inspection to form hypotheses, then verify with benchmarks or counters."]'::jsonb,
    array['assembly', 'codegen', 'compiler', 'llvm-ir', 'mir', 'godbolt', 'vectorization'],
    null,
    null,
    null,
    array['https://godbolt.org/']
  ),
  (
    'compiler-build-optimization',
    'Compiler and build optimization',
    'runtime',
    'Choose build flags deliberately: optimization level, LTO, codegen units, target CPU, panic/runtime settings, allocator choice and PGO can change both speed and memory.',
    '["Report compiler version and flags with benchmark results.", "Use judge-safe portable flags for online submissions and reserve CPU-specific flags for local/product binaries.", "Evaluate Rust opt-level, LTO, codegen-units=1, panic=abort, allocator choice and target-cpu with measurement.", "Use PGO only with representative workloads."]'::jsonb,
    array['compiler', 'build', 'optimization', 'lto', 'pgo', 'target-cpu', 'clang', 'gcc', 'rust'],
    null,
    null,
    null,
    array['https://nnethercote.github.io/perf-book/build-configuration.html', 'https://clang.llvm.org/docs/UsersManual.html', 'https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html', 'https://gcc.gnu.org/onlinedocs/gcc/Instrumentation-Options.html']
  ),
  (
    'cache-data-layout-optimization',
    'Cache and data-layout optimization',
    'runtime',
    'At low runtimes, contiguous data layout, cache locality, branch predictability, smaller payloads and allocation count often matter more than surface syntax.',
    '["Prefer contiguous arrays and compact numeric state over pointer-heavy object graphs in hot loops.", "Choose array-of-structs or struct-of-arrays based on fields touched together.", "Reserve or preallocate when growth is predictable.", "Treat SIMD, prefetching and branch layout as measured optimizations after the algorithm is right."]'::jsonb,
    array['cache', 'locality', 'data-layout', 'aos', 'soa', 'simd', 'branch-prediction', 'microarchitecture'],
    null,
    null,
    null,
    array['https://www.intel.com/content/www/us/en/developer/articles/technical/intel64-and-ia32-architectures-optimization.html', 'https://docs.amd.com/', 'https://www.agner.org/optimize/']
  ),
  (
    'python-runtime-memory',
    'Python runtime memory',
    'runtime',
    'Python object allocations, tracemalloc totals and process RSS answer different questions; compare Python memory only after defining which metric matters.',
    '["Use tracemalloc for Python-managed allocation traces, not complete process RSS.", "Do not count interpreter startup footprint as auxiliary algorithm space unless the benchmark contract defines process RSS as the metric.", "Reduce object count for memory-sensitive Python solutions.", "Report PYTHONMALLOC or allocator settings when they are part of the experiment."]'::jsonb,
    array['python', 'memory', 'tracemalloc', 'rss', 'pymalloc', 'mimalloc', 'allocator'],
    null,
    null,
    null,
    array['https://docs.python.org/3/library/tracemalloc.html', 'https://docs.python.org/3/using/cmdline.html#envvar-PYTHONMALLOC']
  ),
  (
    'zero-ms-memory-contract',
    'Zero-ms / low-memory answer contract',
    'runtime',
    'Exact Runtime: 0ms and Memory <=10MB are measured outcomes, not promises. Optimise toward them and report evidence honestly.',
    '["Choose the lowest asymptotic complexity first.", "Prefer O(1) extra memory when possible.", "Never claim exact milliseconds or memory unless measured.", "If impossible for the constraints or runtime, explain why and ship the fastest correct solution."]'::jsonb,
    array['runtime', '0ms', 'memory', '10mb', 'performance'],
    null,
    0,
    10,
    array['https://rosettacode.org/wiki/Runtime_evaluation', 'https://google.github.io/benchmark/user_guide.html']
  ),
  (
    'constraint-to-complexity-playbook',
    'Constraint-to-complexity optimisation playbook',
    'pattern',
    'Map input constraints to the fastest plausible algorithm family before writing code.',
    '["n <= 20 often invites bitmask DP or meet-in-the-middle.", "n <= 1e5 usually requires O(n), O(n log n), DSU, heap, monotonic structures or logarithmic data structures.", "Large sparse coordinate ranges usually call for hashing or coordinate compression.", "Memory <=10MB favours primitive arrays, in-place mutation and compressed state."]'::jsonb,
    array['constraints', 'complexity', 'optimization', 'leetcode'],
    'Depends on constraint family',
    0,
    10,
    array['https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/', 'https://cp-algorithms.com/navigation.html']
  ),
  (
    'trusted-algorithm-source-catalog',
    'Trusted algorithm source catalog',
    'resource',
    'Trusted official, academic and contest-tested references for algorithmic optimisation.',
    '["Prefer MIT OCW and Stanford CS166 for foundational reasoning.", "Use CP-Algorithms, USACO Guide and KACTL for contest-tested implementation patterns.", "Use official language/runtime docs for measurement claims."]'::jsonb,
    array['trusted', 'sources', 'algorithms', 'data-structures'],
    null,
    null,
    null,
    array['https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/', 'https://web.stanford.edu/class/cs166/', 'https://cp-algorithms.com/index.html', 'https://github.com/kth-competitive-programming/kactl']
  )
on conflict (id) do update set
  title = excluded.title,
  kind = excluded.kind,
  summary = excluded.summary,
  guidance = excluded.guidance,
  tags = excluded.tags,
  complexity = excluded.complexity,
  target_runtime_ms = excluded.target_runtime_ms,
  target_memory_mb = excluded.target_memory_mb,
  source_urls = excluded.source_urls;
