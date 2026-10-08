import { parseFinal } from "../src/lib/parse.ts";
import { computeConsensus } from "../src/lib/consensus.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${extra}`);
    failures++;
  }
}

const final = (o: {
  kind?: string;
  lang?: string;
  answer: string;
  claims: string[];
  code?: string;
  conf?: string;
  complexity?: string;
}) =>
  `Here is my working. First I read the image, then I traced the example.

<<<FINAL
KIND: ${o.kind ?? "code"}
LANGUAGE: ${o.lang ?? "python"}
ANSWER: ${o.answer}
COMPLEXITY: ${o.complexity ?? "O(n) time, O(n) space"}
CONFIDENCE: ${o.conf ?? "0.93"}
CLAIMS:
${o.claims.map((c) => `- ${c}`).join("\n")}
CODE:
\`\`\`${o.lang ?? "python"}
${o.code ?? ""}
\`\`\`
FINAL>>>`;

const twoSumA = `def two_sum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        need = target - n
        if need in seen:
            return [seen[need], i]
        seen[n] = i
    return []`;

const twoSumB = `def two_sum(numbers, goal):
    # one pass with a lookup table
    index_of = {}
    for idx, value in enumerate(numbers):
        complement = goal - value
        if complement in index_of:
            return [index_of[complement], idx]
        index_of[value] = idx
    return []`;

const twoSumC = `def two_sum(a, t):
    d = {}
    for i, x in enumerate(a):
        r = t - x
        if r in d:
            return [d[r], i]
        d[x] = i
    return []`;

const bruteForce = `def two_sum(nums, target):
    for i in range(len(nums)):
        for j in range(i + 1, len(nums)):
            if nums[i] + nums[j] == target:
                return [i, j]
    return []`;

// ---------------------------------------------------------------- test 1
console.log("\n1. four hash-map solutions, different naming");
{
  const claims = [
    "A single pass with a dictionary of value to index is sufficient",
    "The complement is target minus the current value",
    "Indices must be returned in ascending order",
  ];
  const texts = [
    final({ answer: "Use a hash map in one pass; return the stored index and the current index.", claims, code: twoSumA }),
    final({ answer: "One pass with a dictionary of seen values returns the two indices.", claims, code: twoSumB }),
    final({ answer: "A single pass hash map lookup gives the pair of indices.", claims, code: twoSumC }),
    final({ answer: "Track seen values in a dict and return both indices in one pass.", claims, code: twoSumA }),
  ];
  const inputs = texts.map((t, i) => ({
    id: `a${i}`,
    name: ["GPT", "Kimi", "Claude", "Gemini"][i],
    final: parseFinal(t)!,
  }));
  check("all four parsed", inputs.every((i) => i.final && i.final.wellFormed));
  check("code extracted", inputs.every((i) => i.final.code.includes("def two_sum")));
  check("claims extracted", inputs[0].final.claims.length === 3, JSON.stringify(inputs[0].final.claims));
  check("confidence parsed", inputs[0].final.confidence === 0.93);
  const r = computeConsensus(inputs);
  console.log(`  -> ${r.verdict}: ${r.headline}`);
  check("unanimous", r.verdict === "unanimous", `groups=${JSON.stringify(r.groups)}`);
  check("one group", r.groups.length === 1);
}

