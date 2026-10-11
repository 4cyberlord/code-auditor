import { detectMcq, normalizeMcqEndpoint, normalizeOverlayMode, parseMcqAnswer, resolveMcqSelection, formatMcqSelection } from "../src/lib/mcq.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

console.log("\n1. MCQ detection");
{
  const lettered = detectMcq("Which value is returned?\nA. 18\nB. 9\nC. 27\nD. 0");
  check("A/B/C/D options detected", lettered.isMcq, JSON.stringify(lettered));
  check("question captured before options", lettered.question.includes("Which value"));

  const parens = detectMcq("Select the safest option\n(A) Cache\n(B) Delete\n(C) Retry");
  check("(A) option format detected", parens.isMcq, JSON.stringify(parens));

  const numeric = detectMcq("What is 18 + 9?\n1) 18\n2) 9\n3) 27\n4) 0");
  check("numeric option format detected", numeric.isMcq, JSON.stringify(numeric));

  const coding = detectMcq("Write a function sum(a, b) that returns a + b.\nInput: two numbers\nOutput: one number");
  check("coding prompt does not become MCQ", !coding.isMcq, JSON.stringify(coding));
}

console.log("\n2. MCQ answer parsing and normalization");
{
  const parsed = parseMcqAnswer(JSON.stringify({
    kind: "mcq",
    question: "What is 18 + 9?",
    options: [{ label: "A", text: "18" }, { label: "B", text: "27" }],
    answer: { label: "B", text: "27" },
    reason: "18 + 9 equals 27.",
    whyNot: [{ label: "A", reason: "18 ignores the 9." }],
    knowledgeUsed: true,
    model: "anthropic/claude-fable-5",
  }));
  check("JSON answer parses", parsed?.answer.label === "B");
  check("why-not survives", parsed?.whyNot[0]?.label === "A");
  check("overlay mode normalizes", normalizeOverlayMode("mcq") === "mcq" && normalizeOverlayMode("bad") === "auto");
  check("endpoint normalizes", normalizeMcqEndpoint("responses") === "responses" && normalizeMcqEndpoint("bad") === "auto");
}

{
  const detected = detectMcq("Q1. Which follows FIFO?\nA. Stack\nB. Tree\nC. Queue\nD. Graph");
  const original = parseMcqAnswer('{"answer":{"label":"C","text":"Queue"},"reason":"FIFO"}')!;
  const resolved = resolveMcqSelection(original,detected);
  check("Q1 option mapping",!!resolved && formatMcqSelection(resolved)==="✅ C (3rd Option) - Queue");
  check("reject conflicting option text",resolveMcqSelection({...original,answer:{label:"C",text:"Stack"}},detected)===null);
  check("reject fabricated option",resolveMcqSelection({...original,answer:{label:"H",text:"fake"}},detected)===null);
}

{
 const wrapped=detectMcq("Q1. Which structure follows FIFO?\nA) Stack\nB) Tree\nC) Queue\n   stores items in arrival order\nD) Graph");
 check("question numbering not an option",wrapped.isMcq&&wrapped.options.length===4&&wrapped.question.startsWith("Q1."));
 check("wrapped option joined",wrapped.options[2]?.text==="Queue stores items in arrival order");
 const numbered=detectMcq("Question 2: Which is correct?\n1) alpha\n2) beta\n3) gamma");
 check("numbered question retained",numbered.isMcq&&numbered.question.startsWith("Question 2:"));
 const falsePositive=detectMcq("Implement a queue with operations:\n1. enqueue\n2. dequeue\n3. peek");
 check("coding steps not MCQ",!falsePositive.isMcq);
}

{
  const detected=detectMcq("Q4. Choose the right answer?\nA. Red\nB. Blue\nC. Green");
  const wrong=parseMcqAnswer('{"answer":{"label":"B","text":"an invented blue option"}}')!;
  check("reject label paired with invented option text",resolveMcqSelection(wrong,detected)===null);
  const labelOnly=parseMcqAnswer('{"answer":{"label":"B","text":"B"}}')!;
  check("permit label-only answer matching real option",resolveMcqSelection(labelOnly,detected)?.answer.text==="Blue");
}
console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall MCQ checks passed\n");
process.exit(fail ? 1 : 0);
