#!/usr/bin/env node
/**
 * Static release preflight; no secrets, signing, network calls, or deploys.
 * Production signing/notarization must still be tested on the release Mac.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = p => JSON.parse(readFileSync(path.join(root,p),"utf8"));
export function inspectReleaseConfiguration(config, packageJson) {
  const failures=[];
  const need=(ok,why)=>{if(!ok)failures.push(why);};
  need(config?.build?.frontendDist === "../out","Frontend output must match Tauri static export");
  need(config?.bundle?.active === true,"Bundling must be enabled");
  need(config?.bundle?.targets?.includes("app"),"macOS app bundle target is required");
  need(config?.bundle?.targets?.includes("dmg"),"DMG bundle target is required");
  need(Array.isArray(config?.bundle?.externalBin) && config.bundle.externalBin.includes("binaries/mds"),
    "Expected helper sidecar binaries/mds is missing");
  need(typeof config?.identifier==="string" && /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(config.identifier),
    "Bundle identifier invalid");
  need(typeof config?.version==="string" && /^\d+\.\d+\.\d+([+-][a-zA-Z0-9.-]+)?$/.test(config.version),
    "App version must be valid semver");
  need(config?.app?.security?.csp?.["script-src"] === "'self'","Unexpected CSP script source");
  need(packageJson?.scripts?.["app:build:signed"] === "node scripts/build-signed.mjs",
    "Signed build script missing or changed");
  need(packageJson?.scripts?.["app:build"]?.includes("scripts/package-dmg.mjs"),
    "DMG packaging validation script not included");
  return failures;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const failures=inspectReleaseConfiguration(load("src-tauri/tauri.conf.json"),load("package.json"));
  if(failures.length){for(const failure of failures)console.error("FAIL:",failure);process.exitCode=1;}
  else console.log("PASS: release configuration preflight (not a signing/notarization assertion)");
}
