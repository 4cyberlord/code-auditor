/**
 * Conservative symbolic asymptotic bounds. No program-analysis claims are
 * inferred by this parser: it compares *reported upper-bound expressions*
 * assuming independent input dimensions grow at least to 2.
 *
 * Copyright-free implementation notes synthesized from university lectures.
 * "unknown" is essential: an undecidable/unsupported comparison is not equal.
 */
export type BoundRelation = "equivalent" | "left-no-worse" | "right-no-worse" | "incomparable" | "unknown";
export type EvidenceLevel = "formal-proof" | "checked-derivation" | "corroborated-model-audit" | "heuristic" | "unknown";
type Growth = { polynomial:number; logarithm:number; inverseAckermann:number;
  exponential:number; factorial:number };
type Term = Record<string,Growth>;
export interface SymbolicBound {
  notation:"O" | "Theta";
  terms:Term[];
  canonical:string;
  dimensions:string[];
  assumptions:readonly string[];
}
export interface BoundComparison {
  relation:BoundRelation;
  explanation:string;
  assumptions:readonly string[];
}
const MAX_CHARS=240,MAX_TERMS=64,MAX_TOKENS=120;
const fresh=():Growth=>({polynomial:0,logarithm:0,inverseAckermann:0,exponential:0,factorial:0});
const clone=(t:Term):Term=>Object.fromEntries(Object.entries(t).map(([k,v])=>[k,{...v}]));
const add=(a:Term,b:Term):Term=>{
  const result=clone(a);
  for(const [v,g] of Object.entries(b)){
    const prev=result[v]??fresh();
    result[v]={
      polynomial:prev.polynomial+g.polynomial,logarithm:prev.logarithm+g.logarithm,
      inverseAckermann:prev.inverseAckermann+g.inverseAckermann,
      exponential:Math.max(prev.exponential,g.exponential),
      factorial:prev.factorial+g.factorial,
    };
    // Distinct exponential bases for one variable are not represented as a
    // product in this restricted language. Reject before this can be used.
    if(prev.exponential>1&&g.exponential>1) throw Error("exponential products not supported");
  }
  return result;
};
function factor(variable:string,field:keyof Growth,power:number):Term {
  if(!variable || !Number.isFinite(power)||power<0||power>16) throw Error("invalid factor");
  const g=fresh();g[field]=power;return {[variable]:g};
}
function complexityRank(g:Growth):number[]{
  return [g.factorial,g.exponential,g.polynomial,g.logarithm,g.inverseAckermann];
}
/** Sufficient condition: term a in O(term b) for independent dimensions >= 2.
 * Non-comparable terms remain non-comparable. */
function termLE(a:Term,b:Term):boolean{
  const keys=new Set([...Object.keys(a),...Object.keys(b)]);
  for(const k of keys){
    const x=complexityRank(a[k]??fresh()), y=complexityRank(b[k]??fresh());
    let relation=0;
    for(let i=0;i<x.length;i++){
      if(x[i]!==y[i]){relation=x[i]<y[i]?-1:1;break;}
    }
    if(relation>0)return false;
  }
  return true;
}
function termKey(t:Term):string {
  return Object.keys(t).sort().map(k=>{
    const g=t[k], values=complexityRank(g);
    return k+":"+values.join(",");
  }).join("|")||"1";
}
function simplify(terms:Term[]):Term[]{
  const unique=[...new Map(terms.map(t=>[termKey(t),t])).values()];
  return unique.filter((t,i)=>!unique.some((u,j)=>i!==j&&termLE(t,u)&&!termLE(u,t)))
    .sort((a,b)=>termKey(a).localeCompare(termKey(b)));
}
const valueLE=(a:Term[],b:Term[]):boolean=>a.every(t=>b.some(u=>termLE(t,u)));
const PROTOCOL=["Independent dimensions grow without unstated relationships",
  "Nonnegative cost functions; no implicit constraints such as E <= V^2",
  "Comparison concerns stated asymptotic upper bounds, not measured runtime or tightness"];
