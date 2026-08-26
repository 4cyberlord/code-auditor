import {
  readingMarkdown,
  compareExtractions,
  extractionFromOcr,
  ocrIsUsable,
  ocrUserPrompt,
  withOcrDoubt,
  EMPTY_EXTRACTION,
  type Extraction,
} from "../src/lib/extraction.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const ex = (over: Partial<Extraction> = {}): Extraction => ({
  ...EMPTY_EXTRACTION,
  kind: "code",
  language: "python",
  problemSummary: "Return the indices of the two numbers that add to target.",
  code: "def two_sum(nums, target):\n    return []",
  confidence: 0.9,
  ...over,
});

console.log("\n1. the document says what it is before it says what it read");
{
  const md = readingMarkdown(ex(), { readers: ["Claude", "GPT"], agreement: null, at: "2026-08-25T00:00:00Z" });
  check("titled", md.startsWith("# Screenshot reading"), md.slice(0, 40));
  check("warns it is not the picture", md.includes("not the picture"));
  check("names both readers", md.includes("Claude and GPT"));
  check("states confidence numerically", md.includes("0.90"), md);
  check("carries the timestamp", md.includes("2026-08-25T00:00:00Z"));
  check("ends with a newline", md.endsWith("\n"));
}

console.log("\n2. a single reader admits it had no cross-check");
{
  const md = readingMarkdown(ex(), { readers: ["Claude"], agreement: null });
  check("says so plainly", md.includes("single reader — no cross-check"), md.slice(0, 300));
}

console.log("\n3. doubt comes before the content it applies to");
{
  const md = readingMarkdown(ex({ ambiguities: ["line 3: could be l or 1"] }), {
    readers: ["Claude", "GPT"],
    agreement: null,
  });
  const amb = md.indexOf("could not be sure");
  const code = md.indexOf("Code, transcribed verbatim");
  check("ambiguities are a section", amb > -1);
  check("and they precede the code", amb < code, `amb=${amb} code=${code}`);
  check("the ambiguity itself is listed", md.includes("could be l or 1"));
  check("and it is not resolved silently", md.includes("state the reading you"));
}

console.log("\n4. a disagreement between readers is surfaced, not merged away");
{
  const a = ex({ code: "return 1", confidence: 0.9 });
  const b = ex({ code: "return l", confidence: 0.4 });
  const agreement = compareExtractions(a, b);
  check("the comparison found it", agreement.conflicts.some((c) => c.severity === "high"));

  const md = readingMarkdown(agreement.merged, { readers: ["Claude", "GPT"], agreement });
  check("reported as a disagreement", md.includes("The two readers disagreed"), md.slice(0, 400));
  check("says the readers did not agree", md.includes("**Readers agreed:** no"));
  check("shows both readings", md.includes("return 1") && md.includes("return l"));

  const disagree = md.indexOf("readers disagreed");
  const code = md.indexOf("Code, transcribed verbatim");
  check("before the code as well", disagree < code, `d=${disagree} c=${code}`);
}

console.log("\n5. agreement is stated too, not just disagreement");
{
  const agreement = compareExtractions(ex(), ex());
  const md = readingMarkdown(agreement.merged, { readers: ["Claude", "GPT"], agreement });
  check("says they agreed", md.includes("**Readers agreed:** yes"), md.slice(0, 400));
  check("and raises no warning", !md.includes("readers disagreed"));
}

