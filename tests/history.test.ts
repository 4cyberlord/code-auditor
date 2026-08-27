import assert from "node:assert/strict";
import { parseFinal } from "../src/lib/parse.ts";

// Loading a run back into the panes rests on one thing: the stored `body` still
// parses into the same FINAL block it did when it was live. If that ever stops
// being true, history silently renders answers with no structure — no code, no
// complexity, no claims — and looks like the models did worse than they did.
const BODY = `Reasoning about it first.

<<<FINAL
KIND: code
LANGUAGE: c++17
ANSWER: Binary search on the smaller array.
COMPLEXITY: O(log(min(m,n))) time, O(1) space
CONFIDENCE: 0.91
CLAIMS:
- The partition is valid when left1 <= right2 and left2 <= right1.
- Sentinels remove the boundary cases.
CODE:
\`\`\`c++17
class Solution { public: double f(); };
\`\`\`
FINAL>>>`;

const final = parseFinal(BODY);
assert.ok(final, "a stored body must still parse");
assert.equal(final.kind, "code");
assert.equal(final.language, "c++17");
assert.match(final.answer, /Binary search/);
assert.match(final.code ?? "", /class Solution/);
assert.equal(final.claims.length, 2);
assert.ok((final.confidence ?? 0) > 0.9);

// A pane whose model errored stored an empty body. Nothing to show.
assert.equal(parseFinal(""), null);

// Unstructured text does not become null — it comes back marked `wellFormed:
// false`, which is what the pane renders as "answered, but not in the contract".
// History has to preserve that distinction: an answer that ignored the format is
// not the same as an answer that never arrived, and flattening the two would
// make old runs look emptier than they were.
const loose = parseFinal("the request failed before anything was written");
assert.ok(loose, "loose text is still an answer");
assert.equal(loose.wellFormed, false);
assert.equal(loose.kind, "unknown");
assert.equal(loose.code, "");

// A block that was cut off mid-stream — a cancelled run — is likewise kept but
// never mistaken for a complete one.
const truncated = parseFinal("<<<FINAL\nKIND: code\nANSWER: it was cut off here");
assert.ok(truncated);
assert.equal(truncated.wellFormed, false, "a truncated block must never read as well formed");

// And the good one really is marked good, or the distinction above is useless.
assert.equal(final.wellFormed, true);

console.log("history.test.ts: all assertions passed");
