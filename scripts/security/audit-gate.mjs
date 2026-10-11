// No blanket suppression. Only unpatched development-tool advisory
// GHSA-vfj7-8cjw-p6xm is excepted; production is checked separately.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const UNPATCHED_DEV_ADVISORY = "GHSA-vfj7-8cjw-p6xm";
const ALLOWED_CHAIN = new Set([
  "braces", "micromatch", "fast-glob", "@next/eslint-plugin-next", "eslint-config-next",
]);

export function assessAudit(report, lock) {
  if (!report || typeof report !== "object" || !report.vulnerabilities) {
    return { ok: false, errors: ["npm audit did not return a valid vulnerability report"], exception: [] };
  }
  const errors = [];
  const affected = Object.entries(report.vulnerabilities).filter(([,v]) =>
    ["low","moderate","high","critical"].includes(v.severity));
  if (!affected.length) return { ok: true, errors, exception: [] };
  const root = report.vulnerabilities.braces;
  const matchedAdvisory = root?.via?.some(item =>
    item && typeof item === "object" &&
    (item.url || "").toLowerCase().includes(UNPATCHED_DEV_ADVISORY.toLowerCase()));
  if (!matchedAdvisory) errors.push("Unexpected security advisory: no matching unpatched braces advisory");
  for (const [name, v] of affected) {
    if (!ALLOWED_CHAIN.has(name)) errors.push("New unapproved " + v.severity + " advisory: " + name);
    if (v.severity === "critical") errors.push("Critical advisory cannot be excepted: " + name);
    for (const node of v.nodes || ["node_modules/" + name]) {
      if (lock.packages?.[node]?.dev !== true) errors.push("Advisory reaches production dependency: " + node);
    }
  }
  return { ok: errors.length === 0, errors, exception: affected.map(([name])=>name) };
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (direct) {
  try {
    const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const lock = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    const result = assessAudit(report, lock);
    for (const error of result.errors) console.error("::error::" + error);
    if (result.exception.length) console.warn(
      "::warning::Unpatched dev-only braces GHSA-vfj7-8cjw-p6xm (and transitive audit chain): " +
      result.exception.join(", ") + ". No patched version as of 2026-10-11. " +
      "Only developer-controlled lint patterns; monitor for an upstream release."
    );
    if (!result.ok) process.exitCode = 1;
    else console.log("Dependency audit policy passed; unexpected advisories are blocked.");
  } catch (error) {
    console.error("::error::Could not validate npm audit report: " + error);
    process.exitCode = 1;
  }
}
