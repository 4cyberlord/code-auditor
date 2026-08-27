import {
  normalizeLanguage,
  displayLanguage,
  resolveAnswerLanguage,
  answerLanguageRule,
  MATCH_THE_QUESTION,
} from "../src/lib/answerLanguage.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

console.log("\n1. the answer matches the question by default");
{
  const r = resolveAnswerLanguage(MATCH_THE_QUESTION, "python");
  check("python question, python answer", r.id === "python" && r.source === "detected");
  check("spelled the way a person writes it", r.display === "Python", r.display);

  const rule = answerLanguageRule(r);
  check("the rule names it", rule.includes("Python"), rule);
  // The reason matters: a model that has just decided the elegant solution is
  // in another language will read a hint as permission.
  check("and says why it is binding", rule.includes("different question"), rule);
}

console.log("\n2. a configured language overrides the question");
{
  const r = resolveAnswerLanguage("cpp", "python");
  check("the setting wins", r.id === "cpp" && r.source === "setting");
  const rule = answerLanguageRule(r);
  check("told to port it", rule.includes("port it"), rule);
  check("and to say so", rule.includes("say in one line"), rule);
}

console.log("\n3. what transcriptions actually contain");
{
  // Versions and dialects come out of a vision model exactly like this.
  check("Python 3.12", normalizeLanguage("Python 3.12") === "python");
  check("C++20", normalizeLanguage("C++20") === "cpp");
  check("c++", normalizeLanguage("c++") === "cpp");
  check("golang", normalizeLanguage("golang") === "go");
  check("node", normalizeLanguage("node") === "javascript");
  check("TS", normalizeLanguage("TS") === "typescript");
  check("a leading dot", normalizeLanguage(".py") === "python");
  check("padded and shouted", normalizeLanguage("  PYTHON  ") === "python");
  check("C#", normalizeLanguage("C#") === "csharp");
}

console.log("\n4. an unknown language is passed through, not guessed at");
{
  // A language this table has never heard of is far likelier to be real than a
  // typo, and silently rewriting it would be worse than not knowing it.
  check("kept as given", normalizeLanguage("nim") === "nim");
  check("and displayed capitalised", displayLanguage("nim") === "Nim", displayLanguage("nim"));
  check("known ones keep their real casing", displayLanguage("cpp") === "C++");
  check("PHP is not Php", displayLanguage("php") === "PHP");
}

console.log("\n5. nothing known says so rather than picking a house language");
{
  const r = resolveAnswerLanguage("", "");
  check("no id", r.id === "" && r.source === "unknown");
  const rule = answerLanguageRule(r);
  check("follows the source", rule.includes("whatever language the problem is written in"), rule);
  check("and asks it to declare a choice", rule.includes("say which you chose"), rule);
  check("names no default", !/\bPython\b|\bC\+\+\b/.test(rule), rule);
}

console.log("\n6. junk in never throws");
{
  for (const junk of ["", "   ", "...", "///", "12345"]) {
    const r = resolveAnswerLanguage(junk, junk);
    check(`"${junk}" is survivable`, typeof r.id === "string" && typeof answerLanguageRule(r) === "string");
  }
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall answer-language checks passed\n");
process.exit(fail ? 1 : 0);
