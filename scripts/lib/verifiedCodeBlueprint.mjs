/**
 * Source-grounded, language-neutral translation blueprint.
 *
 * This is a lightweight description, NOT a substitute for an AST or a proof.
 * No code is executed here. The exact E2B-passing source and the original
 * problem contract are authoritative if any explanatory sentence conflicts.
 */
const MAX_CODE_CHARS = 64000;
const MAX_ITEMS = 12;
function unique(items) {
  return [...new Set(items.map(x => x.trim()).filter(Boolean))].slice(0, MAX_ITEMS);
}
function linesMatching(lines, regex, mapper = match => match[1]) {
  const result = [];
  for (const line of lines) {
    const match = line.match(regex);
    if (match) result.push(mapper(match).slice(0, 170));
  }
  return unique(result);
}
function describePython(code) {
  const lines=code.split(/\r?\n/);
  const classes=linesMatching(lines,/^\s*class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/);
  const signatures=linesMatching(lines,/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/,m=>m[1]+"("+m[2]+")");
  const imports=linesMatching(lines,/^\s*((?:from\s+[\w.]+\s+import\s+|import\s+)[^\n#]+)/);
  const variables=linesMatching(lines,/^\s*(?:self\.)?([A-Za-z_]\w*)\s*(?::[^=]+)?\s*=(?!=)/);
  const loops=linesMatching(lines,/^\s*((?:for\s+.+?\s+in\s+.+|while\s+.+))\s*:\s*(?:#.*)?$/);
  const decisions=linesMatching(lines,/^\s*((?:if|elif)\s+.+|else)\s*:\s*(?:#.*)?$/);
  const returns=linesMatching(lines,/^\s*return(?:\s+(.+))?/,m=>m[1]||"(no value)");
  const collections=[];
  if(/\b(?:dict|defaultdict|OrderedDict|HashMap)\b|\{\s*[^}\n:]+:\s*[^}\n]+\}/.test(code))collections.push("Dictionary-like key/value lookup or accumulation");
  if(/\b(?:set\(|frozenset\(|Set\[)\b/.test(code))collections.push("Set-based uniqueness or membership");
  if(/\b(?:deque|popleft|appendleft)\b/.test(code))collections.push("Double-ended queue operations");
  if(/\b(?:heapq|heappush|heappop)\b/.test(code))collections.push("Priority-queue / heap operations");
  if(/\b(?:sorted\(|\.sort\()\b/.test(code))collections.push("Sorting");
  if(/\b(?:bisect|binary_search)\b/.test(code))collections.push("Binary-search operations");
  if(/\b(?:Counter|count\()\b/.test(code))collections.push("Counting");
  const parts=[
    "SOURCE-OBSERVED PROGRAM STRUCTURE (mechanically extracted; incomplete, not a behavioral proof):",
    classes.length?"Classes defined: "+classes.join("; ")+".":"",
    signatures.length?"Functions and declared parameters: "+signatures.join("; ")+".":"",
    imports.length?"Imported modules/symbols: "+imports.join("; ")+".":"",
    variables.length?"Named variables or fields assigned: "+variables.join(", ")+".":"",
    collections.length?"Observed data-structure/API patterns: "+collections.join("; ")+".":"",
    loops.length?"Loop statements: "+loops.join("; ")+".":"",
    decisions.length?"Conditional branches: "+decisions.join("; ")+".":"",
    returns.length?"Return expressions: "+returns.join("; ")+".":"",
  ].filter(Boolean);
  return parts.join("\n").slice(0,5300);
}
function describeOther(code, language) {
  const lines=code.split(/\r?\n/);
  const imports=linesMatching(lines,/^\s*((?:#include\s*[<"][^>"]+[>"]|use\s+[^;]+;|import\s+[^;]+;))/);
  const loops=linesMatching(lines,/^\s*((?:for|while)\s*(?:\([^)]*\)|[^{]+))\s*\{/);
  const returns=linesMatching(lines,/^\s*return\s+([^;]+)\s*;?/);
  const names=language==="rust"
    ?linesMatching(lines, /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/,m=>m[1]+(m[2]||""))
    :linesMatching(lines,/^\s*(?:static\s+)?(?:[\w:<>,*&]+\s+)+([A-Za-z_]\w*)\s*(\([^)]*\))\s*(?:const)?(?:\s*\{|\s*;)/,m=>m[1]+m[2]);
  return [
    "SOURCE-OBSERVED PROGRAM STRUCTURE (partial static inspection, not an AST):",
    names.length?"Functions: "+names.join("; ")+".":"",
    imports.length?"Imports/includes: "+imports.join("; ")+".":"",
    loops.length?"Loops: "+loops.join("; ")+".":"",
    returns.length?"Return expressions: "+returns.join("; ")+".":"",
  ].filter(Boolean).join("\n").slice(0,4300);
}
export function verifiedCodeBlueprint({code,language}={}) {
  const source=String(code||"").slice(0,MAX_CODE_CHARS);
  const type=String(language||"").trim().toLowerCase();
  if(!source.trim())return "";
  const observed=type==="python"?describePython(source):describeOther(source,type);
  return [
    "ENGLISH TRANSLATION BLUEPRINT — verified-source structural guide",
    "The original E2B-passing source code is the sole authority. This guide exposes symbol names and flow for translation; it is not executable evidence and does not prove complexity.",
    observed,
    "Preserve semantics, input/output contract, edge cases, numeric behavior, and side effects. Preserve the algorithm unless the problem and independent tests justify a change.",
    "Map language idioms thoughtfully: Python dict/list/set vs Rust HashMap/Vec/HashSet or C++ unordered_map/vector/unordered_set; match actual use, do not introduce unused structures.",
    "Explain how each function contributes to the result and how key variables change during loops. Never guess behavior absent from the source code.",
  ].join("\n\n").slice(0,6500);
}
export function composePortBlueprint({structural="",explanation=""}={}) {
  const original=String(structural||"").trim();
  const narrative=String(explanation||"").trim().slice(0,4000);
  return [
    original,
    narrative ? "SHARED PLAIN-ENGLISH SEMANTIC WALKTHROUGH (AI commentary; source code overrides disagreements):\n"+narrative : "",
  ].filter(Boolean).join("\n\n").slice(0,10600);
}
