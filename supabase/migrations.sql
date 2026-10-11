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

-- Phase 16: who published a knowledge record, and when.
--
-- The library is one shared shelf on purpose — the cloud worker loads it with
-- no principal at all, so a per-owner library would leave a worker guessing
-- whose to reason from. The cost of that is that two signed-in Macs can
-- overwrite each other, and the answer is not ownership but attribution: every
-- row says who last published it, and the publish operation reports what it
-- replaced rather than replacing it quietly.
alter table if exists intelligence_records
  add column if not exists published_by uuid,
  add column if not exists published_at timestamptz;

-- Phase 11: background capture-to-council jobs. The desktop app can be closed
-- while an approved helper uploads captures and a cloud worker claims queued
-- work. The queue records progress and evidence; secrets stay in Keychain or
-- server-side worker environment variables, never in these rows.
create table if not exists solve_jobs (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid        not null references sessions (id) on delete cascade,
  mode              text        not null default 'council'
                      check (mode in ('council', 'mcq')),
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

alter table if exists solve_jobs drop constraint if exists solve_jobs_mode_check;
alter table if exists solve_jobs
  add constraint solve_jobs_mode_check check (mode in ('council', 'mcq'));

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

-- ------------------------------------------------------------------ auth
--
-- A username and a 4-digit PIN, guarding a tool that holds API keys, screen
-- captures and a code executor. Three things about this table matter more than
-- its shape:
--
--   * `pin_hash` is an Argon2id PHC string, never the PIN. Verification happens
--     in Rust; the hash is never handed to the webview.
--   * the PIN is peppered before hashing with a secret that lives in the macOS
--     Keychain and is deliberately NOT in this database. A 4-digit PIN is 10,000
--     possibilities -- no KDF makes that safe on its own -- so the design
--     assumption is that a stolen database dump is useless without the Mac.
--   * `failed_attempts` and `locked_until` are the real defence, and they live
--     here rather than in memory so that quitting the app is not a way to reset
--     the counter.
create table if not exists app_users (
  id              uuid        primary key default gen_random_uuid(),
  username        text        not null,
  pin_hash        text        not null,
  failed_attempts integer     not null default 0,
  -- Set while the account is in a lockout window. Null means "not locked",
  -- which is also true of a past timestamp -- readers compare against now().
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Case-insensitive uniqueness without requiring the citext extension, which is
-- not enabled on a stock Supabase project. The username is stored as typed so it
-- can be shown back the way the owner wrote it.
create unique index if not exists app_users_username_idx
  on app_users (lower(username));

-- "Remember this Mac for 30 days". The row holds the SHA-256 of the token; the
-- token itself is in the Keychain, so this table cannot be replayed into a
-- login. Revocation is a column rather than a delete so that signing out
-- somewhere leaves a trace worth reading.
create table if not exists app_sessions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references app_users (id) on delete cascade,
  token_hash   text        not null unique,
  label        text        not null default '',
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists app_sessions_user_idx
  on app_sessions (user_id, expires_at desc);

drop trigger if exists app_users_touch on app_users;
create trigger app_users_touch before update on app_users
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- app config
--
-- Everything that used to sit in `.development.env`, so the machine running this
-- app is not also the place its configuration lives. One row per variable.
--
-- Not the `settings` table, deliberately. `settings_load` is a Tauri command,
-- which means the webview can read any key in it -- fine for a pane layout,
-- catastrophic for a TokenRouter key. This table has no command that returns a
-- secret value, and that is the whole reason it is separate.
create table if not exists app_config (
  key        text        primary key,
  value      text        not null default '',
  -- Whether the value may ever leave the machine's Rust side. Secrets are
  -- listed to the UI by name only; the value goes to outbound requests and
  -- nowhere else.
  secret     boolean     not null default false,
  updated_at timestamptz not null default now()
);

-- No policies, and that is the point.
--
-- Supabase grants the `anon` and `authenticated` roles access to tables in
-- `public`, and the anon key ships inside the app -- so a table holding a
-- GitHub token with RLS off is a table that anyone who opens the bundle can
-- read. Enabling row level security and writing no policy at all leaves exactly
-- one way in: `service_role`, which bypasses RLS and now lives in the Edge
-- Function rather than on a laptop.
alter table app_config enable row level security;

drop trigger if exists app_config_touch on app_config;
create trigger app_config_touch before update on app_config
  for each row execute function touch_updated_at();

-- ------------------------------------------------------------------ tenancy
--
-- Phase 01 of the multi-tenant migration: give every row an owner.
--
-- Sixteen tables, and until now only `app_sessions` knew who anything belonged
-- to. That is correct for an app built for one person on one Mac, and it is a
-- cross-account leak the moment a second account exists.
--
-- Deliberately in two halves. This file adds the column and backfills it, both
-- of which are safe to run on every launch and safe to run twice. Making the
-- column `not null` lives in `supabase/tenancy-constrain.sql`, run by hand once
-- the audit is clean -- because `ensure_schema` replays this file at startup, so
-- a constraint that fails against one unbackfilled row would stop the app from
-- starting rather than merely failing to migrate.
--
-- `settings` and `app_config` are not here on purpose. Both are key/value tables
-- whose primary key is the key itself, so per-user rows need a composite key
-- rather than an extra column. That is phase 03, where the platform-versus-user
-- resolution is designed properly.

-- Step 1: the column, nullable. Nothing reads it yet, so nothing can break.
alter table if exists sessions             add column if not exists owner_id uuid;
alter table if exists screenshots          add column if not exists owner_id uuid;
alter table if exists runs                 add column if not exists owner_id uuid;
alter table if exists solve_jobs           add column if not exists owner_id uuid;
alter table if exists solve_job_images     add column if not exists owner_id uuid;
alter table if exists solve_job_events     add column if not exists owner_id uuid;
alter table if exists council_reports      add column if not exists owner_id uuid;
alter table if exists notification_devices add column if not exists owner_id uuid;

-- Step 2: backfill.
--
-- With one account this is exact rather than a guess: every existing row belongs
-- to the only person who could have made it. Roots take the first account;
-- children inherit through the foreign key they already carry, so the chain
-- stays true even if a session was created before the account was renamed.
--
-- Each statement is `where owner_id is null`, so the second launch does nothing.

update sessions set owner_id = (select id from app_users order by created_at limit 1)
 where owner_id is null;

update notification_devices set owner_id = (select id from app_users order by created_at limit 1)
 where owner_id is null;

update screenshots c set owner_id = p.owner_id
  from sessions p where p.id = c.session_id and c.owner_id is null;

update runs c set owner_id = p.owner_id
  from sessions p where p.id = c.session_id and c.owner_id is null;

update solve_jobs c set owner_id = p.owner_id
  from sessions p where p.id = c.session_id and c.owner_id is null;

update solve_job_images c set owner_id = p.owner_id
  from solve_jobs p where p.id = c.job_id and c.owner_id is null;

update solve_job_events c set owner_id = p.owner_id
  from solve_jobs p where p.id = c.job_id and c.owner_id is null;

update council_reports c set owner_id = p.owner_id
  from solve_jobs p where p.id = c.job_id and c.owner_id is null;

-- The indexes every scoped query will need. Created now rather than with the
-- constraint, so the first tenant-scoped read is fast on day one.
create index if not exists sessions_owner_idx
  on sessions (owner_id, updated_at desc);
create index if not exists screenshots_owner_idx
  on screenshots (owner_id);
create index if not exists runs_owner_idx
  on runs (owner_id, started_at desc);
create index if not exists solve_jobs_owner_idx
  on solve_jobs (owner_id, created_at desc);
create index if not exists solve_job_images_owner_idx
  on solve_job_images (owner_id);
create index if not exists solve_job_events_owner_idx
  on solve_job_events (owner_id);
create index if not exists council_reports_owner_idx
  on council_reports (owner_id);
create index if not exists notification_devices_owner_idx
  on notification_devices (owner_id);

-- Ownership is inherited, not passed around.
--
-- Four different things write these tables: the Rust app, the cloud worker, the
-- batch runner, and one day an iOS client. Asking every one of them to remember
-- an `owner_id` is asking for the one that forgets — and a child row with the
-- wrong owner is worse than one with none, because it is invisible rather than
-- caught by the audit.
--
-- So the database fills it in from the parent. A writer that supplies an owner
-- keeps it; a writer that does not gets the right one anyway. `addEvent` in the
-- worker holds only a job id and needs no change at all.

create or replace function inherit_owner_from_session() returns trigger as $$
begin
  if new.owner_id is null then
    select owner_id into new.owner_id from sessions where id = new.session_id;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function inherit_owner_from_job() returns trigger as $$
begin
  if new.owner_id is null then
    select owner_id into new.owner_id from solve_jobs where id = new.job_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists screenshots_owner on screenshots;
create trigger screenshots_owner before insert on screenshots
  for each row execute function inherit_owner_from_session();

drop trigger if exists runs_owner on runs;
create trigger runs_owner before insert on runs
  for each row execute function inherit_owner_from_session();

drop trigger if exists solve_jobs_owner on solve_jobs;
create trigger solve_jobs_owner before insert on solve_jobs
  for each row execute function inherit_owner_from_session();

drop trigger if exists solve_job_images_owner on solve_job_images;
create trigger solve_job_images_owner before insert on solve_job_images
  for each row execute function inherit_owner_from_job();

drop trigger if exists solve_job_events_owner on solve_job_events;
create trigger solve_job_events_owner before insert on solve_job_events
  for each row execute function inherit_owner_from_job();

drop trigger if exists council_reports_owner on council_reports;
create trigger council_reports_owner before insert on council_reports
  for each row execute function inherit_owner_from_job();

-- ------------------------------------------------------- per-user settings
--
-- Phase 03. `app_config` and `settings` were left out of phase 01 because their
-- primary key *is* the key: one row named `tokenrouter`, one named `paneLayout`.
-- With two accounts that is not a scoping bug, it is a collision — the second
-- person to save a TokenRouter key overwrites the first, both then see a key
-- present and working, and it bills to whoever's it actually is. Nothing in the
-- app would report a problem.
--
-- So the key becomes (owner_id, key).
--
-- Platform rows use an all-zeroes owner rather than null. Null would need the
-- primary key to be an expression over `coalesce`, and then every upsert has to
-- name that same expression in its `on conflict` — a sharp edge on every write
-- forever, to save one sentinel constant.
--
-- Existing rows go to the owner, not to the platform tier. These are Charles's
-- own keys: defaulting them to "shared with every future account" is the wrong
-- direction to be wrong in. Promoting one to platform is a deliberate act.

alter table if exists app_config add column if not exists owner_id uuid;
alter table if exists settings   add column if not exists owner_id uuid;

update app_config set owner_id = (select id from app_users order by created_at limit 1)
 where owner_id is null;
update settings   set owner_id = (select id from app_users order by created_at limit 1)
 where owner_id is null;

-- A database with no account yet (a fresh install seeding itself) has nobody to
-- own these, so they start as platform rows and the first sign-in inherits them.
update app_config set owner_id = '00000000-0000-0000-0000-000000000000' where owner_id is null;
update settings   set owner_id = '00000000-0000-0000-0000-000000000000' where owner_id is null;

alter table app_config alter column owner_id set not null;
alter table settings   alter column owner_id set not null;

-- Idempotent by name: `migrations.sql` is replayed on every launch, and
-- `add primary key` is not `if not exists`.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_config_owner_key_pk') then
    alter table app_config drop constraint if exists app_config_pkey;
    alter table app_config add constraint app_config_owner_key_pk primary key (owner_id, key);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'settings_owner_key_pk') then
    alter table settings drop constraint if exists settings_pkey;
    alter table settings add constraint settings_owner_key_pk primary key (owner_id, key);
  end if;
end $$;

-- The server API endpoint is app configuration, not somebody's preference: it is
-- the same for every account, so it belongs in the platform tier rather than
-- being copied into each person's rows by the backfill above.
update settings set owner_id = '00000000-0000-0000-0000-000000000000'
 where key = 'serverApi'
   and owner_id <> '00000000-0000-0000-0000-000000000000'
   and not exists (
     select 1 from settings p
      where p.key = 'serverApi'
        and p.owner_id = '00000000-0000-0000-0000-000000000000'
   );

-- --------------------------------------------------------- server-side auth
--
-- Phase 04. The username and PIN stay exactly as the way in; what changes is
-- *where* they are checked.
--
-- Today the desktop reads a pepper from the Mac's Keychain, hashes the PIN with
-- Argon2id locally, and compares. That means: a Keychain entry that cannot be
-- removed, a signature prompt on every rebuild, and an app that fails closed
-- when macOS declines. It also means the attempt counter is enforced by the
-- client that is doing the guessing.
--
-- So verification moves into the database, called by the Edge Function, with the
-- pepper supplied as a function secret. bcrypt via pgcrypto rather than Argon2id
-- because it is already installed in every Supabase project — no WASM
-- dependency in the Deno runtime, and nothing new to keep working.
--
-- `security definer` so the function may read `pin_hash` while nothing else can.

create extension if not exists pgcrypto;

drop function if exists auth_verify_pin(text, text, text);

create or replace function auth_verify_pin(p_username text, p_pin text, p_pepper text)
returns table (
  user_id uuid,
  matched_username text,
  outcome text,
  locked_until timestamptz,
  attempts_remaining integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  u record;
  attempts integer;
begin
  select app_users.id, app_users.username, app_users.pin_hash, app_users.failed_attempts, app_users.locked_until
    into u
    from app_users
   where lower(username) = lower(trim(p_username));

  -- Deliberately the same shape as a wrong PIN to the caller above: telling an
  -- unauthenticated client that a username exists is telling it what to guess.
  if not found then
    return query select null::uuid, null::text, 'no', null::timestamptz, null::integer;
    return;
  end if;

  if u.locked_until is not null and u.locked_until > now() then
    return query select u.id, u.username, 'locked', u.locked_until, 0;
    return;
  end if;

  -- An Argon2id hash from the old local scheme. Not a failure and not a wrong
  -- PIN: this account simply predates server-side checking and needs its PIN
  -- set once more.
  if left(u.pin_hash, 2) <> '$2' then
    return query select u.id, u.username, 'needs_reset', null::timestamptz, null::integer;
    return;
  end if;

  if crypt(p_pin || p_pepper, u.pin_hash) = u.pin_hash then
    update app_users
       set failed_attempts = 0, locked_until = null, last_login_at = now()
     where id = u.id;
    return query select u.id, u.username, 'ok', null::timestamptz, 5;
    return;
  end if;

  -- Four free tries, then widening windows. Enforced here, so it holds however
  -- the caller behaves.
  attempts := u.failed_attempts + 1;
  update app_users
     set failed_attempts = attempts,
         locked_until = case
           when attempts <= 4 then null
           when attempts = 5 then now() + interval '1 minute'
           when attempts = 6 then now() + interval '5 minutes'
           when attempts = 7 then now() + interval '15 minutes'
           when attempts = 8 then now() + interval '1 hour'
           else now() + interval '24 hours'
         end
   where id = u.id;

  return query
    select u.id,
           u.username,
           'no',
           case
             when attempts <= 4 then null::timestamptz
             when attempts = 5 then now() + interval '1 minute'
             when attempts = 6 then now() + interval '5 minutes'
             when attempts = 7 then now() + interval '15 minutes'
             when attempts = 8 then now() + interval '1 hour'
             else now() + interval '24 hours'
           end,
           greatest(0, 5 - attempts);
end;
$$;

create or replace function auth_set_pin(p_user_id uuid, p_pin text, p_pepper text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_pin !~ '^[0-9]{4}$' then
    raise exception 'The PIN has to be exactly 4 digits.';
  end if;
  update app_users
     set pin_hash = crypt(p_pin || p_pepper, gen_salt('bf', 12)),
         failed_attempts = 0,
         locked_until = null,
         updated_at = now()
   where id = p_user_id;
end;
$$;

-- Only the service role, which is to say only the Edge Function. `security
-- definer` would otherwise let any role that can reach PostgREST call these.
revoke all on function auth_verify_pin(text, text, text) from public, anon, authenticated;
revoke all on function auth_set_pin(uuid, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------ saving a run
--
-- One run is three tables: `runs`, every row of `agent_responses`, and at most
-- one `verdicts`. The desktop wrote them inside a single transaction, and that
-- mattered — a network failure halfway through would otherwise leave a run
-- holding some of its answers and no verdict, which reads as a finished run that
-- quietly lost data rather than as a failure anyone would notice.
--
-- PostgREST has no transactions, so moving this to the Edge Function as three
-- inserts would have made the failure worse than the thing it replaced. A
-- function is one statement to the caller and one transaction to Postgres, so
-- the guarantee survives the move.
--
-- `security definer` with an explicit owner check: the caller supplies the owner
-- from its verified token, and a session belonging to anyone else is refused
-- rather than written to.

create or replace function run_save(
  p_owner              uuid,
  p_session            uuid,
  p_mode               text,
  p_asked              text,
  p_context_mode       text,
  p_extracted_context  text,
  p_extraction_agreed  boolean,
  p_responses          jsonb,
  p_verdict            jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run uuid;
  r jsonb;
begin
  if not exists (select 1 from sessions where id = p_session and owner_id = p_owner) then
    raise exception 'no such session' using errcode = 'P0002';
  end if;

  insert into runs (session_id, owner_id, mode, asked, context_mode,
                    extracted_context, extraction_agreed, finished_at)
  values (p_session, p_owner, p_mode, p_asked, p_context_mode,
          p_extracted_context, p_extraction_agreed, now())
  returning id into v_run;

  for r in select * from jsonb_array_elements(coalesce(p_responses, '[]'::jsonb))
  loop
    insert into agent_responses
      (run_id, provider, model, attempt_id, status, body, final_kind,
       final_language, final_answer, final_code, final_claims, complexity,
       confidence, well_formed, input_tokens, output_tokens, elapsed_ms, error)
    values (
      v_run,
      r->>'provider',
      r->>'model',
      r->>'attemptId',
      r->>'status',
      coalesce(r->>'body', ''),
      r->>'finalKind',
      r->>'finalLanguage',
      r->>'finalAnswer',
      r->>'finalCode',
      -- `text[]` from a JSON array, and empty rather than null: the column is
      -- `not null default '{}'` and the Rust struct reads it as a plain Vec.
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(r->'finalClaims')),
        '{}'::text[]
      ),
      r->>'complexity',
      (r->>'confidence')::real,
      coalesce((r->>'wellFormed')::boolean, false),
      (r->>'inputTokens')::bigint,
      (r->>'outputTokens')::bigint,
      (r->>'elapsedMs')::bigint,
      r->>'error'
    );
  end loop;

  if p_verdict is not null and p_verdict <> 'null'::jsonb then
    insert into verdicts
      (run_id, verdict, headline, detail, reliability, camps, outliers,
       representative, judge_provider, judge_text)
    values (
      v_run,
      p_verdict->>'verdict',
      p_verdict->>'headline',
      p_verdict->>'detail',
      p_verdict->>'reliability',
      coalesce(p_verdict->'camps', '[]'::jsonb),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(p_verdict->'outliers')),
        '{}'::text[]
      ),
      p_verdict->>'representative',
      p_verdict->>'judgeProvider',
      p_verdict->>'judgeText'
    );
  end if;

  return v_run;
end;
$$;

revoke all on function run_save(uuid, uuid, text, text, text, text, boolean, jsonb, jsonb)
  from public, anon, authenticated;

-- --------------------------------------------------- queueing a solve job
--
-- Same reasoning as `run_save`: a job is a `solve_jobs` row, one
-- `solve_job_images` row per screenshot, and the first `solve_job_events` line.
-- A job written without its images is a job the worker will claim and fail on,
-- so the three belong in one transaction.

create or replace function solve_job_create(
  p_owner    uuid,
  p_session  uuid,
  p_mode     text,
  p_settings jsonb,
  p_images   jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job uuid;
  img jsonb;
  pos integer := 0;
begin
  if not exists (select 1 from sessions where id = p_session and owner_id = p_owner) then
    raise exception 'no such session' using errcode = 'P0002';
  end if;

  if coalesce(p_mode, 'council') not in ('council', 'mcq') then
    raise exception 'unsupported solve job mode' using errcode = '22023';
  end if;

  insert into solve_jobs (session_id, owner_id, mode, status, progress_phase, settings_snapshot)
  values (p_session, p_owner, coalesce(p_mode, 'council'), 'queued', 'queued', coalesce(p_settings, '{}'::jsonb))
  returning id into v_job;

  for img in select * from jsonb_array_elements(coalesce(p_images, '[]'::jsonb))
  loop
    insert into solve_job_images
      (job_id, session_id, owner_id, position, storage_bucket, storage_path,
       file_name, bytes, mime, width, height)
    values (
      v_job, p_session, p_owner, pos,
      img->>'storageBucket', img->>'storagePath', img->>'fileName',
      (img->>'bytes')::integer, img->>'mime',
      (img->>'width')::integer, (img->>'height')::integer
    );
    pos := pos + 1;
  end loop;

  insert into solve_job_events (job_id, owner_id, level, phase, message, payload)
  values (v_job, p_owner, 'info', 'queued',
          case when coalesce(p_mode, 'council') = 'mcq'
            then 'Background MCQ job queued.'
            else 'Background Council job queued.'
          end,
          jsonb_build_object('imageCount', jsonb_array_length(coalesce(p_images, '[]'::jsonb)), 'mode', coalesce(p_mode, 'council')));

  return v_job;
end;
$$;

revoke all on function solve_job_create(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function solve_job_create(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------ reordering screenshots
--
-- One statement instead of a loop of updates inside a transaction. `position`
-- has no unique constraint, but a partial write would still leave a session
-- whose screenshots are in an order nobody chose.

create or replace function screenshots_reorder(
  p_owner   uuid,
  p_session uuid,
  p_ids     uuid[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update screenshots s
     set position = o.ord - 1
    from unnest(p_ids) with ordinality as o(id, ord)
   where s.id = o.id
     and s.session_id = p_session
     and s.owner_id = p_owner;
end;
$$;

revoke all on function screenshots_reorder(uuid, uuid, uuid[]) from public, anon, authenticated;


-- Submission idempotency: uniqueness is scoped to the signed-in account.
alter table if exists solve_jobs add column if not exists submission_id uuid;
create unique index if not exists solve_jobs_owner_submission_unique
on solve_jobs(owner_id, submission_id) where submission_id is not null;

create or replace function solve_job_create(
  p_owner uuid, p_session uuid, p_mode text, p_settings jsonb,
  p_images jsonb, p_submission uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_job uuid;
  v_existing solve_jobs%rowtype;
  img jsonb;
  pos integer := 0;
begin
  if p_submission is null then raise exception 'missing submission identity' using errcode='22023'; end if;
  if not exists (select 1 from sessions where id=p_session and owner_id=p_owner) then
    raise exception 'no such session' using errcode='P0002';
  end if;
  if coalesce(p_mode,'council') not in ('council','mcq') then
    raise exception 'unsupported mode' using errcode='22023';
  end if;
  if jsonb_typeof(coalesce(p_images,'[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_images,'[]'::jsonb)) not between 1 and 10 then
    raise exception 'invalid screenshot count' using errcode='22023';
  end if;
  insert into solve_jobs(owner_id,session_id,mode,status,progress_phase,settings_snapshot,submission_id)
  values(p_owner,p_session,coalesce(p_mode,'council'),'queued','queued',
         coalesce(p_settings,'{}'::jsonb),p_submission)
  on conflict(owner_id,submission_id) where submission_id is not null do nothing
  returning id into v_job;
  if v_job is null then
    select * into v_existing from solve_jobs where owner_id=p_owner and submission_id=p_submission;
    if not found then raise exception 'submission conflict' using errcode='23505'; end if;
    if v_existing.session_id is distinct from p_session
      or v_existing.mode is distinct from coalesce(p_mode,'council')
      or v_existing.settings_snapshot is distinct from coalesce(p_settings,'{}'::jsonb)
      or (select coalesce(jsonb_agg(jsonb_build_object(
         'storageBucket', storage_bucket, 'storagePath', storage_path,
         'fileName',file_name,'bytes',bytes,'mime',mime,
         'width',width,'height',height) order by position),'[]'::jsonb)
         from solve_job_images where job_id=v_existing.id)
         is distinct from
         (select coalesce(jsonb_agg(jsonb_build_object(
         'storageBucket',x->>'storageBucket','storagePath',x->>'storagePath',
         'fileName',x->>'fileName','bytes',(x->>'bytes')::integer,'mime',x->>'mime',
         'width',(x->>'width')::integer,'height',(x->>'height')::integer)
         order by ordinal),'[]'::jsonb)
         from jsonb_array_elements(p_images) with ordinality as e(x,ordinal))
    then raise exception 'submission identity reused with different data' using errcode='23505'; end if;
    return v_existing.id;
  end if;
  for img in select * from jsonb_array_elements(p_images) loop
    insert into solve_job_images(job_id,session_id,owner_id,position,storage_bucket,
      storage_path,file_name,bytes,mime,width,height)
    values(v_job,p_session,p_owner,pos,img->>'storageBucket',img->>'storagePath',
      img->>'fileName',(img->>'bytes')::integer,img->>'mime',
      (img->>'width')::integer,(img->>'height')::integer);
    pos:=pos+1;
  end loop;
  insert into solve_job_events(job_id,owner_id,level,phase,message,payload)
  values(v_job,p_owner,'info','queued','Background solve job queued.',
    jsonb_build_object('imageCount',pos,'mode',p_mode));
  return v_job;
end;
$$;
revoke all on function solve_job_create(uuid,uuid,text,jsonb,jsonb,uuid)
  from public,anon,authenticated;
