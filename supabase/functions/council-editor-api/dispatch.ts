/** Best-effort notification for the external fast-dispatch lane.
 *
 * The database transaction has already created the durable job. A dispatch
 * outage must never make a successful submission look failed: the online
 * worker's regular poll is the recovery route.
 */
export async function dispatchSolveJob(jobId: string): Promise<void> {
  const url = (Deno.env.get("COUNCIL_DISPATCH_URL") ?? "").trim();
  const secret = (Deno.env.get("COUNCIL_DISPATCH_SECRET") ?? "").trim();
  if (!url || !secret) return;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(4_000)
    });
    if (!response.ok) {
      console.warn("Council dispatch was not accepted:", response.status);
    }
  } catch (error) {
    console.warn("Council dispatch notification failed:", error instanceof Error ? error.message : String(error));
  }
}
