import { routeProblem, routingGuidance, reconcileProblemReadings, selectContractReaders, routeUnparsedProblem, rankSolversForProblem } from "../src/lib/problemRouting.ts";
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

const roster=[{id:"text-only"},{id:"google/gemini-3.7-flash"},{id:"openai/gpt-5.6-sol"}];
const order=["openai/gpt-5.6-sol","google/gemini-3.7-flash"];
check("complex visual problems prefer capable configured readers",selectContractReaders(roster,r=>r.id,true,order)[0].id==="openai/gpt-5.6-sol");
check("ordinary problems retain roster order",selectContractReaders(roster,r=>r.id,false,order)[0].id==="text-only");
check("no unconfigured models are introduced",selectContractReaders(roster.slice(0,2),r=>r.id,true,order)[0].id==="text-only");

const edgesA = ex("Find paths in this graph diagram.", {
  observations: ["Diagram with nodes.", "RELATION: A -> B", "RELATION: B -> C"]
});
const edgesB = ex("Find paths in this graph diagram.", {
  observations: ["Diagram with nodes.", "RELATION: A -> B", "RELATION: B -> D"]
});
const relationMismatch = reconcileProblemReadings([edgesA,edgesB]);
check("different diagram edges trigger review", relationMismatch.path === "ambiguity_review"
  && relationMismatch.disagreements.some(d=>d.includes("diagram relationships")));
const missingEdge = reconcileProblemReadings([edgesA,ex("Find paths in this graph diagram.",{ observations:["Diagram with nodes."] })]);
check("omitted diagram edges trigger review", missingEdge.disagreements.some(d=>d.includes("diagram relationships")));
const sameEdges = reconcileProblemReadings([edgesA,ex("Find paths in this graph diagram.",{
  observations:["Diagram with nodes.", "relation:  b  -> c", "relation: a -> b"]
})]);
check("relation comparison ignores order and spacing", !sameEdges.disagreements.some(d=>d.includes("diagram relationships")));

check("images without extraction require ambiguity review", routeUnparsedProblem("Solve this", true).path === "ambiguity_review");
check("plain text with no screenshot retains fast path", routeUnparsedProblem("Sum an array", false).path === "standard");

const existing=[{id:"solver-a"},{id:"solver-b"},{id:"solver-c"}];
const arrayTask=routeProblem(ex("Return an array prefix sum."));
const evidence=[
  {model:"solver-a",families:["array" as const],executed:10,verified:5},
  {model:"solver-b",families:["array" as const],executed:10,verified:9},
  {model:"solver-c",families:["graph" as const],executed:30,verified:30},
];
check("relevant verified history outranks roster position",
  rankSolversForProblem(existing.slice(0,2),m=>m.id,arrayTask,evidence)[0].id==="solver-b");
check("unrelated benchmark history does not reassign solvers",
  rankSolversForProblem(existing,m=>m.id,arrayTask,evidence.slice(2)).map(m=>m.id).join(",")==="solver-a,solver-b,solver-c");
check("few observations are too weak to change routing",
  rankSolversForProblem(existing.slice(0,2),m=>m.id,arrayTask,[{model:"solver-b",families:["array"],executed:1,verified:1}])[0].id==="solver-a");
check("cannot introduce unconfigured models",
  rankSolversForProblem(existing.slice(0,1),m=>m.id,arrayTask,evidence).length===1);

const interleaved=[{id:"solver-a"},{id:"unmeasured"},{id:"solver-b"}];
const selected=rankSolversForProblem(interleaved,m=>m.id,arrayTask,evidence);
check("unmeasured model stays in its original slot",selected[1].id==="unmeasured");
check("measured solver reorder is deterministic around unknown seats",selected[0].id==="solver-b" && selected[2].id==="solver-a");
check("combined samples are used instead of best batch",
 rankSolversForProblem(existing.slice(0,2),m=>m.id,arrayTask,[
 {model:"solver-a",families:["array"],executed:5,verified:5},
 {model:"solver-a",families:["array"],executed:5,verified:0},
 {model:"solver-b",families:["array"],executed:10,verified:8}
 ])[0].id==="solver-b");
check("invalid sample threshold disables reranking",rankSolversForProblem(existing,m=>m.id,arrayTask,evidence,0)[0].id==="solver-a");
