
import assert from "node:assert/strict";
import {LANGUAGES,bundledPack,loadLanguagePack,clearLanguagePackCache,sha256} from "../scripts/lib/languageRegistry.mjs";
import {referenceKey,isReferenceValidated,markReferenceValidated,clearReferenceCache} from "../scripts/lib/harnessCache.mjs";
import {phaseTimer} from "../scripts/lib/phaseTimings.mjs";
for(const lang of LANGUAGES){const p=bundledPack(lang);assert.equal(p.checksum,sha256(p.markdown));}
let calls=0;const base=bundledPack("python");
const fetchRows=async()=>{calls++;return [{language:"python",runtime_version:"3",content_md:base.markdown,checksum:base.checksum,status:"validated",reviewed_at:new Date().toISOString()}]};
clearLanguagePackCache();
const [a,b]=await Promise.all([loadLanguagePack("python",{fetchRows}),loadLanguagePack("python",{fetchRows})]);
assert.equal(a.source,"postgres");assert.equal(b.source,"postgres");assert.equal(calls,1);
clearLanguagePackCache();
const rejected=await loadLanguagePack("python",{fetchRows:async()=>[{language:"python",runtime_version:"3",content_md:base.markdown,checksum:"0".repeat(64),status:"validated",reviewed_at:new Date().toISOString()}]});
assert.equal(rejected.source,"bundle");
clearLanguagePackCache();
assert.equal((await loadLanguagePack("rust",{fetchRows:async()=>{throw Error("offline")}})).source,"bundle");
assert.deepEqual(LANGUAGES,["python","cpp","rust"]);
for (const removed of ["javascript","typescript","java","c","go","php","ruby","bash"]) assert.throws(()=>bundledPack(removed),RangeError);
assert.throws(()=>bundledPack("../../secret"),RangeError);
clearReferenceCache();const key=referenceKey("cpp","h","r","20");
assert.equal(isReferenceValidated(key),false);markReferenceValidated(key);assert.equal(isReferenceValidated(key),true);
let time=0;const t=phaseTimer(()=>time);t.enter("contract");time=13;t.enter("solver");time=39;
assert.deepEqual(t.snapshot(),{contract:13,solver:26,totalMs:39});
console.log("PASS: validated docs, concurrent cache, bundle fallback, phase timing");
