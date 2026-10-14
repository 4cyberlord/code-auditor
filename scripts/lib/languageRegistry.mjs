
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const LANGUAGES=Object.freeze(["python","cpp","rust"]);
const allowed=new Set(LANGUAGES),cache=new Map(),pending=new Map();
export const sha256=s=>createHash("sha256").update(s,"utf8").digest("hex");
export function canonicalLanguage(raw){
 const s=String(raw||"").trim().toLowerCase();
 const aliases={py:"python",python3:"python","c++":"cpp",cc:"cpp",cxx:"cpp",rs:"rust"};
 const name=aliases[s]||s;
 if(!allowed.has(name))throw new RangeError("Unsupported language: "+s);
 return name;
}
export function bundledPack(language){
 const name=canonicalLanguage(language);
 const markdown=readFileSync(new URL("../../docs/language-runtime/"+name+".md",import.meta.url),"utf8");
 return {language:name,markdown,checksum:sha256(markdown),version:"bundled",source:"bundle",validated:true};
}
export function approvedRow(row,name){
 if(!row||row.language!==name||row.status!=="validated"||!row.reviewed_at||
  typeof row.content_md!=="string"||!row.content_md.trim()||
  Buffer.byteLength(row.content_md,"utf8")>32768||
  !/^[a-f0-9]{64}$/.test(row.checksum||"")||
  sha256(row.content_md)!==row.checksum||
  typeof row.runtime_version!=="string"||!row.runtime_version.trim())return null;
 return {language:name,markdown:row.content_md,checksum:row.checksum,version:row.runtime_version,source:"postgres",databaseId:typeof row.registry_id==="string"&&/^[a-z][a-z0-9_-]{0,47}$/.test(row.registry_id)?row.registry_id:undefined,validated:true};
}
export async function loadLanguagePack(raw,options={}){
 const name=canonicalLanguage(raw),now=options.now??Date.now(),ttl=options.ttlMs??300000;
 const existing=cache.get(name);
 if(existing&&existing.until>now)return existing.pack;
 if(pending.has(name))return pending.get(name);
 const work=(async()=>{
  let pack=bundledPack(name);
  if(options.fetchRows){
   try{
    const rows=await options.fetchRows(name);
    const found=Array.isArray(rows)?rows.map(row=>approvedRow(row,name)).find(Boolean):null;
    if(found)pack=found;
   }catch{}
  }
  // A transient registry outage must not lock the entire process into a bundled\n  // fallback for the normal five-minute success TTL. Retry after 30 seconds.\n  const effectiveTtl=pack.source==="bundle"&&options.fetchRows ? Math.min(ttl,30000) : ttl;\n  cache.set(name,{pack,until:now+Math.max(1,effectiveTtl)});
  return pack;
 })();
 pending.set(name,work);
 try{return await work}finally{pending.delete(name)}
}
export function clearLanguagePackCache(){cache.clear();pending.clear()}
export function languagePrompt(pack,maxChars=4500){
 if(!pack?.validated)throw new Error("Untrusted language pack");
 return "APPROVED "+pack.language+" RUNTIME RULES ["+pack.source+"; "+pack.checksum.slice(0,12)+"]\n"+
 pack.markdown.slice(0,maxChars)+"\nGuidance is not proof: compile and test in E2B.";
}
