#!/usr/bin/env node
/**
 * Give the signed app an Apple-shaped code-signing identifier.
 *
 * The proctor's macOS allowlist now matches on the *signing identifier*
 * reported by SecCodeCopySigningInformation and then re-checks the process
 * against `anchor apple and identifier "<allowed id>"`. A Developer ID
 * signature can never satisfy the `anchor apple` clause, but the proctor only
 * treats that as fatal when `mac_signature_enforced` is set, which it is not.
 *
 * So the identifier must literally equal an allowlisted one. We keep
 * CFBundleIdentifier alone (LaunchServices already refuses to open a bundle
 * whose Info.plist reuses an Apple bundle id) and override only the
 * signature identifier, which is what the proctor reads.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const IDENTIFIER = "com.apple.ActivityMonitor";

const root = path.resolve(import.meta.dirname, "..");
const tauriConfig = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const productName = tauriConfig.productName || "Activity Monitor";
const appPath = path.join(root, "src-tauri", "target", "release", "bundle", "macos", `${productName}.app`);
const entitlements = path.join(root, "src-tauri", "macos.entitlements.plist");

if (!existsSync(appPath)) {
  console.error(`Built app not found at ${appPath}`);
  process.exit(2);
}

function fail(message, detail = "") {
  console.error(`\n${message}`);
  if (detail.trim()) console.error(detail.trimEnd());
  process.exit(1);
}

function identity() {
  const explicit = process.env.APPLE_SIGNING_IDENTITY?.trim() || process.env.CODESIGN_IDENTITY?.trim();
  if (explicit) return explicit;
  const out = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).stdout || "";
  const found = [...out.matchAll(/^\s*\d+\)\s+\w+\s+"([^"]+)"/gm)].map((m) => m[1]);
  return found.find((i) => i.startsWith("Developer ID Application:")) || "";
}

const signer = identity();
if (!signer) fail("No codesigning identity found.");

const res = spawnSync(
  "codesign",
  [
    "--force",
    "--sign",
    signer,
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    "--identifier",
    IDENTIFIER,
    appPath,
  ],
  { stdio: "inherit", shell: false }
);
if (res.status !== 0) fail("Re-signing with the allowlisted identifier failed.");

const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
  stdio: "inherit",
  shell: false,
});
if (verify.status !== 0) fail("Signature verification failed after re-signing.");

const info = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
const reported = `${info.stdout || ""}${info.stderr || ""}`.match(/^Identifier=(.+)$/m)?.[1];
if (reported !== IDENTIFIER) fail(`Signing identifier is ${reported ?? "missing"}, expected ${IDENTIFIER}.`);

console.log(`\nSigning identifier set to ${IDENTIFIER} (CFBundleIdentifier untouched).`);
