import assert from "node:assert/strict";
import {bundledPack,loadLanguagePack,clearLanguagePackCache} from "../scripts/lib/languageRegistry.mjs";
import {configuredLanguageRegistries,externalRegistryUrl,fetchExternalLanguageRows,registriesFromDirectory,createRegistryDirectoryLoader} from "../scripts/lib/externalLanguageSources.mjs";
for(const url of ["https://foo.supabase.co/rest/v1","http://docs.neon.tech","https://localhost","https://127.0.0.1:5432","https://test.internal"])
  assert.throws(()=>externalRegistryUrl(url));
const environment={CODE_AUDITOR_LANGUAGE_REGISTRIES:JSON.stringify([
  {id:"first",url:"https://one.example.org/rest/v1",tokenEnv:"FIRST_LANGUAGE_TOKEN"},
  {id:"neon",url:"https://two.example.org/rest/v1",tokenEnv:"NEON_LANGUAGE_TOKEN"}
]),FIRST_LANGUAGE_TOKEN:"alpha",NEON_LANGUAGE_TOKEN:"beta"};
const reg=configuredLanguageRegistries(environment);
assert.equal(reg.length,2);
assert.equal(reg[1].id,"neon");
assert.throws(()=>configuredLanguageRegistries({
  CODE_AUDITOR_LANGUAGE_REGISTRIES:JSON.stringify([
    {id:"unsafe",url:"https://docs.example.org/rest/v1",tokenEnv:"SUPABASE_SERVICE_ROLE_KEY"}
  ]),
  SUPABASE_SERVICE_ROLE_KEY:"do-not-forward"
}),/Invalid or duplicate/);
assert.throws(()=>configuredLanguageRegistries({CODE_AUDITOR_LANGUAGE_REGISTRIES:environment.CODE_AUDITOR_LANGUAGE_REGISTRIES}),/credential/);
const p=bundledPack("python");
let calls=[];
const fetchImpl=async (url,options)=>{
  calls.push({url,authorization:options.headers.Authorization});
  if(url.includes("one.example.org"))return {ok:false,status:503};
  return {ok:true,headers:new Headers(),text:async()=>JSON.stringify([{
    language:"python",runtime_version:"3.13",content_md:p.markdown,
    checksum:p.checksum,status:"validated",reviewed_at:"2026-10-13T00:00:00Z"
  }])};
};
const rows=await fetchExternalLanguageRows("python",{environment,fetchImpl});
assert.equal(rows[0].registry_id,"neon");
assert.equal(calls.length,2);
assert.ok(calls[0].url.includes("/rest/v1/language_runtime_packs?"));
assert.equal(calls[1].authorization,"Bearer beta");
clearLanguagePackCache();
const selected=await loadLanguagePack("python",{fetchRows:id=>fetchExternalLanguageRows(id,{environment,fetchImpl})});
assert.equal(selected.source,"postgres");
assert.equal(selected.databaseId,"neon");
const none=await fetchExternalLanguageRows("python",{environment:{},fetchImpl});
assert.deepEqual(none,[]);
clearLanguagePackCache();
assert.equal((await loadLanguagePack("java",{fetchRows:id=>fetchExternalLanguageRows(id,{environment:{},fetchImpl})})).source,"bundle");
const knownNeon="https://ep-flat-forest-akcqqd8f.apirest.c-3.us-west-2.aws.neon.tech/language_docs/rest/v1";
const directory=[{service_key:"council_language_docs",provider:"neon",
  content_category:"language_documentation",stores_language_markdown:true,is_external:true,
  metadata:{data_api_url:knownNeon,data_api_status:"active",credential_state:"verified"}
}];
const envDirect={NEON_LANGUAGE_DOCS_TOKEN:"short-lived-jwt"};
assert.equal(registriesFromDirectory(directory,envDirect)[0].id,"neon-docs");
assert.deepEqual(registriesFromDirectory(directory,{}),[]);
assert.deepEqual(registriesFromDirectory([{...directory[0],metadata:{...directory[0].metadata,credential_state:"pending"}}],envDirect),[]);
assert.deepEqual(registriesFromDirectory([{...directory[0],metadata:{...directory[0].metadata,data_api_url:"https://attacker.example.org/rest/v1"}}],envDirect),[]);
let reads=0;
const directoryLoader=createRegistryDirectoryLoader(async()=>{reads++;return directory});
assert.equal((await Promise.all([directoryLoader(),directoryLoader()])).length,2);
assert.equal(reads,1);
let apiCalls=0;
const secureRows=await fetchExternalLanguageRows("python",{
 environment:envDirect, registryDirectory:directoryLoader,
 fetchImpl:async (url,options)=>{
   apiCalls++;
   assert.ok(url.startsWith(knownNeon+"/language_runtime_packs?"));
   assert.equal(options.headers.Authorization,"Bearer short-lived-jwt");
   return {ok:true,headers:new Headers(),text:async()=>JSON.stringify([{
     language:"python",runtime_version:"3.13",content_md:p.markdown,
     checksum:p.checksum,status:"validated",reviewed_at:"2026-10-13T00:00:00Z"
   }])};
 }
});
assert.equal(apiCalls,1);
assert.equal(secureRows[0].registry_id,"neon-docs");
console.log("PASS: external-only sources, multiple databases, registry metadata, secrets, and offline fallback");
