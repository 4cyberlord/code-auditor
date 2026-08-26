import {
  COUNCIL_DEFAULT_JUDGES,
  COUNCIL_DEFAULT_MODELS,
  councilMarkdown,
  candidateDocket,
  candidateLanguage,
  countCases,
  executionDigest,
  gateFor,
  parseReviewSet,
  parseTestSuites,
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
  check("eight default solvers", COUNCIL_DEFAULT_MODELS.length === 8, String(COUNCIL_DEFAULT_MODELS.length));
  check("seven default judges", COUNCIL_DEFAULT_JUDGES.length === 7, String(COUNCIL_DEFAULT_JUDGES.length));
  check(
    "every judge has an emphasis",
    COUNCIL_DEFAULT_JUDGES.every((j) => j.emphasis.length > 0)
  );
  check(
    "every default solver is reachable on the gateway",
    COUNCIL_DEFAULT_MODELS.every((m) => m.id.includes("/"))
  );
  check(
    "codex is benched by default; 5.6-sol is on the responses wire",
    !COUNCIL_DEFAULT_MODELS.some((m) => m.id === "openai/gpt-5.3-codex") &&
      COUNCIL_DEFAULT_MODELS.find((m) => m.id === "openai/gpt-5.6-sol")?.endpoint === "responses"
  );
}

console.log(fail ? `\n${fail} FAILURES\n` : "\nall council checks passed\n");
process.exit(fail ? 1 : 0);
