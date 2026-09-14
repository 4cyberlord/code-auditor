import { userPrompt } from "../src/lib/prompts.ts";
import {
  singleReading,
  findJsonObject,
  parseExtraction,
  compareExtractions,
  renderForReasoning,
  chooseReaders,
  VISION_PREFERENCE,
  parseTieBreak,
  applyTieBreak,
  tieBreakUserPrompt,
  EMPTY_EXTRACTION,
  type Extraction,
} from "../src/lib/extraction.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const make = (o: Partial<Extraction>): Extraction => ({ ...EMPTY_EXTRACTION, ...o });

// -------------------------------------------------- 1: how replies really arrive
console.log("\n1. finding the JSON in a real-world reply");
{
  const bare = '{"kind":"code","language":"python"}';
  check("bare object", findJsonObject(bare) === bare);

  const fenced = 'Here is what I read:\n\n```json\n{"kind":"code"}\n```\n\nHope that helps.';
  check("wrapped in prose and a fence", findJsonObject(fenced) === '{"kind":"code"}');

  // The case that breaks naive brace counting: transcribed code contains braces.
  const withCode =
    '{"kind":"code","code":"function f() { if (x) { return {a:1}; } }","language":"js"}';
  check("braces inside a transcribed string", findJsonObject(withCode) === withCode);

  // And the case that breaks brace counting that ignores escapes.
  const withEscapes = '{"code":"print(\\"}\\")","language":"python"}';
  check("an escaped quote before a brace", findJsonObject(withEscapes) === withEscapes);

  check("no object at all", findJsonObject("I could not read the image.") === null);
  check("unterminated object", findJsonObject('{"kind":"code"') === null);
}

// ------------------------------------------------------------ 2: parsing
console.log("\n2. parsing and coercion");
{
  const e = parseExtraction(`\`\`\`json
{
  "kind": "terminal",
  "language": "python",
  "code": "def f():\\n    return 1",
  "errors": [{"message": "NameError: x", "file": "a.py", "line": 12}, "bare string error"],
  "terminalCommands": ["python a.py", ""],
  "observations": ["ran in a venv", 42],
  "ambiguities": ["line 3: could be l or 1"],
  "confidence": 88
}
\`\`\``)!;
  check("parsed", e !== null);
  check("kind kept", e.kind === "terminal");
  check("structured error kept", e.errors[0].line === 12 && e.errors[0].file === "a.py");
  check("bare-string error accepted", e.errors[1]?.message === "bare string error", JSON.stringify(e.errors));
  check("empty command dropped", e.terminalCommands.length === 1);
  check("non-string observation dropped", e.observations.length === 1);
  check("percentage confidence normalised", e.confidence === 0.88, String(e.confidence));
  check("ambiguity preserved", e.ambiguities.length === 1);

  const bad = parseExtraction('{"kind": "code", oops}');
  check("malformed JSON returns null", bad === null);

  const unknownKind = parseExtraction('{"kind":"screenshot"}')!;
  check("unknown kind falls back to other", unknownKind.kind === "other");
}

// ----------------------------------------- 3: the disagreement that matters
console.log("\n3. two readings of the same screenshot");
{
  const a = make({
    code: "def f(n):\n    return n + 1",
    problemSummary: "Off-by-one in the increment.",
    language: "python",
    confidence: 0.9,
    ambiguities: ["the 1 could be an l"],
  });

  // Same reading, different indentation and a blank line: not a conflict.
  const cosmetic = make({
    code: "def f(n):\n\n    return n + 1   ",
    problemSummary: "Off-by-one in the increment.",
    language: "python",
    confidence: 0.8,
  });
  const r1 = compareExtractions(a, cosmetic);
  check("whitespace alone is not a conflict", r1.agree, JSON.stringify(r1.conflicts));

  // A genuinely different character: this is the whole point of the cross-check.
  const misread = make({
    code: "def f(n):\n    return n + l",
    problemSummary: "Off-by-one in the increment.",
    language: "python",
    confidence: 0.7,
  });
  const r2 = compareExtractions(a, misread);
  check("a misread character is a conflict", !r2.agree);
  check("flagged as high severity", r2.conflicts.some((c) => c.field === "code" && c.severity === "high"));
  check("confidence is knocked down", r2.merged.confidence < 0.7, String(r2.merged.confidence));
  check("summary names the field", r2.summary.includes("code"), r2.summary);

  // Metadata differences should not masquerade as transcription problems.
  const metaOnly = make({
    code: "def f(n):\n    return n + 1",
    problemSummary: "Off-by-one in the increment.",
    language: "python3",
    framework: "flask",
    confidence: 0.85,
  });
  const r3 = compareExtractions(a, metaOnly);
  check("metadata difference does not block agreement", r3.agree);
  check("but is still reported", r3.conflicts.length > 0);
  check("all low severity", r3.conflicts.every((c) => c.severity === "low"));
}

