#!/usr/bin/env node
import { chmodSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const srcTauri = join(root, "src-tauri");
const cargoName = "mds";
const externalName = "mds";
const extension = process.platform === "win32" ? ".exe" : "";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function signingIdentity() {
  return process.env.APPLE_SIGNING_IDENTITY?.trim() || process.env.CODESIGN_IDENTITY?.trim() || "";
}

function signHelper(path) {
  if (process.platform !== "darwin") return;
  const identity = signingIdentity();
  if (!identity) return;
  run("codesign", ["--force", "--sign", identity, "--options", "runtime", path]);
}

run("cargo", [
  "build",
  "--manifest-path",
  join(srcTauri, "Cargo.toml"),
  "--bin",
  cargoName,
]);

const from = join(srcTauri, "target", "debug", `${cargoName}${extension}`);
const to = join(srcTauri, "target", "debug", `${externalName}${extension}`);
copyFileSync(from, to);
chmodSync(to, 0o755);
signHelper(to);

console.log(`Built ghost helper: ${to}`);
