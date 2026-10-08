import {
  COUNCIL_DEFAULT_JUDGES,
  COUNCIL_DEFAULT_MODELS,
  councilMarkdown,
  candidateDocket,
  candidateLanguage,
  countCases,
  executionDigest,
  gateFor,
  selectVerifiedCandidate,
  decideWinner,
  parseReviewSet,
  parseTestSuites,
  parseCouncilSynthesis,
  parseJudgeReport,
  parseProblemContract,
  mergeProblemContracts,
  contractBlock,
  contractQuery,
  reviseUserPrompt,
  buildPresentation,
  mutateCode,
  oracleSuspicion,
  oracleDigest,
  reviewsOf,
  spliceSuite,
  type Candidate,
  type CandidateRun,
} from "../src/lib/council.ts";
import type { AgentFinal } from "../src/lib/parse.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const FINAL = (answer: string, code = "", language = "python"): AgentFinal => ({
  kind: code ? "code" : "research",
  language,
  answer,
  complexity: "O(n)",
  confidence: 0.9,
  claims: ["it works"],
  code,
  raw: `<<<FINAL\nKIND: ${code ? "code" : "research"}\nANSWER: ${answer}\nCODE:\n\`\`\`${language}\n${code}\n\`\`\`\nFINAL>>>`,
  wellFormed: true,
});

const cand = (letter: string, f: AgentFinal | null, model = `m-${letter}`): Candidate => ({
  letter,
  model,
  final: f,
  text: f?.raw ?? "",
  error: f ? null : "boom",
});

console.log("\n1. candidates are anonymised by letter, never by name");
{
  const field = [cand("A", FINAL("one")), cand("B", FINAL("two"))];
  const docket = candidateDocket(field);
  check("letters present", docket.includes("Candidate A") && docket.includes("Candidate B"));
  check("model names absent", !docket.includes("m-A") && !docket.includes("m-B"), docket.slice(0, 200));
  const revisedField = [{ ...field[0], revised: FINAL("one-improved") }, field[1]];
  check("revision marked", candidateDocket(revisedField, { revised: true }).includes("Candidate A (revised)"));
}

console.log("\n2. a review block parses into stanzas with top-level calls");
{
  const text = `Here is my review.

<<<REVIEWS
BEST: B
WORST: A
CANDIDATE: A
CORRECT: no
PROBLEMS: quadratic loop blows up at n=10^5 and the
second half of the sentence continues here
TIME: O(n^2)
SPACE: O(1)
QUALITY: readable but slow
CANDIDATE: B
CORRECT: yes
PROBLEMS: none
TIME: O(n)
SPACE: O(n)
QUALITY: clean
REVIEWS>>>`;
  const rs = parseReviewSet(text, "kimi-k3");
  check("well formed", rs.wellFormed);
  check("best and worst", rs.best === "B" && rs.worst === "A", `${rs.best}/${rs.worst}`);
  check("two stanzas", rs.reviews.length === 2, String(rs.reviews.length));
  check("wrapped problem line folded", rs.reviews[0].problems.includes("continues here"), rs.reviews[0].problems);
  check("correctness parsed", rs.reviews[0].correct === "no" && rs.reviews[1].correct === "yes");

  const junk = parseReviewSet("no block at all", "gpt");
  check("missing block is declared malformed", !junk.wellFormed && junk.reviews.length === 0);
}

console.log("\n3. a solver sees only the reviews addressed to it");
{
  const rs = parseReviewSet(
    `<<<REVIEWS\nBEST: A\nCANDIDATE: A\nCORRECT: yes\nPROBLEMS: none\nEND\nCANDIDATE: B\nCORRECT: no\nPROBLEMS: wrong on duplicates\nEND\nREVIEWS>>>`,
    "r1"
  );
  check("A gets one", reviewsOf([rs], "A").length === 1);
  check("B gets the criticism", reviewsOf([rs], "B")[0].problems.includes("duplicates"));
  check("C gets nothing", reviewsOf([rs], "C").length === 0);
}

