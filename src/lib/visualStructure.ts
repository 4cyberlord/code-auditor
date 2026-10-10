/**
 * Phase 6.7: compare explicitly transcribed visual facts without inventing
 * source-image content. Disagreements demand review of the original pixels.
 */
export type VisualFactKind = "relation" | "symbol" | "table" | "axis" | "dimension";
export interface VisualFact { kind: VisualFactKind; value: string }
const PREFIX=/^\s*(RELATION|SYMBOL|TABLE|AXIS|DIMENSION)\s*:\s*(.*?)\s*$/i;
export function extractVisualFacts(observations: readonly string[]): VisualFact[] {
  const facts: VisualFact[]=[];
  for (const line of observations.flatMap(v=>v.split("\n"))) {
    const match=line.match(PREFIX);
    if (!match || !match[2]) continue;
    const kind=match[1].toLowerCase() as VisualFactKind;
    const value=match[2].replace(/\s+/g," ").trim().toLowerCase();
    if (value && !facts.some(f=>f.kind===kind&&f.value===value)) facts.push({kind,value});
  }
  return facts;
}
export function compareVisualFacts(readings: readonly (readonly string[])[]): string[] {
  if (readings.length<2) return [];
  const sets=readings.map(lines=>new Map<VisualFactKind,Set<string>>(
    (["relation","symbol","table","axis","dimension"] as VisualFactKind[])
      .map(kind=>[kind,new Set(extractVisualFacts(lines).filter(f=>f.kind===kind).map(f=>f.value))])
  ));
  const issues:string[]=[];
  for (const kind of ["relation","symbol","table","axis","dimension"] as const) {
    const first=sets[0].get(kind)!;
    if (sets.slice(1).some(m=>{const other=m.get(kind)!;return other.size!==first.size||[...first].some(x=>!other.has(x))}))
      issues.push("Readers disagree on "+kind+" facts; recheck the source image.");
  }
  return issues;
}
