import assert from "node:assert/strict";
import {bundledPack,sha256} from "../scripts/lib/languageRegistry.mjs";
import {fetchLanguageViaGateway} from "../scripts/lib/supabaseLanguageGateway.mjs";

const verified=bundledPack("python");
let gatewayCalls=0,fallbackCalls=0;
const packRows=[{language:"python",runtime_version:"3.13",content_md:verified.markdown,
 checksum:sha256(verified.markdown),status:"validated",reviewed_at:"2026-10-14T00:00:00Z"}];
const rows=await fetchLanguageViaGateway("python",{
 queryGateway:async id=>{gatewayCalls++;assert.equal(id,"python");return packRows},
 fallback:async()=>{fallbackCalls++;return []}
});
assert.equal(rows.length,1);
assert.equal(rows[0].registry_id,"neon-fdw");
assert.equal(gatewayCalls,1);assert.equal(fallbackCalls,0);
const missing=await fetchLanguageViaGateway("python",{
 queryGateway:async()=>{throw Error("user mapping not found")},
 fallback:async()=>{fallbackCalls++;return []}
});
assert.deepEqual(missing,[]);
assert.equal(fallbackCalls,1);
const invalid=await fetchLanguageViaGateway("python",{
 queryGateway:async()=>[{...packRows[0],checksum:"0".repeat(64)}],
 fallback:async()=>{fallbackCalls++;return [{...packRows[0]}]}
});
assert.equal(invalid.length,1);assert.equal(fallbackCalls,2);
await assert.rejects(fetchLanguageViaGateway("java",{queryGateway:async()=>null}),RangeError);
await assert.rejects(fetchLanguageViaGateway("../secrets",{}),/Unsupported language/);
console.log("PASS: Supabase-to-Neon FDW reads, checksum validation and safe fallback");
