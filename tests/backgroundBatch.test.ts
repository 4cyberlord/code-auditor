import {
  IDLE_BACKGROUND_BATCH,
  addImageToBackgroundBatch,
  buildCloudSolveJobDraft,
  cancelBackgroundBatch,
  startBackgroundBatch,
} from "../src/lib/backgroundBatch.ts";
import { CLOUD_SOLVER_MAX_IMAGES } from "../src/lib/cloudJobs.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const img = {
  position: 99,
  storageBucket: "code-auditor-screenshots",
  storagePath: "sessions/s1/a.png",
  fileName: "a.png",
  bytes: 42,
  mime: "image/png",
};

console.log("\n1. batch lifecycle");
const started = startBackgroundBatch("2026-08-26T00:00:00Z", "batch-1");
check("starts collecting", started.status === "collecting");
const one = addImageToBackgroundBatch(started, img);
check("first image makes it ready", one.status === "ready");
check("position is assigned by batch order", one.images[0].position === 0);
const cancelled = cancelBackgroundBatch(one);
check("cancel clears images", cancelled.status === "cancelled" && cancelled.images.length === 0);

console.log("\n2. guards");
const rejected = addImageToBackgroundBatch(IDLE_BACKGROUND_BATCH, img);
check("cannot add without a batch", !!rejected.error);
let full = started;
for (let i = 0; i < CLOUD_SOLVER_MAX_IMAGES; i++) full = addImageToBackgroundBatch(full, img);
const eleventh = addImageToBackgroundBatch(full, img);
check("eleventh screenshot is refused", eleventh.images.length === CLOUD_SOLVER_MAX_IMAGES);
check("refusal explains the limit", eleventh.error?.includes(String(CLOUD_SOLVER_MAX_IMAGES)) === true);

console.log("\n3. submit draft");
const { draft, errors } = buildCloudSolveJobDraft(one, "session-1", {
  gatewayKey: "secret",
  councilEnabled: true,
});
check("valid batch builds a draft", !!draft && errors.length === 0);
check("draft is council mode", draft?.mode === "council");
check("secrets are stripped", draft ? !("gatewayKey" in draft.settingsSnapshot) : false);
const empty = buildCloudSolveJobDraft(started, "session-1", {});
check("empty batch is not submitted", empty.errors.some((x) => x.includes("at least one")));

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall background batch checks passed\n");
process.exit(fail ? 1 : 0);