// ---------------------------------------------------------------- test 2
console.log("\n2. three hash-map, one brute force with a different answer");
{
  const good = [
    "A single pass with a dictionary of value to index is sufficient",
    "The complement is target minus the current value",
  ];
  const bad = [
    "Every pair must be checked exhaustively",
    "Nested loops compare each element against the ones after it",
  ];
  const inputs = [
    { id: "a0", name: "GPT", final: parseFinal(final({ answer: "Use a hash map in one pass; return the stored index and current index.", claims: good, code: twoSumA }))! },
    { id: "a1", name: "Kimi", final: parseFinal(final({ answer: "One pass with a dictionary of seen values returns the two indices.", claims: good, code: twoSumB }))! },
    { id: "a2", name: "Claude", final: parseFinal(final({ answer: "A single pass hash map lookup gives the pair of indices.", claims: good, code: twoSumC }))! },
    { id: "a3", name: "Gemini", final: parseFinal(final({ answer: "Compare every pair with two nested loops until the sum matches.", claims: bad, code: bruteForce, complexity: "O(n^2) time, O(1) space" }))! },
  ];
  const r = computeConsensus(inputs);
  console.log(`  -> ${r.verdict}: ${r.headline}`);
  console.log(`     pairs: ${r.pairs.map((p) => `${p.a}/${p.b}=${p.score.toFixed(2)}`).join(" ")}`);
  check("majority", r.verdict === "majority", `groups=${JSON.stringify(r.groups)}`);
  check("gemini flagged as outlier", r.outliers.includes("a3"), JSON.stringify(r.outliers));
  check("representative is in the majority", ["a0", "a1", "a2"].includes(r.representative!));
}

// ---------------------------------------------------------------- test 3
console.log("\n3. research question, two-two split");
{
  const mk = (answer: string, claims: string[]) =>
    parseFinal(
      final({ kind: "research", lang: "n/a", answer, claims, code: "", complexity: "n/a" })
    )!;
  const inputs = [
    { id: "a0", name: "GPT", final: mk("The policy took effect in January and applies to all new contracts.", ["It took effect in January", "It applies to new contracts only"]) },
    { id: "a1", name: "Kimi", final: mk("It became effective in January and covers newly signed contracts.", ["Effective from January", "Covers newly signed contracts"]) },
    { id: "a2", name: "Claude", final: mk("The rule starts in July and is retroactive to existing agreements.", ["Starts in July", "Retroactive to existing agreements"]) },
    { id: "a3", name: "Gemini", final: mk("It begins in July and applies retroactively to agreements already signed.", ["Begins in July", "Applies retroactively to signed agreements"]) },
  ];
  const r = computeConsensus(inputs);
  console.log(`  -> ${r.verdict}: ${r.headline}`);
  check("split", r.verdict === "split", `groups=${JSON.stringify(r.groups)}`);
  check("two camps of two", r.groups.length === 2 && r.groups.every((g) => g.length === 2));
  check("no code axis used", r.pairs.every((p) => p.code === -1));
}

// ---------------------------------------------------------------- test 4
console.log("\n4. degraded inputs");
{
  const noBlock = `The answer is that you should memoize the recursion.

\`\`\`python
from functools import lru_cache

@lru_cache(None)
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
\`\`\`

Memoizing turns the exponential recursion into linear time.`;
  const p = parseFinal(noBlock)!;
  check("salvaged without a FINAL block", p !== null && !p.wellFormed);
  check("salvage found the code", p.code.includes("lru_cache"), p.code);
  check("salvage produced an answer", p.answer.length > 10, p.answer);

  const truncated = `Working on it...

<<<FINAL
KIND: code
LANGUAGE: rust
ANSWER: Sort the intervals by start, then merge overlapping ones in a single sweep.
CONFIDENCE: 0.8
CLAIMS:
- Sorting by start is required first`;
  const t = parseFinal(truncated)!;
  check("mid-stream block still parses", t.answer.startsWith("Sort the intervals"), t.answer);
  check("mid-stream marked not well formed", !t.wellFormed);
  check("mid-stream claim captured", t.claims.length === 1, JSON.stringify(t.claims));

  check("empty text returns null", parseFinal("") === null);

  const one = computeConsensus([{ id: "a0", name: "GPT", final: p }]);
  check("single answer is insufficient", one.verdict === "insufficient");
  check("zero answers is insufficient", computeConsensus([]).verdict === "insufficient");
}

