/**
 * Query a remote language pack through Supabase's service-role-only
 * postgres_fdw RPC, falling back to independent sources / packaged Markdown.
 * This does NOT persist Markdown in Supabase.
 */
import { approvedRow, canonicalLanguage } from "./languageRegistry.mjs";

export async function fetchLanguageViaGateway(language,{queryGateway,fallback}={}) {
  const id=canonicalLanguage(language);
  if(typeof queryGateway==="function") {
    try {
      const rows=await queryGateway(id);
      if(Array.isArray(rows)) {
        const valid=rows.map(row=>approvedRow(row,id)).find(Boolean);
        if(valid)return [{
          language:id,runtime_version:valid.version,content_md:valid.markdown,
          checksum:valid.checksum,status:"validated",reviewed_at:true,
          registry_id:"neon-fdw",
        }];
      }
    } catch {
      // Unavailable remote mapping, failed networking or invalid gateway data:
      // use a separately configured source or the reviewed bundled pack.
    }
  }
  return typeof fallback==="function" ? fallback(id) : [];
}
