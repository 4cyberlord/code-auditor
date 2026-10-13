import assert from "node:assert/strict";
import { routeFor, useStore } from "../src/lib/store.ts";

const initial = useStore.getState();
const settings = {
  ...initial.settings,
  gatewayId: "wiro" as const,
  useGateway: true,
  routerModels: { ...initial.settings.routerModels, moonshot: "moonshotai/kimi-k3" },
  probes: {},
};
assert.equal(routeFor("moonshot", settings, initial.keys, true)?.model,
  "moonshotai/kimi-k3", "Wiro Kimi is not hard-blocked before live discovery");

useStore.setState({
  runId: "audit-run", running: true, settings,
  agents: initial.agents.map(agent => ({ ...agent, enabled: false, status: "idle" as const })),
});
useStore.getState().patchSettings({ probes: {
  "openai/gpt-5-6-sol": { ok: true, ms: 20, error: null, at: Date.now(), vision: true, visionNote: null },
} });
assert.ok(useStore.getState().agents.every(agent => !agent.enabled),
  "saving a probe must preserve the adaptive selection rather than restoring configured flags");

const preparingStates: boolean[] = [];
const stopWatching = useStore.subscribe(state => preparingStates.push(state.preparing));
useStore.setState({
  running: false,
  preparing: false,
  gatewayKey: false,
  keys: Object.fromEntries(Object.keys(initial.keys).map(key => [key, false])) as typeof initial.keys,
  note: "A test task",
  settings: {
    ...settings,
    useGateway: false,
    enabled: Object.fromEntries(Object.keys(settings.enabled).map(key => [key, false])) as typeof settings.enabled,
  },
});
await useStore.getState().start({ adaptivePanels: true });
stopWatching();
assert.ok(preparingStates.includes(true), "a start must expose preflight progress immediately");
assert.equal(useStore.getState().preparing, false,
  "a failed preflight must not leave the app looking busy forever");

console.log("PASS: dynamic Wiro routing and adaptive selection survive settings writes");
