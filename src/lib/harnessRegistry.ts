/**
 * Harness template registry.
 *
 * A template is selectable only while it is `certified`: its known-good and
 * known-bad fixture pass through the real runner. The registry describes what a
 * family can build; the builders in providedCaseHarness.ts do the assembly.
 *
 * Adding a family means adding an entry here, a builder branch and both
 * fixtures under tests/harnessFixtures/. Uncertified entries are skipped and the
 * caller falls back to the reference harness.
 */

export type HarnessFamily = "callable-scalar" | "callable-vector" | "stdin";
export type HarnessLanguage = "python" | "cpp" | "rust";

export interface HarnessTemplate {
  id: string;
  family: HarnessFamily;
  languages: HarnessLanguage[];
  /** Lower wins when more than one family matches. */
  rank: number;
  certified: boolean;
  description: string;
  materialises: string[];
  refuses: string[];
}

const ALL: HarnessLanguage[] = ["python", "cpp", "rust"];
const NATIVE: HarnessLanguage[] = ["cpp", "rust"];

const scalar = (language: HarnessLanguage, id: string): HarnessTemplate => ({
  id,
  family: "callable-scalar",
  languages: [language],
  rank: 10,
  certified: true,
  description: "Calls the judge function with scalar arguments and compares the return exactly.",
  materialises: ["int", "float", "bool", "string"],
  refuses: ["node and composite types"],
});

export const HARNESS_REGISTRY: HarnessTemplate[] = [
  scalar("python", "python.callable-scalar"),
  scalar("cpp", "cpp.callable-scalar"),
  scalar("rust", "rust.callable-scalar"),
  {
    id: "python.callable-vector",
    family: "callable-vector",
    languages: ["python"],
    rank: 20,
    certified: true,
    description: "Calls the judge function with JSON lists and compares structurally.",
    materialises: ["list", "nested list", "string"],
    refuses: ["TreeNode", "ListNode", "maps", "tuples"],
  },
  {
    id: "native.callable-vector",
    family: "callable-vector",
    languages: NATIVE,
    rank: 20,
    certified: true,
    description: "Typed native call with vector arguments and declaration-typed comparison.",
    materialises: ["vector", "nested vector", "string"],
    refuses: ["TreeNode", "ListNode", "pointers", "maps", "tuples"],
  },
  {
    id: "stdin.wrapper",
    family: "stdin",
    languages: ALL,
    rank: 30,
    certified: true,
    description: "Compiles the candidate as a whole program and feeds labelled stdin fixtures.",
    materialises: ["stdin text"],
    refuses: ["callable-only contracts", "interactive protocols"],
  },
];

export function certifiedTemplate(id: string): HarnessTemplate | undefined {
  return HARNESS_REGISTRY.find((template) => template.id === id && template.certified);
}

/** Best certified template for a language and family, if one exists. */
export function bestTemplate(language: string, family: HarnessFamily): HarnessTemplate | undefined {
  return HARNESS_REGISTRY
    .filter((template) => template.certified && template.family === family &&
      template.languages.includes(language as HarnessLanguage))
    .sort((left, right) => left.rank - right.rank)[0];
}

export interface HarnessSupport {
  supported: boolean;
  templateId: string | null;
  reason: string;
}

/**
 * Capability report for one candidate. Descriptive only — the builder still
 * decides whether every concrete value materialises.
 */
export function describeHarnessSupport(
  language: string,
  hasCallable: boolean,
  hasStdinContract: boolean,
): HarnessSupport {
  if (!ALL.includes(language as HarnessLanguage)) {
    return { supported: false, templateId: null, reason: `no adapter for ${language}` };
  }
  const family: HarnessFamily | null = hasCallable ? "callable-vector" : hasStdinContract ? "stdin" : null;
  if (!family) return { supported: false, templateId: null, reason: "no recognizable callable or stdin contract" };
  const template = bestTemplate(language, family) || certifiedTemplate("stdin.wrapper");
  if (!template) return { supported: false, templateId: null, reason: `no certified ${family} template` };
  return { supported: true, templateId: template.id, reason: template.description };
}
