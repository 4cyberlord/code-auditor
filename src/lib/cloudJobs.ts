export const CLOUD_SOLVER_MAX_IMAGES = 10;

export const SOLVE_JOB_STATUSES = [
  "queued",
  "running",
  "needs_attention",
  "failed",
  "completed",
  "cancelled",
] as const;

export type SolveJobStatus = (typeof SOLVE_JOB_STATUSES)[number];

export const SOLVE_JOB_EVENT_LEVELS = ["info", "warn", "error"] as const;

export type SolveJobEventLevel = (typeof SOLVE_JOB_EVENT_LEVELS)[number];

export interface QueuedSolveImage {
  position: number;
  storageBucket: string;
  storagePath: string;
  fileName: string;
  bytes: number;
  mime: string;
  width?: number | null;
  height?: number | null;
}

export interface CloudSolveJobDraft {
  sessionId: string;
  mode: "council";
  settingsSnapshot: Record<string, unknown>;
  images: QueuedSolveImage[];
}

const SECRET_KEY = /(api|secret|token|key|password|credential)/i;

export function isSolveJobStatus(value: string): value is SolveJobStatus {
  return (SOLVE_JOB_STATUSES as readonly string[]).includes(value);
}

export function sanitizedSettingsSnapshot(
  settings: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SECRET_KEY.test(key)) continue;
    if (Array.isArray(value)) out[key] = value.map((x) => sanitizeNested(x));
    else out[key] = sanitizeNested(value);
  }
  return out;
}

function sanitizeNested(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((x) => sanitizeNested(x));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!SECRET_KEY.test(key)) out[key] = sanitizeNested(inner);
  }
  return out;
}

export function validateCloudSolveJobDraft(draft: CloudSolveJobDraft): string[] {
  const errors: string[] = [];
  if (!draft.sessionId.trim()) errors.push("sessionId is required");
  if (draft.mode !== "council") errors.push("v1 cloud solving only supports council mode");
  if (!draft.images.length) errors.push("at least one screenshot is required");
  if (draft.images.length > CLOUD_SOLVER_MAX_IMAGES) {
    errors.push(`no more than ${CLOUD_SOLVER_MAX_IMAGES} screenshots can be submitted`);
  }

  const positions = new Set<number>();
  for (const image of draft.images) {
    if (!Number.isInteger(image.position) || image.position < 0) {
      errors.push("image positions must be zero-based integers");
    }
    if (positions.has(image.position)) errors.push(`duplicate image position ${image.position}`);
    positions.add(image.position);
    if (!image.storageBucket.trim()) errors.push("storageBucket is required");
    if (!image.storagePath.trim()) errors.push("storagePath is required");
    if (!image.fileName.trim()) errors.push("fileName is required");
    if (!image.mime.startsWith("image/")) errors.push(`${image.fileName} is not an image`);
    if (!Number.isFinite(image.bytes) || image.bytes <= 0) {
      errors.push(`${image.fileName} has no bytes`);
    }
  }

  return [...new Set(errors)];
}