console.log("\n4. the test-spec block parses, harnesses must carry the splice marker");
{
  const spec = `<<<TESTS
HARNESS: python
\`\`\`python
<<<SOLUTION>>>
def check(name, got, want):
    print(("PASS " if got == want else f"FAIL {name} got={got} want={want}"), name)

cases = [(([2,7,11,15], 9), [0,1]), (([3,3], 6), [0,1]), (([], 0), [])]
for args, want in cases:
    got = twoSum(*args)
    name = str(args)
    print(("PASS " if got == want else f"FAIL got={got} want={want} ") + name)
\`\`\`
HARNESS: javascript
\`\`\`javascript
// no marker in this one
console.log("PASS x");
\`\`\`
TESTS>>>`;
  const suites = parseTestSuites(spec);
  check("one suite (the markerless one is refused)", suites.length === 1, String(suites.length));
  check("language picked up", suites[0]?.language === "python");

  const noBlock = parseTestSuites("nothing here");
  check("no block, no suites, no crash", noBlock.length === 0);
}

console.log("\n5. splicing puts the candidate's code at the marker, verbatim");
{
  const h = "def run():\n<<<SOLUTION>>>\nprint('done')";
  const out = spliceSuite({ language: "python", harness: h }, "x = 1\nx += 1");
  check("spliced", out !== null && out.includes("x += 1") && !out.includes("<<<SOLUTION>>>"));
  check("no marker, no splice", spliceSuite({ language: "python", harness: "x=1" }, "y=2") === null);
}

console.log("\n6. PASS/FAIL counting, and the gate that outranks opinion");
{
  check("mixed", JSON.stringify(countCases("PASS a\nFAIL b got=1\nPASS c")) === JSON.stringify({ passed: 2, failed: 1 }));
  check("junk counts nothing", countCases("hello world").passed === 0);

  const run = (p: Partial<CandidateRun>): CandidateRun => ({
    letter: "A", ran: true, ok: true, passed: 0, failed: 0, durationMs: 5, note: "", runtime: "python3", ...p,
  });
  check("clean run passes the gate", gateFor(run({ passed: 9 })) === "pass");
  check("a failure rejects", gateFor(run({ passed: 9, failed: 1 })) === "fail");
  check("nonzero exit with no FAIL lines still fails", gateFor(run({ passed: 3, ok: false, note: "exit 1" })) === "fail");
  check("exit 0 printing nothing proves nothing", gateFor(run({ passed: 0 })) === "untested");
  check("never executed is untested", gateFor(run({ ran: false })) === "untested");
  check("no record is untested", gateFor(undefined) === "untested");
}

console.log("\n7. the execution digest the reviewers read");
{
  const field = [cand("A", FINAL("a", "x=1")), cand("B", FINAL("b", "y=2"))];
  const runs: Record<string, CandidateRun> = {
    A: { letter: "A", ran: true, ok: true, passed: 5, failed: 0, durationMs: 12, note: "", runtime: "python3" },
    B: { letter: "B", ran: true, ok: false, passed: 3, failed: 2, durationMs: 12, note: "exit 1", runtime: "python3" },
  };
  const d = executionDigest(field, runs);
  check("passed reads as passed", d.includes("ALL PASSED"));
  check("a rejected candidate is labelled rejected", d.includes("FAILED") && d.includes("[GATE: rejected]"));
  check("no model names leak into the digest", !d.includes("m-A") && !d.includes("m-B"));
}

console.log("\n8. language normalisation and the report");
{
  check("js aliases", candidateLanguage(FINAL("x", "y", "js")) === "javascript");
  check("py aliases", candidateLanguage(FINAL("x", "y", "python")) === "python");
  check("case folded", candidateLanguage(FINAL("x", "y", "Python")) === "python");

  const report = councilMarkdown({
    candidates: [cand("A", FINAL("a"), "claude-opus-5")],
    suites: [],
    runs: { A: { letter: "A", ran: true, ok: true, passed: 4, failed: 0, durationMs: 8, note: "", runtime: "node 22" } },
    revisedRuns: {},
    reviews: [parseReviewSet("<<<REVIEWS\nBEST: A\nCANDIDATE: A\nCORRECT: yes\nPROBLEMS: none\nEND\nREVIEWS>>>", "kimi-k3")],
    judges: [{ model: "gpt-5.6-sol", emphasis: "performance", text: "t", error: null }],
    synthesis: "VERDICT: fine\nWINNER: A",
    winner: "A",
  });
  check("mentions the winner", report.includes("Winner: **A**"));
  check("mentions the gate", report.includes("round 1 pass"));
}

