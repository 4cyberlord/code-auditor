/**
 * Fast, deliberately small dispatch lane for Council jobs.
 *
 * Supabase remains authoritative: it creates and owns solve_jobs, records
 * status, and lets the VPS worker atomically claim work.  This Worker moves no
 * screenshots and holds no provider, Azure, E2B, or database credentials.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameSecret(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function authorized(request, secret) {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") && sameSecret(value.slice(7), secret);
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function wake(message, env) {
  // A wake is only an acceleration hint. The VPS worker still polls Supabase,
  // and its conditional claim is what prevents duplicate Queue delivery from
  // executing a job twice.
  if (!env.NIMO_WAKE_URL || !env.NIMO_WAKE_SECRET) return;
  const response = await fetch(env.NIMO_WAKE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.NIMO_WAKE_SECRET}`,
      "content-type": "application/json",
      "x-council-dispatch": "cloudflare-queue"
    },
    body: JSON.stringify({ jobId: message.jobId, source: "cloudflare-queue" }),
    signal: AbortSignal.timeout(4_000)
  });
  if (!response.ok) throw new Error(`Nimo wake endpoint returned ${response.status}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "council-solve-dispatch" });
    }
    if (request.method !== "POST" || url.pathname !== "/enqueue") {
      return new Response("not found", { status: 404 });
    }
    if (!authorized(request, env.DISPATCH_SECRET)) {
      return new Response("unauthorized", { status: 401 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid JSON" }, 400);
    }
    const jobId = typeof body?.jobId === "string" ? body.jobId : "";
    if (!UUID.test(jobId)) return json({ ok: false, error: "invalid job id" }, 400);

    await env.SOLVE_DISPATCH.send({ jobId, submittedAt: Date.now() }, { contentType: "json" });
    return json({ ok: true, accepted: true }, 202);
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await wake(message.body, env);
        message.ack();
      } catch (error) {
        console.error("Council fast-dispatch wake failed", {
          jobId: message.body?.jobId,
          attempt: message.attempts,
          error: error instanceof Error ? error.message : String(error)
        });
        // The durable Supabase poller is intentionally left in place as the
        // recovery mechanism. Retrying here merely improves wake latency.
        message.retry({ delaySeconds: 5 });
      }
    }
  }
};
