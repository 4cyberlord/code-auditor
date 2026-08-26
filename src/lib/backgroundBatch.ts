import {
  CLOUD_SOLVER_MAX_IMAGES,
  sanitizedSettingsSnapshot,
  validateCloudSolveJobDraft,
  type CloudSolveJobDraft,
  type QueuedSolveImage,
} from "./cloudJobs.ts";

export type BackgroundBatchStatus = "idle" | "collecting" | "ready" | "submitted" | "cancelled";

export interface BackgroundBatchState {
  id: string | null;
  status: BackgroundBatchStatus;
  sessionId: string | null;
  images: QueuedSolveImage[];
  startedAt: string | null;
  submittedAt: string | null;
  error: string | null;
}

export const IDLE_BACKGROUND_BATCH: BackgroundBatchState = {
  id: null,
  status: "idle",
  sessionId: null,
  images: [],
  startedAt: null,
  submittedAt: null,
  error: null,
};

export function startBackgroundBatch(
  now = new Date().toISOString(),
  id = `batch-${Date.now().toString(36)}`
): BackgroundBatchState {
  return {
    id,
    status: "collecting",
    sessionId: null,
    images: [],
    startedAt: now,
    submittedAt: null,
    error: null,
  };
}

export function addImageToBackgroundBatch(
  state: BackgroundBatchState,
  image: QueuedSolveImage
): BackgroundBatchState {
  if (state.status !== "collecting" && state.status !== "ready") {
    return { ...state, error: "Start a background batch before adding screenshots." };
  }
  if (state.images.length >= CLOUD_SOLVER_MAX_IMAGES) {
    return { ...state, status: "ready", error: `A batch can hold ${CLOUD_SOLVER_MAX_IMAGES} screenshots.` };
  }
  const images = [...state.images, { ...image, position: state.images.length }];
  return { ...state, images, status: "ready", error: null };
}

export function cancelBackgroundBatch(state: BackgroundBatchState): BackgroundBatchState {
  if (state.status === "idle") return state;
  return { ...IDLE_BACKGROUND_BATCH, id: state.id, status: "cancelled" };
}

export function buildCloudSolveJobDraft(
  state: BackgroundBatchState,
  sessionId: string,
  settings: Record<string, unknown>
): { draft: CloudSolveJobDraft | null; errors: string[] } {
  if (state.status !== "ready" && state.status !== "collecting") {
    return { draft: null, errors: ["batch is not ready to submit"] };
  }
  const draft: CloudSolveJobDraft = {
    sessionId,
    mode: "council",
    settingsSnapshot: sanitizedSettingsSnapshot(settings),
    images: state.images.map((image, position) => ({ ...image, position })),
  };
  const errors = validateCloudSolveJobDraft(draft);
  return { draft: errors.length ? null : draft, errors };
}
