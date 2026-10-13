#!/usr/bin/env node
import "./lib/config.mjs";
import { LANGUAGES,bundledPack } from "./lib/languageRegistry.mjs";
const url=String(process.env.SUPABASE_URL||"").replace(/\/$/,"");
const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw Error("SUPABASE_URL and service role key required");
const approved=process.argv.includes("--approve-reviewed");
const reviewer=process.env.CODE_AUDITOR_DOC_REVIEWER;
if(approved&&!reviewer)throw Error("CODE_AUDITOR_DOC_REVIEWER must identify the reviewer");
if(!process.argv.includes("--confirm-database-write"))throw Error("Explicit --confirm-database-write required");
for(const language of LANGUAGES){
 const pack=bundledPack(language);const status=approved?"validated":"draft";
 const response=await fetch(url+"/rest/v1/language_runtime_packs?on_conflict=language",{
  method:"POST",headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},
  body:JSON.stringify({language,runtime_version:pack.version,content_md:pack.markdown,checksum:pack.checksum,status,
   reviewed_at:approved?new Date().toISOString():null,reviewed_by:approved?reviewer:null})
 });
 if(!response.ok)throw Error(language+" publication failed: HTTP "+response.status);
 console.log(language+": "+status);
}
