import { validateProperty } from "./propertyVerification.ts";

/** Trusted fixtures are configured independently of council-produced answers. */
export interface PropertyFixture {
  id: string;
  /** A reviewed rule containing independently established constraints. */
  rule: { kind: "unique" } | { kind: "permutation"; expected: readonly (string | number)[] } |
    { kind: "topological_order"; nodes: readonly string[]; edges: readonly (readonly [string, string])[] };
  /** Candidate output must parse as JSON (not arbitrary prose or code). */
  outputPath?: string;
}
export interface PropertyAssessment {
  checked: number;
  passed: number;
  failed: number;
  errors: string[];
}
/** Only substitutes candidate-supplied values, never trusted expectations. */
export function assessPropertyFixtures(
  output: string,
  fixtures: readonly PropertyFixture[],
): PropertyAssessment {
  const errors: string[]=[];
  let passed=0;
  if (fixtures.length===0) return {checked:0,passed:0,failed:0,errors};
  let parsed:unknown;
  try { parsed=JSON.parse(output); }
  catch {return {checked:fixtures.length,passed:0,failed:fixtures.length,errors:["Candidate output is not JSON"]};}
  for (const fixture of fixtures) {
    try {
      const value=fixture.outputPath ? fixture.outputPath.split(".").reduce<unknown>(
        (obj,key) => obj && typeof obj==="object" ? (obj as Record<string,unknown>)[key] : undefined,parsed
      ) : parsed;
      if (!Array.isArray(value)) throw Error("Expected JSON array");
      const rule=fixture.rule;
      if(rule.kind==="unique") {
        if(!value.every(x=>typeof x==="string"||typeof x==="number")) throw Error("Invalid value type");
        const result=validateProperty({kind:"unique",values:value});
        if(!result.ok)throw Error(result.reason);
      } else if(rule.kind==="permutation") {
        if(!value.every(x=>typeof x==="string"||typeof x==="number")) throw Error("Invalid value type");
        const result=validateProperty({kind:"permutation",actual:value,expected:rule.expected});
        if(!result.ok)throw Error(result.reason);
      } else {
        if(!value.every(x=>typeof x==="string")) throw Error("Expected node labels");
        const result=validateProperty({kind:"topological_order",order:value,nodes:rule.nodes,edges:rule.edges});
        if(!result.ok)throw Error(result.reason);
      }
      passed++;
    } catch(err) {errors.push(fixture.id+": "+String(err));}
  }
  return {checked:fixtures.length,passed,failed:fixtures.length-passed,errors};
}
