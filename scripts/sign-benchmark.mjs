#!/usr/bin/env node
/**
 * Offline operator-only signing of independently adjudicated benchmark fixtures.
 * Input MUST come from a trusted evaluation runner; council votes or user
 * responses are not independent ground truth.
 *
 * BENCHMARK_SIGNING_PRIVATE_JWK='{"kty":"EC",...}' node scripts/sign-benchmark.mjs verified.json report.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !process.env.BENCHMARK_SIGNING_PRIVATE_JWK) {
  console.error("Usage: BENCHMARK_SIGNING_PRIVATE_JWK=<private-P256-JWK> node scripts/sign-benchmark.mjs verified.json signed.json");
  process.exit(2);
}
const allowed = new Set(["array","string","tree","graph","dynamic_programming","linked_list","heap","math","geometry","database","concurrency","greedy","backtracking","other"]);
try {
  const raw = await readFile(inputPath, "utf8");
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2000) throw Error("Expected 1..2000 verified benchmark rows");
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || row.verified !== true ||
        row.provenance !== "trusted_fixture_runner" ||
        typeof row.model !== "string" || !row.model.trim() ||
        typeof row.evaluationId !== "string" || !row.evaluationId.trim() ||
        !allowed.has(row.family) || typeof row.correct !== "boolean" ||
        (row.latencyMs !== undefined && (!Number.isFinite(row.latencyMs) || row.latencyMs < 0)))
      throw Error("Invalid independently verified benchmark record");
    const identity = JSON.stringify([row.model,row.evaluationId]);
    if (seen.has(identity)) throw Error("Duplicate model/fixture pair");
    seen.add(identity);
  }
  const jwk = JSON.parse(process.env.BENCHMARK_SIGNING_PRIVATE_JWK);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) throw Error("A private P-256 signing key is required");
  const key = await webcrypto.subtle.importKey("jwk", jwk, {name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const payload = JSON.stringify(rows);
  const sig = await webcrypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,new TextEncoder().encode(payload));
  await writeFile(outputPath,JSON.stringify({version:1,payload,signature:Buffer.from(sig).toString("base64url")})+"\n",{flag:"wx",mode:0o600});
  console.log("Signed",rows.length,"independently verified fixtures");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Signing failed");
  process.exitCode=1;
}
