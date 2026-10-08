import { routeProblem, routingGuidance, reconcileProblemReadings } from "../src/lib/problemRouting.ts";
import { EMPTY_EXTRACTION, renderForReasoning, readingMarkdown, type Extraction } from "../src/lib/extraction.ts";

const ex = (summary: string, changes: Partial<Extraction> = {}): Extraction =>
  ({ ...EMPTY_EXTRACTION, confidence: 0.96, problemSummary: summary, ...changes });
const check = (label: string, condition: boolean) => {
  if (!condition) throw new Error("FAIL: " + label);
  console.log("PASS:", label);
};
const simple = routeProblem(ex("Given an array of integers, return the sum."));
check("simple text uses standard routing", simple.path === "standard" && simple.families.includes("array"));
const diagram = routeProblem(ex("Binary tree inorder traversal", { observations: ["Diagram shows a tree image with edges connecting nodes."] }));
check("diagram triggers visual review", diagram.path === "visual_review" && diagram.needsVisualStructure);
const dubious = routeProblem(ex("Read the matrix", { ambiguities: ["Symbol Σ may be cropped"] }));
check("unclear symbols trigger ambiguity review", dubious.path === "ambiguity_review");
const bst = routeProblem(ex("Delete a node from a BST. Another valid output is accepted."));
check("multiple valid BST outputs use property checks", bst.verification === "property_validator");
const inter = routeProblem(ex("Interactive problem: query the judge."));
check("interactive problems need specialized verification", inter.verification === "specialized_validator");
const unknown = routeProblem(ex("Solve this task."));
check("unseen algorithms are not force-labeled", unknown.families.join(",") === "other");
check("routing advice reaches text-only solvers", renderForReasoning(ex("Delete node from BST. Another valid output is accepted.")).includes("Validate required properties"));
check("route records source uncertainty", routingGuidance(dubious).includes("do not invent missing notation"));

const left = ex("Delete a node in a BST. Another valid output is accepted.", {
  observations: ["Shown above: tree image with edges connecting nodes"]
});
const right = ex("Delete a node in a BST. Another valid output is accepted.");
const compared = reconcileProblemReadings([left, right]);
check("missing diagram observation escalates to ambiguous review", compared.path === "ambiguity_review");
check("multiple valid answers retain property verification", compared.verification === "property_validator");
check("multiple readers preserve tree classification", compared.families.includes("tree"));
const altered = reconcileProblemReadings([
  ex("Repair array", { code: "return x + 1" }),
  ex("Repair array", { code: "return x - 1" })
]);
check("different code transcriptions require adjudication", altered.disagreements.some(s => s.includes("code")));
const absent = reconcileProblemReadings([]);
check("missing readers fail closed to review", absent.path === "ambiguity_review");

const record = readingMarkdown(left, {readers:["vision-a","vision-b"], agreement:null,
  independentReadings:[left,right]});
check("live reading document includes adaptive routing plan", record.includes("Problem understanding and verification plan"));
check("live reading document includes reader disputes", record.includes("Reader disagreements requiring source-image review"));
check("live reading advises source recheck", record.includes("Recheck the source image"));
const ordinaryRecord = readingMarkdown(ex("Compute a sum of an array"), {readers:["one"],agreement:null});
check("simple reading receives routing context", ordinaryRecord.includes("Reading path: standard"));
