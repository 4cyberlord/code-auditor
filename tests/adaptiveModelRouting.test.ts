import { selectAdaptiveModels, selectAdaptiveJudges } from "../src/lib/adaptiveModelRouting.ts";
import { routeProblem, routeUnparsedProblem } from "../src/lib/problemRouting.ts";
const check=(name:string, ok:boolean)=>{if(!ok)throw Error(name);console.log("PASS:",name)};
const route=routeProblem({problemSummary:"Find shortest path in a graph",observations:[],ambiguities:[],confidence:1,code:"",kind:"other"});
const models=[{id:"general"},{id:"graph-specialist"},{id:"offline"},{id:"unverified-vision"}];
const caps=[
{id:"graph-specialist",families:["graph"] as const,verifiedAccuracy:0.92,evaluatedSamples:40,vision:true},
{id:"offline",availability:"unavailable" as const},
{id:"unverified-vision",vision:false},
];
const order=selectAdaptiveModels(models,m=>m.id,route,caps,4);
check("domain specialist ranked first",order.selected[0]?.id==="graph-specialist");
check("unavailable model excluded",order.selected.every(m=>m.id!=="offline"));
check("no candidates are invented",order.selected.every(m=>models.includes(m)));
const visual=selectAdaptiveModels(models,m=>m.id,route,caps,4,{passesImages:true});
check("image bytes require attested vision",visual.selected.length===1&&visual.selected[0].id==="graph-specialist");
const repeated=selectAdaptiveModels(models,m=>m.id,route,[],4,{excludedIds:["general"]});
check("seated models not billed twice",repeated.selected.every(m=>m.id!=="general"));
const uncertain=routeUnparsedProblem("Solve screenshot",true);
check("unparsed screenshot remains ambiguous",uncertain.path==="ambiguity_review");
const judge=selectAdaptiveJudges([{model:"general"},{model:"graph-specialist"}],x=>x.model,route,caps,1);
check("judge selection uses specialist evidence",judge.selected[0].model==="graph-specialist");
const ties=selectAdaptiveModels(models.slice(0,2),m=>m.id,route,[],2);
check("unknown capabilities preserve configured order",ties.selected[0].id==="general");

const reliabilityRoute=routeProblem({problemSummary:"Compute array prefix sums",observations:[],ambiguities:[],confidence:1,code:"",kind:"other"});
const comparable=[{id:"weak"},{id:"strong"}];
const assessed=selectAdaptiveModels(comparable,m=>m.id,reliabilityRoute,[
  {id:"weak",verifiedAccuracy:0.99,evaluatedSamples:2},
  {id:"strong",verifiedAccuracy:0.82,evaluatedSamples:40}
],2);
check("unverified sample-poor accuracy never outranks trusted history",assessed.selected[0].id==="strong");
const unavailable=selectAdaptiveModels([{id:"a"},{id:"b"}],m=>m.id,reliabilityRoute,[
  {id:"a",availability:"unavailable"},{id:"b",availability:"unavailable"}
],4);
check("no model fabricated when every route is unavailable",unavailable.selected.length===0);
