import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../src/components/SettingsDialog.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const council = settings.split("function CouncilCard() {")[1]?.split("/**\n * The three global shortcuts")[0] ?? "";

assert.ok(council.length > 12000, "Full Council UI must remain");
assert.match(council, /settings-council-card/, "Council must use scoped form styles");
assert.match(council, /settings-roster-row/, "Multi-line rosters must be vertically aligned");
assert.match(council, /settings-form-section-heading/, "Council must have readable section groupings");
assert.match(council, /settings-inline-help/, "Long explanations should be optional");

for (const behavior of [
  "onBlur={commitSolvers}",
  "onBlur={commitJudges}",
  "patch({ councilEnabled: v })",
  "patch({ outputLanguage: event.target.value })",
  "patch({ councilIncludePanel: v })",
  "patch({ memoryTargetKb:",
  "patch({ e2bTimeoutMs:",
  "patch({ synthesisModel: e.target.value })",
  "void listModels()",
  "void testModels(councilModelsInUse, false)",
  "<ProbeBadge",
  "settings.councilModels",
  "settings.councilJudges",
]) {
  assert.ok(council.includes(behavior), "Council setting/probe behavior missing: " + behavior);
}

for (const id of ["default-solution-language", "memory-target", "e2b-timeout", "council-solvers", "council-judges", "council-synth"]) {
  assert.ok(council.includes('id="' + id + '"'), "Accessible Council control missing: " + id);
}
assert.match(settings, /title="Unlock API settings"/);
assert.match(settings, /title="Unlock account settings"/);
assert.match(settings, /authReauthenticate\(pin\)/);
assert.match(settings, /settings-inline-help[\s\S]*?Permissions and capture sequence/);
assert.match(settings, /Capture & Overlay/);
assert.match(css, /\.settings-workspace \.settings-workspace-content \.field[\s\S]*?min-height: 42px/);
assert.match(css, /padding: 0 14px;/);
assert.match(css, /textarea\.field[\s\S]*?padding: 13px 15px/);
assert.match(css, /\.row\.settings-roster-row/);
assert.match(css, /@media \(max-width: 700px\)/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
const scoped = css.slice(css.lastIndexOf("Settings form polish:"));
assert.doesNotMatch(scoped, /\.coding-overlay[\s.{:#]|\.overlay-panel[\s.{:#]/, "Settings CSS cannot style overlay controls");
console.log("PASS: clean Settings form fields, Council persistence, roster edit behavior, gateway probes, security and overlay isolation");