// ---------------------------------------------------------------- test 5
console.log("\n5. one agent produced code, another did not");
{
  const withCode = parseFinal(final({ answer: "Reverse the list in place with two pointers.", claims: ["Two pointers converge from both ends"], code: "def rev(a):\n    i, j = 0, len(a) - 1\n    while i < j:\n        a[i], a[j] = a[j], a[i]\n        i += 1\n        j -= 1" }))!;
  const noCode = parseFinal(final({ answer: "Reverse the list in place with two pointers.", claims: ["Two pointers converge from both ends"], code: "" }))!;
  const r = computeConsensus([
    { id: "a0", name: "GPT", final: withCode },
    { id: "a1", name: "Kimi", final: noCode },
  ]);
  console.log(`  -> pair score ${r.pairs[0].score.toFixed(2)} (code axis ${r.pairs[0].code})`);
  check("missing code is scored as disagreement, not as a match", r.pairs[0].code === 0);
  check("identical prose alone does not clear the bar", r.verdict !== "unanimous", r.verdict);
}


// ---------------------------------------------------------------- test 6
console.log("\n6. same algorithm, nothing phrased alike (the realistic case)");
{
  const mk = (answer: string, claims: string[], code: string) =>
    parseFinal(final({ answer, claims, code }))!;
  const inputs = [
    {
      id: "a0",
      name: "GPT",
      final: mk(
        "Walk the array once and keep a dictionary from value to index.",
        ["A dictionary lookup is constant time", "One traversal is enough", "Return the earlier index first"],
        twoSumA
      ),
    },
    {
      id: "a1",
      name: "Kimi",
      final: mk(
        "Store each number you have already seen, then look for the missing addend.",
        ["Hashing avoids the quadratic scan", "Each element is visited exactly one time", "The stored position precedes the current one"],
        twoSumB
      ),
    },
    {
      id: "a2",
      name: "Claude",
      final: mk(
        "Keep a table of previously visited numbers and check for the complement.",
        ["A lookup table makes membership checks cheap", "A single sweep of the input suffices", "Output the older index before the newer"],
        twoSumC
      ),
    },
  ];
  const r = computeConsensus(inputs);
  console.log(`  -> ${r.verdict}: ${r.headline}`);
  console.log(`     pairs: ${r.pairs.map((p) => `${p.a}/${p.b}=${p.score.toFixed(2)} (ans ${p.answer.toFixed(2)} claims ${p.claims.toFixed(2)} code ${p.code.toFixed(2)})`).join("\n            ")}`);
  check("paraphrase does not break agreement", r.verdict === "unanimous", `groups=${JSON.stringify(r.groups)}`);
}


// ---------------------------------------------- the same idea, three languages

