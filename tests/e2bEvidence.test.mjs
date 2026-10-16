import assert from "node:assert/strict";
import {assessHarnessTrust,buildE2BEvidenceSummary,requireTrustedHarness} from "../scripts/lib/e2bEvidence.mjs";
const suite=[{language:"python",referenceCode:"def solve(x): return x"}];
const caught=[{kind:"mutation",letter:"A",ran:true,survived:false}];
const trust=assessHarnessTrust(suite,caught);
assert.equal(trust.referencePreflight,true);
assert.equal(trust.mutationCaught,1);
assert.equal(requireTrustedHarness(trust,true),true);
const missing=assessHarnessTrust([{language:"rust"}],[]);
assert.match(missing.risks[0],/Missing independent reference/);
assert.throws(()=>requireTrustedHarness(missing,true),/trust gate/);
assert.equal(requireTrustedHarness(missing,false),false);
const survived=assessHarnessTrust(suite,[{kind:"mutation",letter:"B",ran:true,survived:true}]);
assert.equal(survived.mutationSurvived[0],"B");
assert.throws(()=>requireTrustedHarness(survived,true),/corrupted candidate/);
const report=buildE2BEvidenceSummary({
  runs:{A:{ran:true,ok:true,passed:5,failed:0,provider:"e2b",
    sandboxId:"box-1",executionId:"exec-1",remoteElapsedMs:7,peakMemoryKb:8096,
    bootMs:30,prewarmed:true,exitVerified:true},
  B:{ran:false,note:"not executed"}},
  suites:suite,oracles:caught,
  ports:[{language:"rust",status:"failed",run:null}],
});
assert.equal(report.candidates.A.status,"passed");
assert.equal(report.candidates.A.prewarmed,true);
assert.equal(report.candidates.A.runtimeMs,7);
assert.equal(report.candidates.B.status,"untested");
assert.equal(report.ports[0].status,"failed");
assert.equal(report.ports[0].execution.status,"untested");
assert.ok(!JSON.stringify(report).includes("sourceCode"));
console.log("PASS: independent harness trust, strict canary policy and reproducible structured E2B evidence");
