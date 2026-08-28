#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

if (!existsSync(appPath)) {
  console.error(`Missing app bundle: ${appPath}`);
  console.error("Run `tauri build --bundles app` first.");
  process.exit(2);
}

mkdirSync(dmgDir, { recursive: true });
rmSync(stageDir, { recursive: true, force: true });
rmSync(outPath, { force: true });
mkdirSync(stageDir, { recursive: true });

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
console.log(`DMG created at: ${outPath}`);
