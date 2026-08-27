import { titleFor, placeholderTitle, isPlaceholder } from "../src/lib/title.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

console.log("\n1. the summary is the name, minus the throat-clearing");
{
  const t = titleFor({ extraction: { problemSummary: "Return the indices of the two numbers that add to target." } });
  check("no trailing period", !t.endsWith("."), t);
  check("kept short enough to scan", t.length <= 52, `${t.length}: ${t}`);
  check("starts with a capital", /^[A-Z]/.test(t), t);

  // A model told to summarise a screenshot very often says so first.
  const p = titleFor({ extraction: { problemSummary: "The problem is to reverse a linked list in place." } });
  check("preamble is stripped", p.startsWith("Reverse a linked list"), p);
  const q = titleFor({ extraction: { problemSummary: "This screenshot shows a failing unit test for the parser." } });
  check("another opener stripped", !q.toLowerCase().startsWith("this screenshot"), q);
}

console.log("\n2. what the person typed outranks what a model inferred");
{
  const t = titleFor({
    note: "interview prep, two pointers",
    extraction: { problemSummary: "Return the indices of the two numbers that add to target." },
  });
  check("the note wins", t === "Interview prep, two pointers", t);

  // But a two-word grunt is not a name.
  const short = titleFor({ note: "help", extraction: { problemSummary: "Reverse a linked list in place." } });
  check("a throwaway note does not win", short.startsWith("Reverse"), short);
}

console.log("\n3. an error on screen names the session by itself");
{
  const t = titleFor({
    extraction: {
      errors: [{ message: "NameError: name 'qs' is not defined", file: "views.py", line: 42 }],
      fileName: "views.py",
    },
  });
  check("the error is the name", t.includes("NameError"), t);
  check("and it says where", t.includes("views.py"), t);
  // Casing must survive: NameError is not nameerror.
  check("identifier casing survives", t.includes("NameError") && !t.includes("Nameerror"), t);
}

console.log("\n4. failing that, the code says what this is");
{
  check("python def", titleFor({ extraction: { code: "def two_sum(nums, target):\n    pass" } }) === "Two sum", titleFor({ extraction: { code: "def two_sum(nums, target):\n    pass" } }));
  check("with the language", titleFor({ extraction: { code: "def two_sum(n):\n  pass", language: "python" } }) === "Two sum (python)");
  check("js function", titleFor({ extraction: { code: "export function mergeSort(a) {}" } }) === "Merge sort");
  check("a class", titleFor({ extraction: { code: "public class OrderService {}" } }) === "Order service");
  check("rust fn", titleFor({ extraction: { code: "pub fn parse_header(b: &[u8]) {}" } }) === "Parse header");
  check("an arrow const", titleFor({ extraction: { code: "const useThing = (x) => x" } }) === "Use thing");
}

console.log("\n5. a terminal with no error is still identifiable");
{
  const t = titleFor({ extraction: { terminalCommands: ["npm run build -- --verbose"] } });
  check("named by its command", t.startsWith("Npm run build"), t);
}

console.log("\n6. nothing to go on means no name, not a made-up one");
{
  check("empty everything", titleFor({}) === "");
  check("empty extraction", titleFor({ extraction: {} }) === "");
  check("whitespace note", titleFor({ note: "   " }) === "");
}

console.log("\n7. a name the user chose is never overwritten");
{
  check("blank is a placeholder", isPlaceholder(""));
  check("the literal placeholder", isPlaceholder("New session"));
  check("the dated placeholder", isPlaceholder("Session — 3 Jul, 9:30 PM"));
  check("the old default", isPlaceholder("Untitled session"));
  check("a real name is not", !isPlaceholder("Two sum"));
  check("nor one that merely mentions a session", !isPlaceholder("Session pooler bug"), "");
  check("the placeholder says when", placeholderTitle("3 Jul, 9:30 PM") === "Session — 3 Jul, 9:30 PM");
  check("and degrades without a time", placeholderTitle("") === "New session");
}

console.log("\n8. long input is cut on a word boundary");
{
  const long = "Implement a function that determines whether a given directed graph contains a cycle reachable from the start node";
  const t = titleFor({ extraction: { problemSummary: long } });
  check("capped", t.length <= 52, `${t.length}: ${t}`);
  // The real property: the last word of the name is a whole word from the source.
  const lastWord = t.split(" ").pop() ?? "";
  check("the last word is whole", long.includes(lastWord), `"${lastWord}" not in source`);
  check("does not end mid-word", /[a-z)\]]$/i.test(t), t);
}

console.log("\n7. naming a run when nothing read the picture");
{
  // The cloud path stopped transcribing by default, so `problemSummary` is gone
  // and the answers are all there is to name a run after.
  const fromAnswer = titleFor({
    answers: [
      { answer: "Binary search on the partition of the smaller array. Then take the median.", language: "cpp" },
    ],
  });
  check("names it after what the panel concluded", /Binary search on the partition/.test(fromAnswer), fromAnswer);
  check("one sentence, not the paragraph", !/Then take the median/.test(fromAnswer), fromAnswer);

  // Order of authority is unchanged: a reading still beats an answer.
  const both = titleFor({
    extraction: { problemSummary: "Find the median of two sorted arrays" },
    answers: [{ answer: "Binary search on the partition of the smaller array." }],
  });
  check("a reading still wins", /median of two sorted arrays/i.test(both), both);

  // And a typed note still beats everything.
  const typed = titleFor({
    note: "why is my merge step wrong",
    extraction: { problemSummary: "Find the median of two sorted arrays" },
    answers: [{ answer: "Binary search on the partition." }],
  });
  check("what the person typed wins over both", /merge step/.test(typed), typed);

  // Nothing to go on is still a legitimate empty answer.
  check("no sources, no invented name", titleFor({ answers: [{ answer: "ok" }] }) === "");
  check("empty answers are skipped", titleFor({ answers: [{ answer: "" }, { answer: "" }] }) === "");
}

console.log("\n8. scaffolding names are replaceable, typed ones are not");
{
  check("the batch runner's name", isPlaceholder("Batch — lc4"));
  check("the smoke test's name", isPlaceholder("Cloud smoke 2026-08-27T02:07:42.817Z"));
  check("the ordinary placeholder", isPlaceholder("Session — a moment ago"));
  check("nothing at all", isPlaceholder("   "));
  check("a name someone typed is never replaced", !isPlaceholder("Median of two sorted arrays"));
  check("nor one that merely mentions a batch", !isPlaceholder("Batching strategy for the queue"));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall title checks passed\n");
process.exit(fail ? 1 : 0);
