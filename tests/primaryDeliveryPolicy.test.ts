import assert from "node:assert/strict";
import { configuredCodeLanguage, primaryCodingLanguage, primaryFirstInstruction, providedTestBrief } from "../src/lib/primaryDeliveryPolicy.ts";
import { reviewSystemPromptFor, parseReview } from "../src/lib/review.ts";

assert.equal(primaryCodingLanguage("Find the optimal algorithm"), "python");
assert.equal(primaryCodingLanguage("Required language: Python"), "python");
assert.equal(primaryCodingLanguage("Required language: Rust"), "rust");
assert.equal(primaryCodingLanguage("Implement the solution in C++"), "cpp");
assert.equal(primaryCodingLanguage("class Solution { public: int solve(int x); }"), "cpp");
assert.equal(primaryCodingLanguage("fn main() {}"), "rust");

assert.equal(configuredCodeLanguage("C++"), "cpp");
assert.equal(configuredCodeLanguage("Rust"), "rust");
assert.equal(primaryCodingLanguage("Find the optimal algorithm", "C++"), "cpp");
assert.equal(primaryCodingLanguage("Find the optimal algorithm", "Rust"), "rust");
assert.equal(primaryCodingLanguage("Required language: Python", "C++"), "python");
assert.match(providedTestBrief([{id:"provided_1",input:"[1,2]",output:"3"}]),/EXPECTED OUTPUT 3/);
const primaryPrompt = primaryFirstInstruction("python");
assert.match(primaryPrompt, /Code in Python only/);
assert.match(primaryFirstInstruction("cpp"), /Code in C\+\+23 only/);
assert.match(primaryFirstInstruction("rust"), /Code in Rust only/);
assert.match(primaryPrompt, /Other language equivalents follow only after an execution-verified winner/);

const reviewPrompt = reviewSystemPromptFor();
assert.match(reviewPrompt, /Review only the already verified primary solution/);
assert.match(reviewPrompt, /TIME:/);
assert.match(reviewPrompt, /SPACE:/);
assert.doesNotMatch(reviewPrompt, /"PORT cpp"|PORT cpp\n/);
assert.doesNotMatch(reviewPrompt, /complete C\+\+ implementation/);

// Existing reports remain readable even when legacy review replies contained ports.
const old = parseReview("<<<REVIEW\nVALID: yes\nTIME: O(n)\nSPACE: O(1)\nPORT python\n```python\nprint(1)\n```\nREVIEW>>>");
assert.ok(old);
assert.equal(old.ports.python, "print(1)");
console.log("PASS: primary-first language defaults and review-only complexity prompt");
