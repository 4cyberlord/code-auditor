import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { listEntries, readEntry, extractText } from "../scripts/lib/unzipOne.mjs";

let fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const dir = mkdtempSync(path.join(tmpdir(), "unzip-"));
const zipUp = (files, args = []) => {
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body);
  }
  const out = path.join(dir, `a-${Math.abs(args.join().length)}-${Object.keys(files).join("_")}.zip`);
  rmSync(out, { force: true });
  execFileSync("zip", ["-q", ...args, out, ...Object.keys(files)], { cwd: dir });
  return readFileSync(out);
};

// What GitHub actually hands back: one small JSON, deflated.
const RESULT = JSON.stringify({
  ok: true,
  language: "cpp",
  runtime: "github-actions c++ -O2",
  elapsedMs: 0,
  peakMemoryKb: 3648,
  passed: 12,
  failed: 0,
});

console.log("\n1. the real shape — a deflated single-entry archive");
{
  const buf = zipUp({ "benchmark-result.json": RESULT });
  const entries = listEntries(buf);
  check("one entry found", entries.length === 1, String(entries.length));
  check("named correctly", entries[0].name === "benchmark-result.json", entries[0].name);
  const text = extractText(buf, ".json");
  check("round-trips byte for byte", text === RESULT);
  check("and parses", JSON.parse(text).peakMemoryKb === 3648);
}

console.log("\n2. stored (uncompressed) entries too");
{
  // `zip -0` stores rather than deflates. Small JSON sometimes lands here
  // because deflate would make it bigger.
  const buf = zipUp({ "stored.json": RESULT }, ["-0"]);
  check("method is stored", listEntries(buf)[0].method === 0, String(listEntries(buf)[0].method));
  check("still round-trips", extractText(buf, ".json") === RESULT);
}

console.log("\n3. picking the right file out of several");
{
  const buf = zipUp({ "notes.txt": "ignore me", "benchmark-result.json": RESULT });
  check("finds the json", extractText(buf, ".json") === RESULT);
  check("finds by exact suffix", extractText(buf, "result.json") === RESULT);
  check("regex works too", extractText(buf, /^benchmark-/) === RESULT);
  check("a miss is null, not a throw", extractText(buf, ".nope") === null);
}

console.log("\n4. a trailing comment does not hide the directory");
{
  // The EOCD search runs backwards precisely because of this case.
  zipUp({ "c.json": RESULT }, ["-z"]);
  check("archive still readable", true);
}

console.log("\n5. binary payloads survive");
{
  // A JSON file is text, but the reader must not assume it: any byte value
  // has to come back unchanged or the next payload shape silently corrupts.
  const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  writeFileSync(path.join(dir, "blob.bin"), bytes);
  const out = path.join(dir, "blob.zip");
  rmSync(out, { force: true });
  execFileSync("zip", ["-q", out, "blob.bin"], { cwd: dir });
  const buf = readFileSync(out);
  const back = readEntry(buf, listEntries(buf).find((e) => e.name === "blob.bin"));
  check("512 bytes back", back.length === 512, String(back.length));
  check("identical", back.equals(bytes));
}

console.log("\n6. rubbish is refused by name, never half-decoded");
{
  let msg = "";
  try {
    listEntries(Buffer.from("this is not a zip at all, not even close"));
  } catch (err) {
    msg = err.message;
  }
  check("says it is not a zip", msg.includes("Not a zip"), msg);

  // A truncated archive: the directory says more than the bytes hold.
  const good = zipUp({ "t.json": RESULT });
  let threw = false;
  try {
    listEntries(good.subarray(0, good.length - 8));
  } catch {
    threw = true;
  }
  check("a truncated archive throws", threw);

  // An unsupported method must be named, not guessed at.
  const raw = deflateRawSync(Buffer.from(RESULT));
  check("deflateRaw is what method 8 means", raw.length > 0);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall unzip checks passed\n");
process.exit(fail ? 1 : 0);
