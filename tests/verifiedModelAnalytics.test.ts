import { summarizeVerifiedOutcomes, outcomeFromTrustedExecution, mergeVerifiedOutcomes } from "../src/lib/verifiedModelAnalytics.ts";
const rows = Array.from({length: 24}, (_,i) => ({
  model:"model-a", family:"graph" as const, correct:i<21, verified:true, provenance:"trusted_fixture_runner" as const, evaluationId:"g-"+i, latencyMs:1000,
}));
const result = summarizeVerifiedOutcomes([...rows, rows[0]]);
if (result[0].evaluatedSamples !== 24) throw Error("deduplication failed");
if (result[0].verifiedAccuracy !== 21/24) throw Error("accuracy failed");
if (summarizeVerifiedOutcomes(rows.slice(0,5))[0].evaluatedSamples !== undefined) throw Error("sample threshold failed");
console.log("PASS: verified analytics aggregation");

const fixture = {model:"candidate-x",family:"array" as const,evaluationId:"official-fixture-1",independentlyVerifiedFixture:true,ran:true,ok:true,passed:8,failed:0,durationMs:50};
const trusted=outcomeFromTrustedExecution(fixture);
if (!trusted?.verified || !trusted.correct) throw Error("trusted execution not recorded");
if (outcomeFromTrustedExecution({...fixture,independentlyVerifiedFixture:false}) !== null) throw Error("untrusted fixture accepted");
if (outcomeFromTrustedExecution({...fixture,passed:0,failed:0}) !== null) throw Error("empty test suite accepted");
if (outcomeFromTrustedExecution({...fixture,truncated:true}) !== null) throw Error("truncated execution accepted");
if (outcomeFromTrustedExecution({...fixture,failed:1})?.correct !== false) throw Error("failed case accepted");
const merged=mergeVerifiedOutcomes([trusted],[{...trusted,correct:false}]);
if (merged.length !== 1 || merged[0].correct !== false) throw Error("idempotent update failed");
console.log("PASS: trusted evaluation ingestion");
