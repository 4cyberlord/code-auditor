import { classifyCandidateRun, needsCandidateRevision } from "../src/lib/revisionPolicy.ts";
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
check("a harness failure does not trigger a code rewrite", !needsCandidateRevision({
  ...failing(), failed: 0, failureKind: "harness",
}, []));
check("an infrastructure failure does not trigger a code rewrite", !needsCandidateRevision({
  ...failing(), ran: false, failed: 0, failureKind: "infrastructure",
}, []));
check("a concrete candidate failure remains repairable", needsCandidateRevision({
  ...failing(), failureKind: "candidate",
}, []));

const mapped = classifyCandidateRun({
  ...failing(), stderr: 'Traceback (most recent call last):\n  File "main.py", line 12, in solve\nValueError: bad',
}, { startLine: 10, endLine: 14 });
check("candidate errors are classified and mapped to their submitted source line",
  mapped.failureKind === "candidate" && mapped.failureLocation?.sourceLine === 3);
const harness = classifyCandidateRun({
  ...failing(), failed: 0, passed: 0, stderr: '  File "main.py", line 3, in <module>\nSyntaxError: bad harness',
}, { startLine: 10, endLine: 14 });
check("errors outside the inserted solution are classified as harness failures",
  harness.failureKind === "harness" && harness.failureLocation === null);

process.exit(failures ? 1 : 0);
