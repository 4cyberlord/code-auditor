import assert from "node:assert/strict";
import {analyzePortSource} from "../scripts/lib/e2bPortAnalysis.mjs";
const answer=analyzePortSource({
 code:"use std::collections::HashMap; fn solve() {}",answer:"Hash map complements",
 complexity:"Time: O(n), Space: O(n)"
},{remoteElapsedMs:15,totalElapsedMs:182,peakMemoryKb:1750});
assert.equal(answer.timeComplexityClaim,"O(n)");
assert.equal(answer.spaceComplexityClaim,"O(n)");
assert.equal(answer.algorithmUsed,"Hash map complements");
assert.ok(answer.dataStructureClues.includes("map"));
assert.equal(answer.instrumentation.compiledTotalMs,182);
assert.equal(answer.instrumentation.includesTestHarness,true);
assert.equal(answer.derivationStatus,"model-claimed-not-proven");
assert.equal(analyzePortSource({code:"fn solve() {}",complexity:"fast"},null).timeComplexityClaim,null);
console.log("PASS: Rust/C++ complexity is labelled model-claimed and kept separate from E2B measurements");

const inline=analyzePortSource({code:"void solve() {}",answer:"two pointers",
 complexity:"O(n log n) time, O(1) space"},null);
assert.equal(inline.timeComplexityClaim,"O(n log n)");
assert.equal(inline.spaceComplexityClaim,"O(1)");
console.log("PASS: natural-language complexity ordering is parsed without runtime guesswork");
