#!/usr/bin/env node
import { copyFileSync, chmodSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { signBinary } from "./lib/signing.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const srcTauri = join(root, "src-tauri");
const args = process.argv.slice(2);

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

function hostTargetTriple() {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`Unsupported: ${process.platform}/${process.arch}`);
}

function targetTriple() {
  return process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || hostTargetTriple();
}

const extension = process.platform === "win32" ? ".exe" : "";
const dir = join(srcTauri, "binaries");
mkdirSync(dir, { recursive: true });

const cargoHelperName = "mds";
const helperName = "mds";
const explicitCargoTarget = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || "";
const triple = targetTriple();
const to = join(dir, `${helperName}-${triple}${extension}`);
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1] : args.includes("--debug") ? "debug" : "release";
const skipFrontend = args.includes("--skip-frontend") || args.includes("--no-frontend");

if (!["debug", "release"].includes(profile)) {
  throw new Error(`Unsupported profile: ${profile}`);
}

if (!existsSync(to)) {
  writeFileSync(to, "#!/bin/sh\nexit 70\n");
  chmodSync(to, 0o755);
}

const cargoArgs = ["build", "--manifest-path", join(srcTauri, "Cargo.toml"), "--bin", cargoHelperName];
if (profile === "release") cargoArgs.push("--release");
if (explicitCargoTarget) cargoArgs.push("--target", triple);
run("cargo", cargoArgs);

const from = explicitCargoTarget
  ? join(srcTauri, "target", triple, profile, `${cargoHelperName}${extension}`)
  : join(srcTauri, "target", profile, `${cargoHelperName}${extension}`);
signBinary(from, { require: true });
copyFileSync(from, to);
chmodSync(to, 0o755);
const signedAs = signBinary(to, { require: true });
console.log(`Prepared ${profile} sidecar: ${to}`);
if (signedAs) console.log(`Signed sidecar as: ${signedAs}`);

if (!skipFrontend) {
  run("npm", ["run", "build"]);
}
