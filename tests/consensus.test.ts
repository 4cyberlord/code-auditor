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

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
