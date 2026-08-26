/**
 * Syntax highlighting, hand-rolled.
 *
 * A library would be the obvious choice, and for most apps it would be right.
 * Two things argue against it here. Code blocks in this app are *streaming*:
 * every token that arrives re-renders the whole block, and the heavier
 * highlighters do far more work per pass than a panel of four running at once
 * can afford. And the output goes into React elements rather than an HTML
 * string, so there is no `dangerouslySetInnerHTML` anywhere near model-written
 * text — which is a property worth keeping in an app whose entire input is
 * model-written text.
 *
 * The tokenizer is deliberately shallow. It knows about comments, strings,
 * numbers and keywords, and nothing about grammar. That is enough to read code
 * by, and it degrades into plain text rather than into nonsense when it meets
 * something it does not understand.
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "func";

export interface Token {
  text: string;
  kind: TokenKind;
}

interface Grammar {
  lineComment: string[];
  blockComment: [string, string] | null;
  /** Quote characters that open a string. */
  quotes: string[];
  /** Python's triple quotes, and anything else that spans lines. */
  longStrings: string[];
  keywords: Set<string>;
  types: Set<string>;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE_TYPES =
  "int long short char float double void bool auto unsigned signed size_t string vector map set";

const GRAMMARS: Record<string, Grammar> = {
  python: {
    lineComment: ["#"],
    blockComment: null,
    quotes: ['"', "'"],
    longStrings: ['"""', "'''"],
    keywords: words(`def class return if elif else for while in not and or is None True False
      import from as with try except finally raise yield lambda global nonlocal pass break
      continue assert del await async match case`),
    types: words(`int float str bool list dict set tuple bytes object type List Dict Set Tuple
      Optional Union Any Callable Iterable Sequence self cls print len range enumerate zip map
      filter sorted sum min max abs round open isinstance super`),
  },
  javascript: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    longStrings: [],
    keywords: words(`const let var function return if else for while do switch case break continue
      new delete typeof instanceof in of class extends super this null undefined true false try
      catch finally throw async await yield import export from default static get set void`),
    types: words(`String Number Boolean Object Array Map Set Promise Date RegExp Error JSON Math
      console window document require module exports process Symbol BigInt`),
  },
  typescript: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    longStrings: [],
    keywords: words(`const let var function return if else for while do switch case break continue
      new delete typeof instanceof in of class extends super this null undefined true false try
      catch finally throw async await yield import export from default static get set void
      interface type enum namespace declare implements readonly public private protected abstract
      as satisfies keyof infer`),
    types: words(`string number boolean object any unknown never void null undefined Array Promise
      Record Partial Readonly Pick Omit Map Set Date JSON Math console`),
  },
  c: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
    longStrings: [],
    keywords: words(`if else for while do switch case break continue return goto struct union enum
      typedef sizeof static const volatile extern inline register restrict include define ifdef
      ifndef endif pragma NULL true false`),
    types: words(C_LIKE_TYPES + " FILE printf scanf malloc free memcpy strlen"),
  },
  cpp: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
    longStrings: [],
    keywords: words(`if else for while do switch case break continue return goto class struct union
      enum typedef sizeof static const constexpr volatile extern inline virtual override final
      public private protected namespace using template typename new delete this nullptr true false
      try catch throw operator friend explicit mutable include define pragma co_await co_return`),
    types: words(C_LIKE_TYPES + " std cout cin endl printf nullptr_t uint32_t int64_t"),
  },
  java: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
    longStrings: [],
    keywords: words(`public private protected class interface extends implements static final
      abstract synchronized native transient volatile if else for while do switch case break
      continue return new this super try catch finally throw throws import package instanceof
      null true false enum record var`),
    types: words(`int long short byte char float double boolean void String Object Integer Long
      Double Boolean List Map Set ArrayList HashMap HashSet System out println Math Arrays`),
  },
  go: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    longStrings: [],
    keywords: words(`package import func return if else for range switch case default break continue
      go defer chan select type struct interface map var const nil true false fallthrough goto`),
    types: words(`int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string
      bool byte rune error any fmt len cap make new append copy delete panic recover print println`),
  },
  rust: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
    longStrings: [],
    keywords: words(`fn let mut const static struct enum trait impl for while loop if else match
      return break continue use mod pub crate self super where as move ref dyn async await unsafe
      type in true false Some None Ok Err`),
    types: words(`i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String
      Vec Option Result Box Rc Arc HashMap HashSet println print format vec panic`),
  },
  ruby: {
    lineComment: ["#"],
    blockComment: null,
    quotes: ['"', "'"],
    longStrings: [],
    keywords: words(`def end class module if elsif else unless while until for in do then return
      yield begin rescue ensure raise require require_relative attr_accessor attr_reader
      attr_writer self nil true false and or not case when next break lambda proc puts`),
    types: words(`String Integer Float Array Hash Symbol Range Proc Struct Time File puts print p`),
  },
  php: {
    lineComment: ["//", "#"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
    longStrings: [],
    keywords: words(`function return if else elseif foreach for while do switch case break continue
      class interface trait extends implements public private protected static final abstract new
      echo print use namespace require require_once include include_once try catch finally throw
      null true false array as instanceof global const fn match yield`),
    types: words(`int float string bool array object callable iterable void mixed self parent
      count strlen array_map array_filter implode explode json_encode json_decode`),
  },
  bash: {
    lineComment: ["#"],
    blockComment: null,
    quotes: ['"', "'"],
    longStrings: [],
    keywords: words(`if then elif else fi for while until do done case esac function return in
      local export readonly declare source break continue exit trap set unset`),
    types: words(`echo printf cd ls cat grep sed awk cut sort uniq head tail wc find xargs mkdir rm
      cp mv chmod curl git npm node python3 test`),
  },
};

const ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  nodejs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  "c++": "cpp",
  cxx: "cpp",
  cc: "cpp",
  golang: "go",
  rs: "rust",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
};

/** Whether this language is highlighted at all. */
export function grammarFor(language: string): Grammar | null {
  const raw = language.trim().toLowerCase().replace(/^\./, "");
  return GRAMMARS[ALIASES[raw] ?? raw] ?? null;
}

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/**
 * Splits code into coloured runs.
 *
 * Adjacent tokens of the same kind are merged, because a span per character is
 * how you make a streaming block janky.
 */
export function highlight(code: string, language: string): Token[] {
  const g = grammarFor(language);
  if (!g) return code ? [{ text: code, kind: "plain" }] : [];

  const out: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };

  let i = 0;
  const n = code.length;

  while (i < n) {
    const rest = code.slice(i);

    // Multi-line strings first: they can contain anything, quotes included.
    const long = g.longStrings.find((q) => rest.startsWith(q));
    if (long) {
      const end = code.indexOf(long, i + long.length);
      const stop = end === -1 ? n : end + long.length;
      push(code.slice(i, stop), "string");
      i = stop;
      continue;
    }

    const line = g.lineComment.find((c) => rest.startsWith(c));
    if (line) {
      const nl = code.indexOf("\n", i);
      const stop = nl === -1 ? n : nl;
      push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }

    if (g.blockComment && rest.startsWith(g.blockComment[0])) {
      const [, close] = g.blockComment;
      const end = code.indexOf(close, i + 2);
      const stop = end === -1 ? n : end + close.length;
      push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }

    const quote = g.quotes.find((q) => rest.startsWith(q));
    if (quote) {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === quote) {
          j += 1;
          break;
        }
        // An unterminated string should colour to end of line, not swallow the
        // rest of the file -- which is what a half-written streaming line is.
        if (code[j] === "\n" && quote !== "`") break;
        j += 1;
      }
      push(code.slice(i, Math.min(j, n)), "string");
      i = Math.min(j, n);
      continue;
    }

    const c = code[i];

    if (isDigit(c) || (c === "." && isDigit(code[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXbBoO._]/.test(code[j])) j += 1;
      push(code.slice(i, j), "number");
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdent(code[j])) j += 1;
      const word = code.slice(i, j);

      // A name followed by "(" is being called or defined. Worth its own colour:
      // it is how you find the shape of a file at a glance.
      let k = j;
      while (k < n && (code[k] === " " || code[k] === "\t")) k += 1;
      const called = code[k] === "(";

      if (g.keywords.has(word)) push(word, "keyword");
      else if (g.types.has(word)) push(word, "type");
      else if (called) push(word, "func");
      else if (/^[A-Z]/.test(word)) push(word, "type");
      else push(word, "plain");

      i = j;
      continue;
    }

    push(c, "plain");
    i += 1;
  }

  return out;
}
