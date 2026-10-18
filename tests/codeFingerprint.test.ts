import assert from "node:assert/strict";
import { fingerprintCode } from "../src/lib/codeFingerprint.ts";

const code = "def solve(value):\n    return value + 1\n";
const digest = await fingerprintCode(code);
assert.match(digest || "", /^[a-f0-9]{64}$/);
assert.equal(await fingerprintCode(code), digest);
assert.notEqual(await fingerprintCode(code.trimEnd()), digest);
console.log("PASS: exact source fingerprints are stable and newline-sensitive");
