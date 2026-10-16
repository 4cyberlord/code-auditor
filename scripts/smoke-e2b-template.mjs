#!/usr/bin/env node
/** Explicit E2B Hobby smoke test. Never runs during normal CI/PR processing. */
import { Sandbox } from "e2b";
const key = String(process.env.E2B_API_KEY || "").trim();
const alias = String(process.env.CODE_AUDITOR_E2B_TEMPLATE || "").trim();
if (!key || !alias) {
  console.error("Specify E2B_API_KEY and CODE_AUDITOR_E2B_TEMPLATE for an explicitly built canary image.");
  process.exitCode = 2;
} else {
  let sandbox;
  try {
    sandbox = await Sandbox.create(alias, {
      apiKey: key, timeoutMs: 120_000, allowInternetAccess: false,
      metadata: {app:"council-editor", purpose:"explicit-template-smoke"},
    });
    const cmd = [
      "set -e",
      "python3 --version",
      "c++ --version | head -1",
      "rustc --version",
      "cargo --version",
      "test -x /usr/bin/time",
      "test \"$(command -v python3)\" != ''",
      "if [ \"$COUNCIL_LAB_TEMPLATE_REVISION\" = '' ]; then exit 49; fi",
    ].join("; ");
    const quote = value => "\'" + String(value).replaceAll("\'", "\'\\\"\'\\\"\'") + "\'";
    const result=await sandbox.commands.run("bash -lc " + quote(cmd),{timeoutMs:60_000});
    if (result.exitCode !== 0)throw new Error("Template smoke failed with exit "+result.exitCode+
      ": "+String(result.stderr||"").slice(0,600));
    console.log("PASS: template "+alias+" executed isolated Python, C++, Rust and required tools.");
  } catch(error) {
    console.error("FAIL: "+String(error instanceof Error?error.message:error));
    process.exitCode = 1;
  } finally {
    if (sandbox) {
      try { await sandbox.kill(); }
      catch(error) {
        console.error("FAIL: sandbox cleanup: "+String(error));
        process.exitCode=1;
      }
    }
  }
}
