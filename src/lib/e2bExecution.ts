import * as db from "@/lib/sessions";

/** Queue generated code on the server; never execute it in the desktop process. */
export async function runInE2B(
  sessionId: string,
  language: string,
  program: string,
  timeoutMs: number,
  stdin = "",
) {
  const id = await db.createBenchmark(sessionId, language, program, timeoutMs, stdin);
  const deadline = Date.now() + timeoutMs + 60_000;
  while (Date.now() < deadline) {
    const request = await db.getBenchmark(id);
    if (request.status === "failed") throw new Error(request.error || "E2B execution failed.");
    if (request.status === "completed") {
      if (!request.result) throw new Error("E2B completed without execution evidence.");
      return request.result;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("E2B execution did not finish before the waiting limit; no result was assumed.");
}
