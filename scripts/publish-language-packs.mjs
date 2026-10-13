#!/usr/bin/env node
/**
 * Publishing is always to an explicitly configured external registry.
 * Supabase application credentials are intentionally not consulted.
 */
import "./lib/config.mjs";
import { LANGUAGES, bundledPack } from "./lib/languageRegistry.mjs";
import { configuredLanguageRegistries } from "./lib/externalLanguageSources.mjs";

if(!process.argv.includes("--confirm-database-write"))
  throw new Error("Specify --confirm-database-write to publish to an external database.");
const selected=process.argv.find(arg=>arg.startsWith("--registry="))?.slice(11);
if(!selected)throw new Error("Specify --registry=<configured-external-database-id>.");
const registries=configuredLanguageRegistries(process.env);
const db=registries.find(item=>item.id===selected);
if(!db)throw new Error("No authorized external registry configured with id "+selected);
const approved=process.argv.includes("--approve-reviewed");
const reviewer=process.env.CODE_AUDITOR_DOC_REVIEWER?.trim();
if(approved&&!reviewer)
  throw new Error("Approved language packs require CODE_AUDITOR_DOC_REVIEWER.");
for(const language of LANGUAGES){
  const pack=bundledPack(language);
  const url=new URL(db.endpoint.href);
  url.pathname=(url.pathname.endsWith("/")?url.pathname:url.pathname+"/")+"language_runtime_packs";
  url.searchParams.set("on_conflict","language");
  const response=await fetch(url.href,{
    method:"POST",redirect:"error",
    headers:{Authorization:"Bearer "+db.token,"Content-Type":"application/json",
      Prefer:"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify({language,runtime_version:pack.version,content_md:pack.markdown,
      checksum:pack.checksum,status:approved?"validated":"draft",
      reviewed_at:approved?new Date().toISOString():null,
      reviewed_by:approved?reviewer:null})
  });
  if(!response.ok)throw new Error("External publication failed for "+language+
    " (HTTP "+response.status+").");
  console.log(language+": "+(approved?"validated":"draft")+" -> "+db.id);
}
