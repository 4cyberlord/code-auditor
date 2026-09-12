#!/usr/bin/env node
import { copyFileSync, chmodSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const srcTauri = join(root, "src-tauri");

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

function targetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`Unsupported build host for helper sidecar: ${process.platform}/${process.arch}`);
}

const extension = process.platform === "win32" ? ".exe" : "";
const dir = join(srcTauri, "binaries");
mkdirSync(dir, { recursive: true });

const cargoHelperName = "corespotlightd";
const helperName = "com.apple.corespotlightd";
const to = join(dir, `${helperName}-${targetTriple()}${extension}`);
// Tauri validates the sidecar path before Cargo has built the helper, so a
// clean release build needs a placeholder before the real binary exists.
if (!existsSync(to)) {
  writeFileSync(to, "#!/bin/sh\nexit 70\n");
  chmodSync(to, 0o755);
}

{
  run("cargo", [
    "build",
    "--manifest-path",
    join(srcTauri, "Cargo.toml"),
    "--bin",
    cargoHelperName,
    "--release",
  ]);

  const from = join(srcTauri, "target", "release", `${cargoHelperName}${extension}`);
  copyFileSync(from, to);
  chmodSync(to, 0o755);
  console.log(`Prepared helper sidecar: ${to}`);
}

run("npm", ["run", "build"]);
