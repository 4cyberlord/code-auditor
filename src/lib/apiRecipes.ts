/**
 * API recipes — the small, high-frequency slice of each standard library that a
 * harness actually has to *construct*. Not a documentation dump: one entry per
 * operation a driver needs, with a source link and a compiled-by-tests snippet.
 *
 * Coverage is deliberately narrow. Unknown operations are the model's job; the
 * recipes only remove the constructs that break drivers most often.
 */

export type RecipeLanguage = "python" | "cpp" | "rust";

export interface ApiRecipe {
  id: string;
  language: RecipeLanguage;
  /** What the driver is trying to do, not the API name. */
  purpose: "list" | "map" | "set" | "tuple" | "sort" | "string" | "optional" | "heap";
  snippet: string;
  source: string;
  note?: string;
}

export const API_RECIPES: ApiRecipe[] = [
  { id: "py.list", language: "python", purpose: "list", snippet: "values = [1, 2, 3]", source: "https://docs.python.org/3/tutorial/datastructures.html", note: "lists are the JSON array; nested lists are lists of lists" },
  { id: "py.dict", language: "python", purpose: "map", snippet: "counts = {}\ncounts[key] = counts.get(key, 0) + 1", source: "https://docs.python.org/3/library/stdtypes.html#mapping-types-dict" },
  { id: "py.set", language: "python", purpose: "set", snippet: "seen = set()\nseen.add(value)", source: "https://docs.python.org/3/library/stdtypes.html#set-types-set-frozenset" },
  { id: "py.tuple", language: "python", purpose: "tuple", snippet: "pair = (left, right)", source: "https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences" },
  { id: "py.sort", language: "python", purpose: "sort", snippet: "ordered = sorted(values)\nordered.sort(reverse=True)", source: "https://docs.python.org/3/library/functions.html#sorted" },
  { id: "py.heap", language: "python", purpose: "heap", snippet: "import heapq\nheapq.heapify(values)\nheapq.heappush(values, item)", source: "https://docs.python.org/3/library/heapq.html" },
  { id: "py.string", language: "python", purpose: "string", snippet: 'text = "a\\"b"', source: "https://docs.python.org/3/library/stdtypes.html#text-sequence-type-str" },

  { id: "cpp.vector", language: "cpp", purpose: "list", snippet: "std::vector<int> values{1, 2, 3};", source: "https://en.cppreference.com/w/cpp/container/vector", note: "the driver must keep a named lvalue; temporaries do not bind to T&" },
  { id: "cpp.nested", language: "cpp", purpose: "list", snippet: "std::vector<std::vector<int>> grid{{1, 2}, {3, 4}};", source: "https://en.cppreference.com/w/cpp/container/vector" },
  { id: "cpp.map", language: "cpp", purpose: "map", snippet: "std::map<std::string, int> counts;\ncounts[key]++;", source: "https://en.cppreference.com/w/cpp/container/map" },
  { id: "cpp.set", language: "cpp", purpose: "set", snippet: "std::set<int> seen;\nseen.insert(value);", source: "https://en.cppreference.com/w/cpp/container/set" },
  { id: "cpp.pair", language: "cpp", purpose: "tuple", snippet: "std::pair<int, int> pair{left, right};", source: "https://en.cppreference.com/w/cpp/utility/pair" },
  { id: "cpp.sort", language: "cpp", purpose: "sort", snippet: "std::sort(values.begin(), values.end());", source: "https://en.cppreference.com/w/cpp/algorithm/sort" },
  { id: "cpp.heap", language: "cpp", purpose: "heap", snippet: "std::priority_queue<int> heap(values.begin(), values.end());", source: "https://en.cppreference.com/w/cpp/container/priority_queue", note: "#include <queue>" },
  { id: "cpp.optional", language: "cpp", purpose: "optional", snippet: "std::optional<int> maybe = std::nullopt;", source: "https://en.cppreference.com/w/cpp/utility/optional", note: "C++17 and later" },

  { id: "rust.vec", language: "rust", purpose: "list", snippet: "let values = vec![1i64, 2, 3];", source: "https://doc.rust-lang.org/std/vec/struct.Vec.html" },
  { id: "rust.nested", language: "rust", purpose: "list", snippet: "let grid = vec![vec![1i64, 2], vec![3, 4]];", source: "https://doc.rust-lang.org/std/vec/struct.Vec.html" },
  { id: "rust.map", language: "rust", purpose: "map", snippet: "use std::collections::HashMap;\nlet mut counts: HashMap<String, i64> = HashMap::new();\n*counts.entry(key).or_insert(0) += 1;", source: "https://doc.rust-lang.org/std/collections/struct.HashMap.html" },
  { id: "rust.set", language: "rust", purpose: "set", snippet: "use std::collections::HashSet;\nlet mut seen: HashSet<i64> = HashSet::new();\nseen.insert(value);", source: "https://doc.rust-lang.org/std/collections/struct.HashSet.html" },
  { id: "rust.tuple", language: "rust", purpose: "tuple", snippet: "let pair = (left, right);", source: "https://doc.rust-lang.org/std/primitive.tuple.html" },
  { id: "rust.sort", language: "rust", purpose: "sort", snippet: "values.sort();", source: "https://doc.rust-lang.org/std/vec/struct.Vec.html#method.sort" },
  { id: "rust.heap", language: "rust", purpose: "heap", snippet: "use std::collections::BinaryHeap;\nlet mut heap = BinaryHeap::from(values);", source: "https://doc.rust-lang.org/std/collections/struct.BinaryHeap.html" },
  { id: "rust.option", language: "rust", purpose: "optional", snippet: "let maybe: Option<i64> = None;", source: "https://doc.rust-lang.org/std/option/enum.Option.html" },
];

/** Recipes for one language, optionally limited to the shapes a contract needs. */
export function recipesFor(language: string, purposes?: ApiRecipe["purpose"][]): ApiRecipe[] {
  const wanted = purposes && purposes.length ? new Set(purposes) : null;
  return API_RECIPES.filter((recipe) => recipe.language === language && (!wanted || wanted.has(recipe.purpose)));
}

/** Compact prompt block; empty when nothing matches. */
export function recipePrompt(language: string, purposes?: ApiRecipe["purpose"][]): string {
  const rows = recipesFor(language, purposes);
  if (!rows.length) return "";
  return [
    `Known-good ${language} constructs (use these shapes; adapt types to the contract):`,
    ...rows.map((row) => `- ${row.purpose}: ${row.snippet.replace(/\n/g, " ⏎ ")}${row.note ? ` (${row.note})` : ""}`),
  ].join("\n");
}
