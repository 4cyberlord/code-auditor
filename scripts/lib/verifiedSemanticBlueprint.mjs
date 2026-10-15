/**
 * Deterministic, read-only semantic handoff for verified solutions.
 *
 * The extraction uses lexical cues and the existing winner explanation,
 * never executes the source and never asks another model to summarize it.
 * This makes it essentially immediate, shared across all target languages,
 * and safe to perform AFTER publishing the verified primary result.
 *
 * The manifest is explanatory context, not a proof of behavior or complexity.
 */
const LIMITS={code:120000,explanation:1500,brief:5200};
const uniq=(xs,max=20)=>[...new Set(xs.filter(Boolean))].slice(0,max);
function trimText(value,limit){
  return String(value||"").replace(/\x00/g,"").trim().slice(0,limit);
}
function allMatches(code,regex,limit=16){
  const found=[];
  for(const match of code.matchAll(regex)){
    found.push(match);
    if(found.length>=limit)break;
  }
  return found;
}
function detection(code,regex){return regex.test(code)}
export function extractVerifiedCodeStructure(source,language="python"){
  const code=trimText(source,LIMITS.code);
  const lang=String(language||"").toLowerCase().trim();
  const python=lang==="python"||lang==="py"||lang==="python3";
  const classes=uniq(allMatches(code,python
    ? /^\s*class\s+([A-Za-z_]\w*)\b/gm
    : /^\s*(?:pub\s+)?(?:struct|class|enum)\s+([A-Za-z_]\w*)\b/gm
  ).map(m=>m[1]),14);
  const definitions=allMatches(code,python
    ? /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm
    : /\b(?:fn|function)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm,
    24).map(m=>({
      name:m[1],
      parameters:trimText(m[2],200),
      // The original unmodified source code remains authoritative.
    }));
  const assigned=python
    ? allMatches(code,/^\s*([A-Za-z_]\w*)\s*(?::\s*[^=\n]+)?=(?!=)/gm,40).map(m=>m[1])
    : allMatches(code,/\b(?:let|const|var)\s+(?:mut\s+)?([A-Za-z_]\w*)/g,40).map(m=>m[1]);
  const loopVars=python
    ? allMatches(code,/^\s*for\s+([^\n:]{1,90}?)\s+in\s+/gm,20).flatMap(m=>
        m[1].replace(/[()]/g,"").split(",").map(p=>p.trim())
          .filter(p=>/^[A-Za-z_]\w*$/.test(p)))
    : [];
  const imports=python
    ? allMatches(code,/^\s*(?:from\s+[^\n]+\s+import\s+[^\n]+|import\s+[^\n]+)/gm,15).map(m=>trimText(m[0],110))
    : allMatches(code,/^\s*(?:#include\s*[<"][^>"]+[>"]|use\s+[A-Za-z0-9_:{}*,\s]+;)/gm,15).map(m=>trimText(m[0],110));
  const dataStructures=uniq([
    detection(code,/\b(?:dict|defaultdict|Counter|HashMap)\s*\(|=\s*\{|\{[^}\n]*:/)?"dictionaries / hash maps":"",
    detection(code,/\bset\s*\(|\bHashSet\b/)?"sets":"",
    detection(code,/\b(?:list|deque|Vec)\b|\[[^\]\n]*(?:,|\bfor\b)[^\]\n]*\]|\.append\s*\(|\.push\s*\(/)?"lists / dynamic arrays":"",
    detection(code,/\bheapq\b|\bBinaryHeap\b/)?"heaps / priority queues":"",
    detection(code,/\b(?:bisect|binary_search)\b/)?"binary search":"",
    detection(code,/\b(?:sort|sorted|sort_unstable)\s*\(/)?"sorting":"",
    detection(code,/\b(?:tuple|zip|enumerate)\s*\(/)?"tuple, zip or index iteration":"",
  ],12);
  const controlFlow=uniq([
    detection(code,/\bfor\s+|^\s*for\b/m)?"for-loops":"",
    detection(code,/\bwhile\s+|^\s*while\b/m)?"while-loops":"",
    detection(code,/\bif\s+|^\s*if\b/m)?"conditional branches":"",
    detection(code,/\btry\s*:|\bexcept\b|\bcatch\b/)?"exception handling":"",
    detection(code,/\byield\b/)?"generators / lazy iteration":"",
    detection(code,/\breturn\b/)?"explicit return values":"",
    detection(code,/\b(?:async|await)\b/)?"asynchronous operations":"",
  ],10);
  const mutations=uniq([
    detection(code,/\.append\s*\(|\.extend\s*\(|\.push\s*\(/)?"appending to a collection":"",
    detection(code,/\.pop\s*\(|\.remove\s*\(|\.discard\s*\(/)?"removing collection elements":"",
    detection(code,/\.sort\s*\(|\.reverse\s*\(/)?"sorting or reversing an existing collection":"",
    detection(code,/\[[^\]\n]+\]\s*(?:=|\+=|-=)/)?"assignment to an indexed element":"",
  ],10);
  return {
    language:lang,
    classes,definitions,variables:uniq([...assigned,...loopVars],32),imports,
    dataStructures,controlFlow,mutations,
  };
}
export function buildVerifiedSemanticBlueprint({
  source,sourceLanguage="python",sourceLetter="",problem="",passedTests=0,
}={}){
  if(!source?.code||typeof source.code!=="string")return null;
  const structure=extractVerifiedCodeStructure(source.code,sourceLanguage);
  const explanation=trimText(source.answer,LIMITS.explanation);
  const complexityClaim=trimText(source.complexity,180);
  const programTerms=structure.definitions.map(f=>
    f.name+"("+f.parameters+")").join("; ");
  const segments=[
    "VERIFIED SOURCE SEMANTIC BLUEPRINT — read-only translation assistance",
    "Language: "+sourceLanguage+
      (sourceLetter?"; source candidate "+sourceLetter:"")+
      (passedTests>0?"; "+passedTests+" passing E2B test case(s)":""),
    explanation?"What the original solver says the algorithm does: "+explanation:"",
    programTerms?"Detected functions and parameters: "+programTerms:"",
    structure.classes.length?"Detected classes / structs: "+structure.classes.join(", "):"",
    structure.variables.length?"Detected assigned/local variables: "+structure.variables.join(", "):"",
    structure.imports.length?"Detected imports/dependencies: "+structure.imports.join(" | "):"",
    structure.dataStructures.length?"Detected data structures or operations: "+structure.dataStructures.join(", "):"",
    structure.controlFlow.length?"Detected flow: "+structure.controlFlow.join(", "):"",
    structure.mutations.length?"Detected state changes: "+structure.mutations.join(", "):"",
    complexityClaim?"Original solver complexity CLAIM (not a verified theorem): "+complexityClaim:"",
    "Translation invariants: follow the original problem's exact callable interface; preserve argument order, return format, index boundaries, duplicates, empty input behavior, mutation semantics, numeric precision, overflow behavior, and error handling. Convert language-specific data structures idiomatically.",
    "This blueprint is a best-effort interpretation of lexical structure and existing solution notes, NOT an independent correctness proof. If it conflicts with the original problem or exact tested source, the problem and source win. Independently compile, execute, and verify every port.",
  ].filter(Boolean);
  const brief=segments.join("\n").slice(0,LIMITS.brief);
  return {
    sourceLanguage,sourceLetter,explanation,complexityClaim,structure,brief,
    // The source code itself lives in the saved candidate/report; do not
    // duplicate it inside this manifest or send it to the client twice.
    basedOn:"verified-source",
  };
}
