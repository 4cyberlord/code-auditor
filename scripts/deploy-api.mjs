#!/usr/bin/env node
/**
 * Deploy the Council Editor API to the project this app is built against.
 *
 *   npm run api:deploy
 *
 * A wrapper around one Supabase CLI command, for one reason: the project ref
 * is already in `SUPABASE_URL`, and a deploy that asks you to paste it is a
 * deploy that eventually goes to the wrong project. This reads the ref from the
 * environment the rest of the tooling uses, says which project it is about to
 * write to, and then runs the CLI.
 *
 * Nothing here needs the service-role key. Deploying is an account-level
 * action, so the CLI's own login is what authorises it — `supabase login`, or
 * SUPABASE_ACCESS_TOKEN in the environment.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

for (const file of [".development.env", ".env"]) {
  const full = path.join(process.cwd(), file);
  if (!existsSync(full)) continue;
  for (const raw of readFileSync(full, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const url = (process.env.SUPABASE_URL || "").trim();
const ref = process.env.SUPABASE_PROJECT_REF || /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(url)?.[1] || "";
if (!ref) {
  console.error("No project ref: set SUPABASE_URL (or SUPABASE_PROJECT_REF) in .development.env.");
  process.exit(2);
}

const dry = process.argv.includes("--dry-run");
const args = ["functions", "deploy", "council-editor-api", "--project-ref", ref];

console.log(`\nDeploying council-editor-api to ${ref}`);
console.log(`  supabase ${args.join(" ")}\n`);
if (dry) {
  console.log("--dry-run: nothing was deployed.\n");
  process.exit(0);
}

// npx rather than a global install, so this works on a machine that has the CLI
// and on one that does not, without a README step in between.
const run = spawnSync("npx", ["--yes", "supabase", ...args], { stdio: "inherit" });
if (run.status !== 0) {
  console.error(
    "\nThe deploy did not finish. If it asked for credentials, run `npx supabase login` once,\n" +
      "or set SUPABASE_ACCESS_TOKEN in .development.env.\n"
  );
  process.exit(run.status || 1);
}
console.log("\nDeployed. The Knowledge tab's Publish button works from here.\n");
