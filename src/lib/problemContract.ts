/**
 * Problem contract — the typed, fail-closed description a harness is built from.
 *
 * A contract exists only when the executable interface is established. When it
 * cannot be, the builder refuses and the reference harness takes over, instead of
 * emitting a driver against a guess.
 */



export type ContractLanguage = "python" | "cpp" | "rust";

export interface ContractArgument {
  name: string;
  type: string;
}

export interface ProblemContract {
  version: 1;
  language: ContractLanguage;
  /** Hash of the statement the contract came from. */
  questionHash: string;
  interface: "method" | "function" | "stdin";
  signature: {
    name: string;
    args: ContractArgument[];
    returns: string;
    mutates: string | null;
  };
  fixtureCount: number;
  comparator: "ordered" | "unordered";
  /** How the node class is obtained: from the starter, or injected by us. */
  nodeSource: "starter" | "injected" | "none";
  provenance: "provided" | "generated";
}

export interface ContractResult {
  ok: boolean;
  contract?: ProblemContract;
  reason?: string;
}

function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b ^ code, 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export interface ContractInput {
  question: string;
  language: string;
  code: string;
  fixtureCount: number;
  fixturesHaveExpected: boolean;
  /** True when a callable signature was parsed. */
  callable: boolean;
  stdinContract: boolean;
  signature?: {
    name: string;
    args: Array<{ name: string; decl: string; type: string }>;
    ret: string;
    mutates: string | null;
    owner?: "class" | "free";
  };
  unordered: boolean;
  source: "provided" | "generated";
  nodeKind: boolean;
  nodeDeclared: boolean;
}

/** Refuses when the interface is not established; never guesses. */
export function buildContract(input: ContractInput): ContractResult {
  if (!["python", "cpp", "rust"].includes(input.language)) {
    return { ok: false, reason: `no contract compiler for ${input.language}` } as never;
  }
  if (input.fixtureCount < 1) return { ok: false, reason: "no labelled examples" };
  if (!input.fixturesHaveExpected) return { ok: false, reason: "an example has no expected output" };
  if (!input.callable && !input.stdinContract) {
    return { ok: false, reason: "no recognizable callable or stdin interface" };
  }
  const signature = input.signature;

  const contract: ProblemContract = {
    version: 1,
    language: input.language as ContractLanguage,
    questionHash: hash(`${input.language}\u0000${input.question}`),
    interface: signature ? (signature.owner === "free" ? "function" : "method") : input.callable ? "function" : "stdin",
    signature: signature
      ? {
        name: signature.name,
        args: signature.args.map((argument) => ({ name: argument.name, type: argument.decl })),
        returns: signature.ret,
        mutates: signature.mutates,
      }
      : { name: "", args: [], returns: "", mutates: null },
    fixtureCount: input.fixtureCount,
    comparator: input.unordered ? "unordered" : "ordered",
    nodeSource: input.nodeKind ? (input.nodeDeclared ? "starter" : "injected") : "none",
    provenance: input.source,
  };
  return { ok: true, contract };
}

/** Identity of a full contract (statement + interface + fixtures). */
export function contractIdentity(
  contract: ProblemContract,
  fixtures: Array<{ input: string; expected?: unknown; output?: string }>,
): string {
  const rows = fixtures.map((fixture) =>
    `${fixture.input}\u0001${JSON.stringify(fixture.expected ?? fixture.output ?? "")}`);
  return hash(JSON.stringify(contract) + "\u0002" + rows.join("\u0003"));
}

export const CONTRACT_VERSION = 1;