console.log("\n6. transcribed markdown cannot break the fence");
{
  // A screenshot of a README. Three backticks inside a three-backtick fence
  // would end it early and turn the rest of the transcription into prose.
  const md = readingMarkdown(ex({ code: "```js\nconst a = 1;\n```", language: "markdown" }), {
    readers: ["Claude"],
    agreement: null,
  });
  const opens = [...md.matchAll(/^(`{3,})/gm)].map((m) => m[1].length);
  check("the outer fence is longer than the inner", opens.some((n) => n >= 4), opens.join(","));
  // Every fence must pair up, or the document is malformed.
  check("fences are balanced", opens.length % 2 === 0, opens.join(","));
}

console.log("\n7. an empty reading says it is empty rather than looking valid");
{
  const md = readingMarkdown(
    { ...EMPTY_EXTRACTION, confidence: 0.1 },
    { readers: ["Claude"], agreement: null }
  );
  check("declares itself empty", md.includes("Nothing legible was found"), md);
  check("and tells the model not to infer", md.includes("rather than inferring one"));
  check("no empty code section", !md.includes("Code, transcribed verbatim"));
}

console.log("\n8. everything the reader saw survives the conversion");
{
  const md = readingMarkdown(
    ex({
      framework: "django",
      filePath: "app/views.py",
      url: "http://localhost:8000/orders",
      errors: [{ message: "NameError: name 'qs' is not defined", file: "views.py", line: 42 }],
      terminalCommands: ["python manage.py runserver"],
      terminalOutput: "Internal Server Error: /orders",
      observations: ["A breakpoint marker is visible on line 40"],
    }),
    { readers: ["Claude", "GPT"], agreement: null, manifest: "One screenshot is attached." }
  );
  for (const bit of [
    "django",
    "app/views.py",
    "localhost:8000/orders",
    "NameError",
    "views.py:42",
    "manage.py runserver",
    "Internal Server Error",
    "breakpoint marker",
    "One screenshot is attached.",
  ]) {
    check(`kept: ${bit}`, md.includes(bit));
  }
}

console.log("\n9. the transcription decides whether a model is needed at all");
{
  const page = (words: number, text = "x", unsure: string[] = []) => ({
    text,
    unsure,
    confidence: 0.98,
    words,
  });

  check("a screen full of text is usable", ocrIsUsable([page(40)]));
  check("tiles are counted together", ocrIsUsable([page(6), page(6)]));
  // A diagram or a mockup comes back as a scattering of labels. Handing eleven
  // disconnected words to a model as "the problem" is worse than admitting the
  // transcriber was the wrong tool.
  check("a diagram is not", !ocrIsUsable([page(11)]));
  check("nothing at all is not", !ocrIsUsable([]));
  check("an empty page is not", !ocrIsUsable([page(0, "")]));
}

console.log("\n10. a transcription with nobody to interpret it is still honest");
{
  const pages = [
    { text: "def f(n):\n    return n", unsure: ['"l1" (61% sure)'], confidence: 0.94, words: 20 },
  ];
  const e = extractionFromOcr(pages);
  check("the text survives verbatim", e.code.includes("return n"), e.code);
  // Deliberately not problemSummary: nothing has read it, so claiming a summary
  // would be a claim that something understood it.
  check("and is not passed off as a summary", e.problemSummary === "");
  check("the engine's doubt is carried", e.ambiguities.includes('"l1" (61% sure)'));
  check("confidence comes from the engine", Math.abs(e.confidence - 0.94) < 0.001);

  const md = readingMarkdown(e, { readers: ["Cloud Vision"], agreement: null });
  check("the document names the transcriber", md.includes("Cloud Vision"), md.slice(0, 200));
  check("and still leads with the doubt", md.indexOf("could not be sure") < md.indexOf("Code, transcribed"));
}

console.log("\n11. measured doubt outranks a model's own");
{
  const pages = [{ text: "x", unsure: ['"rn" (58% sure)'], confidence: 0.9, words: 30 }];
  const fromModel = {
    ...EMPTY_EXTRACTION,
    problemSummary: "Two sum.",
    ambiguities: ["I could not read line 4"],
    confidence: 0.8,
  };
  const merged = withOcrDoubt(fromModel, pages);
  check("the engine's doubt is there", merged.ambiguities.includes('"rn" (58% sure)'));
  check("and it comes first", merged.ambiguities[0] === '"rn" (58% sure)', merged.ambiguities.join(" | "));
  check("the model's is kept too", merged.ambiguities.includes("I could not read line 4"));
  check("the structure survives", merged.problemSummary === "Two sum.");

  // Nothing measured must not disturb what the model said.
  const clean = withOcrDoubt(fromModel, [{ text: "x", unsure: [], confidence: 1, words: 30 }]);
  check("no measured doubt changes nothing", clean.ambiguities.length === 1);
}

console.log("\n12. what the structuring model is actually shown");
{
  const one = ocrUserPrompt([{ text: "print(1)", unsure: [], confidence: 1, words: 5 }]);
  check("a single page is not numbered", one.includes("--- TRANSCRIPTION ---"), one.slice(0, 60));
  check("no ordering lecture for one page", !one.includes("one problem, in the order"));

  const many = ocrUserPrompt([
    { text: "a", unsure: ['"l" (55% sure)'], confidence: 0.9, words: 5 },
    { text: "b", unsure: [], confidence: 1, words: 5 },
  ], "focus on the error");
  check("pages are numbered", many.includes("SCREENSHOT 1 OF 2") && many.includes("SCREENSHOT 2 OF 2"));
  check("and said to be one problem", many.includes("one problem, in the order"));
  // Which character was doubtful matters far less than where it was, so the
  // doubt rides with its own page rather than being pooled at the end.
  check("doubt stays with its page", many.indexOf('"l" (55% sure)') < many.indexOf("SCREENSHOT 2"));
  check("the note arrives", many.includes("focus on the error"));
  check("and it asks for JSON", many.includes("Return the JSON object"));

  const empty = ocrUserPrompt([{ text: "   ", unsure: [], confidence: 0, words: 0 }]);
  check("an empty page says so rather than being blank", empty.includes("(nothing legible)"));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall reading checks passed\n");
process.exit(fail ? 1 : 0);
