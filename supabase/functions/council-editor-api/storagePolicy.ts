/** Pure upload-key policy shared by the Edge Function and Node regression tests. */
export const SCREENSHOT_BUCKET = "screenshots";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateScreenshotUploadKey(
  ownerId: string,
  path: unknown,
  bucket: unknown,
): string | null {
  if (bucket !== undefined && bucket !== SCREENSHOT_BUCKET) return "Unsupported screenshot bucket.";
  if (typeof path !== "string" || path.length > 512) return "Invalid screenshot path.";
  if (!ID.test(ownerId) || !path.startsWith(ownerId + "/")) return "Screenshot path must belong to the account.";
  if (path.includes("\\") || path.includes("//") || /[?#%\u0000-\u001f\u007f]/.test(path)) return "Invalid screenshot path.";
  const parts = path.split("/");
  if (parts.length < 3 || parts.some((part) => !part || part === "." || part === "..")) return "Invalid screenshot path.";
  // Existing captures use account/session/name; retry-safe captures use
  // account/session/submission-uuid/position-name.
  if (!ID.test(parts[1]) || (parts.length !== 3 && parts.length !== 4)) return "Invalid screenshot path.";
  if (parts.length === 4 && !ID.test(parts[2])) return "Invalid screenshot submission.";
  const file = parts.at(-1)!;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file) || file.includes("..")) return "Invalid screenshot filename.";
  if (parts.length === 4 && !/^[0-9]-/.test(file)) return "Invalid screenshot position.";
  return null;
}
