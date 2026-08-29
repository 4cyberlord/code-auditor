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

import { execFileSync, spawnSync } from "node:child_process";
import "./lib/config.mjs";

if (process.platform !== "darwin") {
  console.error("Signing is a macOS thing; run this on the Mac.");
  process.exit(2);
}

function identities() {
  let out = "";
  try {
    out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  // Lines look like:  1) ABC123… "Developer ID Application: Name (TEAM)"
  return [...out.matchAll(/^\s*\d+\)\s+\w+\s+"([^"]+)"/gm)].map((m) => m[1]);
}

const found = identities();
const chosen =
  process.env.APPLE_SIGNING_IDENTITY?.trim() ||
  // Developer ID is the one that works on other people's machines. An Apple
  // Development certificate signs fine and then fails Gatekeeper everywhere
  // except here, which is the confusing way to discover the difference.
  found.find((i) => i.startsWith("Developer ID Application:")) ||
  found.find((i) => i.startsWith("Apple Development:"));

if (!chosen) {
  console.error(
    "\nNo code-signing identity found on this Mac.\n\n" +
      (found.length ? `  found: ${found.join(", ")}\n\n` : "") +
      "Open Xcode → Settings → Accounts → Manage Certificates and create a\n" +
      "Developer ID Application certificate, or run `npm run app:build` to\n" +
      "produce an unsigned bundle for local use.\n"
  );
  process.exit(1);
}

const isDeveloperId = chosen.startsWith("Developer ID Application:");
console.log(`\nSigning as: ${chosen}`);
if (!isDeveloperId) {
  console.log(
    "\n  This is a development certificate, not a Developer ID. The bundle will\n" +
      "  run here and be refused on any other Mac. Fine for testing the helper;\n" +
      "  not something to hand anyone.\n"
  );
}

const env = { ...process.env, APPLE_SIGNING_IDENTITY: chosen };

// Notarisation needs an Apple ID, an app-specific password and the team. Tauri
// picks these up itself when they are set; saying which are missing beats a
// build that silently produces something Gatekeeper will reject.
const notaryVars = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
const missing = notaryVars.filter((v) => !env[v]?.trim());
if (missing.length && isDeveloperId) {
  console.log(
    `  Not notarising: ${missing.join(", ")} not set.\n` +
      "  The bundle will be signed but still warn on a Mac that has not seen it.\n"
  );
}

const res = spawnSync("npm", ["run", "app:build"], { stdio: "inherit", env, shell: false });
process.exit(res.status ?? 1);
