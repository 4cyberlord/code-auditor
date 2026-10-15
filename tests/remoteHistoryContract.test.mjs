import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("remote history queries account-owned jobs by origin, not current desktop session", () => {
  const api = read("supabase/functions/council-editor-api/ops.ts");
  assert.match(api, /eq\("owner_id", principal\.userId\)/);
  assert.match(api, /contains\("settings_snapshot", \{ origin: "remote-terminal" \}\)/);
  assert.match(api, /range\(offset, offset \+ limit - 1\)/);
  const remote = read("src/components/RemoteHistory.tsx");
  assert.match(remote, /origin: "remote-terminal"/);
  assert.doesNotMatch(remote, /sessionId === current/);
  assert.match(remote, /Load older remote solutions/);
});

test("Rust command and TypeScript bridge both pass filtered pagination", () => {
  const rust = read("src-tauri/src/sessions.rs");
  const ts = read("src/lib/sessions.ts");
  assert.match(rust, /origin: Option<String>/);
  assert.match(rust, /offset: Option<i32>/);
  assert.match(rust, /limit: Option<i32>/);
  assert.match(ts, /origin\?: "remote-terminal"/);
  assert.match(ts, /"solve_job_list", \{ status, \.\.\.options \}/);
});

test("remote cloud reports are accessible from BOTH History interfaces", () => {
  for (const path of ["src/components/HistoryPanel.tsx", "src/app/page.tsx"]) {
    const code = read(path);
    assert.match(code, /import RemoteHistory from "@\/components\/RemoteHistory"/);
    assert.match(code, /<RemoteHistory \/>/);
  }
  const remote = read("src/components/RemoteHistory.tsx");
  assert.match(remote, /getCouncilReport\(selected.id\)/);
  assert.match(remote, /listSolveJobImages\(selected.id\)/);
});

test("cloud worker can find configured gateway for a credentialed remote job", () => {
  const worker = read("scripts/cloud-worker.mjs");
  assert.match(worker, /settings\?\.origin === "remote-terminal"/);
  assert.match(worker, /for \(const candidate of \["tokenrouter", "cleanapis", "wiro"\]\)/);
  assert.match(worker, /gatewayBaseUrl\(settings\)/);
});