function scan(s:string):string[]{
  const tokens:string[]=[];
  let i=0;
  const regex=/^(?:\d+(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9]*|[()+*^!+]|α)/;
  while(i<s.length){
    if(/\s/.test(s[i])){i++;continue;}
    const hit=regex.exec(s.slice(i));
    if(!hit)throw Error("unsupported token");
    tokens.push(hit[0]);i+=hit[0].length;
    if(tokens.length>MAX_TOKENS)throw Error("expression too large");
  }
  return tokens;
}
export function parseSymbolicBound(input:string):SymbolicBound|null{
  if(typeof input!=="string"||input.length>MAX_CHARS)return null;
  const normalized=input.trim().replace(/²/g,"^2").replace(/³/g,"^3").replace(/×|·/g,"*");
  const envelope=/^(O|Theta|Θ)\s*\(([\s\S]*)\)$/i.exec(normalized);
  if(!envelope)return null;
  const notation=envelope[1].toLowerCase()==="o"?"O":"Theta";
  try {
    const ts=scan(envelope[2]);let pos=0;
    const peek=()=>ts[pos];
    const take=(want?:string)=>{
      const out=ts[pos++];
      if(want && out!==want)throw Error("unexpected token");
      return out;
    };
    const isIdentifier=(x?:string)=>!!x&&/^[A-Za-z_][A-Za-z_0-9]*$/.test(x)&&!["log","lg","sqrt","alpha"].includes(x.toLowerCase());
    const positiveExponent=()=>{
      const n=Number(take());
      if(!Number.isFinite(n)||n<0||n>16)throw Error("exponent outside range");
      return n;
    };
    // Upper-bound sums/products only; subtraction, division, unknown functions
    // and variable exponents are intentionally rejected rather than guessed.
    const parseSum=():Term[]=>{
      let result=parseProduct();
      while(peek()==="+"){take("+");result=[...result,...parseProduct()];if(result.length>MAX_TERMS)throw Error("too many terms");}
      return result;
    };
    const parseAtom=():Term[]=>{
      const x=take();
      if(!x)throw Error("missing factor");
      if(x==="("){const t=parseSum();take(")");return t;}
      if(/^\d/.test(x)){
        const n=Number(x);
        if(!Number.isFinite(n)||n<=0)throw Error("only positive constants supported");
        if(peek()==="^"){
          take("^");
          const v=take();
          if(!isIdentifier(v)||n<=1)throw Error("unsupported exponential");
          return [factor(v,"exponential",n)];
        }
        return [{}];
      }
      const fn=x.toLowerCase();
      if(["log","lg","sqrt","alpha"].includes(fn)||x==="α"){
        let pow=1;
        if(peek()==="^"){take("^");pow=positiveExponent();}
        let v;
        if(peek()==="("){take("(");v=take();take(")");}
        else v=take();
        if(!isIdentifier(v))throw Error("function argument must be one dimension");
        if(fn==="sqrt")return [factor(v,"polynomial",0.5*pow)];
        if(fn==="log"||fn==="lg")return [factor(v,"logarithm",pow)];
        return [factor(v,"inverseAckermann",pow)];
      }
      if(!isIdentifier(x))throw Error("invalid variable");
      // x(y) may be an unknown function call; never reinterpret it as x*y.
      if(peek()==="(")throw Error("unknown function");
      if(peek()==="!"){take("!");return [factor(x,"factorial",1)];}
      if(peek()==="^"){take("^");return [factor(x,"polynomial",positiveExponent())];}
      return [factor(x,"polynomial",1)];
    };
    const canStart=(x?:string)=>!!x&&(x==="("||/^[A-Za-z_]/.test(x)||x==="α"||/^\d/.test(x));
    const parseProduct=():Term[]=>{
      let left=parseAtom();
      while(peek()==="*"||canStart(peek())){
        if(peek()==="*")take("*");
        const right=parseAtom();
        if(left.length*right.length>MAX_TERMS)throw Error("expression explosion");
        left=left.flatMap(a=>right.map(b=>add(a,b)));
      }
      return left;
    };
    const terms=simplify(parseSum());
    if(pos!==ts.length||!terms.length)throw Error("unexpected trailing token");
    const dimensions=[...new Set(terms.flatMap(t=>Object.keys(t)))].sort();
    return {notation,terms,canonical:terms.map(termKey).join("+"),dimensions,assumptions:PROTOCOL};
  }catch{return null;}
}
export function compareComplexityBounds(left:string,right:string):BoundComparison{
  const a=parseSymbolicBound(left),b=parseSymbolicBound(right);
  if(!a||!b)return {relation:"unknown",
    explanation:"Unsupported expression or asymptotic notation; no mathematical ranking is justified.",
    assumptions:PROTOCOL};
  const ab=valueLE(a.terms,b.terms),ba=valueLE(b.terms,a.terms);
  const relation:BoundRelation=ab&&ba?"equivalent":ab?"left-no-worse":ba?"right-no-worse":"incomparable";
  return {relation,explanation:relation==="incomparable"
    ?"Bounds involve independent dimensions or competing growth terms: neither dominates without extra assumptions."
    :relation==="equivalent"?"These stated bounds have equivalent asymptotic growth under the declared assumptions."
    :"One stated upper bound is dominated by the other; this alone does NOT prove tight runtime or actual speed.",
    assumptions:PROTOCOL};
}
export function canonicalComplexityBound(input:string):string|null{
  return parseSymbolicBound(input)?.canonical??null;
}
/** Deliberately limited Master theorem for polynomial tolls n^d(log n)^k.
 * A proof certificate must record a>=1, b>1, nonnegative d,k and the
 * regularity assumption (automatic for a polynomial gap in case 3). */
export interface MasterResult { bound:string; case:1|2|3; basis:string; evidence:EvidenceLevel }
export function solvePolynomialMaster(a:number,b:number,d:number,k=0):MasterResult|null{
  if(![a,b,d,k].every(Number.isFinite)||a<1||b<=1||d<0||k<0||!Number.isInteger(k))return null;
  const p=Math.log(a)/Math.log(b);
  const approx=(n:number)=>Math.abs(n-Math.round(n))<1e-9?String(Math.round(n)):n.toFixed(6).replace(/0+$/,"").replace(/\.$/,"");
  const power=(x:number)=>x===0?"1":x===1?"n":"n^"+approx(x);
  const withLogs=(x:number,y:number)=>power(x)+(y===0?"":" log"+(y===1?"":"^"+y)+" n");
  const e=1e-9;
  if(d<p-e)return {bound:"Theta("+withLogs(p,0)+")",case:1,
    basis:"T(n)=aT(n/b)+Theta(n^d log^k n), d<log_b(a); polynomial-gap case",
    evidence:"checked-derivation"};
  if(Math.abs(d-p)<=e)return {bound:"Theta("+withLogs(p,k+1)+")",case:2,
    basis:"T(n)=aT(n/b)+Theta(n^d log^k n), d=log_b(a)",
    evidence:"checked-derivation"};
  return {bound:"Theta("+withLogs(d,k)+")",case:3,
    basis:"T(n)=aT(n/b)+Theta(n^d log^k n), d>log_b(a); regularity follows from polynomial gap",
    evidence:"checked-derivation"};
}
