#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const srcTauri = join(root, "src-tauri");
const extension = process.platform === "win32" ? ".exe" : "";
const helper = join(srcTauri, "target", "debug", `com.apple.corespotlightd${extension}`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

run("node", [join(root, "scripts", "build-helper.mjs")]);
run(helper, []);