// Four agents all wrote the two-pointer scan for Trapping Rain Water, in
// different languages. Before the language check the code axis — 0.7 of the
// weight — compared `for i in range(n):` against `for (int i = 0; i < n; ++i)`
// and found nothing, so the panel reported "every agent produced a materially
// different answer" about four agents that entirely agreed.
{
  const shared = {
    kind: "code" as const,
    answer:
      "Two pointers with running left and right maxima; process whichever end is lower and add the running max minus the current bar.",
    complexity: "O(n) time, O(1) space",
    confidence: 0.99,
    claims: [
      "Each index is visited at most once, so the scan is linear.",
      "Water above a bar is bounded by the smaller of the two running maxima.",
    ],
    raw: "",
    wellFormed: true,
  };

  const python = {
    id: "a",
    name: "Kimi",
    final: {
      ...shared,
      language: "python",
      code: "def trap(h):\n    l, r = 0, len(h) - 1\n    lm = rm = out = 0\n    while l < r:\n        if h[l] <= h[r]:\n            lm = max(lm, h[l])\n            out += lm - h[l]\n            l += 1\n        else:\n            rm = max(rm, h[r])\n            out += rm - h[r]\n            r -= 1\n    return out",
    },
  };

  const cpp = {
    id: "b",
    name: "Claude",
    final: {
      ...shared,
      language: "c++17",
      code: "int trap(vector<int>& h) {\n  int l = 0, r = (int)h.size() - 1, lm = 0, rm = 0, out = 0;\n  while (l < r) {\n    if (h[l] <= h[r]) { lm = max(lm, h[l]); out += lm - h[l]; ++l; }\n    else { rm = max(rm, h[r]); out += rm - h[r]; --r; }\n  }\n  return out;\n}",
    },
  };

  const rust = {
    id: "c",
    name: "Gemini",
    final: {
      ...shared,
      language: "rust",
      code: "fn trap(h: Vec<i32>) -> i32 {\n    let (mut l, mut r) = (0usize, h.len() - 1);\n    let (mut lm, mut rm, mut out) = (0, 0, 0);\n    while l < r {\n        if h[l] <= h[r] { lm = lm.max(h[l]); out += lm - h[l]; l += 1; }\n        else { rm = rm.max(h[r]); out += rm - h[r]; r -= 1; }\n    }\n    out\n}",
    },
  };

  const mixed = computeConsensus([python, cpp, rust] as never, 0.55);
  check(
    "the same algorithm in three languages is one group",
    mixed.groups.length === 1,
    `${mixed.groups.length} camps: ${JSON.stringify(mixed.groups)}`
  );
  check("nobody is called an outlier for their language", mixed.outliers.length === 0, mixed.outliers.join(", "));
  check("and it does not read as total disagreement", mixed.verdict !== "none", mixed.verdict);

  // The guard must not paper over real disagreement that happens to cross
  // languages: a different algorithm is still a different algorithm.
  const bruteForce = {
    id: "d",
    name: "GPT",
    final: {
      ...shared,
      language: "python",
      answer: "For every bar, scan left and right for the tallest bar on each side and add the shortfall.",
      complexity: "O(n^2) time, O(1) space",
      claims: ["Each bar rescans the whole array, so the scan is quadratic."],
      code: "def trap(h):\n    out = 0\n    for i in range(len(h)):\n        lm = max(h[:i + 1])\n        rm = max(h[i:])\n        out += min(lm, rm) - h[i]\n    return out",
    },
  };
  const split = computeConsensus([cpp, rust, bruteForce] as never, 0.55);
  check(
    "a genuinely different approach still separates",
    split.groups.length > 1,
    `${split.groups.length} camps: ${JSON.stringify(split.groups)}`
  );
}

// Phase 3 regression suites run before the final test report.
// Phase 3: every group must have direct pairwise agreement, not a chained bridge.
// This invariant is independent of candidate ordering and forbids false unanimity.
{
  const mk = (answer: string) => ({ id: answer, name: answer, final: parseFinal(final({ answer, claims: [answer], code: "" }))! });
  const inputs = [mk("one two three four five"), mk("one two three five six"), mk("five six seven eight nine")];
  const result = computeConsensus(inputs, 0.55);
  for (const group of result.groups) {
    for (let i=0; i<group.length; i++) for (let j=i+1; j<group.length; j++) {
      const pair = result.pairs.find(p => (p.a===group[i] && p.b===group[j]) || (p.b===group[i] && p.a===group[j]));
      check("no chained agreement without pair support", Boolean(pair && pair.score>=0.55));
    }
  }
}


// Invalid thresholds, duplicate agent IDs, and empty identities must never
// produce a misleading unanimous or majority decision.
{
  const mk = (id: string, answer: string) => ({
    id, name: id, final: parseFinal(final({ answer, claims: [answer], code: "" }))!,
  });
  const valid = [mk("a", "Choose the first solution."), mk("b", "Choose the second solution.")];
  for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
    let rejected = false;
    try { computeConsensus(valid, threshold); } catch (e) { rejected = e instanceof RangeError; }
    check("reject invalid consensus threshold", rejected, String(threshold));
  }
  for (const invalid of [[mk("a", "first"), mk("a", "second")], [mk("", "first"), mk("b", "second")]]) {
    let rejected = false;
    try { computeConsensus(invalid); } catch { rejected = true; }
    check("reject invalid agent identity", rejected);
  }
  const zero = computeConsensus(valid, 0);
  check("explicit threshold zero is supported", zero.verdict === "unanimous");
  const strict = computeConsensus(valid, 1);
  check("strict threshold does not manufacture unanimity", strict.groups.length > 1);
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
