import assert from "node:assert/strict";
import {extractDifferentialTrace,compareDifferentialTraces,sharedDifferentialFixtures} from "../scripts/lib/e2bDifferential.mjs";
const src=['PASS normal','CA_DIFF_CASE {"id":"normal","input":{"a":1,"b":2},"actual":[0,1]}',
 'CA_DIFF_CASE {"id":"zero","input":[0],"actual":0}'].join("\n");
const ok=['CA_DIFF_CASE {"id":"normal","input":{"b":2,"a":1},"actual":[0,1]}',
 'CA_DIFF_CASE {"id":"zero","input":[0],"actual":0}'].join("\n");
assert.equal(extractDifferentialTrace(src).size,2);
assert.equal(compareDifferentialTraces(src,ok).status,"corroborated");
assert.equal(compareDifferentialTraces(src,ok).sharedCases,2);
assert.deepEqual(sharedDifferentialFixtures(src).map(c=>c.id),["normal","zero"]);
assert.equal(compareDifferentialTraces(src,'CA_DIFF_CASE {"id":"zero","input":[1],"actual":0}').status,"incomparable");
assert.equal(compareDifferentialTraces(src,'CA_DIFF_CASE {"id":"zero","input":[0],"actual":1}').status,"disagreement");
assert.deepEqual(compareDifferentialTraces(src,"").mismatches,[]);
assert.equal(compareDifferentialTraces(src,"").status,"unavailable");
assert.equal(extractDifferentialTrace('CA_DIFF_CASE {"id":"wrong","actual":1}').size,0);
console.log("PASS: language-neutral differential traces are optional and never falsely treated as verification");
