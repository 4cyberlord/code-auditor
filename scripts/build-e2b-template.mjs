#!/usr/bin/env node

// Configuration lives in the database now. This import has a top-level await,
// so app_config is merged into process.env before anything below reads it.
import "./lib/config.mjs";

import { Template, defaultBuildLogger } from "e2b";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
}

loadDotEnv(path.join(process.cwd(), ".development.env"));
loadDotEnv(path.join(process.cwd(), ".env"));

if (!process.env.E2B_API_KEY?.trim()) {
  console.error("E2B_API_KEY is missing. Add it to .development.env and run again.");
  process.exit(2);
}

const alias = process.env.CODE_AUDITOR_E2B_TEMPLATE || "code-editor-runners";

const template = Template()
  .fromTemplate("code-interpreter-v1")
  .aptInstall(["time", "curl", "ca-certificates", "build-essential", "pkg-config", "golang-go"], {
    noInstallRecommends: true,
  })
  .runCmd(
    [
      "mkdir -p /opt/rust/cargo /opt/rust/rustup",
      "CARGO_HOME=/opt/rust/cargo RUSTUP_HOME=/opt/rust/rustup curl https://sh.rustup.rs -sSf | CARGO_HOME=/opt/rust/cargo RUSTUP_HOME=/opt/rust/rustup sh -s -- -y --profile minimal",
      "CARGO_HOME=/opt/rust/cargo RUSTUP_HOME=/opt/rust/rustup /opt/rust/cargo/bin/rustup default stable",
      "chmod -R a+rX /opt/rust",
      "CARGO_HOME=/opt/rust/cargo RUSTUP_HOME=/opt/rust/rustup /opt/rust/cargo/bin/rustc --version",
      "CARGO_HOME=/opt/rust/cargo RUSTUP_HOME=/opt/rust/rustup /opt/rust/cargo/bin/cargo --version",
      "go version",
      "/usr/bin/time --version | head -1",
    ],
    { user: "root" }
  )
  .runCmd(
    [
      "printf '%s\\n' '#!/usr/bin/env bash' 'export CARGO_HOME=/opt/rust/cargo' 'export RUSTUP_HOME=/opt/rust/rustup' 'exec /opt/rust/cargo/bin/rustc \"$@\"' > /usr/local/bin/rustc",
      "printf '%s\\n' '#!/usr/bin/env bash' 'export CARGO_HOME=/opt/rust/cargo' 'export RUSTUP_HOME=/opt/rust/rustup' 'exec /opt/rust/cargo/bin/cargo \"$@\"' > /usr/local/bin/cargo",
      "printf '%s\\n' '#!/usr/bin/env bash' 'export CARGO_HOME=/opt/rust/cargo' 'export RUSTUP_HOME=/opt/rust/rustup' 'exec /opt/rust/cargo/bin/rustup \"$@\"' > /usr/local/bin/rustup",
      "chmod 0755 /usr/local/bin/rustc /usr/local/bin/cargo /usr/local/bin/rustup",
    ],
    { user: "root" }
  );

console.log(`Building E2B template "${alias}"...`);
const info = await Template.build(template, alias, {
  onBuildLogs: defaultBuildLogger(),
});
console.log(JSON.stringify(info, null, 2));
