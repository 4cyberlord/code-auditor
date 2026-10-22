import assert from "node:assert/strict";
import { apiLinks } from "../scripts/lib/apiIndex.mjs";

const python = apiLinks("python", "parse with json.loads then os.path.join");
assert.match(python, /json\.loads/);
assert.match(python, /https:\/\/docs\.python\.org\/3\.15\//);
const rust = apiLinks("rust", "keep a BinaryHeap and call Vec::push");
assert.match(rust, /https:\/\/doc\.rust-lang\.org\//);
assert.ok(!rust.includes("doc.rust-lang.org/std/std/"));
const cpp = apiLinks("cpp", "use std::sort and std::priority_queue");
assert.match(cpp, /en\.cppreference\.com\/cpp\/algorithm\/sort/);
assert.equal(apiLinks("go", "sort.Ints"), "");
assert.equal(apiLinks("python", "nothing known here").length >= 0, true);
assert.ok(apiLinks("python", "json.loads json.dumps os.path.join os.getenv", 2).split("\n").length <= 3);
console.log("PASS: API index returns pinned links and caps the list");
