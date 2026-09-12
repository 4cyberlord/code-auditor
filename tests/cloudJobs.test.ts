import {
  CLOUD_SOLVER_MAX_IMAGES,
  isSolveJobStatus,
  sanitizedSettingsSnapshot,
  validateCloudSolveJobDraft,
  type CloudSolveJobDraft,
} from "../src/lib/cloudJobs.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const image = (position: number) => ({
  position,
  storageBucket: "code-auditor-screenshots",
  storagePath: `sessions/s1/${position}.png`,
  fileName: `${position}.png`,
  bytes: 1234,
  mime: "image/png",
});

console.log("\n1. cloud job statuses");
check("queued is a status", isSolveJobStatus("queued"));
check("completed is a status", isSolveJobStatus("completed"));
check("random strings are not statuses", !isSolveJobStatus("done-ish"));

console.log("\n2. cloud job draft validation");
const valid: CloudSolveJobDraft = {
  sessionId: "session-1",
  mode: "council",
  settingsSnapshot: { councilEnabled: true },
  images: [image(0), image(1)],
};
check("valid draft passes", validateCloudSolveJobDraft(valid).length === 0);
check("mcq draft passes", validateCloudSolveJobDraft({ ...valid, mode: "mcq" }).length === 0);

const tooMany: CloudSolveJobDraft = {
  ...valid,
  images: Array.from({ length: CLOUD_SOLVER_MAX_IMAGES + 1 }, (_, i) => image(i)),
};
check(
  "eleventh screenshot is refused",
  validateCloudSolveJobDraft(tooMany).some((x) => x.includes("no more than"))
);

const broken: CloudSolveJobDraft = {
  sessionId: "",
  mode: "council",
  settingsSnapshot: {},
  images: [
    image(0),
    { ...image(0), storagePath: "", mime: "text/plain", bytes: 0 },
  ],
};
const errors = validateCloudSolveJobDraft(broken);
check("requires a session", errors.includes("sessionId is required"));
check("requires unique image order", errors.some((x) => x.includes("duplicate image position")));
check("requires storage path", errors.includes("storagePath is required"));
check("requires image mime", errors.some((x) => x.includes("is not an image")));
check("requires bytes", errors.some((x) => x.includes("has no bytes")));

console.log("\n3. settings snapshots do not carry secrets");
const snapshot = sanitizedSettingsSnapshot({
  gatewayKey: "secret",
  apiToken: "secret",
  nested: {
    password: "secret",
    model: "openai/gpt-5.6-sol",
  },
  list: [{ storageKey: "secret", id: "anthropic/claude-opus-4.6" }],
});
check("top-level keys stripped", !("gatewayKey" in snapshot) && !("apiToken" in snapshot));
check("nested secrets stripped", !("password" in (snapshot.nested as Record<string, unknown>)));
check("safe nested values preserved", (snapshot.nested as Record<string, unknown>).model === "openai/gpt-5.6-sol");
check("array values sanitized", !("storageKey" in (snapshot.list as Record<string, unknown>[])[0]));

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall cloud job checks passed\n");
process.exit(fail ? 1 : 0);
