/**
 * Harness Engine V2: question-supplied examples are test evidence, not model output.
 *
 * Only labelled Input/Output pairs are admitted. A deterministic Python driver
 * compiles/runs stdin solutions in Python, C++23 or Rust, or invokes a supported
 * Python function/class API. No fabricated oracle or generated expected value.
 *
 * Unsupported/ambiguous contracts fall back to the independently checked
 * legacy specification harness; the compiler never guesses an answer.
 */

export type ProvidedFixture = {
  id: string;
  input: string;
  output: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  expected?: unknown;
};

export type ProvidedSuite = {
  language: string;
  runnerLanguage: "python" | "cpp" | "rust";
  source: "provided" | "generated";
  providedCaseCount: number;
  /** Retained so each candidate can get an adapter for its own callable API. */
  question: string;
  harness: string;
  harnessVersion?: string;
  contractHash?: string;
  referenceCode?: string;
  candidateAsString?: boolean;
  templateId?: string;
  signature?: string;
  contract?: import("./problemContract.ts").ProblemContract;
  unordered?: boolean;
};


interface PythonNodeSpec {
  params: Array<{ index: number; tree: boolean }>;
  /** Parameter names in declaration order, so kwargs become positional. */
  order: string[];
  returnsNode: boolean;
  inPlace: boolean;
  fields: NodeFields;
}

/** Only when the candidate names the node type or the parameter is node-ish. */
export function pythonNodeSpec(question: string, code: string, name: string): PythonNodeSpec | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const definition = new RegExp(`def\\s+${escaped}\\s*\\(([^)]*)\\)\\s*(?:->\\s*([^:]+))?:`).exec(code);
  if (!definition) return null;
  const params = splitParams(definition[1]).filter((part) => !/^self\b/.test(part.trim()));
  const treeQuestion = /\btree\b/i.test(question);
  const specs: PythonNodeSpec["params"] = [];
  params.forEach((param, index) => {
    const [name, ...rest] = param.split(":");
    const annotation = rest.join(":");
    if (/ListNode/.test(annotation)) specs.push({ index, tree: false });
    else if (/TreeNode/.test(annotation)) specs.push({ index, tree: true });
    else if (!annotation) {
      const bare = name.trim().toLowerCase();
      if (/^(?:root|tree)$/.test(bare) || (/^node$/.test(bare) && treeQuestion)) specs.push({ index, tree: true });
      else if (/^(?:head|node|l1|l2|list1|list2)$/.test(bare)) specs.push({ index, tree: false });
    }
  });
  if (!specs.length) return null;
  const tree = specs.some((spec) => spec.tree);
  return {
    params: specs,
    order: params.map((param) => param.split(":")[0].trim()),
    returnsNode: /ListNode|TreeNode/.test(definition[2] || ""),
    inPlace: /^\s*(?:None|NoneType)\b/.test(definition[2] || ""),
    fields: nodeFields(code, tree, tree ? "TreeNode" : "ListNode"),
  };
}

// ------------------------------------------------- native function adapters
//
// Judge-style APIs (a Solution class or a free function) need a typed call, not
// stdin. These adapters cover the types below; anything else returns null so the
// existing reference-harness path takes over.

type NativeType =
  | { kind: "int" | "float" | "bool" | "string" | "void" }
  | { kind: "list"; item: NativeType }
  | { kind: "node"; tree: boolean }
  | { kind: "optional"; item: NativeType };

interface NativeArgument {
  name: string;
  type: NativeType;
  decl: string;
}

interface NativeSignature {
  name: string;
  args: NativeArgument[];
  ret: NativeType;
  retDecl: string;
  owner: "class" | "free";
  receiver: boolean;
}

function cppTypeName(type: NativeType): string {
  if (type.kind === "node") return type.tree ? "TreeNode*" : "ListNode*";
  if (type.kind === "list") return `std::vector<${cppTypeName(type.item)}>`;
  if (type.kind === "float") return "double";
  if (type.kind === "bool") return "bool";
  if (type.kind === "string") return "std::string";
  return "long long";
}

function cppType(raw: string): NativeType | null {
  const text = raw.replace(/\bconst\b/g, "").replace(/[&\s]+$/g, "").trim();
  if (/^TreeNode\s*\*$/.test(text)) return { kind: "node", tree: true };
  if (/^ListNode\s*\*$/.test(text)) return { kind: "node", tree: false };
  const optCpp = /^(?:std::)?optional<(.+)>$/.exec(text);
  if (optCpp) { const item = cppType(optCpp[1]); return item ? { kind: "optional", item } : null; }
  if (text === "void") return { kind: "void" };
  if (text === "bool") return { kind: "bool" };
  if (text === "double" || text === "float") return { kind: "float" };
  if (text === "string" || text === "std::string") return { kind: "string" };
  const list = /^(?:std::)?vector<(.+)>$/.exec(text);
  if (list) {
    const item = cppType(list[1]);
    return item ? { kind: "list", item } : null;
  }
  return /^(?:unsigned\s+)?(?:int|long|short|size_t|long long)$/.test(text) ? { kind: "int" } : null;
}

