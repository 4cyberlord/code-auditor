import {
  allKnowledgeRecords,
  knowledgePackFor,
  renderKnowledgePack,
  retrieveKnowledge,
} from "../src/lib/knowledge.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

console.log("\n1. the local knowledge library has useful coding records");
{
  const records = allKnowledgeRecords();
  check("several records", records.length >= 25, String(records.length));
  check("runtime discipline exists", records.some((r) => r.id === "runtime-discipline"));
  check("zero-ms contract exists", records.some((r) => r.id === "zero-ms-memory-contract"));
  check("Rosetta Code is a linked source", records.some((r) => r.sources?.some((s) => s.url === "https://rosettacode.org/wiki/Runtime_evaluation")));
  check("Supabase RAG source exists", records.some((r) => r.sources?.some((s) => s.url === "https://supabase.com/docs/guides/ai/hybrid-search")));
  check("Node performance source exists", records.some((r) => r.sources?.some((s) => s.url === "https://nodejs.org/api/perf_hooks.html")));
  check("MIT algorithm source exists", records.some((r) => r.sources?.some((s) => s.url === "https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/")));
  check("KACTL source exists", records.some((r) => r.sources?.some((s) => s.url === "https://github.com/kth-competitive-programming/kactl")));
  check("Linux memory source exists", records.some((r) => r.sources?.some((s) => s.url === "https://man7.org/linux/man-pages/man2/getrusage.2.html")));
  check("Compiler Explorer source exists", records.some((r) => r.sources?.some((s) => s.url === "https://godbolt.org/")));
  check("Hypothesis source exists", records.some((r) => r.sources?.some((s) => s.url === "https://hypothesis.readthedocs.io/")));
  check("sources include trust levels", records.some((r) => r.sources?.some((s) => s.trust === "official" || s.trust === "academic")));
}

console.log("\n2. graph connectivity retrieves the right pattern");
{
  const hits = retrieveKnowledge(
    "1627 Graph Connectivity With Threshold cities share common divisor threshold queries connected",
    4
  );
  const ids = hits.map((h) => h.record.id);
  check("threshold problem found", ids.includes("graph-connectivity-threshold"), ids.join(", "));
  check("dsu support found", ids.includes("dsu-template"), ids.join(", "));
}

console.log("\n3. rendered knowledge carries professional runtime rules");
{
  const pack = knowledgePackFor("Need fastest runtime for union find graph connectivity threshold", 5);
  check("runtime target included", pack.includes("<= 17ms"), pack);
  check("memory target included", pack.includes("<= 10MB"), pack);
  check("no fake measurement allowed", pack.includes("never invent") || pack.includes("not measured"), pack);
  check("complexity included", /O\(.+\)/.test(pack), pack);
}

console.log("\n4. rendering is empty when nothing matches");
{
  check("empty hits render empty", renderKnowledgePack([]) === "");
}

console.log("\n5. resource queries retrieve the right improvement packs");
{
  const python = retrieveKnowledge("python solution too slow profile with cprofile timeit", 3).map((h) => h.record.id);
  check("python performance retrieved", python.includes("python-performance"), python.join(", "));

  const rag = retrieveKnowledge("build RAG semantic hybrid search in supabase postgres pgvector", 3).map((h) => h.record.id);
  check("supabase rag retrieved", rag.includes("rag-storage-supabase"), rag.join(", "));

  const app = retrieveKnowledge("next react tauri bundle render startup performance", 3).map((h) => h.record.id);
  check("app performance retrieved", app.includes("next-react-tauri-performance"), app.join(", "));

  const zero = retrieveKnowledge("need Runtime 0ms memory 10mb fastest algorithm optimization", 3).map((h) => h.record.id);
  check("zero-ms contract retrieved", zero.includes("zero-ms-memory-contract"), zero.join(", "));

  const dp = retrieveKnowledge("dynamic programming optimize state memory compression", 4).map((h) => h.record.id);
  check("dynamic programming retrieved", dp.includes("dynamic-programming-optimization"), dp.join(", "));

  const strings = retrieveKnowledge("string matching kmp z function trie rolling hash", 4).map((h) => h.record.id);
  check("string algorithms retrieved", strings.includes("string-algorithm-optimization"), strings.join(", "));
}

console.log("\n6. performance-engineering records protect benchmark quality");
{
  const memory = retrieveKnowledge("ru_maxrss VmRSS VmHWM peak RSS auxiliary memory process memory", 4).map((h) => h.record.id);
  check("memory taxonomy retrieved", memory.includes("memory-metric-taxonomy"), memory.join(", "));

  const fair = retrieveKnowledge("compare C++ Rust Python same random matrix identical input benchmark warmup", 4).map((h) => h.record.id);
  check("cross-language benchmark contract retrieved", fair.includes("cross-language-benchmark-contract"), fair.join(", "));

  const gate = retrieveKnowledge("optimized candidate property based differential test brute force reference before benchmark", 4).map((h) => h.record.id);
  check("optimization correctness gate retrieved", gate.includes("optimization-correctness-gate"), gate.join(", "));

  const codegen = retrieveKnowledge("inspect generated assembly LLVM IR Rust MIR vectorization bounds checks godbolt", 4).map((h) => h.record.id);
  check("assembly inspection retrieved", codegen.includes("assembly-codegen-inspection"), codegen.join(", "));

  const layout = retrieveKnowledge("cache locality data layout AoS SoA SIMD branch prediction", 4).map((h) => h.record.id);
  check("cache data layout retrieved", layout.includes("cache-data-layout-optimization"), layout.join(", "));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall knowledge checks passed\n");
process.exit(fail ? 1 : 0);
