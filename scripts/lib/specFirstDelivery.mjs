/**
 * Spec-first verified delivery helpers.
 * All accepted results must carry actual E2B evidence.
 */
export const PORT_LANGUAGES = Object.freeze(["python","rust","cpp"]);
export function canonicalPortLanguage(value){
 const v=String(value||"").trim().toLowerCase();
 return ({python:"python",python3:"python",py:"python",rust:"rust",rs:"rust",cpp:"cpp",cxx:"cpp","c++":"cpp","c++23":"cpp","c++26":"cpp"})[v]||"";
}
export function preferredLanguages(configured, fallback=["python","rust","cpp"]){
 return [...new Set((Array.isArray(configured)&&configured.length?configured:fallback)
   .map(canonicalPortLanguage).filter(Boolean))];
}
/**
 * Respect explicit language requirements in the user's problem. When none is
 * stated, use the configured output-language order, starting with Python.
 */
export function requiredProblemLanguage(question){
 const text=String(question||"").slice(0,18000);
 const languagePattern="(python|rust|c\\+\\+|cpp)";
 const direct=new RegExp("(?:required|target|programming|implementation|output)\\s*language\\s*[:=]\\s*"+languagePattern+"(?=\\s|$|[,.;:)])","i").exec(text)
   ||new RegExp("\\b(?:implement|write|solve|code)\\s+(?:this|it|the\\s+solution|the\\s+program)?\\s*in\\s+"+languagePattern+"(?=\\s|$|[,.;:)])","i").exec(text);
 if(direct)return canonicalPortLanguage(direct[1]);
 if(/#include\s*[<"]|\bstd::|\bclass\s+Solution\s*\{/.test(text))return "cpp";
 if(/\bfn\s+main\s*\(|\bimpl\s+Solution\b/.test(text))return "rust";
 if(/\bdef\s+[a-z_]\w*\s*\(|\bclass\s+Solution\s*:\s*/.test(text))return "python";
 return "";
}
export function contractSupportsEarlyHarness(question,kind){
 if(kind!=="code")return false;
 const s=String(question||"").slice(0,16000);
 // A known signature permits an independent test harness without access to
 // any solution. Otherwise defer harness generation until code is available.
 return /\bclass\s+Solution\b|\bdef\s+[a-z_]\w*\s*\(|\bfn\s+[a-z_]\w*\s*\(|\b(?:function|method)\s+signature\s*:/i.test(s);
}
export function evidenceStatus(run){
 if(!run?.ran)return "untested";
 if(!run.ok||run.failed>0)return "rejected";
 return run.passed>0?"verified":"untested";
}
export function isVerified(run){return evidenceStatus(run)==="verified"}
export function rankedPortTiming(ports){
 // Only timings from passing runs within THE SAME language and a declared
 // comparable benchmark environment are directly comparable. Never claim
 // cross-language "fastest" from end-to-end E2B wall clock time.
 const eligible=(ports||[]).filter(p=>p.status==="verified"&&p.run&&
   Number.isFinite(p.run.remoteElapsedMs)&&p.run.remoteElapsedMs>=0);
 const groups=new Map();
 for(const port of eligible){
   const key=port.language+":"+(port.run.runtime||"unknown")+":"+(port.run.benchmarkGroup||"");
   const list=groups.get(key)||[];list.push(port);groups.set(key,list);
 }
 return [...groups.entries()].flatMap(([group,list])=>{
   if(list.length<2)return [];
   const winner=[...list].sort((a,b)=>a.run.remoteElapsedMs-b.run.remoteElapsedMs)[0];
   return [{group,language:winner.language,fastest:winner.sourceLetter,measuredMs:winner.run.remoteElapsedMs}];
 });
}
export function createBoundedExecutor(concurrency=4){
 const limit=Math.max(1,Math.min(9,Math.floor(Number(concurrency)||4)));
 let busy=0;const queue=[];
 function next(){
  while(busy<limit&&queue.length){
   const {fn,resolve,reject}=queue.shift();busy++;
   Promise.resolve().then(fn).then(resolve,reject).finally(()=>{busy--;next()});
  }
 }
 return fn=>new Promise((resolve,reject)=>{queue.push({fn,resolve,reject});next()});
}
