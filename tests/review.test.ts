import assert from "node:assert/strict";
import { parseReview, isAlreadyOptimal, PORT_LANGUAGES } from "../src/lib/review.ts";

const GOOD = `Some preamble the model felt like writing.

<<<REVIEW
VALID: yes
WHY: Returns 6 and 9 on the two worked examples and handles the empty array.
APPROACH: Two Pointers
APPROACH_SUGGESTED: Two Pointers
KEY_IDEA: Track the running maxima from both ends and always advance the lower side.
TIME: O(n)
SPACE: O(1)
TIME_SUGGESTED: O(n)
SPACE_SUGGESTED: O(1)
EFFICIENCY_NOTE: Already at the theoretical bound; every bar is visited once.
READABILITY: excellent
STRUCTURE: excellent
STYLE_NOTE: Clear names and a single loop with no special cases.
PORT cpp
\`\`\`cpp
int trap(vector<int>& h) { return 0; }
\`\`\`
PORT rust
\`\`\`rust
fn trap(h: Vec<i32>) -> i32 { 0 }
\`\`\`
PORT python
\`\`\`python
def trap(h): return 0
\`\`\`
REVIEW>>>`;

const r = parseReview(GOOD);
assert.ok(r, "a well-formed block must parse");
assert.equal(r.valid, true);
assert.match(r.validNote, /Returns 6 and 9/);
assert.equal(r.approach.current, "Two Pointers");
assert.match(r.approach.keyIdea, /running maxima/);
assert.equal(r.efficiency.currentTime, "O(n)");
assert.equal(r.efficiency.currentSpace, "O(1)");
assert.equal(r.style.readability, "excellent");
assert.equal(r.style.structure, "excellent");

// All three ports, keyed by language, with the fences stripped.
for (const lang of PORT_LANGUAGES) assert.ok(r.ports[lang], `${lang} port missing`);
assert.match(r.ports.rust ?? "", /fn trap/);
assert.ok(!/```/.test(r.ports.cpp ?? ""), "fences must not survive into the code");

// Nothing to improve — the card says so rather than inventing a suggestion.
assert.equal(isAlreadyOptimal(r), true);

// A reviewer that names no alternative is saying the current one stands, so the
// card never shows an empty "suggested" beside a filled "current".
{
  const sparse = parseReview(`<<<REVIEW
VALID: yes
APPROACH: Sliding Window
TIME: O(n log n)
SPACE: O(n)
REVIEW>>>`);
  assert.ok(sparse);
  assert.equal(sparse.approach.suggested, "Sliding Window");
  assert.equal(sparse.efficiency.suggestedTime, "O(n log n)");
  assert.equal(sparse.efficiency.suggestedSpace, "O(n)");
  assert.deepEqual(sparse.ports, {}, "no ports is normal, not an error");
}

// A wrong answer must survive the round trip as wrong. A review that softens a
// failure is worse than no review at all.
{
  const bad = parseReview(`<<<REVIEW
VALID: no
WHY: Returns 0 for [4,2,0,3,2,5]; the right pointer never advances.
APPROACH: Two Pointers
APPROACH_SUGGESTED: Two Pointers
TIME: O(n)
SPACE: O(1)
READABILITY: good
STRUCTURE: fair
REVIEW>>>`);
  assert.ok(bad);
  assert.equal(bad.valid, false);
  assert.match(bad.validNote, /never advances/);
  assert.equal(bad.style.structure, "fair");
}

// An unusable grade is dropped rather than shown as a label nobody defined.
{
  const odd = parseReview("<<<REVIEW\nVALID: maybe\nREADABILITY: superb\nREVIEW>>>");
  assert.ok(odd);
  assert.equal(odd.valid, null, "an unclear verdict is unknown, not a pass");
  assert.equal(odd.style.readability, "");
}

// No block at all is null, so the caller can leave the card off entirely.
assert.equal(parseReview("the model just answered in prose"), null);
assert.equal(parseReview(""), null);

console.log("review.test.ts: all assertions passed");