console.log("\n9. defaults hold the shape the design specifies");
{
  check("four default solvers", COUNCIL_DEFAULT_MODELS.length === 4, String(COUNCIL_DEFAULT_MODELS.length));
  check("two default judges", COUNCIL_DEFAULT_JUDGES.length === 2, String(COUNCIL_DEFAULT_JUDGES.length));
  check(
    "every judge has an emphasis",
    COUNCIL_DEFAULT_JUDGES.every((j) => j.emphasis.length > 0)
  );
  check(
    "every default solver is reachable on the gateway",
    COUNCIL_DEFAULT_MODELS.every((m) => m.id.includes("/"))
  );
  check(
    "the requested solver roster is installed",
    COUNCIL_DEFAULT_MODELS.map((m) => m.id).join(",") ===
      "moonshotai/kimi-k3,z-ai/glm-5.3,x-ai/grok-4.6,google/gemini-3.7-flash"
  );
  check(
    "the requested judge roster is installed",
    COUNCIL_DEFAULT_JUDGES.map((j) => `${j.model}/${j.emphasis}`).join(",") ===
      "openai/gpt-5.6-sol/performance,anthropic/claude-opus-5/security"
  );
}

console.log("\n8. the synthesis parses into fields, code included");
{
  const text = `Thinking about it first.

VERDICT: A is the only verified answer
WINNER: A
REJECTED: B - failed two cases
EVIDENCE: A passed 19/19 in 41ms
APPROACH: one pass with a hash map
FINAL ANSWER: Ship A, corrected for the empty case:

\`\`\`python
def solve(xs):
    # Complexity: O(n) - a label-shaped line inside the code
    return len(xs)
\`\`\`
`;
  const parsed = parseCouncilSynthesis(text);
  check("winner read", parsed.winner === "A", parsed.winner);
  check("approach read", parsed.approach.includes("hash map"), parsed.approach);
  check("evidence read", parsed.evidence.includes("19/19"), parsed.evidence);
  check("rejected read", parsed.rejected.includes("failed two cases"), parsed.rejected);
  check("preamble kept out of the fields", parsed.preamble.startsWith("Thinking"), parsed.preamble);
  check("code lifted out of the final answer", parsed.code.includes("return len(xs)"), parsed.code);
  check("language read from the fence", parsed.language === "python", parsed.language);
  // The reason the parser tracks fences at all: a comment inside shipped code
  // reads exactly like a section header, and cutting there truncates the answer.
  check("a label inside the code did not split the answer", parsed.code.includes("Complexity: O(n)"), parsed.code);
}

console.log("\n9. WINNER: NONE is not a letter");
{
  const parsed = parseCouncilSynthesis("VERDICT: nothing survived\nWINNER: NONE (all gate-rejected)\nFINAL ANSWER: none");
  check("no winner recorded", parsed.winner === "", parsed.winner);
  check("but the report still parsed", parsed.wellFormed);
}

console.log("\n10. a judge report parses into a ranking");
{
  const judge = parseJudgeReport(
    "VERDICT: B is strongest\n**RANKING:** B > A > C\nCORRECT: A, B\nWHY: B is O(n)\nDEFECTS: C overflows\nBEST ANSWER: ship B"
  );
  check("ranking in order", judge.ranking.join("") === "BAC", judge.ranking.join(""));
  check("correct letters read", judge.correct.join("") === "AB", judge.correct.join(""));
  check("bolded labels survive", judge.verdict.includes("B is strongest"), judge.verdict);
  check("defects read", judge.defects.includes("overflows"), judge.defects);
}

