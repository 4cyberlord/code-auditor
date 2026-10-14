import { needsCandidateRevision } from "../src/lib/revisionPolicy.ts";
import type { CandidateReview, CandidateRun } from "../src/lib/council.ts";

let failures = 0;
const check = (name: string, value: boolean) => {
  console.log(`  ${value ? "ok  " : "FAIL"} ${name}`);
  if (!value) failures++;
};

const review = (correct: CandidateReview["correct"], problems: string): CandidateReview => ({
  letter: "A", reviewer: "reviewer", correct, problems, time: "", space: "", quality: "",
});
const passing = (): CandidateRun => ({
  letter: "A", ran: true, ok: true, passed: 3, failed: 0, durationMs: 10, note: "", runtime: "node",
});
const failing = (): CandidateRun => ({ ...passing(), ok: false, failed: 1, note: "exit 1" });

console.log("\nadaptive revision policy");
check("a failed execution is always repaired", needsCandidateRevision(failing(), []));
check("a clean passing review does not trigger redundant work", !needsCandidateRevision(passing(), [review("yes", "none")]));
check("an incorrect review triggers a repair", needsCandidateRevision(passing(), [review("no", "off-by-one at the boundary")]));
check("a substantive uncertain review triggers a repair", needsCandidateRevision(passing(), [review("unsure", "overflow case is not justified")]));
check("an empty uncertain review does not manufacture work", !needsCandidateRevision(passing(), [review("unsure", "")]));

process.exit(failures ? 1 : 0);