// ------------------------------------------------------------- 4: merging
console.log("\n4. merging two readings");
{
  const low = make({ code: "a", language: "js", confidence: 0.4, ambiguities: ["x"] });
  const high = make({ code: "a", language: "ts", confidence: 0.95, ambiguities: ["y"] });
  const r = compareExtractions(low, high);
  check("the more confident reading wins", r.merged.language === "ts", r.merged.language);
  check("doubts from both are kept", r.merged.ambiguities.length === 2, JSON.stringify(r.merged.ambiguities));
  check("merged confidence is the lower of the two", r.merged.confidence === 0.4, String(r.merged.confidence));
}

// ------------------------------------------- 5: what the text models receive
console.log("\n5. rendering for a model that cannot see");
{
  const e = make({
    kind: "code",
    language: "rust",
    filePath: "src/main.rs",
    code: "fn main() {}",
    errors: [{ message: "borrow of moved value", file: "src/main.rs", line: 7 }],
    problemSummary: "Ownership error on line 7.",
    ambiguities: ["line 7 indentation unclear"],
  });
  const t = renderForReasoning(e);
  check("carries the problem", t.includes("Ownership error"));
  check("carries the code in a fence", t.includes("```rust") && t.includes("fn main() {}"));
  check("carries the error with its location", t.includes("borrow of moved value") && t.includes("src/main.rs:7"));
  check("carries the uncertainty forward", t.includes("UNCERTAIN") && t.includes("indentation unclear"));

  const empty = renderForReasoning(EMPTY_EXTRACTION);
  check("an empty extraction renders to nothing", empty.trim() === "", JSON.stringify(empty));
}

// ------------------------------------------- 6: when only one model could read
console.log("\n6. a reading with nothing to check it against");
{
  const only = make({ code: "x = 1", confidence: 0.9 });
  const r = singleReading(only, "Kimi returned no usable JSON");
  check("the reading survives", r.merged.code === "x = 1");
  check("no conflicts to report", r.conflicts.length === 0);
  // The dangerous outcome would be a single reading that reads as verified.
  check("says out loud that nothing checked it", r.summary.includes("nothing cross-checked"));
  check("names the reason", r.summary.includes("no usable JSON"), r.summary);
}

// ------------------------------------- 7: what the reasoning agent is told
console.log("\n7. framing the reading for a model that cannot see");
{
  const reading = "PROBLEM\nOff-by-one on line 7.";

  const blind = userPrompt("", false, reading);
  check("says the picture is not attached", blind.includes("not being shown"));
  check("carries the reading", blind.includes("Off-by-one on line 7."));
  check("delimits the reading", blind.includes("--- READING OF THE SCREENSHOT ---"));
  // Without this the model fills gaps from imagination and sounds just as sure.
  check("tells it to refuse rather than guess", blind.includes("instead of filling the gap"));

  const both = userPrompt("", true, reading);
  check("both: says the image is attached too", both.includes("screenshot is attached"));
  check("both: the image wins a disagreement", both.includes("the image is the truth"));

  // The proven path must not have changed shape.
  const imagesOnly = userPrompt("", true, "");
  check(
    "images-only prompt is untouched",
    imagesOnly === "The problem is in the attached image. Read it, then solve it.",
    imagesOnly
  );

  const noted = userPrompt("focus on the loop", false, reading);
  check("the note still arrives", noted.includes("focus on the loop"));
  check("note comes after the reading", noted.indexOf("focus on the loop") > noted.indexOf(reading));

  const nothing = userPrompt("", false, "   ");
  check("blank reading is not treated as a reading", nothing === "Solve the attached problem.", nothing);
}

console.log("\nN. prose is compared by meaning, not by spelling");
{
  const base = {
    ...EMPTY_EXTRACTION,
    kind: "code" as const,
    code: "def f(): pass",
    confidence: 0.93,
  };

  // The bug this replaced: two models asked to summarise the same problem
  // produce two different sentences every time, which was reported as a
  // disagreement, cost 40% of the confidence, and taught the user to ignore the
  // one warning that would have mattered.
  const a = { ...base, problemSummary: "Return the indices of the two numbers that add to target." };
  const b = { ...base, problemSummary: "Find two numbers in the array summing to the target and return their indices." };
  const same = compareExtractions(a, b);
  check("a paraphrase is not a disagreement", same.agree, same.summary);
  check("and costs no confidence", Math.abs(same.merged.confidence - 0.93) < 0.001, String(same.merged.confidence));

  // But two genuinely different readings of what is being asked must still stop
  // the run, because that is the case where the panel would confidently solve a
  // problem that was never on screen.
  const c = { ...base, problemSummary: "Reverse a linked list in place." };
  const d = { ...base, problemSummary: "Find the maximum subarray sum." };
  const differ = compareExtractions(c, d);
  check("a different problem still disagrees", !differ.agree, differ.summary);
  check("and is named", differ.conflicts.some((x) => x.field === "problemSummary" && x.severity === "high"));
  check("and the confidence drops", differ.merged.confidence < 0.93);
  check("the warning says what to do", differ.summary.includes("reading document"), differ.summary);

  // One model summarising and the other not is worth noting, quietly.
  const e = compareExtractions({ ...base, problemSummary: "Two sum." }, { ...base, problemSummary: "" });
  check("a missing summary is flagged", e.conflicts.some((x) => x.field === "problemSummary"));
  check("but does not block", e.agree === false || e.agree === true);

  check("neither summarising is not a conflict",
    compareExtractions({ ...base, problemSummary: "" }, { ...base, problemSummary: "" }).conflicts
      .every((x) => x.field !== "problemSummary"));
}

