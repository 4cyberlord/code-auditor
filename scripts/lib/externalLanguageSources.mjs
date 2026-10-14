/**
 * Language documentation sources are server-only, separate from Supabase.
 *
 * CODE_AUDITOR_LANGUAGE_REGISTRIES is an administrator-owned JSON array of:
 * { "id":"neon-docs", "url":"https://<external-data-api>/", "tokenEnv":"NEON_LANGUAGE_DOCS_TOKEN" }.
 * The endpoint must be a separately provisioned PostgREST-compatible Data API.
 * Never take an endpoint or token from a solve job, model answer, or screenshot.
 */
import { approvedRow, canonicalLanguage } from "./languageRegistry.mjs";

const MAX_REGISTRIES=5;
const REQUEST_TIMEOUT_MS=2500;
const MAX_RESPONSE_BYTES=40*1024;
const REGISTRY_ID=/^[a-z][a-z0-9_-]{0,47}$/;
const TOKEN_NAME=/^[A-Z][A-Z0-9_]{3,90}$/;
const UNSAFE_SHARED_SECRETS=new Set([
  "DATABASE_URL","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","SUPABASE_SERVICE_KEY",
  "SUPABASE_ANON_KEY","SUPABASE_PUBLISHABLE_KEY"
]);

export function externalRegistryUrl(raw) {
  if(typeof raw!=="string")throw new TypeError("External registry URL must be a string");
  const url=new URL(raw);
  const h=url.hostname.toLowerCase();
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash
    ||!h.includes(".")||h==="localhost"
    ||/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)
    ||h.endsWith(".localhost")||h.endsWith(".internal")
    ||h==="supabase.co"||h.endsWith(".supabase.co")
    ||h==="supabase.com"||h.endsWith(".supabase.com")
    ||h==="supabase.in"||h.endsWith(".supabase.in"))
    throw new Error("Language documentation must use a secure, external database endpoint, not Supabase or a private host.");
  if(url.pathname.includes(".."))throw new Error("Invalid registry path.");
  return url;
}

export function configuredLanguageRegistries(environment=process.env) {
  const raw=environment.CODE_AUDITOR_LANGUAGE_REGISTRIES;
  if(!raw)return [];
  let data;
  try{data=JSON.parse(raw)}catch{throw new Error("CODE_AUDITOR_LANGUAGE_REGISTRIES must be JSON.");}
  if(!Array.isArray(data)||data.length>MAX_REGISTRIES)
    throw new Error("Expected at most five external language database endpoints.");
  const ids=new Set();
  return data.map(entry=>{
    if(!entry||typeof entry!=="object"||!REGISTRY_ID.test(entry.id||"")||ids.has(entry.id)
      ||!TOKEN_NAME.test(entry.tokenEnv||"")||UNSAFE_SHARED_SECRETS.has(entry.tokenEnv))
      throw new Error("Invalid or duplicate external language database definition.");
    ids.add(entry.id);
    const endpoint=externalRegistryUrl(entry.url);
    if(!environment[entry.tokenEnv])
      throw new Error("External language database credential is not configured for "+entry.id);
    return {id:entry.id,endpoint,token:environment[entry.tokenEnv]};
  });
}

/**
 * Query verified rows only, with bounded response and request lifetime.
 * On outage or tampered content, try the next external registry.
 * The caller's existing loadLanguagePack fallback handles a complete outage.
 */
/**
 * Only server-side, service-role authenticated application metadata may define
 * which *external* database to contact. This directory does not contain docs
 * or tokens. Validated published Markdown can be read anonymously under
 * Neon's anonymous role and row-level security. No JWT is sent for public reads.
 */
export function registriesFromDirectory(rows) {
  if(!Array.isArray(rows))return [];
  return rows.filter(row=>
    row && row.service_key==="council_language_docs" &&
    row.provider==="neon" && row.content_category==="language_documentation" &&
    row.stores_language_markdown===true && row.is_external===true &&
    row.project_ref==="rough-lake-58845101" &&
    row.metadata?.data_api_status==="active" &&
    typeof row.metadata?.data_api_url==="string" &&
    /^https:\/\/[^/]+\.neon\.tech\//.test(row.metadata.data_api_url)
  ).slice(0,1).map(row=>({
    id:"neon-docs",endpoint:externalRegistryUrl(row.metadata.data_api_url),
    // No Authorization header: only public, validated records are visible.
  }));
}

export function createRegistryDirectoryLoader(fetchRows, ttlMs=300000) {
  let until=0,cache=[],pending=null;
  return async ()=>{
    const now=Date.now();
    if(now<until)return cache;
    if(pending)return pending;
    pending=(async()=>{
      try{
        const rows=await fetchRows();
        cache=Array.isArray(rows)?rows:[];
      } catch {cache=[];}
      until=Date.now()+Math.max(1000,ttlMs);
      return cache;
    })();
    try{return await pending}finally{pending=null}
  };
}

export async function fetchExternalLanguageRows(language,{environment=process.env,fetchImpl=fetch,registryDirectory}={}){
  const id=canonicalLanguage(language);
  let registries=configuredLanguageRegistries(environment);
  if(!registries.length && typeof registryDirectory==="function") {
    const rows=await registryDirectory();
    registries=registriesFromDirectory(rows,environment);
  }
  for(const registry of registries){
    try{
      const endpoint=new URL(registry.endpoint.href);
      const root=endpoint.pathname.endsWith("/")?endpoint.pathname:endpoint.pathname+"/";
      endpoint.pathname=root+"language_runtime_packs";
      endpoint.searchParams.set("select","language,runtime_version,content_md,checksum,status,reviewed_at");
      endpoint.searchParams.set("language","eq."+id);
      endpoint.searchParams.set("status","eq.validated");
      endpoint.searchParams.set("limit","1");
      const response=await fetchImpl(endpoint.href,{
        method:"GET",redirect:"error",signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers:registry.token
          ? {Authorization:"Bearer "+registry.token,Accept:"application/json"}
          : {Accept:"application/json"}
      });
      if(!response.ok)continue;
      if(Number(response.headers?.get?.("content-length")||0)>MAX_RESPONSE_BYTES)continue;
      const body=await response.text();
      if(Buffer.byteLength(body,"utf8")>MAX_RESPONSE_BYTES)continue;
      const rows=JSON.parse(body);
      const match=Array.isArray(rows)?rows.map(row=>approvedRow(row,id)).find(Boolean):null;
      if(match)return [{language:id,runtime_version:match.version,content_md:match.markdown,
        checksum:match.checksum,status:"validated",reviewed_at:true,registry_id:registry.id}];
    }catch{/* A failed registry must not prevent the next source or the bundle. */}
  }
  return [];
}
