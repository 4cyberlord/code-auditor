import { classifyProbeResult, probeToastText } from "../src/lib/probeFit.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

console.log("\n1. the happy path");
{
  const r = classifyProbeResult("openai/gpt-5.6-sol", true, null, 240);
  check("status", r.status === "ok");
  check("summary names the model and time", r.summary.includes("gpt-5.6-sol") && r.summary.includes("240ms"));
  check("toast is brief", probeToastText(r).title === "Model connected");
}

console.log("\n2. rate limits classify as waits, not failures to blame");
{
  const r = classifyProbeResult(
    "x-ai/grok-4.6",
    false,
    "You have reached the request limit: Maximum 5 requests within 1 minutes. (request id: 20260825182954624049436zc8xTZcc)"
  );
  check("status", r.status === "failed");
  check("says the ceiling", r.summary.includes("5 requests/minute"));
  check("a wait is scheduled", r.retryAfterMs > 0);
}

console.log("\n3. concurrency overload is told apart from rate limits");
{
  const r = classifyProbeResult("qwen/qwen3.8-max-free", false, "gateway overloaded: hard concurrency limit reached");
  check("status", r.status === "failed");
  check("does not say rate limited", !r.summary.toLowerCase().includes("rate limit"));
  check("names concurrency", r.summary.toLowerCase().includes("concurrency"));
  check("bounded retry", r.retryAfterMs >= 30_000);
}

console.log("\n4. the codex case: an endpoint split is not a failure");
{
  const r = classifyProbeResult(
    "openai/gpt-5.3-codex",
    false,
    "This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead."
  );
  check("status", r.status === "unsupported");
  check("summary says why", r.summary.includes("different endpoint"));
  check("detail explains the remedy", r.detail!.includes("/v1/responses"));
  check("toast is named", probeToastText(r).title === "Wrong endpoint");
}

console.log("\n5. unknown ids and refused keys");
{
  const notFound = classifyProbeResult("foo/bar", false, "404 model_not_found");
  check("model_not_found reads plainly", notFound.summary.includes("not recognised"));

  const denied = classifyProbeResult("foo/bar", false, "401 invalid api key");
  check("401 reads plainly", denied.summary.includes("key was refused"));
}

console.log("\n6. patience failures");
{
  const timeout = classifyProbeResult("deepseek/deepseek-v4-pro", false, "Request timed out after 90s");
  check("timeout names the wait", timeout.summary.includes("90s"));

  const empty = classifyProbeResult("nvidia/nemotron", false, "Answered, but returned nothing at all.");
  check("empty 200 is a routing lie", empty.summary.includes("gave nothing back"));
  check("short retry, not a blame", empty.retryAfterMs === 30_000);
}

console.log("\n7. uncategorised errors stay raw rather than wearing polish");
{
  const weird = classifyProbeResult("x/y", false, "the semaphore has escaped its kettle");
  check("still failed", weird.status === "failed");
  check("raw preserved", weird.raw.includes("kettle"));
}

console.log(fail ? `\n${fail} FAILURES\n` : "\nall probe-fit checks passed\n");
process.exit(fail ? 1 : 0);
