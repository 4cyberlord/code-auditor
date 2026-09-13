import { execFileSync, spawnSync } from "node:child_process";

export function codesigningIdentities() {
  if (process.platform !== "darwin") return [];
  let out = "";
  try {
    out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  return [...out.matchAll(/^\s*\d+\)\s+\w+\s+"([^"]+)"/gm)].map((m) => m[1]);
}

export function developerIdApplicationIdentity() {
  if (process.platform !== "darwin") return "";
  const explicit = process.env.APPLE_SIGNING_IDENTITY?.trim() || process.env.CODESIGN_IDENTITY?.trim();
  if (explicit?.startsWith("Developer ID Application:")) return explicit;
  return codesigningIdentities().find((i) => i.startsWith("Developer ID Application:")) || "";
}

export function signingIdentity({ require = false } = {}) {
  if (process.platform !== "darwin") return "";
  const explicit = process.env.APPLE_SIGNING_IDENTITY?.trim() || process.env.CODESIGN_IDENTITY?.trim();
  const found = codesigningIdentities();
  const chosen =
    explicit ||
    found.find((i) => i.startsWith("Developer ID Application:")) ||
    found.find((i) => i.startsWith("Apple Development:"));

  if (!chosen && require && process.env.CODE_AUDITOR_ALLOW_ADHOC !== "1") {
    throw new Error(
      "No Developer ID Application or Apple Development signing identity found. " +
        "Create one in Xcode, set APPLE_SIGNING_IDENTITY/CODESIGN_IDENTITY, " +
        "or set CODE_AUDITOR_ALLOW_ADHOC=1 for a local-only ad-hoc helper."
    );
  }

  return chosen || "";
}

export function signBinary(path, { require = false } = {}) {
  if (process.platform !== "darwin") return "";
  const identity = signingIdentity({ require });
  if (!identity) {
    console.warn(`Leaving ${path} ad-hoc signed because CODE_AUDITOR_ALLOW_ADHOC=1 or no identity was required.`);
    return "";
  }

  const res = spawnSync("codesign", ["--force", "--sign", identity, "--options", "runtime", path], {
    stdio: "inherit",
    shell: false,
  });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
  return identity;
}