console.log("\n11. two readings of a problem become one contract");
{
  const block = (sig: string, cons: string) => `<<<CONTRACT
KIND: code
LANGUAGES: python, javascript
SIGNATURE: ${sig}
INPUTS: xs, a list of ints
OUTPUTS: the count
CONSTRAINTS: ${cons}
EXAMPLES: [] -> 0
EDGE CASES: empty list
COMPLEXITY: O(n) time
UNKNOWNS: none
CONTRACT>>>`;
  const a = parseProblemContract(block("def solve(xs)", "0 <= len(xs) <= 1e5"));
  const b = parseProblemContract(block("def solve(xs)", "0 <= len(xs) <= 1e5"));
  check("the contract parsed", a.wellFormed && a.kind === "code", a.kind);
  check("languages normalised", a.languages.join(",") === "python,javascript", a.languages.join(","));
  const agreed = mergeProblemContracts([a, b]);
  check("agreement is the quiet case", agreed.agreement.agree && agreed.contract?.signature === "def solve(xs)");

  const c = parseProblemContract(block("def solve(xs, k)", "1 <= len(xs) <= 1e9"));
  const disputed = mergeProblemContracts([a, c]);
  check("a disagreement is not averaged away", disputed.agreement.agree === false);
  check(
    "and it is carried where every prompt reads it",
    disputed.contract!.unknowns.includes("disagreed") &&
      contractBlock(disputed.contract).includes("UNDETERMINED"),
    disputed.contract!.unknowns
  );
  check("an unreadable contract is nothing, not a guess", mergeProblemContracts([parseProblemContract("no block here")]).contract === null);
}

console.log("\n12. a harness that passes a broken program is suspect");
{
  const mutated = mutateCode("def solve(xs):\n    if len(xs) < 2:\n        return 0\n    return len(xs)");
  check("something was broken", mutated.applied && mutated.code.includes("> 2"), mutated.code);
  const survived = [{ kind: "mutation" as const, letter: "A", ran: true, survived: true, description: mutated.description, note: "" }];
  const caught = [{ kind: "mutation" as const, letter: "A", ran: true, survived: false, description: mutated.description, note: "" }];
  check("survival raises doubt", oracleSuspicion(survived).includes("unproven"), oracleSuspicion(survived));
  check("being caught raises none", oracleSuspicion(caught) === "", oracleSuspicion(caught));
  check("either way it is written down", oracleDigest(caught).includes("correctly rejected"), oracleDigest(caught));
  // A doubt about the measurement is not a verdict about the thing measured:
  // nothing here promotes or demotes a candidate.
  check("nothing about a candidate changed", !oracleSuspicion(survived).includes("winner"));
}

console.log("\n13. the presentation explains the answer without another model call");
{
  const field: Candidate[] = [
    { ...cand("A", FINAL("count them", "def solve(xs): return len(xs)")), revised: FINAL("count them, fixed", "def solve(xs): return len(xs)") },
    cand("B", FINAL("count them slowly", "def solve(xs): return sum(1 for _ in xs)")),
  ];
  const mkRun = (letter: string, over: Partial<CandidateRun>): CandidateRun => ({
    letter,
    ran: true,
    ok: true,
    passed: 19,
    failed: 0,
    durationMs: 41,
    note: "",
    runtime: "node 22",
    ...over,
  });
  const presentation = buildPresentation({
    candidates: field,
    suites: [],
    runs: { A: mkRun("A", { ok: false, passed: 17, failed: 2 }), B: mkRun("B", {}) },
    revisedRuns: { A: mkRun("A", {}) },
    reviews: [],
    judges: [],
    synthesis: "",
    winner: "A",
    dossier: {
      synthesis: parseCouncilSynthesis("WINNER: A\nREJECTED: B - slower\nAPPROACH: one pass\nFINAL ANSWER: ship A"),
      judges: [
        { model: "j-1", emphasis: "correctness", ...parseJudgeReport("RANKING: A, B\nCORRECT: A") },
        { model: "j-2", emphasis: "performance", ...parseJudgeReport("RANKING: B, A\nCORRECT: B") },
      ],
      tally: [],
      winnerSource: "synthesis",
      disagreement: "",
    },
  });
  check("standing is verified", presentation.standing === "verified", presentation.standing);
  // The revised run is the one that was judged; round one's failure belongs to a
  // program nobody shipped.
  check("A is shown by its revision", presentation.evidence[0].revised && presentation.evidence[0].gate === "pass", JSON.stringify(presentation.evidence[0]));
  check("provenance names the model after the gate", presentation.provenance.includes("m-A"), presentation.provenance);
  check("the dissenting judge is on the record", presentation.dissent.some((d) => d.includes("j-2")), JSON.stringify(presentation.dissent));
  check("the rejection reason survives", presentation.rejected.join(" ").includes("slower"), JSON.stringify(presentation.rejected));
  check("there is code to paste", presentation.code.includes("len(xs)"), presentation.code);
}

