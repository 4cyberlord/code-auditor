import assert from "node:assert/strict";
import { inspectReleaseConfiguration } from "../scripts/release-preflight.mjs";
const base={build:{frontendDist:"../out"},bundle:{active:true,targets:["app","dmg"],externalBin:["binaries/mds"]},identifier:"com.charles.councileditor",version:"0.1.0",app:{security:{csp:{"script-src":"'self'"}}}};
const pkg={scripts:{"app:build:signed":"node scripts/build-signed.mjs","app:build":"tauri build && node scripts/package-dmg.mjs"}};
assert.deepEqual(inspectReleaseConfiguration(base,pkg),[]);
assert.ok(inspectReleaseConfiguration({...base,bundle:{...base.bundle,externalBin:[]}},pkg).some(x=>x.includes("sidecar")));
assert.ok(inspectReleaseConfiguration({...base,app:{security:{csp:{"script-src":"'self' 'unsafe-eval'"}}}},pkg).some(x=>x.includes("CSP")));
assert.ok(inspectReleaseConfiguration({...base,version:"bad"},pkg).some(x=>x.includes("semver")));
console.log("PASS: static release preflight regression tests");
