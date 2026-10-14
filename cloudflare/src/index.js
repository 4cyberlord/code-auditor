import { DurableObject } from "cloudflare:workers";

const PORT = 8787;
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;

function authorized(request, secret) {
  const value = request.headers.get("authorization") || "";
  return Boolean(secret) && value === `Bearer ${secret}`;
}

/**
 * One durable, online host for the existing Node/E2B worker.
 *
 * It starts only from the Cloudflare scheduler or an authenticated dispatch,
 * keeps no user-provider secret itself, and passes only the bootstrap
 * Supabase credentials into the container.  Per-user provider secrets are
 * loaded by the worker from the protected app_config rows for the claimed job.
 */
export class CouncilWorkerContainer extends DurableObject {
  starting;

  async fetch(request) {
    this.starting ??= this.startAndWait().finally(() => { this.starting = undefined; });
    await this.starting;
    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container.getTcpPort(PORT).fetch(forwarded);
  }

  async startAndWait() {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({
        image: container.images.council,
        instance: "standard-1",
        enableInternet: true,
        env: {
          PORT: String(PORT),
          SUPABASE_URL: this.env.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: this.env.SUPABASE_SERVICE_ROLE_KEY,
          CODE_AUDITOR_WORKER_TICK_SECRET: this.env.INTERNAL_TICK_SECRET,
          CODE_AUDITOR_WORKER_HOST: "cloudflare-container",
          CODE_AUDITOR_WORKER_ID: "cloudflare-primary"
        }
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    const port = container.getTcpPort(PORT);
    let lastError;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await port.fetch("http://container/health", { signal: AbortSignal.timeout(1_000) });
        await response.body?.cancel();
        if (response.ok) return;
        lastError = new Error(`health returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await scheduler.wait(200);
    }
    throw new Error("Council worker container did not become ready", { cause: lastError });
  }
}

async function kick(env) {
  const target = env.COUNCIL_WORKER.getByName("primary");
  return target.fetch("https://container/api/worker-kick", {
    method: "POST",
    headers: { authorization: `Bearer ${env.INTERNAL_TICK_SECRET}` }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "council-editor-worker" });
    }
    if (request.method === "POST" && url.pathname === "/dispatch") {
      if (!authorized(request, env.DISPATCH_SECRET)) return new Response("unauthorized", { status: 401 });
      return kick(env);
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(kick(env));
  }
};