console.log("\n14. the contract is retrieval material, and revision finally gets the library");
{
  const contract = parseProblemContract(`<<<CONTRACT
KIND: code
LANGUAGES: python
SIGNATURE: def median(a, b)
INPUTS: two sorted arrays
OUTPUTS: the median as a float
CONSTRAINTS: 0 <= len(a) + len(b) <= 2000
EXAMPLES: [1,3],[2] -> 2.0
EDGE CASES: one array empty
COMPLEXITY: O(log(m+n)) required
UNKNOWNS: none
CONTRACT>>>`);
  const query = contractQuery(contract);
  // What the library is searched with: the problem's own words, available
  // before a single solver has written anything.
  check("the query carries the shape of the problem", query.includes("def median(a, b)") && query.includes("O(log(m+n))"), query);
  check("and not the block's own furniture", !query.includes("CONTRACT") && !query.includes("KIND"), query);
  check("an unreadable contract searches for nothing", contractQuery(parseProblemContract("nothing here")) === "");

  const revise = reviseUserPrompt({
    question: "median of two sorted arrays",
    letter: "A",
    ownRaw: "<<<FINAL ... FINAL>>>",
    docket: "### Candidate A",
    received: "- [m-b] correct: no. off by one",
    execution: "Candidate A: FAILED",
    knowledge: "Binary search on the shorter array partitions both halves.",
  });
  check("the revising solver is handed the library", revise.includes("Local Knowledge/RAG"), revise.slice(0, 200));
  check("and it still gets everything it had before", revise.includes("off by one") && revise.includes("Candidate A"));
  check(
    "no knowledge means no empty section",
    !reviseUserPrompt({
      question: "q",
      letter: "A",
      ownRaw: "raw",
      docket: "d",
      received: "r",
      execution: "e",
    }).includes("Local Knowledge/RAG")
  );
}


{
  const run = (letter: string, passed: number, failed = 0, ms: number | null = null): CandidateRun =>
    ({ letter, ran: true, ok: failed === 0, passed, failed, remoteElapsedMs: ms } as CandidateRun);
  const ranking = selectVerifiedCandidate({
    A: run("A", 7, 3, 5),
    B: run("B", 10, 0, 12),
    C: run("C", 8, 0, 4),
  });
  check("verified minority beats failed majority", ranking.winner === "B");
  check("failed candidates are ineligible", ranking.eligible.join(",") === "B,C");
  const tied = selectVerifiedCandidate({ B: run("B", 10, 0, 8), A: run("A", 10, 0, 5) });
  check("runtime evidence resolves equal passing coverage", tied.winner === "A");
  const noTests = selectVerifiedCandidate({ A: run("A", 0, 0, 0) });
  check("zero passed tests is not verification", noTests.winner === null);
  const allFailed = selectVerifiedCandidate({ A: run("A", 1, 1) });
  check("failed execution cannot win", allFailed.winner === null);
  const unexecuted = selectVerifiedCandidate({});
  check("missing evidence never implies verified", unexecuted.winner === null);
}


// Phase 5: synthesis and judges cannot override real executable evidence.
{
  const run = (letter: string, passed: number, failed = 0) =>
    ({ letter, ran: true, ok: failed === 0, passed, failed } as CandidateRun);
  const result = decideWinner({ claimed: "A", judges: [], runs: {
    A: run("A", 9, 1), B: run("B", 10), C: run("C", 8),
  }, letters: ["A","B","C"] });
  check("verified minority is the actual Council winner", result.winner === "B");
  check("selection is labeled evidence-derived", result.source === "evidence");
  const noWinner = decideWinner({ claimed: "A", judges: [], runs: { A: run("A", 0, 1) }, letters: ["A"] });
  check("no execution success means no winner", noWinner.winner === "");
  const reasoning = decideWinner({ claimed: "A", judges: [], runs: {}, letters: ["A"] });
  check("research or MCQ without execution can keep synthesis", reasoning.winner === "A");
}

console.log(fail ? `\n${fail} FAILURES\n` : "\nall council checks passed\n");
process.exit(fail ? 1 : 0);
