#!/usr/bin/env node
/**
 * Build and sign the app in one step.
 *
 *   npm run app:build:signed
 *
 * Tauri signs *during* the bundle rather than afterwards, so signing is a
 * matter of handing it an identity before it starts. This finds the Developer
 * ID on this Mac, sets `APPLE_SIGNING_IDENTITY`, and runs the normal build — so
 * the .app and the helper sidecar inside it are both signed as they are
 * assembled.
 *
 * Notarisation runs too when the credentials are present. Without it, a DMG
 * that leaves this machine still gets "cannot be opened because the developer
 * cannot be verified" — signing alone is not enough for anyone else's Mac.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import "./lib/config.mjs";
import { codesigningIdentities, developerIdApplicationIdentity } from "./lib/signing.mjs";

if (process.platform !== "darwin") {
  console.error("Signing is a macOS thing; run this on the Mac.");
  process.exit(2);
}

const found = codesigningIdentities();
const chosen = developerIdApplicationIdentity();

if (!chosen) {
  console.error(
    "\nNo Developer ID Application identity found on this Mac.\n\n" +
      (found.length ? `  found: ${found.join(", ")}\n\n` : "") +
      "Open Xcode → Settings → Accounts → Manage Certificates and create a\n" +
      "Developer ID Application certificate. Apple Development, Apple Distribution,\n" +
      "and Developer ID Installer identities are not valid substitutes for signing\n" +
      "a directly distributed macOS app/helper.\n"
  );
  process.exit(1);
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    env: options.env,
    shell: false,
    stdio: options.stdio ?? "pipe",
  });
  return res;
}

function fail(message, detail = "") {
  console.error(`\n${message}`);
  if (detail.trim()) console.error(detail.trimEnd());
  process.exit(1);
}

function requireTool(command, args) {
  const res = run(command, args);
  if (res.status !== 0) {
    fail(`Missing required release tool: ${command} ${args.join(" ")}`, res.stderr || res.stdout || "");
  }
}

function hasNotaryProfile(profile) {
  const res = run("xcrun", ["notarytool", "history", "--keychain-profile", profile]);
  return res.status === 0;
}

function validateNotarizedApp(appPath) {
  if (!existsSync(appPath)) fail(`Built app was not found at ${appPath}`);

  const staple = run("xcrun", ["stapler", "validate", appPath]);
  if (staple.status !== 0) {
    fail(
      "Notarization validation failed: no stapled ticket was accepted for the app.",
      staple.stderr || staple.stdout || ""
    );
  }

  const assess = run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  const assessOutput = `${assess.stdout || ""}${assess.stderr || ""}`;
  if (assess.status !== 0 || /Unnotarized Developer ID/i.test(assessOutput)) {
    fail("Gatekeeper assessment failed for the built app.", assessOutput);
  }

  console.log("\nNotarization verified:");
  console.log(`  stapler validate: ${appPath}`);
  console.log(`  spctl assess: accepted`);
}

console.log(`\nSigning as: ${chosen}`);
const env = { ...process.env, APPLE_SIGNING_IDENTITY: chosen };

// Notarisation needs either Apple ID credentials or App Store Connect API
// credentials. Tauri picks these up itself when they are set; failing before
// the build beats silently producing something Gatekeeper will reject.
const appleIdVars = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
const apiKeyVars = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"];
const missingAppleIdVars = appleIdVars.filter((v) => !env[v]?.trim());
const missingApiKeyVars = apiKeyVars.filter((v) => !env[v]?.trim());
const notaryProfile = env.APPLE_NOTARY_PROFILE?.trim() || "notary-profile";
const hasProfile = hasNotaryProfile(notaryProfile);
if (missingAppleIdVars.length && missingApiKeyVars.length && !hasProfile) {
  fail(
    "Cannot make a teammate-safe release: notarization credentials are incomplete.",
    "Set APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID, set APPLE_API_ISSUER, APPLE_API_KEY, and APPLE_API_KEY_PATH, or save a notarytool keychain profile.\n" +
      "Use npm run app:build for local unsigned/unnotarized builds."
  );
}
if (hasProfile && !env.APPLE_NOTARY_PROFILE) env.APPLE_NOTARY_PROFILE = notaryProfile;

requireTool("xcrun", ["-f", "notarytool"]);
requireTool("xcrun", ["-f", "stapler"]);
requireTool("spctl", ["--status"]);

const res = spawnSync("npm", ["run", "app:build"], { stdio: "inherit", env, shell: false });
if (res.status !== 0) process.exit(res.status ?? 1);

const ROOT = process.cwd();
const tauriConfig = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const productName = tauriConfig.productName || "Council Editor";
const appPath = path.join(ROOT, "src-tauri", "target", "release", "bundle", "macos", `${productName}.app`);

validateNotarizedApp(appPath);
