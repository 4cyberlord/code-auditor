import { summarizeVerifiedOutcomes } from "../src/lib/verifiedModelAnalytics.ts";
const rows = Array.from({length: 24}, (_,i) => ({
  model:"model-a", family:"graph" as const, correct:i<21, verified:true, evaluationId:"g-"+i, latencyMs:1000,
}));
const result = summarizeVerifiedOutcomes([...rows, rows[0]]);
if (result[0].evaluatedSamples !== 24) throw Error("deduplication failed");
if (result[0].verifiedAccuracy !== 21/24) throw Error("accuracy failed");
if (summarizeVerifiedOutcomes(rows.slice(0,5))[0].evaluatedSamples !== undefined) throw Error("sample threshold failed");
console.log("PASS: verified analytics aggregation");
