/**
 * Reads a single file out of a ZIP archive, with no dependency.
 *
 * GitHub hands back workflow artifacts as a zip, always. Node has no zip
 * reader, and pulling in a package to open a one-entry archive containing one
 * small JSON file is a dependency this project would then have to trust on
 * every build — the same reasoning that kept base64 hand-rolled in
 * `storage.rs`. A zip's central directory is a well-specified structure and
 * `zlib` already ships the only hard part.
 *
 * Scope is deliberately narrow: the two compression methods a real archive
 * actually uses (stored and deflate), and no encryption, no spanning, no
 * zip64. Anything outside that throws by name rather than returning something
 * plausible, because a benchmark result that silently decodes to the wrong
 * bytes is worse than one that fails loudly.
 */

import { inflateRawSync } from "node:zlib";

/** End of central directory record: the only fixed anchor in a zip. */
const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

/**
 * Finds the end-of-central-directory record.
 *
 * It sits at the very end unless the archive carries a trailing comment, so
 * the search runs backwards. 22 bytes is the record with an empty comment;
 * 0xffff is the largest comment the format allows.
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Every entry in the archive, as `{ name, method, compressedSize, size, offset }`.
 *
 * Read from the central directory rather than by scanning for local headers:
 * a local header can carry sizes of zero and defer them to a data descriptor
 * after the payload, which makes forward scanning a guessing game. The central
 * directory always has the real numbers.
 */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("Not a zip archive: no end-of-central-directory record.");

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== CENTRAL_SIG) {
      throw new Error(`Corrupt zip: central directory entry ${i} has a bad signature.`);
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const offset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, size, offset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Extracts one entry's bytes.
 *
 * The local header's name and extra-field lengths are read fresh rather than
 * reused from the central directory: the two are allowed to differ in the
 * extra field, and using the central copy is a classic way to land a few bytes
 * into the payload and inflate garbage.
 */
export function readEntry(buf, entry) {
  if (buf.readUInt32LE(entry.offset) !== 0x04034b50) {
    throw new Error(`Corrupt zip: "${entry.name}" has no local header.`);
  }
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(body);
  if (entry.method === 8) return inflateRawSync(body);
  throw new Error(`Unsupported zip compression method ${entry.method} for "${entry.name}".`);
}

/**
 * The first entry whose name matches, as text.
 *
 * `match` may be a suffix or a RegExp. Returns null when nothing matches, so a
 * caller can tell "the archive did not contain what I asked for" from "the
 * archive was unreadable", which are different bugs with different fixes.
 */
export function extractText(buf, match = ".json") {
  const test =
    match instanceof RegExp ? (n) => match.test(n) : (n) => n.endsWith(match);
  const entry = listEntries(buf).find((e) => test(e.name) && !e.name.endsWith("/"));
  if (!entry) return null;
  return readEntry(buf, entry).toString("utf8");
}
