/**
 * E2B-tested but not yet Council-reviewed solutions are PROVISIONAL.
 *
 * This is intentionally conservative: parse a common single-input Big-O
 * family, compare it to the problem contract if comparable, and never
 * represent a model's complexity CLAIM as an independent complexity audit.
 * Unknown/multivariate bounds wait for Council judgment.
 */
const GROWTH = new Map([
  ["1",0],["logn",1],["n",2],["nlogn",3],["n^2",4],
  ["n^2logn",5],["n^3",6],["2^n",7],["n!",8],
]);
export function simpleComplexityRank(value){
  const match=/\bO\(\s*([^)\n]{1,32})\s*\)/i.exec(String(value||""));
  if(!match)return null;
  const expr=match[1].toLowerCase().replace(/\s+/g,"")
    .replace(/²/g,"^2").replace(/³/g,"^3")
    .replace(/[×*]/g,"").replace(/log_?2n/g,"logn")
    .replace(/log2n/g,"logn");
  return GROWTH.has(expr)?{bound:"O("+expr+")",rank:GROWTH.get(expr)}:null;
}
export function screenProvisionalCandidate({final,run,contractComplexity="",language=""}={}){
  if(final?.kind!=="code"||!String(final?.code||"").trim())
    return {eligible:false,reason:"No complete code"};
  if(language&&String(final.language||"").toLowerCase().replace(/[^a-z+]/g,"")!==
      String(language).toLowerCase().replace(/[^a-z+]/g,""))
    return {eligible:false,reason:"Not the preferred language"};
  if(!run?.ran||!run.ok||run.passed<=0||run.failed!==0)
    return {eligible:false,reason:"No passing E2B evidence"};
  const claim=simpleComplexityRank(final.complexity);
  if(!claim)return {eligible:false,reason:"Complexity unknown; wait for Council audit"};
  const target=simpleComplexityRank(contractComplexity);
  if(target && claim.rank>target.rank){
    return {eligible:false,reason:"Claimed "+claim.bound+" exceeds contract target "+target.bound,
      claimedBound:claim.bound,targetBound:target.bound};
  }
  return {eligible:true,reason:target?"Claim screened against contract; not independently audited":"Claim parsed; no comparable contract bound available",
    claimedBound:claim.bound,targetBound:target?.bound||null,
    disclaimer:"E2B cases passed; code quality, test strength and Big-O are awaiting independent Council review."};
}
export function createProvisionalRecord({candidate,run,language,screened,at=new Date().toISOString()}){
  return {
    status:"provisional",letter:candidate.letter,model:candidate.model,
    codingTrusty:Boolean(candidate.codingTrusty),
    language,code:candidate.final.code,complexity:candidate.final.complexity||"",
    passed:run.passed,failed:run.failed,screenedComplexity:screened,
    at,verification:"E2B test cases passed; Council review and final selection pending.",
  };
}
export function buildSolutionHistory(provisional,final){
  const history=[];
  if(provisional)history.push({
    version:"provisional",letter:provisional.letter,language:provisional.language,
    code:provisional.code,complexity:provisional.complexity,
    at:provisional.at,passed:provisional.passed,
  });
  if(final?.code)history.push({
    version:"final",letter:final.letter,language:final.language,
    code:final.code,complexity:final.complexity||"",
    at:final.at||new Date().toISOString(),passed:final.passed||0,
  });
  return history;
}
