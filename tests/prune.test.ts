import { classifyProbeResult, isPermanentlyUnreachable } from "../src/lib/probeFit.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

/** What the pruner asks of each seat. */
const drops = (error: string) =>
  isPermanentlyUnreachable(classifyProbeResult("m", false, error).reason);

console.log("\n1. the four errors from Charles's key");
{
  // Verbatim from the TokenRouter run on 2026-08-25.
  check("claude-opus-5 no access", drops("This token has no access to model anthropic/claude-opus-5 (request id: 20260825205415110358883inXUuRpo)"));
  check("deepseek no access", drops("This token has no access to model deepseek/deepseek-v4-pro"));
  check("qwen3.8-max no access", drops("This token has no access to model qwen/qwen3.8-max"));
  check("glm-5.3 no access", drops("This token has no access to model z-ai/glm-5.3"));
}

console.log("\n2. a wrong wire is not a dead seat");
{
  // The model is fine and the app already knows the right endpoint. Removing
  // it would delete a working seat to avoid fixing a one-line routing bug.
  check(
    "codex is kept",
    !drops("This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead."),
  );
  const r = classifyProbeResult("openai/gpt-5.3-codex", false, "Use the v1/responses endpoint instead.");
  check("and is labelled as such", r.status === "unsupported", r.status);
  check("with the wire named", r.suggestEndpoint === "responses");
}

console.log("\n3. transient failures never cost a seat");
{
  // Each of these had already passed by the time anyone looked at the roster.
  check("rate limit", !drops("429 Too Many Requests: You have reached the request limit: Maximum 5 requests within 1 minutes."));
  check("concurrency ceiling", !drops("concurrency limit reached"));
  check("timeout", !drops("request timed out"));
  check("empty reply", !drops("the gateway returned nothing"));
  check("overloaded", !drops("503 service overloaded"));
  check("a refused key", !drops("401 unauthorized"), "a bad key is fixed by re-pasting, not by deleting every seat");
  check("an uncategorised error", !drops("something nobody has seen before"));
}

console.log("\n4. a genuinely wrong id is a dead seat");
{
  check("unknown model", drops("model_not_found"));
  check("does not exist", drops("The model does not exist"));
}

console.log("\n5. success is never pruned");
{
  const r = classifyProbeResult("m", true, null, 240);
  check("ok has its own reason", r.reason === "ok", r.reason);
  check("and is not permanent failure", !isPermanentlyUnreachable(r.reason));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall prune checks passed\n");
process.exit(fail ? 1 : 0);
