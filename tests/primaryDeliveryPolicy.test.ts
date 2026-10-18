import assert from "node:assert/strict";
import { primaryCodingLanguage, primaryFirstInstruction } from "../src/lib/primaryDeliveryPolicy.ts";
import { reviewSystemPromptFor, parseReview } from "../src/lib/review.ts";

assert.equal(primaryCodingLanguage("Find the optimal algorithm"), "python");
assert.equal(primaryCodingLanguage("Required language: Python"), "python");
assert.equal(primaryCodingLanguage("Required language: Rust"), "rust");
assert.equal(primaryCodingLanguage("Implement the solution in C++"), "cpp");
assert.equal(primaryCodingLanguage("class Solution { public: int solve(int x); }"), "cpp");
assert.equal(primaryCodingLanguage("fn main() {}"), "rust");

const primaryPrompt = primaryFirstInstruction();
assert.match(primaryPrompt, /Python unless the problem explicitly requires C\+\+ or Rust/);
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
