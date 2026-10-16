import assert from "node:assert/strict";
import {createSandboxCapacity, hobbyWorkerLimit, standbyBudget} from "../scripts/lib/e2bCapacity.mjs";
import {createE2BWarmPool} from "../scripts/lib/e2bWarmPool.mjs";

assert.equal(hobbyWorkerLimit("99"),8);
assert.equal(hobbyWorkerLimit("4"),4);
const capacity = createSandboxCapacity(2);
const first = await capacity.acquire();
const second = await capacity.acquire();
assert.equal(capacity.snapshot().active,2);
let obtained = false;
const wait = capacity.acquire().then(release => {obtained = true; return release;});
await Promise.resolve();
assert.equal(obtained,false);
first();
const third = await wait;
assert.equal(capacity.snapshot().active,2);
first(); third(); second();
assert.equal(capacity.snapshot().active,0);

let creates=0, kills=0;
const events=[];
const pool = createE2BWarmPool({
  create: async letter => {creates++; return {sandbox:{sandboxId:letter}, release:() => {}};},
  destroy: async lease => {assert.ok(lease.sandbox); kills++;},
  onEvent: (type,meta) => events.push([type,meta.letter]),
});
pool.prewarm(["A","B","C","D","E"]);
assert.equal(pool.snapshot().slots.length,4);
const a = await pool.take("A");
assert.equal(a.sandbox.sandboxId,"A");
assert.equal(await pool.take("A"),null);
await pool.close();
assert.equal(creates,4);
assert.equal(kills,3);
assert.equal(await pool.take("B"),null);
assert.ok(events.some(e=>e[0]==="reused"));
await pool.close();
const failing = createE2BWarmPool({
  create: async letter => {if(letter==="A")throw Error("startup failed"); return {sandbox:{sandboxId:letter}};},
  destroy: async () => {},
});
failing.prewarm(["A","B"]);
assert.equal(await failing.take("A"),null);
assert.equal((await failing.take("B")).sandbox.sandboxId,"B");
await failing.close();
// Closing during startup must dispose the eventual sandbox, never hand it out.
let resolveStart, lateKills=0;
const late = createE2BWarmPool({
  create: () => new Promise(resolve => {resolveStart=resolve;}),
  destroy: async () => {lateKills++;},
});
late.prewarm(["A"]);
await Promise.resolve(); await Promise.resolve();
const closing = late.close();
resolveStart({sandbox:{sandboxId:"late"}});
await closing;
assert.equal(lateKills,1);
assert.equal(await late.take("A"),null);
console.log("PASS: bounded Hobby capacity; four independent warm slots; reuse once; cleanup on failure");

assert.equal(standbyBudget({active:0,limit:8},4),4);
assert.equal(standbyBudget({active:0,limit:4},4),2);
assert.equal(standbyBudget({active:0,limit:2},4),0);
assert.equal(standbyBudget({active:1,limit:3},4),0);
assert.equal(standbyBudget({active:5,limit:8},4),1);
console.log("PASS: standby never occupies the last two verification slots");

const cleanupFailure = createE2BWarmPool({
 create: async letter => ({sandbox:{sandboxId:letter}}),
 destroy: async () => {throw Error("E2B kill failed");},
});
cleanupFailure.prewarm(["A"]);
await assert.rejects(cleanupFailure.close(),/E2B standby cleanup failed/);
assert.equal(cleanupFailure.snapshot().cleanupFailures,1);
console.log("PASS: failed sandbox disposal is surfaced rather than silently ignored");
