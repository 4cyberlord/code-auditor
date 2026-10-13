import assert from "node:assert/strict";
import { ALL_AGENTS, CLEANAPIS_GATEWAY, EXTRA_AGENTS, KNOWN_GATEWAYS, PROVIDERS, PROVIDER_ORDER } from "../src/lib/models.ts";
import {
  PRIMARY_MODEL_IDS,
  isPrimaryModel,
  listedPrimaryRoute,
  preferredPrimaryRoute,
  primaryCatalog,
  primaryModelId,
} from "../src/lib/primaryModels.ts";

assert.equal(PRIMARY_MODEL_IDS.length, 10);
assert.equal(new Set(PRIMARY_MODEL_IDS).size, 10);
assert.equal(ALL_AGENTS.length, 10);
assert.equal(new Set([
  ...PROVIDER_ORDER.map(id => primaryModelId(PROVIDERS[id].defaultModel)),
  ...EXTRA_AGENTS.map(agent => primaryModelId(agent.model)),
]).size, 10, "every approved model has one selectable slot");
assert.equal(KNOWN_GATEWAYS.some(gateway => gateway.id === "cleanapis"), true);
assert.equal(CLEANAPIS_GATEWAY.defaultBaseUrl, "https://cleanapis.com/v1");
for (const id of PRIMARY_MODEL_IDS) {
  assert.equal(primaryModelId(id), id);
  for (const gateway of ["tokenrouter", "wiro", "cleanapis"] as const) {
    assert.equal(primaryModelId(preferredPrimaryRoute(id, gateway)), id,
      `${gateway} should never substitute another model for ${id}`);
  }
}
assert.equal(listedPrimaryRoute("google/gemini-3.1-pro",
  ["google/gemini-3-7-flash", "google/gemini-3-1-pro"]), "google/gemini-3-1-pro");
assert.deepEqual(primaryCatalog(["claude/opus-5", "kimi-k3", "gpt-5.6-sol"]),
  ["kimi-k3", "gpt-5.6-sol"]);
assert.equal(isPrimaryModel("google/gemini-3.7-flash"), false);
assert.equal(isPrimaryModel("claude/opus-5"), false);
assert.equal(isPrimaryModel("gpt-5.6-luna"), false);
assert.equal(isPrimaryModel(undefined), false);

console.log("PASS: Clean APIs gateway and exact ten-model allowlist");
