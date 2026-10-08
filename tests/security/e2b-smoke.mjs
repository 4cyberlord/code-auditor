import assert from "node:assert/strict";
import { Sandbox } from "@e2b/code-interpreter";

if (!process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY secret is unavailable. Configure it in repository Actions secrets.");
}

let sandbox;
try {
  sandbox = await Sandbox.create({ timeoutMs: 90_000, allowInternetAccess: false });
  const success = await sandbox.commands.run("python3 -c 'print(\"COUNCIL_E2B_SMOKE_OK\")'", { timeoutMs: 30_000 });
  assert.equal(success.exitCode, 0, "Valid Python program exited unsuccessfully");
  assert.match(success.stdout ?? "", /COUNCIL_E2B_SMOKE_OK/, "Missing expected program output");

  // E2B SDK throws CommandExitError for non-zero exits; this failure is intentional.
  // Keep the command's real result, but do not suppress transport/authentication errors.
  const failure = await sandbox.commands.run("python3 -c 'raise RuntimeError(\"EXPECTED_E2B_FAILURE\")'", { timeoutMs: 30_000 })
    .catch((error) => {
      if (!error?.result || error.result.exitCode === 0) throw error;
      return error.result;
    });
  assert.notEqual(failure.exitCode, 0, "Failing program unexpectedly reported success");
  assert.match(failure.stderr ?? "", /EXPECTED_E2B_FAILURE/, "Missing failure diagnostics");

  console.log("PASS: E2B sandbox execution and failure diagnostics");
} finally {
  if (sandbox) {
    await sandbox.kill();
    console.log("PASS: E2B sandbox kill completed");
  }
}
