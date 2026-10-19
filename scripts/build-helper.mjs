#!/usr/bin/env node
import { chmodSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { signBinary } from "./lib/signing.mjs";
import { buildCaptureHelper } from "./lib/build-capture-helper.mjs";

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

run("cargo", [
  "build",
  "--manifest-path",
  join(srcTauri, "Cargo.toml"),
  "--bin",
  cargoName,
]);

const from = join(srcTauri, "target", "debug", `${cargoName}${extension}`);
const to = join(srcTauri, "target", "debug", `${externalName}${extension}`);
if (from !== to) {
  copyFileSync(from, to);
}
chmodSync(to, 0o755);
const signedAs = signBinary(to, { require: true });

console.log(`Built ghost helper: ${to}`);
if (signedAs) console.log(`Signed helper as: ${signedAs}`);
const triple = process.platform === "darwin"
  ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin")
  : process.platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu";
buildCaptureHelper(root, join(srcTauri, "target", "debug", `mds-capture${extension}`), triple);
