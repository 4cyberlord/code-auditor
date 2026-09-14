#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import "./lib/config.mjs";

const ROOT = process.cwd();
const tauriConfig = JSON.parse(
  readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")
);
const productName = tauriConfig.productName || "Council Editor";
const version = tauriConfig.version || "0.1.0";
const arch = process.arch === "arm64" ? "aarch64" : process.arch;
const bundleDir = path.join(ROOT, "src-tauri", "target", "release", "bundle");
const appPath = path.join(bundleDir, "macos", `${productName}.app`);
const dmgDir = path.join(bundleDir, "dmg");
const stageDir = path.join(dmgDir, `${productName}.dmg.stage`);
const outPath = path.join(dmgDir, `${productName}_${version}_${arch}.dmg`);
const signingIdentity =
  process.env.APPLE_SIGNING_IDENTITY?.trim() || process.env.CODESIGN_IDENTITY?.trim() || "";
const appleIdVars = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
const apiKeyVars = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"];
const notaryProfile = process.env.APPLE_NOTARY_PROFILE?.trim() || "notary-profile";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    shell: false,
    stdio: options.stdio ?? "pipe",
  });
}

function fail(message, detail = "") {
  console.error(`\n${message}`);
  if (detail.trim()) console.error(detail.trimEnd());
  process.exit(1);
}

function requireTool(command, args) {
  const res = run(command, args);
  if (res.status !== 0) {
    fail(`Missing required DMG release tool: ${command} ${args.join(" ")}`, res.stderr || res.stdout || "");
  }
}

function hasNotaryProfile(profile) {
  const res = run("xcrun", ["notarytool", "history", "--keychain-profile", profile]);
  return res.status === 0;
}

function notarizationArgs() {
  if ((process.env.APPLE_NOTARY_PROFILE?.trim() || hasNotaryProfile(notaryProfile)) && notaryProfile) {
    return ["--keychain-profile", notaryProfile];
  }

  const hasAppleId = appleIdVars.every((v) => process.env[v]?.trim());
  if (hasAppleId) {
    return [
      "--apple-id",
      process.env.APPLE_ID,
      "--password",
      process.env.APPLE_PASSWORD,
      "--team-id",
      process.env.APPLE_TEAM_ID,
    ];
  }

  const hasApiKey = apiKeyVars.every((v) => process.env[v]?.trim());
  if (hasApiKey) {
    return [
      "--issuer",
      process.env.APPLE_API_ISSUER,
      "--key-id",
      process.env.APPLE_API_KEY,
      "--key",
      process.env.APPLE_API_KEY_PATH,
    ];
  }

  return [];
}

function verifyGatekeeper(pathToAssess, type, label, context = "") {
  const args = ["--assess", "--type", type, "--verbose=4"];
  if (context) args.push("--context", context);
  args.push(pathToAssess);
  const assess = run("spctl", args);
  const assessOutput = `${assess.stdout || ""}${assess.stderr || ""}`;
  if (assess.status !== 0 || /Unnotarized Developer ID/i.test(assessOutput)) {
    fail(`Gatekeeper assessment failed for the ${label}.`, assessOutput);
  }
}

function stapleAndValidate(pathToValidate, label) {
  execFileSync("xcrun", ["stapler", "staple", pathToValidate], { stdio: "inherit" });
  const staple = run("xcrun", ["stapler", "validate", pathToValidate]);
  if (staple.status !== 0) {
    fail(`${label} notarization validation failed: no stapled ticket was accepted.`, staple.stderr || staple.stdout || "");
  }
}

function ensureNotarizedApp(appBundlePath) {
  if (!signingIdentity) {
    return;
  }

  const notaryArgs = notarizationArgs();
  if (!notaryArgs.length) {
    fail(
      "Cannot make a teammate-safe app bundle: notarization credentials are incomplete.",
      "Set APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID, set APPLE_API_ISSUER, APPLE_API_KEY, and APPLE_API_KEY_PATH, or set APPLE_NOTARY_PROFILE."
    );
  }

  requireTool("xcrun", ["-f", "notarytool"]);
  requireTool("xcrun", ["-f", "stapler"]);
  requireTool("spctl", ["--status"]);

  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundlePath], {
    stdio: "inherit",
  });

  const zipPath = path.join(dmgDir, `${productName}.app.notary.zip`);
  rmSync(zipPath, { force: true });
  execFileSync("ditto", ["-c", "-k", "--keepParent", appBundlePath, zipPath], { stdio: "inherit" });
  try {
    execFileSync("xcrun", ["notarytool", "submit", zipPath, "--wait", ...notaryArgs], {
      stdio: "inherit",
    });
  } finally {
    rmSync(zipPath, { force: true });
  }
  stapleAndValidate(appBundlePath, "App bundle");
  verifyGatekeeper(appBundlePath, "execute", "app bundle");
}

function signAndNotarizeDmg(dmgPath) {
  if (!signingIdentity) {
    console.log("DMG created for local use only; set APPLE_SIGNING_IDENTITY to sign and notarize it.");
    return;
  }

  const notaryArgs = notarizationArgs();
  if (!notaryArgs.length) {
    fail(
      "Cannot make a teammate-safe DMG: notarization credentials are incomplete.",
      "Set APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID, set APPLE_API_ISSUER, APPLE_API_KEY, and APPLE_API_KEY_PATH, or set APPLE_NOTARY_PROFILE."
    );
  }

  requireTool("xcrun", ["-f", "notarytool"]);
  requireTool("xcrun", ["-f", "stapler"]);
  requireTool("spctl", ["--status"]);

  execFileSync("codesign", ["--force", "--sign", signingIdentity, dmgPath], { stdio: "inherit" });
  execFileSync("xcrun", ["notarytool", "submit", dmgPath, "--wait", ...notaryArgs], {
    stdio: "inherit",
  });
  stapleAndValidate(dmgPath, "DMG");
  verifyGatekeeper(dmgPath, "open", "DMG", "context:primary-signature");

  console.log("DMG signing and notarization verified.");
}

if (!existsSync(appPath)) {
  console.error(`Missing app bundle: ${appPath}`);
  console.error("Run `tauri build --bundles app` first.");
  process.exit(2);
}

mkdirSync(dmgDir, { recursive: true });
rmSync(stageDir, { recursive: true, force: true });
rmSync(outPath, { force: true });
mkdirSync(stageDir, { recursive: true });

ensureNotarizedApp(appPath);
execFileSync("ditto", [appPath, path.join(stageDir, `${productName}.app`)], {
  stdio: "inherit",
});
symlinkSync("/Applications", path.join(stageDir, "Applications"));

execFileSync(
  "hdiutil",
  [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    stageDir,
    "-ov",
    "-format",
    "UDZO",
    outPath,
  ],
  { stdio: "inherit" }
);

rmSync(stageDir, { recursive: true, force: true });
signAndNotarizeDmg(outPath);
console.log(`DMG created at: ${outPath}`);
