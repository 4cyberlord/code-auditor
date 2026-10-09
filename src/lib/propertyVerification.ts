/**
 * Phase 6.7: independently specified, deterministic property predicates.
 * These validate structured outputs; no model-generated claims are a trusted oracle.
 */
export type PropertyRule =
  | { kind: "unique"; values: readonly (string | number)[] }
  | { kind: "permutation"; actual: readonly (string | number)[]; expected: readonly (string | number)[] }
  | { kind: "topological_order"; order: readonly string[]; nodes: readonly string[]; edges: readonly (readonly [string,string])[] };
export interface PropertyResult { ok: boolean; reason: string }
const counts=(xs:readonly (string|number)[])=>{
 const m=new Map<string,number>(); for(const x of xs){const k=JSON.stringify([typeof x,x]);m.set(k,(m.get(k)??0)+1);}return m;
};
export function validateProperty(rule: PropertyRule): PropertyResult {
 if(rule.kind==="unique"){
  const unique=counts(rule.values).size===rule.values.length;
  return {ok:unique,reason:unique?"All values unique":"Repeated output value"};
 }
 if(rule.kind==="permutation"){
  const a=counts(rule.actual),b=counts(rule.expected);
  const ok=a.size===b.size && [...a].every(([k,n])=>b.get(k)===n);
  return {ok,reason:ok?"Same multiset":"Output does not preserve the required multiset"};
 }
 const expected=new Set(rule.nodes);
 const order=new Map<string,number>();
 for(let i=0;i<rule.order.length;i++){
  const node=rule.order[i];if(order.has(node))return {ok:false,reason:"Repeated node"};
  order.set(node,i);
 }
 if(order.size!==expected.size||[...expected].some(n=>!order.has(n)))
  return {ok:false,reason:"Order omits or adds nodes"};
 for(const [source,target] of rule.edges){
  if(!expected.has(source)||!expected.has(target))
   return {ok:false,reason:"Unknown endpoint in trusted graph"};
  if(order.get(source)! >= order.get(target)!)
   return {ok:false,reason:"Edge direction violated"};
 }
 return {ok:true,reason:"Topological constraints satisfied"};
}
