import { chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { signBinary } from "./signing.mjs";

export function buildCaptureHelper(root, output, triple) {
  if (process.platform !== "darwin") {
    const result = spawnSync("rustc", [
      "--target", triple,
      join(root, "src-tauri", "native", "mds-capture-stub.rs"),
      "-o", output,
    ], { cwd: root, stdio: "inherit", shell: false });
    if (result.status !== 0) process.exit(result.status || 1);
    chmodSync(output, 0o755);
    return;
  }
  const architecture = triple.startsWith("aarch64-") ? "arm64" : "x86_64";
  const target = `${architecture}-apple-macosx11.0`;
  const source = join(root, "src-tauri", "native", "mds-capture.swift");
  const result = spawnSync("swiftc", [
    "-parse-as-library", "-target", target,
    "-framework", "ScreenCaptureKit",
    "-framework", "CoreGraphics",
    "-framework", "ImageIO",
    "-framework", "UniformTypeIdentifiers",
    source, "-o", output,
  ], { cwd: root, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status || 1);
  chmodSync(output, 0o755);
  signBinary(output, { require: true });
}
