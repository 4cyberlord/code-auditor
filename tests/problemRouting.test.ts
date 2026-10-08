import { routeProblem, routingGuidance } from "../src/lib/problemRouting.ts";
import { EMPTY_EXTRACTION, renderForReasoning, type Extraction } from "../src/lib/extraction.ts";

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