function rustType(raw: string): NativeType | null {
  const text = raw.trim().replace(/^&mut\s+/, "").replace(/^&(?!(?:str|\[))/, "").trim();
  if (/^(?:Option<)?Box<TreeNode>>$/.test(text)) return { kind: "node", tree: true };
  if (/^(?:Option<)?Box<ListNode>>$/.test(text)) return { kind: "node", tree: false };
  const opt = /^Option<(.+)>$/.exec(text);
  if (opt) { const item = rustType(opt[1]); return item ? { kind: "optional", item } : null; }
  if (text === "()" || text === "void") return { kind: "void" };
  if (text === "bool") return { kind: "bool" };
  if (text === "f32" || text === "f64") return { kind: "float" };
  if (text === "String" || text === "&str" || text === "str") return { kind: "string" };
  const list = /^Vec<(.+)>$/.exec(text);
  if (list) {
    const item = rustType(list[1]);
    return item ? { kind: "list", item } : null;
  }
  if (/^(?:i|u)(?:8|16|32|64|size)$/.test(text)) return { kind: "int" };
  return null;
}

function nativeLiteral(type: NativeType, value: unknown, language: "cpp" | "rust"): string | null {
  if (type.kind === "node") {
    if (!Array.isArray(value)) return null;
    const items = value.map((item) => item === null ? "null" : Number.isInteger(item) ? String(item) : null);
    if (items.some((item) => item === null)) return null;
    if (language === "cpp") {
      return type.tree
        ? `ca_tree(std::vector<std::optional<long long>>{${items.map((item) => item === "null" ? "std::nullopt" : item).join(", ")}})`
        : `ca_list(std::vector<long long>{${items.join(", ")}})`;
    }
    return type.tree
      ? `ca_tree(&vec![${items.map((item) => item === "null" ? "None" : `Some(${item})`).join(", ")}])`
      : `ca_list(&vec![${items.join(", ")}])`;
  }
  if (type.kind === "optional") {
    if (value === null) return language === "cpp" ? "std::nullopt" : "None";
    const inner = nativeLiteral(type.item, value, language);
    return inner === null ? null : (language === "cpp" ? `std::optional<${cppTypeName(type.item)}>{${inner}}` : `Some(${inner})`);
  }
  if (type.kind === "list") {
    if (!Array.isArray(value)) return null;
    const items = value.map((item) => nativeLiteral(type.item, item, language));
    if (items.some((item) => item === null)) return null;
    return language === "cpp"
      ? `std::vector<${cppTypeName(type.item)}>{${items.join(", ")}}`
      : `vec![${items.join(", ")}]`;
  }
  if (type.kind === "bool") return typeof value === "boolean" ? String(value) : null;
  if (type.kind === "float") return typeof value === "number" ? `${value}` : null;
  if (type.kind === "int") return Number.isInteger(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  return language === "cpp" ? JSON.stringify(value) : `String::from(${JSON.stringify(value)})`;
}

function cppDeclLiteral(decl: string, value: unknown): string | null {
  const list = /^(?:std::)?vector<(.+)>$/.exec(decl.trim());
  if (list) {
    if (!Array.isArray(value)) return null;
    const inner = list[1].trim();
    const items = value.map((item) => cppDeclLiteral(inner, item));
    if (items.some((item) => item === null)) return null;
    return `${decl.trim()}{${items.join(", ")}}`;
  }
  return nativeLiteral(cppType(decl) || { kind: "int" }, value, "cpp");
}

function splitParams(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "<" || character === "(") depth += 1;
    if (character === ">" || character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(raw.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function cppArguments(raw: string): NativeArgument[] | null {
  const args: NativeArgument[] = [];
  for (const param of splitParams(raw)) {
    const match = /^(.*?)([A-Za-z_]\w*)\s*$/.exec(param.trim());
    if (!match || !match[1].trim()) return null;
    const type = cppType(match[1]);
    if (!type) return null;
    args.push({ name: match[2], type, decl: match[1].replace(/\bconst\b/g, "").replace(/[&\s]+/g, " ").trim() });
  }
  return args;
}

function nativeValue(fixture: ProvidedFixture, argument: NativeArgument, position: number): unknown {
  if (Array.isArray(fixture.args) && position < fixture.args.length) return fixture.args[position];
  const kwargs = fixture.kwargs || {};
  if (Object.hasOwn(kwargs, argument.name)) return kwargs[argument.name];
  // Candidates rename parameters (nums -> n); fall back to declaration order.
  const values = Object.values(kwargs);
  return position < values.length ? values[position] : undefined;
}

export function cppSignature(code: string): NativeSignature | null {
  const classAt = code.search(/\bclass\s+Solution\b/);
  if (classAt >= 0) {
    const brace = code.indexOf("{", classAt);
    const body = code.slice(brace + 1).replace(/\b(?:public|private|protected)\s*:/g, "");
    const method = /([A-Za-z_][\w:<>,*\s]*?(?:<[^>]*>)?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:const\s*)?\{/.exec(body);
    if (!method || method[2] === "Solution") return null;
    const args = cppArguments(method[3]);
    const ret = cppType(method[1]);
    if (!ret || !args) return null;
    return { name: method[2], args, ret, retDecl: method[1].trim(), owner: "class", receiver: true };
  }
  const free = /^\s*(?:static\s+)?([A-Za-z_][\w:<>,\s]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/m.exec(code);
  if (!free || free[2] === "main") return null;
  const args = cppArguments(free[3]);
  const ret = cppType(free[1]);
  if (!ret || !args) return null;
  return { name: free[2], args, ret, retDecl: free[1].trim(), owner: "free", receiver: false };
}

export function rustSignature(code: string): NativeSignature | null {
  const implAt = code.search(/\bimpl\s+Solution\s*\{/);
  const source = implAt >= 0 ? code.slice(implAt) : code;
  const method = /\bpub\s+fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\{/.exec(source);
  if (!method || method[1] === "main") return null;
  const params = splitParams(method[2]);
  const receiver = params.some((part) => /^&?\s*(?:mut\s+)?self\b/.test(part));
  const valueParams = params.filter((part) => !/^&?\s*(?:mut\s+)?self\b/.test(part));
  const args: NativeArgument[] = [];
  for (const param of valueParams) {
    const [rawName, ...rest] = param.split(":");
    const type = rustType(rest.join(":"));
    if (!type || !rawName.trim()) return null;
    args.push({ name: rawName.trim().replace(/^mut\s+/, ""), type, decl: rest.join(":").trim() });
  }
  const ret = method[3] ? rustType(method[3]) : { kind: "void" } as NativeType;
  if (!ret) return null;
  return { name: method[1], args, ret, retDecl: (method[3] || "()").trim(), owner: implAt >= 0 ? "class" : "free", receiver };
}

function cppDriver(signature: NativeSignature, fixtures: ProvidedFixture[], unordered: boolean, source: string, fields: { list: NodeFields; tree: NodeFields }): string | null {
  const lf = fields.list;
  const tf = fields.tree;
  const inPlace = signature.ret.kind === "void";
  const firstNode = signature.args.find((argument) => argument.type.kind === "node" && /&mut|\*/.test(argument.decl))
    || signature.args.find((argument) => argument.type.kind === "node");
  const outType = inPlace ? firstNode?.type : signature.ret;
  if (!outType || outType.kind !== "node" && inPlace) return null;
  const blocks: string[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const declarations: string[] = [];
    for (const [position, argument] of signature.args.entries()) {
      const literal = cppDeclLiteral(argument.decl, nativeValue(fixture, argument, position));
      if (literal === null) return null;
      declarations.push(`    ${argument.decl} a${position} = ${literal};`);
    }
    const expected = cppDeclLiteral(outType.kind === "node" ? cppTypeName(outType) : signature.retDecl, fixture.expected);
    if (expected === null) return null;
    const args = signature.args.map((_, position) => `a${position}`).join(", ");
    const call = signature.owner === "class" ? `solution.${signature.name}(${args})` : `${signature.name}(${args})`;
    const comparedList = (inPlace ? outType.kind : signature.ret.kind) === "list";
  const sort = unordered && comparedList ? "    std::sort(actualOut.begin(), actualOut.end());\n    std::sort(expectedOut.begin(), expectedOut.end());\n" : "";
    const serialized = signature.ret.kind === "node";
    const serial = outType.kind === "node" && outType.tree ? "tree" : "list";
    const outcome = inPlace
      ? [`    ${call};`, `    auto actualOut = ca_ser_${serial}(a0);`, `    auto expectedOut = ca_ser_${serial}(${expected});`]
      : serialized
        ? [`    auto actual = ${call};`, `    auto actualOut = ca_ser_${serial}(actual);`, `    auto expectedOut = ca_ser_${serial}(${expected});`]
        : [`    ${signature.retDecl} expectedOut = ${expected};`, `    auto actual = ${call};`, "    auto actualOut = actual;"];
    blocks.push([
      "  {",
      ...declarations,
      ...outcome,
      sort.replace(/\n$/, ""),
      `    bool ok = actualOut == expectedOut;`,
      "    if (ok) ++ca_passed; else ++ca_failed;",
      `    std::ostringstream a, e; ca_put(a, actualOut); ca_put(e, expectedOut);`,
      `    std::cout << "CA_CASE {\\"id\\":\\"${fixture.id}\\",\\"status\\":\\"" << (ok ? "passed" : "failed") << "\\",\\"expected\\":" << e.str() << ",\\"actual\\":" << a.str() << "}" << std::endl;`,
      "  }",
    ].filter(Boolean).join("\n"));
  }
  const instance = signature.owner === "class"
    ? `  std::vector<long long> unused;\n  (void)unused;`
    : "";
  const nodeStructs = [
    /(?:struct|class)\s+ListNode\b/.test(source) ? "" : "struct ListNode { long long val; ListNode* next; ListNode(long long v) : val(v), next(nullptr) {} };",
    /(?:struct|class)\s+TreeNode\b/.test(source) ? "" : "struct TreeNode { long long val; TreeNode* left; TreeNode* right; TreeNode(long long v) : val(v), left(nullptr), right(nullptr) {} };",
  ].filter(Boolean).join("\n");
  const nodeFunctions = [
    `static ListNode* ca_list(const std::vector<long long>& values) { ListNode* head = nullptr; ListNode** tail = &head; for (long long value : values) { *tail = new ListNode(value); tail = &(*tail)->${lf.next}; } return head; }`,
    `static TreeNode* ca_tree(const std::vector<std::optional<long long>>& values) { if (values.empty() || !values[0]) return nullptr; TreeNode* root = new TreeNode(*values[0]); std::queue<TreeNode*> queue; queue.push(root); size_t index = 1; while (!queue.empty() && index < values.size()) { TreeNode* parent = queue.front(); queue.pop(); for (int side = 0; side < 2 && index < values.size(); ++side) { auto item = values[index++]; if (!item) continue; TreeNode* child = new TreeNode(*item); if (side == 0) parent->${tf.left} = child; else parent->${tf.right} = child; queue.push(child); } } return root; }`,
    `static std::vector<long long> ca_ser_list(ListNode* node) { std::vector<long long> out; while (node) { out.push_back(node->${lf.value}); node = node->${lf.next}; } return out; }`,
    `static std::vector<std::optional<long long>> ca_ser_tree(TreeNode* root) { std::vector<std::optional<long long>> out; if (!root) return out; out.push_back(root->${tf.value}); std::queue<TreeNode*> queue; queue.push(root); while (!queue.empty()) { TreeNode* node = queue.front(); queue.pop(); for (TreeNode* child : {node->${tf.left}, node->${tf.right}}) { if (!child) { out.push_back(std::nullopt); continue; } out.push_back(child->${tf.value}); queue.push(child); } } while (!out.empty() && !out.back()) out.pop_back(); return out; }`,
  ].filter(Boolean).join("\n");
  return [
    "#include <algorithm>",
    "#include <iostream>",
    "#include <sstream>",
    "#include <string>",
    "#include <vector>",
    "#include <optional>",
    "#include <queue>",
    "using namespace std;",
    nodeStructs,
    "static void ca_put(ostringstream& o, bool v) { o << (v ? \"true\" : \"false\"); }",
    "static void ca_put(ostringstream& o, const string& v) { o << '\"'; for (char c : v) { if (c == '\"' || c == '\\\\') o << '\\\\'; o << c; } o << '\"'; }",
    "template <class T> static void ca_put(ostringstream& o, const T& v) { o << v; }",
    "template <class T> static void ca_put(ostringstream& o, const vector<T>& v) { o << '['; for (size_t i = 0; i < v.size(); ++i) { if (i) o << ','; ca_put(o, v[i]); } o << ']'; }",
    "template <class T> static void ca_put(ostringstream& o, const optional<T>& v) { if (!v) o << \"null\"; else ca_put(o, *v); }",
    "",
    "<<<SOLUTION>>>",
    "",
    nodeFunctions,
    "",
    "int main() {",
    "  int ca_passed = 0, ca_failed = 0;",
    instance,
    "  Solution solution;".replace("Solution solution;", signature.owner === "class" ? "  Solution solution;" : ""),
    ...blocks,
    '  std::cout << "CA_DONE {\\"cases\\":" << (ca_passed + ca_failed) << ",\\"passed\\":" << ca_passed << ",\\"failed\\":" << ca_failed << "}" << std::endl;',
    "  return ca_failed ? 1 : 0;",
    "}",
  ].filter((line) => line !== "").join("\n");
}

function rustDriver(signature: NativeSignature, fixtures: ProvidedFixture[], unordered: boolean, declareSolution: boolean, source: string, fields: { list: NodeFields; tree: NodeFields }): string | null {
  const lf = fields.list;
  const tf = fields.tree;
  const inPlaceOwn = signature.ret.kind === "void";
  const firstNodeOwn = signature.args.find((argument) => argument.type.kind === "node" && argument.decl.startsWith("&mut"))
    || signature.args.find((argument) => argument.type.kind === "node");
  const outTypeOwn = inPlaceOwn ? firstNodeOwn?.type : signature.ret;
  if (inPlaceOwn && (!outTypeOwn || outTypeOwn.kind !== "node")) return null;
  const blocks: string[] = [];
  for (const fixture of fixtures) {
    const declarations: string[] = [];
    for (const [position, argument] of signature.args.entries()) {
      const literal = nativeLiteral(argument.type, nativeValue(fixture, argument, position), "rust");
      if (literal === null) return null;
      declarations.push(`    let ${argument.decl.startsWith("&mut") ? "mut " : ""}a${position} = ${literal};`);
    }
    const expected = nativeLiteral(inPlaceOwn ? outTypeOwn! : signature.ret, fixture.expected, "rust");
    if (expected === null) return null;
    const args = signature.args.map((argument, position) =>
      argument.decl.startsWith("&mut") ? `&mut a${position}`
        : argument.decl.startsWith("&") ? `&a${position}` : `a${position}`).join(", ");
    const call = signature.owner === "class"
      ? (signature.receiver ? `solution.${signature.name}(${args})` : `Solution::${signature.name}(${args})`)
      : `${signature.name}(${args})`;
    const comparedList = (inPlaceOwn ? outTypeOwn?.kind : signature.ret.kind) === "list";
    const sort = unordered && comparedList ? "    actual_out.sort();\n    expected_out.sort();\n" : "";
    const nodeReturn = signature.ret.kind === "node";
    const serial = outTypeOwn?.kind === "node" && outTypeOwn.tree ? "tree" : "list";
    const comparedNode = inPlaceOwn || nodeReturn;
    const comparedIsList = !comparedNode && (inPlaceOwn ? outTypeOwn?.kind : signature.ret.kind) === "list";
    const fmtExpected = "expected_out.ca_json()";
    const fmtActual = "actual_out.ca_json()";
    const outcome = inPlaceOwn
      ? [`    ${call};`, `    let actual_out = ca_ser_${serial}(std::mem::take(&mut a0));`, `    let expected_out = ca_ser_${serial}(${expected});`]
      : nodeReturn
        ? [`    let actual = ${call};`, `    let actual_out = ca_ser_${serial}(actual);`, `    let expected_out = ca_ser_${serial}(${expected});`]
        : [`    let expected_out = ${expected};`, `    let actual = ${call};`, "    let actual_out = actual;"];
    blocks.push([
      "  {",
      ...declarations,
      ...outcome,
      sort.replace(/\n$/, ""),
      "    let ok = actual_out == expected_out;",
      "    if ok { ca_passed += 1 } else { ca_failed += 1 }",
      `    println!("CA_CASE {{\\"id\\":\\"${fixture.id}\\",\\"status\\":\\"{}\\",\\"expected\\":{},\\"actual\\":{}}}", if ok { "passed" } else { "failed" }, ${fmtExpected}, ${fmtActual});`,
      "  }",
    ].filter(Boolean).join("\n"));
  }
  return [
    signature.owner === "class" && declareSolution ? "struct Solution;" : "",
    /\bstruct\s+ListNode\b/.test(source) ? "" : "struct ListNode { val: i64, next: Option<Box<ListNode>> }",
    /\bstruct\s+TreeNode\b/.test(source) ? "" : "struct TreeNode { val: i64, left: Option<Box<TreeNode>>, right: Option<Box<TreeNode>> }",
    "<<<SOLUTION>>>",
    "",
    "fn ca_list(values: &Vec<i64>) -> Option<Box<ListNode>> {",
    "  let mut head: Option<Box<ListNode>> = None;",
    `  for value in values.iter().rev() { head = Some(Box::new(ListNode { ${lf.value}: *value, ${lf.next}: head })); }`,
    "  head",
    "}",
    "fn ca_tree(values: &Vec<Option<i64>>) -> Option<Box<TreeNode>> {",
    "  if values.is_empty() || values[0].is_none() { return None; }",
    "  let mut left: Vec<Option<usize>> = vec![None; values.len()];",
    "  let mut right: Vec<Option<usize>> = vec![None; values.len()];",
    "  let mut queue: std::collections::VecDeque<usize> = std::collections::VecDeque::from([0usize]);",
    "  let mut index = 1usize;",
    "  while let Some(parent) = queue.pop_front() {",
    "    for side in 0..2 {",
    "      if index >= values.len() { break; }",
    "      let child = index; index += 1;",
    "      if values[child].is_none() { continue; }",
    "      if side == 0 { left[parent] = Some(child); } else { right[parent] = Some(child); }",
    "      queue.push_back(child);",
    "    }",
    "  }",
    "  fn build(values: &Vec<Option<i64>>, left: &Vec<Option<usize>>, right: &Vec<Option<usize>>, at: usize) -> Option<Box<TreeNode>> {",
    "    Some(Box::new(TreeNode {",
    `      ${tf.value}: values[at]?,`,
    `      ${tf.left}: left[at].and_then(|child| build(values, left, right, child)),`,
    `      ${tf.right}: right[at].and_then(|child| build(values, left, right, child)),`,
    "    }))",
    "  }",
    "  build(values, &left, &right, 0)",
    "}",
    "fn ca_ser_list(mut node: Option<Box<ListNode>>) -> Vec<i64> {",
    "  let mut out = Vec::new();",
    `  while let Some(current) = node { out.push(current.${lf.value}); node = current.${lf.next}; }`,
    "  out",
    "}",
    "fn ca_ser_tree(root: Option<Box<TreeNode>>) -> Vec<Option<i64>> {",
    "  let mut out = Vec::new();",
    "  let mut queue: Vec<Option<Box<TreeNode>>> = vec![root];",
    "  let mut index = 0;",
    "  while index < queue.len() {",
    "    match queue[index].take() {",
    `      Some(node) => { out.push(Some(node.${tf.value})); queue.push(node.${tf.left}); queue.push(node.${tf.right}); }`,
    "      None => out.push(None),",
    "    }",
    "    index += 1;",
    "  }",
    "  while matches!(out.last(), Some(None)) { out.pop(); }",
    "  out",
    "}",
    "trait CaJson { fn ca_json(&self) -> String; }",
    "impl CaJson for i64 { fn ca_json(&self) -> String { self.to_string() } }",
    "impl CaJson for i32 { fn ca_json(&self) -> String { self.to_string() } }",
    "impl CaJson for u32 { fn ca_json(&self) -> String { self.to_string() } }",
    "impl CaJson for u64 { fn ca_json(&self) -> String { self.to_string() } }",
    "impl CaJson for usize { fn ca_json(&self) -> String { self.to_string() } }",
    "impl CaJson for f64 { fn ca_json(&self) -> String { self.to_string() } }",
    "impl CaJson for f32 { fn ca_json(&self) -> String { self.to_string() } }",
    "impl CaJson for bool { fn ca_json(&self) -> String { self.to_string() } }",
    "impl CaJson for String { fn ca_json(&self) -> String { format!(\"{:?}\", self) } }",
    "impl CaJson for char { fn ca_json(&self) -> String { format!(\"{:?}\", self.to_string()) } }",
    "impl<T: CaJson> CaJson for Option<T> { fn ca_json(&self) -> String { match self { Some(inner) => inner.ca_json(), None => \"null\".to_string() } } }",
    "impl<T: CaJson> CaJson for Vec<T> { fn ca_json(&self) -> String { let parts: Vec<String> = self.iter().map(|item| item.ca_json()).collect(); format!(\"[{}]\", parts.join(\",\")) } }",
    "fn main() {",
    "  let mut ca_passed = 0usize; let mut ca_failed = 0usize;",
    signature.owner === "class" && signature.receiver ? "  let solution = Solution;" : "",
    ...blocks,
    "  println!(\"CA_DONE {{\\\"cases\\\":{},\\\"passed\\\":{},\\\"failed\\\":{}}}\", ca_passed + ca_failed, ca_passed, ca_failed);",
    "  if ca_failed > 0 { std::process::exit(1) }",
    "}",
  ].filter((line) => line !== "").join("\n");
}


interface NodeFields { value: string; next: string; left: string; right: string }

/** Judge starter code usually uses val/next or val/left/right; honour whatever
 * the file actually declares so a renamed field does not break the driver. */
export function nodeFields(source: string, tree: boolean, owner: "ListNode" | "TreeNode"): NodeFields {
  const fields: NodeFields = { value: "val", next: "next", left: "left", right: "right" };
  const at = source.search(new RegExp(`(?:class|struct)\\s+${owner}\\b`));
  if (at < 0) return fields;
  const brace = source.indexOf("{", at);
  const block = source.slice(brace + 1, source.indexOf("}", brace + 1) + 1 || undefined);
  // Python assigns through self.<field>; Rust and C++ declare <field>: or <field>;
  const names = [
    ...[...block.matchAll(/self\.(\w+)\s*=/g)].map((match) => match[1]),
    ...[...block.matchAll(/(?:pub\s+)?\b(\w+)\s*:/g)].map((match) => match[1]),
    ...[...block.matchAll(/[^;{}\n]+?\s+(\w+)\s*;/g)].map((match) => match[1]),
  ].filter((name) => !/^(?:self|Self|i32|i64|u32|u64|usize|f32|f64|bool|String|long|int|short|double)$/.test(name));
  for (const name of names) {
    if (/^(?:next|nxt|link)$/i.test(name)) fields.next = name;
    else if (/^left$/i.test(name)) fields.left = name;
    else if (/^right$/i.test(name)) fields.right = name;
  }
  const value = names.find((name) => !/^(?:next|nxt|link|left|right)$/i.test(name) && !/^_/.test(name));
  if (value) fields.value = value;
  return fields;
}


function contractFor(
  question: string, language: string, code: string, source: "provided" | "generated",
  fixtures: ProvidedFixture[], signature: NativeSignature | null, pythonName?: string,
): ReturnType<typeof buildContract> {
  const unordered = harnessOrderMode(question).unordered;
  const declared = /\b(?:class|struct)\s+(?:ListNode|TreeNode)\b/.test(code);
  if (!signature) {
    if (pythonName) {
      return buildContract({
        question, language, code, fixtureCount: fixtures.length,
        fixturesHaveExpected: fixtures.every((fixture) => Object.hasOwn(fixture, "expected") || Object.hasOwn(fixture, "output")),
        callable: true, stdinContract: false, unordered, source,
        nodeKind: false, nodeDeclared: false,
      } as never);
    }
    return buildContract({
      question, language, code, fixtureCount: fixtures.length,
      fixturesHaveExpected: fixtures.every((fixture) => Object.hasOwn(fixture, "expected") || Object.hasOwn(fixture, "output")),
      callable: false, stdinContract: true, unordered, source,
      nodeKind: false, nodeDeclared: declared,
    } as never);
  }
  const mutating = signature.ret.kind === "void"
    ? signature.args.find((argument) => /&mut|\*/.test(argument.decl))?.name ?? null : null;
  return buildContract({
    question, language, code, fixtureCount: fixtures.length,
    fixturesHaveExpected: fixtures.every((fixture) => Object.hasOwn(fixture, "expected") || Object.hasOwn(fixture, "output")),
    callable: true, stdinContract: false,
    unordered, source,
    nodeKind: signature.ret.kind === "node" || signature.args.some((argument) => argument.type.kind === "node"),
    nodeDeclared: declared,
    signature: {
      name: signature.name,
      args: signature.args.map((argument) => ({ name: argument.name, decl: argument.decl, type: argument.type.kind })),
      ret: signature.retDecl,
      mutates: mutating,
      owner: signature.owner,
    },
  });
}

/** Bump whenever a template or comparison rule changes. */
import { bestTemplate } from "./harnessRegistry.ts";
import { buildContract, contractIdentity } from "./problemContract.ts";

export const HARNESS_ENGINE_VERSION = "v2.6";

/** Stable identity for the contract a harness was built for. */
export function contractHash(question: string, fixtures: ProvidedFixture[]): string {
  // Browser-safe and stable: two FNV-1a lanes, not a cryptographic digest.
  const material = [HARNESS_ENGINE_VERSION, String(question || ""),
    ...fixtures.flatMap((fixture) => [String(fixture.input), String(fixture.output)])].join("\u0000");
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const character of material) {
    const code = character.codePointAt(0) ?? 0;
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b ^ code, 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const MAX_CASES = 16;
const MAX_SOURCE_CHARS = 6000;
const LABEL = /^\s*(?:sample\s+)?(?:(?:arg(?:ument)?s?)|(?:input)|(?:returns?|output|result|expected(?:\s+(?:output|result))?))\s*:\s*(.*)$/i;
const INLINE_LABEL = /\b(?:sample\s+)?(?:(?:arg(?:ument)?s?)|input|output|returns?|result|expected(?:\s+(?:output|result))?)\s*:/gi;
export const MIN_GENERATED_HARNESS_CASES = 8;

function splitTopLevel(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let quoted = "";
  let escaped = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quoted) quoted = "";
    } else if (ch === '"' || ch === "'") quoted = ch;
    else if (ch === "[" || ch === "{" || ch === "(") depth += 1;
    else if (ch === "]" || ch === "}" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      result.push(text.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) return [];
  }
  if (depth !== 0 || quoted) return [];
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}

function literal(text: string): unknown {
  const normalized = text.trim()
    .replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null");
  // Never eval content transcribed from a screenshot.
  return JSON.parse(normalized);
}

function callableInputs(text: string): { args: unknown[]; kwargs: Record<string, unknown> } | null {
  try {
    const segments = splitTopLevel(text);
    if (!segments.length || segments.length > 12) return null;
    const kwargs: Record<string, unknown> = Object.create(null);
    const args: unknown[] = [];
    for (const part of segments) {
      const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([\s\S]+)$/.exec(part);
      if (match) {
        if (Object.hasOwn(kwargs, match[1]) || args.length) return null;
        kwargs[match[1]] = literal(match[2]);
      } else {
        if (Object.keys(kwargs).length) return null;
        args.push(literal(part));
      }
    }
    return { args, kwargs };
  } catch {
    return null;
  }
}

/** Extract only actual labelled sample values from the transcribed question. */
export function extractProvidedFixtures(question: string): ProvidedFixture[] {
  // Vision readers often flatten a screenshot's layout into one line, e.g.
  // "Example 1: Input: ... Output: ...". Split only at explicit field labels
  // before parsing; values themselves are kept verbatim and never evaluated.
  const lines = String(question || "").slice(0, 40_000).split(/\r?\n/).flatMap((line) => {
    const labels = [...line.matchAll(INLINE_LABEL)];
    if (labels.length < 2) return [line];
    const result: string[] = [];
    let start = 0;
    for (const label of labels) {
      const index = label.index ?? 0;
      if (index > start) result.push(line.slice(start, index).trimEnd());
      start = index;
    }
    result.push(line.slice(start));
    return result.filter(part => part.trim());
  });
  const pairs: ProvidedFixture[] = [];
  let input: string | null = null;
  let output: string | null = null;
  let mode: "input" | "output" | null = null;
  const finish = () => {
    if (input !== null && output !== null && pairs.length < MAX_CASES) {
      const rawInput = input.trim();
      const rawOutput = output.trim();
      if (rawInput && rawOutput && rawInput.length <= MAX_SOURCE_CHARS && rawOutput.length <= MAX_SOURCE_CHARS) {
        const parsed = callableInputs(rawInput);
        let expected: unknown;
        let expectedValid = false;
        try { expected = literal(rawOutput); expectedValid = true; } catch { /* stdin text is still usable */ }
        pairs.push({
          id: "provided_" + (pairs.length + 1),
          input: rawInput,
          output: rawOutput,
          ...(parsed && expectedValid ? { args: parsed.args, kwargs: parsed.kwargs, expected } : {}),
        });
      }
    }
    input = null;
    output = null;
    mode = null;
  };
  const ARROW = /^\s*(.+?)\s*(?:=>|->)\s*(.+?)\s*$/;
  for (const line of lines) {
    // "nums = [2,7], target = 9 => [0,1]" is a complete case on one line. The
    // signature also uses "->", so skip lines that define one.
    const arrow = !/^\s*(?:def|class|function|fn|public|private|static)\b/.test(line) && ARROW.exec(line);
    if (arrow && !/^\s*(?:example|input|output|sample|note)\b/i.test(line) && pairs.length < MAX_CASES) {
      const rawInput = arrow[1].trim();
      const rawOutput = arrow[2].replace(/^["'`]|["'`]$/g, "").trim();
      try {
        const expected = literal(rawOutput);
        const parsed = callableInputs(rawInput);
        pairs.push({
          id: "provided_" + (pairs.length + 1), input: rawInput, output: rawOutput,
          ...(parsed ? { args: parsed.args, kwargs: parsed.kwargs, expected } : {}),
        });
        continue;
      } catch { /* fall through to the label parser */ }
    }
    const label = LABEL.exec(line);
    if (label) {
      const isInput = /arg|input/i.test(line.split(":")[0]);
      if (isInput) {
        finish();
        input = label[1];
        mode = "input";
      } else if (input !== null) {
        output = label[1];
        mode = "output";
      }
      continue;
    }
    if (/^\s*(?:example|test case|sample|explanation|constraints|note)\b/i.test(line)) {
      finish();
      continue;
    }
    if (mode === "input" && input !== null) input += "\n" + line;
    if (mode === "output" && output !== null) output += "\n" + line;
  }
  finish();
  // Repeated screenshots of the same example do not inflate evidence.
  const seen = new Set<string>();
  return pairs.filter(pair => {
    const key = JSON.stringify([pair.input, pair.output]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((pair, index) => ({ ...pair, id: "provided_" + (index + 1) }));
}

function callableName(code: string): string | null {
  if (/^\s*from\s+__future__\s+import\s+/m.test(code)) return null;
  const lines = code.split(/\r?\n/);
  const classIndex = lines.findIndex(line => /^\s*class\s+Solution\s*(?:\([^)]*\))?\s*:\s*(?:#.*)?$/.test(line));
  if (classIndex >= 0) {
    const classIndent = lines[classIndex].match(/^\s*/)?.[0].length ?? 0;
    for (const line of lines.slice(classIndex + 1)) {
      if (line.trim() && !/^\s*#/.test(line) && (line.match(/^\s*/)?.[0].length ?? 0) <= classIndent) break;
      const method = /^([ \t]+)def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      if (method && method[2] !== "__init__" && !method[2].startsWith("_")) return method[2];
    }
  }
  const standalone = /(?:^|\n)def\s+([a-zA-Z_]\w*)\s*\(/.exec(code);
  return standalone && !standalone[1].startsWith("_") ? standalone[1] : null;
}

const ANY_ORDER = /\b(?:any order|in any order|arbitrary order|order does not matter|any one)\b/i;
const HARD_TO_COMPARE = /\b(?:any valid|multiple valid|modify in.place|in.place modification|do not return anything)\b/i;

/** Equality-based cases cannot validate a contract that permits several
 * correct representations. Ordering-only contracts are still comparable once
 * both sides are normalized. */
export function harnessOrderMode(question: string): { unordered: boolean; comparable: boolean } {
  const text = String(question || "");
  return { unordered: ANY_ORDER.test(text), comparable: !HARD_TO_COMPARE.test(text) };
}

function pythonDriver(fixtures: ProvidedFixture[], mode: "callable" | "stdin", language: string, method?: string, unordered = false, node?: PythonNodeSpec | null, reference = "", fuzzCount = 0): string {
  // The replacement is an escaped JSON string literal. Candidate text is not
  // interpolated into Python syntax and cannot break the driver string.
  const payload = JSON.stringify(fixtures.map(pair => mode === "callable"
    ? { id: pair.id, args: pair.args, kwargs: pair.kwargs, expected: pair.expected }
    : { id: pair.id, input: pair.input, expected: pair.output }));
  const methodLiteral = JSON.stringify(method || "");
  const driver = [
    "import copy, json, os, subprocess, sys, tempfile",
    "CA_SOURCE = <<<SOLUTION>>>",
    "CA_CASES = json.loads(" + JSON.stringify(payload) + ")",
    "CA_MODE = " + JSON.stringify(mode),
    "CA_LANGUAGE = " + JSON.stringify(language),
    "CA_METHOD = " + methodLiteral,
    "CA_UNORDERED = " + (unordered ? "True" : "False"),
    "CA_NODE = json.loads(" + JSON.stringify(JSON.stringify(node || null)) + ")",
    "CA_REFERENCE = " + JSON.stringify(reference || ""),
    "CA_FUZZ = " + String(fuzzCount || 0),
    "import random",
    "random.seed(17)",
    "CA_NODE_VALUE = (CA_NODE or {}).get('fields', {}).get('value', 'val')",
    "CA_NODE_NEXT = (CA_NODE or {}).get('fields', {}).get('next', 'next')",
    "CA_NODE_LEFT = (CA_NODE or {}).get('fields', {}).get('left', 'left')",
    "CA_NODE_RIGHT = (CA_NODE or {}).get('fields', {}).get('right', 'right')",
    "scope = {}",
    "def ca_build(value, tree):",
    "    name = 'TreeNode' if tree else 'ListNode'",
    "    cls = scope.get(name)",
    "    if cls is None:",
    "        def ca_init(self, v=0, **extra):",
    "            setattr(self, CA_NODE_VALUE, v); setattr(self, CA_NODE_LEFT, extra.get('left')); setattr(self, CA_NODE_RIGHT, extra.get('right')); setattr(self, CA_NODE_NEXT, extra.get('next'))",
    "        cls = type(name, (), {'__init__': ca_init}); scope[name] = cls",
    "    if not value: return None",
    "    if tree:",
    "        root = None if value[0] is None else cls(value[0])",
    "        if root is None: return None",
    "        setattr(root, CA_NODE_LEFT, None); setattr(root, CA_NODE_RIGHT, None)",
    "        queue, index = [root], 1",
    "        while queue and index < len(value):",
    "            parent = queue.pop(0)",
    "            for side in (CA_NODE_LEFT, CA_NODE_RIGHT):",
    "                if index >= len(value): break",
    "                item = value[index]; index += 1",
    "                if item is None: setattr(parent, side, None); continue",
    "                node = cls(item)",
    "                setattr(node, CA_NODE_LEFT, None); setattr(node, CA_NODE_RIGHT, None)",
    "                setattr(parent, side, node); queue.append(node)",
    "        return root",
    "    head = tail = None",
    "    for item in value:",
    "        node = cls(item)",
    "        setattr(node, CA_NODE_NEXT, None)",
    "        if tail is None: head = node",
    "        else: setattr(tail, CA_NODE_NEXT, node)",
    "        tail = node",
    "    return head",
    "def ca_ser(node, tree):",
    "    if node is None: return []",
    "    if not tree:",
    "        out = []",
    "        while node is not None: out.append(getattr(node, CA_NODE_VALUE)); node = getattr(node, CA_NODE_NEXT, None)",
    "        return out",
    "    out, queue = [getattr(node, CA_NODE_VALUE)], [node]",
    "    while queue:",
    "        current = queue.pop(0)",
    "        for side in (CA_NODE_LEFT, CA_NODE_RIGHT):",
    "            child = getattr(current, side, None)",
    "            if child is None: out.append(None)",
    "            else:",
    "                out.append(getattr(child, CA_NODE_VALUE)); queue.append(child)",
    "    while out and out[-1] is None: out.pop()",
    "    return out",
    "def ca_profile():",
    "    ints, lengths, sorted_lists, nonneg, unique = [], [], True, True, True",
    "    for case in CA_CASES:",
    "        for value in (case.get('args') or []) + list((case.get('kwargs') or {}).values()):",
    "            values = value if isinstance(value, list) else [value]",
    "            if isinstance(value, list): lengths.append(len(value)); unique = unique and len(value) == len({json.dumps(item, sort_keys=True, default=str) for item in value})",
    "            if isinstance(value, list) and all(item is not None for item in value):",
    "                try: sorted_lists = sorted_lists and value == sorted(value)",
    "                except TypeError: sorted_lists = False",
    "            for item in values:",
    "                if isinstance(item, int) and not isinstance(item, bool):",
    "                    ints.append(item); nonneg = nonneg and item >= 0",
    "    lo = min(ints) if ints else 0; hi = max(ints) if ints else 20",
    "    return {'lo': lo, 'hi': hi, 'minlen': min(lengths) if lengths else 0, 'maxlen': max(lengths) if lengths else 5, 'sorted': sorted_lists, 'nonneg': nonneg, 'unique': unique}",
    "CA_PROFILE = ca_profile()",
    "def ca_random(value):",
    "    if isinstance(value, bool): return random.choice([True, False])",
    "    if isinstance(value, int):",
    "        low = 0 if CA_PROFILE['nonneg'] else CA_PROFILE['lo']",
    "        high = max(CA_PROFILE['hi'], low)",
    "        return random.randint(low, high)",
    "    if isinstance(value, float): return round(random.uniform(-5.0, 5.0), 2)",
    "    if isinstance(value, str): return random.choice(['', 'a', 'ab', 'abc'])",
    "    if isinstance(value, list):",
    "        size = random.randint(CA_PROFILE['minlen'], CA_PROFILE['maxlen'])",
    "        out = [ca_random(random.choice(value) if value else 0) for _ in range(size)]",
    "        if CA_PROFILE['unique']: out = list({json.dumps(item, sort_keys=True, default=str): item for item in out}.values())",
    "        if CA_PROFILE['sorted']: out.sort()",
    "        return out",
    "    return value",
    "def ca_shrink_args(args):",
    "    out = []",
    "    for value in args:",
    "        if isinstance(value, list) and len(value) > 1: out.append(value[: max(1, len(value) // 2)])",
    "        elif isinstance(value, int) and not isinstance(value, bool): out.append(value // 2)",
    "        else: out.append(value)",
    "    return out",
    "def ca_norm(value):",
    "    if isinstance(value, list):",
    "        return sorted((ca_norm(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True, default=str))",
    "    if isinstance(value, dict):",
    "        return {key: ca_norm(item) for key, item in value.items()}",
    "    return value",
    "def ca_test(case, actual):",
    "    expected = case['expected']",
    "    ok = (ca_norm(actual) == ca_norm(expected)) if CA_UNORDERED else (actual == expected)",
    "    print(('PASS ' if ok else 'FAIL ') + case['id'])",
    "    trace_input = case['input'] if 'input' in case else {'args': case.get('args'), 'kwargs': case.get('kwargs')} ",
    "    print('CA_CASE ' + json.dumps({'id': case['id'], 'input': trace_input, 'expected': expected, 'actual': actual, 'status': 'passed' if ok else 'failed'}, default=str))",
    "    return ok",
    "def ca_execute():",
    "    if CA_MODE == 'callable':",
    "        scope.update({'__name__': '__council_candidate__'})",
    "        from typing import List, Optional, Dict, Tuple, Set",
    "        scope.update({'List': List, 'Optional': Optional, 'Dict': Dict, 'Tuple': Tuple, 'Set': Set})",
    "        exec(compile(CA_SOURCE, '<candidate>', 'exec'), scope)",
    "        target = scope['Solution']() if 'Solution' in scope else scope",
    "        if CA_METHOD:",
    "            method = getattr(target, CA_METHOD) if not isinstance(target, dict) else target[CA_METHOD]",
    "        elif not isinstance(target, dict):",
    "            names = [name for name in dir(target) if not name.startswith('_') and callable(getattr(target, name, None))]",
    "            method = getattr(target, names[0]) if names else None",
    "        else:",
    "            names = [name for name, value in target.items() if not name.startswith('_') and callable(value)]",
    "            method = target[names[0]] if names else None",
    "        if method is None: raise RuntimeError('No public callable found in candidate')",
    "        ref = None",
    "        if CA_REFERENCE:",
    "            ref_scope = {'__name__': '__council_reference__'}",
    "            try:",
    "                exec(compile(CA_REFERENCE, '<reference>', 'exec'), ref_scope)",
    "                ref = ref_scope.get(CA_METHOD) or next((v for k, v in ref_scope.items() if callable(v) and not k.startswith('_')), None)",
    "                if ref and CA_CASES:",
    "                    for probe_case in CA_CASES:",
    "                        if 'expected' not in probe_case: continue",
    "                        if ca_norm(ref(*copy.deepcopy(probe_case.get('args') or []))) != ca_norm(probe_case['expected']): ref = None; break",
    "            except Exception: ref = None",
    "        results = []",
    "        for case in CA_CASES:",
    "            if CA_NODE:",
    "                args = [copy.deepcopy(case['kwargs'][key]) for key in CA_NODE['order']]",
    "            else:",
    "                args = copy.deepcopy(case['args'])",
    "            for spec in (CA_NODE or {}).get('params', []):",
    "                args[spec['index']] = ca_build(args[spec['index']], spec['tree'])",
    "            result = method(*args) if CA_NODE else method(*args, **copy.deepcopy(case['kwargs']))",
    "            if CA_NODE and CA_NODE.get('inPlace'):",
    "                result = ca_ser(args[0], bool((CA_NODE.get('params') or [{}])[0].get('tree')))",
    "            if CA_NODE and (CA_NODE.get('returnsNode') or hasattr(result, CA_NODE_VALUE)):",
    "                result = ca_ser(result, bool((CA_NODE.get('params') or [{}])[0].get('tree')))",
    "            ok = ca_test(case, result)",
    "            results.append(ok)",
    "            if not ok and CA_NODE is None and ref is not None:",
    "                shrunk, expected_for_shrink = args, case['expected']",
    "                locally_min = True; hit_cap = True",
    "                for _ in range(3):",
    "                    variants = []",
    "                    for position, value in enumerate(shrunk):",
    "                        if isinstance(value, list) and len(value) > 1:",
    "                            for cut in range(len(value)):",
    "                                reduced = list(shrunk); reduced[position] = value[:cut] + value[cut + 1:]",
    "                                variants.append(reduced)",
    "                        elif isinstance(value, int) and not isinstance(value, bool) and value != 0:",
    "                            reduced = list(shrunk); reduced[position] = value // 2",
    "                            variants.append(reduced)",
    "                    smaller = None",
    "                    for candidate_args in variants:",
    "                        try: retry = method(*copy.deepcopy(candidate_args))",
    "                        except Exception: locally_min = False; continue",
    "                        if CA_REFERENCE:",
    "                            try: expected_for_shrink = ref(*copy.deepcopy(candidate_args))",
    "                            except Exception: continue",
    "                        else: expected_for_shrink = case['expected']",
    "                        if ca_norm(retry) != ca_norm(expected_for_shrink): smaller = (candidate_args, expected_for_shrink); break",
    "                    if not smaller: hit_cap = False; break",
    "                    shrunk, expected_for_shrink = smaller",
    "                print('CA_SHRUNK ' + json.dumps({'id': case['id'], 'args': shrunk, 'expected': expected_for_shrink, 'reduced': shrunk != args, 'locallyMinimized': locally_min}, default=str))",
    "        if ref and CA_FUZZ:",
    "            for index in range(CA_FUZZ):",
    "                base = copy.deepcopy(CA_CASES[index % len(CA_CASES)]['args'])",
    "                fuzz_args = [ca_random(value) for value in base]",
    "                try: expected = ref(*copy.deepcopy(fuzz_args))",
    "                except Exception: continue",
    "                actual = method(*copy.deepcopy(fuzz_args))",
    "                same = (ca_norm(actual) == ca_norm(expected)) if CA_UNORDERED else (actual == expected)",
    "                results.append(same)",
    "                print(('PASS fuzz_' if same else 'FAIL fuzz_') + str(index + 1))",
    "                print('CA_CASE ' + json.dumps({'id': 'fuzz_' + str(index + 1), 'input': fuzz_args, 'expected': expected, 'actual': actual, 'status': 'passed' if same else 'failed'}, default=str))",
    "        print('CA_DONE ' + json.dumps({'cases': len(results), 'passed': sum(1 for value in results if value), 'failed': sum(1 for value in results if not value)}))",
    "        return all(results)",
    "    with tempfile.TemporaryDirectory(prefix='council-fixtures-') as directory:",
    "        ext = {'python': '.py', 'cpp': '.cpp', 'rust': '.rs'}[CA_LANGUAGE]",
    "        src = os.path.join(directory, 'solution' + ext)",
    "        binary = os.path.join(directory, 'solution')",
    "        prelude = '#include <iostream>\\n#include <vector>\\n#include <string>\\n#include <algorithm>\\n#include <sstream>\\n' if CA_LANGUAGE == 'cpp' else ''",
    "        with open(src, 'w', encoding='utf-8') as file: file.write(prelude + CA_SOURCE)",
    "        command = {'python': [sys.executable, src], 'cpp': [binary], 'rust': [binary]}[CA_LANGUAGE]",
    "        if CA_LANGUAGE != 'python':",
    "            compiler = ['g++', '-std=c++23', '-O1', '-o', binary, src] if CA_LANGUAGE == 'cpp' else ['rustc', '--edition=2021', '-O', src, '-o', binary]",
    "            compilation = subprocess.run(compiler, text=True, capture_output=True, timeout=35, check=False)",
    "            if compilation.returncode:",
    "                print(compilation.stderr[:2000], file=sys.stderr)",
    "                raise RuntimeError('Candidate compilation failed')",
    "        passed = True",
    "        ca_ok = 0; ca_bad = 0",
    "        for case in CA_CASES:",
    "            result = subprocess.run(command, input=case['input'], text=True, capture_output=True, timeout=12, check=False)",
    "            if result.returncode:",
    "                print(result.stderr[:2000], file=sys.stderr)",
    "            one = ca_test(case, result.stdout.rstrip('\\r\\n') if result.returncode == 0 else '<nonzero exit>')",
    "            ca_ok += 1 if one else 0; ca_bad += 0 if one else 1",
    "            passed = one and passed",
    "        print('CA_DONE ' + json.dumps({'cases': len(CA_CASES), 'passed': ca_ok, 'failed': ca_bad}))",
    "        return passed",
    "if __name__ == '__main__':",
    "    try:",
    "        if not ca_execute(): sys.exit(1)",
    "    except Exception as error:",
    "        print('Harness V2 execution/adapter error: ' + str(error), file=sys.stderr)",
    "        sys.exit(2)",
  ];
  return driver.join("\n") + "\n";
}

/**
 * Compile a small model-authored JSON test specification into our fixed Python
 * runner. The model supplies data and an independent reference, never runner
 * code, so quoting/indentation/syntax failures cannot strand the Council.
 */
export function buildGeneratedPythonHarness(
  question: string,
  rawSpec: string,
  candidateCode = "",
): ProvidedSuite | null {
  const order = harnessOrderMode(question);
  if (!order.comparable) return null;
  let spec: Record<string, unknown>;
  try {
    const text = String(rawSpec || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    spec = JSON.parse(text.slice(first, last + 1));
  } catch { return null; }

  const referenceCode = [spec.reference_code, spec.referenceCode, spec.reference, spec.solution, spec.code]
    .find((value): value is string => typeof value === "string" && !!value.trim())?.trim() || "";
  if (!referenceCode || referenceCode.length > 24_000) return null;
  const rawCases = [spec.cases, spec.tests, spec.test_cases, spec.testCases]
    .find((value): value is unknown[] => Array.isArray(value)) || [];
  if (rawCases.length < MIN_GENERATED_HARNESS_CASES || rawCases.length > MAX_CASES) return null;
  const mode = spec.mode === "stdin" ? "stdin" : spec.mode === "callable" ? "callable" : null;
  if (!mode) return null;

  const supplied = extractProvidedFixtures(question);
  const cases: ProvidedFixture[] = [];
  const seen = new Set<string>();
  for (const [index, value] of rawCases.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    let fixture: ProvidedFixture;
    if (mode === "callable") {
      const args = Array.isArray(row.args) ? row.args : Array.isArray(row.input) ? row.input : [];
      const kwargs = row.kwargs && typeof row.kwargs === "object" && !Array.isArray(row.kwargs)
        ? row.kwargs as Record<string, unknown> : {};
      const hasExpected = Object.hasOwn(row, "expected") || Object.hasOwn(row, "output") || Object.hasOwn(row, "want");
      if (!hasExpected) return null;
      const expected = Object.hasOwn(row, "expected") ? row.expected : Object.hasOwn(row, "output") ? row.output : row.want;
      fixture = { id: `generated_${index + 1}`, input: JSON.stringify([args, kwargs]), output: JSON.stringify(expected), args, kwargs, expected };
    } else {
      const expectedOutput = typeof row.expected === "string" ? row.expected : typeof row.output === "string" ? row.output : null;
      if (typeof row.input !== "string" || expectedOutput === null) return null;
      fixture = { id: `generated_${index + 1}`, input: row.input, output: expectedOutput };
    }
    const key = JSON.stringify(mode === "callable" ? [fixture.args, fixture.kwargs] : fixture.input);
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push(fixture);
  }
  if (cases.length < MIN_GENERATED_HARNESS_CASES) return null;

  // If we could safely parse statement examples, require every one to appear
  // with its exact input and expected value. This prevents a JSON-mode answer
  // from silently dropping or rewriting the examples it was asked to preserve.
  if (supplied.length) {
    const retained = supplied.every(example => cases.some(test => mode === "callable"
      ? JSON.stringify([test.args, test.kwargs, test.expected]) === JSON.stringify([
          example.args?.length ? example.args : Object.values(example.kwargs || {}), {}, example.expected,
        ])
      : test.input === example.input && test.output === example.output));
    if (!retained) return null;
  }
  return {
    language: "python", runnerLanguage: "python", source: "generated",
    providedCaseCount: cases.length, question, candidateAsString: true,
    harness: pythonDriver(cases, mode, "python", callableName(candidateCode) || (typeof spec.method === "string" ? spec.method : undefined), order.unordered, null, typeof spec.reference_code === "string" ? spec.reference_code : "", mode === "callable" ? 6 : 0),
    unordered: order.unordered,
    harnessVersion: HARNESS_ENGINE_VERSION,
    contractHash: contractHash(question, cases),
    referenceCode,
  };
}

export function pythonHarnessJsonSystemPrompt(): string {
  return [
    "You design test DATA and an independent Python reference implementation for one coding problem.",
    "Do not write a test harness, assertions, runner, Markdown, or prose. Return one JSON object only.",
    'Schema: {"mode":"callable|stdin","method":"optional public method name","cases":[...],"reference_code":"complete independent Python implementation"}.',
    "For callable mode each case is {id,args:[JSON values],kwargs:{JSON values},expected:JSON value}.",
    "For stdin mode each case is {id,input:string,expected:string}; preserve exact statement examples.",
    `Return at least ${MIN_GENERATED_HARNESS_CASES} distinct cases and no more than ${MAX_CASES}; include all supplied examples exactly and add only contract-justified cases.`,
    "The reference_code must implement the exact problem interface, independently of the candidate solutions. Never invent a signature or expected result. If the contract cannot support a reliable oracle, return {\"error\":\"insufficient contract\"}.",
  ].join(" ");
}

export function buildProvidedHarness(question: string, language: string, candidateCode: string): ProvidedSuite | null {
  if (!["python", "cpp", "rust"].includes(language)) return null;
  // Multiple acceptable answers require a property comparator, not example equality.
  if (/\b(?:any order|any valid|multiple valid|in any order|any one|arbitrary order|order does not matter|modify in.place|in.place modification|do not return anything)\b/i.test(question)) return null;
  // Judge UI serializes trees/linked lists as arrays; a raw Python method
  // expects real nodes, not that displayed serialization.
  const fixtures = extractProvidedFixtures(question);
  if (!fixtures.length) return null;
  const code = String(candidateCode || "");
  const name = language === "python" ? callableName(code) : null;
  const registryEnabled = (globalThis as { __COUNCIL_HARNESS_REGISTRY__?: boolean }).__COUNCIL_HARNESS_REGISTRY__ !== false;
  const nodeSpec = registryEnabled && language === "python" && name ? pythonNodeSpec(question, code, name) : null;
  const signature = registryEnabled && language === "cpp" ? cppSignature(code)
    : registryEnabled && language === "rust" ? rustSignature(code) : null;
  const signatureText = signature
    ? `${signature.name}(${signature.args.map((argument) => argument.decl).join(", ")}) -> ${signature.retDecl}`
    : undefined;
  const scalarOnly = !fixtures.some((fixture) => [
    ...(fixture.args || []), ...Object.values(fixture.kwargs || {}),
  ].some(Array.isArray));
  const callableFamily = scalarOnly ? "callable-scalar" : "callable-vector";
  const callableFixtures = signature && fixtures.every((fixture) =>
    Object.hasOwn(fixture, "expected") &&
    signature.args.every((argument, position) => nativeValue(fixture, argument, position) !== undefined))
    ? fixtures : null;
  if (signature && callableFixtures) {
    const compiled = contractFor(question, language, code, "provided", callableFixtures, signature);
    if (!compiled.ok || !compiled.contract) return null;
    const treeShape = signature.ret.kind === "node" ? signature.ret.tree
      : signature.args.some((argument) => argument.type.kind === "node" && argument.type.tree);
    const fields = { list: nodeFields(code, false, "ListNode"), tree: nodeFields(code, true, "TreeNode") };
    const driver = language === "cpp"
      ? cppDriver(signature, callableFixtures, harnessOrderMode(question).unordered, code, fields)
      : rustDriver(signature, callableFixtures, harnessOrderMode(question).unordered, !/\bstruct\s+Solution\b/.test(code), code, fields);
    if (driver) return {
      language, runnerLanguage: language as "cpp" | "rust", source: "provided",
      providedCaseCount: callableFixtures.length,
      question, harness: driver, candidateAsString: false,
      unordered: harnessOrderMode(question).unordered,
      harnessVersion: HARNESS_ENGINE_VERSION,
      contractHash: contractIdentity(compiled.contract, callableFixtures),
      contract: compiled.contract,
      templateId: signature && (signature.ret.kind === "node" || signature.args.some((argument) => argument.type.kind === "node"))
        ? bestTemplate(language, "callable-node")?.id
        : bestTemplate(language, callableFamily)?.id,
      signature: signatureText,
    };
  }
  const callable = Boolean(name && fixtures.every(f => f.args && f.kwargs && Object.hasOwn(f, "expected")));
  // Executable stdin contracts only: never pass function-call examples to a stdin runner.
  const stdinContract = /\b(?:standard input|stdin|input format|reads? from input|prints? to output)\b/i.test(question);
  const isStandalone = language === "python"
    ? /\b(?:input\s*\(|sys\.stdin|readline\s*\()/i.test(code)
    : language === "cpp" ? /\bint\s+main\s*\(/.test(code) : /\bfn\s+main\s*\(/.test(code);
  const stdin = !callable && stdinContract && isStandalone && fixtures.every(f => !/(?:^|,)\s*[A-Za-z_]\w*\s*=/.test(f.input));
  if (!callable && !stdin) return null;
  const compiled = contractFor(question, language, code, "provided", fixtures, null, callable ? name || undefined : undefined);
  if (!compiled.ok || !compiled.contract) return null;
  return {
    language, runnerLanguage: "python", source: "provided",
    providedCaseCount: fixtures.length,
    question,
    harness: pythonDriver(fixtures, callable ? "callable" : "stdin", language, name || undefined, harnessOrderMode(question).unordered, nodeSpec),
    unordered: harnessOrderMode(question).unordered,
    harnessVersion: HARNESS_ENGINE_VERSION,
    contractHash: contractIdentity(compiled.contract, fixtures),
    contract: compiled.contract,
    templateId: nodeSpec ? "callable-node" : bestTemplate(language, callable ? callableFamily : "stdin")?.id,
  };
}

/** Supplied examples require exact coverage; generated suites retain the broader gate. */
export function requiredHarnessCases(suite: { source?: string; providedCaseCount?: number }): number {
  return suite.source === "provided"
    ? Math.max(1, Number(suite.providedCaseCount) || 0)
    : MIN_GENERATED_HARNESS_CASES;
}

/** Only accepted fixture IDs count; extra PASS text is not verification. */
export function providedCaseEvidence(stdout: string, required: number): { passed: number; failed: number; complete: boolean } {
  const rows = new Map<string, string>();
  let trailer: { cases?: number; passed?: number; failed?: number } | null = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (line.startsWith("CA_DONE ")) {
      try { trailer = JSON.parse(line.slice(8)); } catch { trailer = null; }
      continue;
    }
    if (!line.startsWith("CA_CASE ")) continue;
    try {
      const row = JSON.parse(line.slice(8));
      if (!/^(?:provided|fuzz)_[1-9]\d*$/.test(row.id) || !["passed", "failed"].includes(row.status) || rows.has(row.id)) continue;
      rows.set(row.id, row.status);
    } catch { /* malformed trace is not evidence */ }
  }
  let passed = 0;
  let failed_link = 0;
  for (const status of rows.values()) {
    if (status === "passed") passed += 1;
    else failed_link += 1;
  }
  let providedSeen = 0;
  for (let n = 1; n <= required; n += 1) {
    if (rows.has("provided_" + n)) providedSeen += 1;
  }
  // The trailer is written after every case by the driver; a candidate that
  // prints its own CA_CASE lines cannot quietly complete the run without it.
  const trailerOk = !!trailer && trailer.cases === passed + failed_link &&
    trailer.passed === passed && trailer.failed === failed_link;
  return { passed, failed: failed_link, complete: trailerOk && providedSeen === required };
}
