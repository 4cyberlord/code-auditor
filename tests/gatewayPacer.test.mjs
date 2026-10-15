import assert from "node:assert/strict";
import { createGatewayPacer, gatewayPacingScope } from "../scripts/lib/gatewayPacer.mjs";

assert.equal(gatewayPacingScope(undefined), "global");
assert.equal(gatewayPacingScope("unexpected"), "global");
assert.equal(gatewayPacingScope("per_model"), "per_model");

const globalWaits = [];
const global = createGatewayPacer({
  scope: "global", minDelayMs: 100, jitterMs: 0, now: () => 0,
  delay: async ms => { globalWaits.push(ms); },
});
await Promise.all([global("first-model"), global("second-model"), global("third-model")]);
assert.deepEqual(globalWaits, [100,100],
  "Default global mode must preserve rate-limit spacing even for different models");

const laneWaits = [];
const lanes = createGatewayPacer({
  scope: "per_model", minDelayMs: 100, jitterMs: 0, now: () => 0,
  delay: async ms => { laneWaits.push(ms); },
});
await Promise.all([lanes("model-a"),lanes("model-b"),lanes("model-a"),lanes("model-b")]);
assert.deepEqual(laneWaits, [100,100],
  "Different models start immediately, repeated same-model calls are paced");

const invalidModeWaits=[];
const invalid = createGatewayPacer({
  scope: "invalid", minDelayMs: 10, jitterMs: 0, now: () => 0,
  delay: async ms => { invalidModeWaits.push(ms); },
});
await Promise.all([invalid("model-a"),invalid("model-b")]);
assert.deepEqual(invalidModeWaits,[10],"Unknown modes must fail back to global throttling");

const jitterWaits=[];
const jitter = createGatewayPacer({
  minDelayMs: 100, jitterMs: 20, now: () => 0, random: () => .5,
  delay: async ms => { jitterWaits.push(ms); },
});
await jitter("a");
await jitter("b");
assert.deepEqual(jitterWaits,[110],"Configured jitter remains supported");

let call=0;
const resilience=createGatewayPacer({
  minDelayMs: 20, jitterMs: 0, now: () => 0,
  delay: async () => { if (call++ === 0) throw new Error("timer interrupted"); },
});
await resilience("a");
await assert.rejects(resilience("b"),/timer interrupted/);
await resilience("c"); // one failed queued turn must not poison future requests
console.log("PASS: Council gateway pacing preserves conservative default and supports opt-in per-model lanes");