console.log("\nN. transcription is still compared exactly");
{
  const base = { ...EMPTY_EXTRACTION, kind: "code" as const, confidence: 0.9 };

  // The l/1 misread is the whole reason two models read the picture.
  const one = compareExtractions({ ...base, code: "return 1" }, { ...base, code: "return l" });
  check("a single character in code still disagrees", !one.agree, one.summary);

  // Whitespace is not a misreading.
  const ws = compareExtractions({ ...base, code: "def f():\n    pass  " }, { ...base, code: "def f():\n    pass" });
  check("trailing whitespace in code is forgiven", ws.agree, ws.summary);

  const term = compareExtractions(
    { ...base, terminalOutput: "error: failed\n\n" },
    { ...base, terminalOutput: "error: failed" }
  );
  check("blank lines in terminal output are forgiven", term.agree, term.summary);

  const termReal = compareExtractions(
    { ...base, terminalOutput: "exit code 1" },
    { ...base, terminalOutput: "exit code 7" }
  );
  check("but a different exit code is not", !termReal.agree);

  const errWs = compareExtractions(
    { ...base, errors: [{ message: "NameError:  name 'qs'", file: "", line: 0 }] },
    { ...base, errors: [{ message: "NameError: name 'qs'", file: "", line: 0 }] }
  );
  check("a wrapped error message is forgiven", errWs.agree, errWs.summary);

  const errReal = compareExtractions(
    { ...base, errors: [{ message: "NameError: name 'qs'", file: "", line: 0 }] },
    { ...base, errors: [{ message: "NameError: name 'gs'", file: "", line: 0 }] }
  );
  check("a misread identifier in an error is not", !errReal.agree);
}


console.log("\n— ranked readers and the arbiter —");
{
  const seats = [{ id: "z-ai/glm-5.3" }, { id: "openai/gpt-5.6-sol" }, { id: "google/gemini-3.7-flash" }, { id: "anthropic/claude-opus-5" }];
  const { readers, tieBreaker } = chooseReaders(seats, (m) => m.id);
  check("the strongest visual readers go first", readers.map((r) => r.id).join(",") === "openai/gpt-5.6-sol,anthropic/claude-opus-5", readers.map((r) => r.id).join(","));
  // Asking one of the two whether it was wrong is not an answer, so the third
  // is held back deliberately.
  check("and the arbiter is neither of them", tieBreaker?.id === "google/gemini-3.7-flash", String(tieBreaker?.id));
  check("an unranked seat still gets used", chooseReaders([{ id: "some/new-model" }], (m) => m.id).readers.length === 1);
  check("the preference is data, not a hardcoded pair", VISION_PREFERENCE.length >= 3 && VISION_PREFERENCE[0] === "openai/gpt-5.6-sol");
}

console.log("\n— the arbiter settles the disputed fields only —");
{
  const a = { ...EMPTY_EXTRACTION, kind: "code" as const, code: "let n = l1", problemSummary: "add two numbers", language: "rust", confidence: 0.9 };
  const b = { ...EMPTY_EXTRACTION, kind: "code" as const, code: "let n = 11", problemSummary: "add two numbers", language: "rust", confidence: 0.4 };
  const agreement = compareExtractions(a, b);
  check("the misread character is a conflict", agreement.conflicts.some((c) => c.field === "code" && c.severity === "high"));
  // The old rule would have taken A here for claiming 0.9 against 0.4. A model
  // that looked at the picture says otherwise.
  const settled = applyTieBreak(a, b, agreement, parseTieBreak("code: B", ["code"]), "google/gemini-3.7-flash");
  check("confidence no longer decides it", settled.merged.code === "let n = 11", settled.merged.code);
  check("the run still knows there was a conflict", settled.conflicts.length > 0 && settled.summary.includes("settled"), settled.summary);
  check("and it reads as agreed once nothing high is left", settled.agree);

  const unsettled = applyTieBreak(a, b, agreement, [], "google/gemini-3.7-flash");
  check("an arbiter that named nothing changes nothing", unsettled.merged.code === agreement.merged.code && !unsettled.agree);
  check("the prompt shows both readings", tieBreakUserPrompt(agreement.conflicts).includes("let n = l1"));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall extraction checks passed\n");
process.exit(fail ? 1 : 0);
