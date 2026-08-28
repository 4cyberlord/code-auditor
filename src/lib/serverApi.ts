/**
 * The client for the Council Editor server API.
 *
 * The desktop currently reaches Postgres and Storage directly, holding the
 * service-role key to do it. This is the other side of moving that key to a
 * server: the same calls, over HTTP, authenticated by the sign-in token the app
 * already has rather than by a key that can do anything.
 *
 * It is deliberately additive. Nothing is switched over by importing this —
 * `configured()` is false until an API URL is set, and every caller is expected
 * to keep its direct path until the server route is proven for that call. A
 * transport swap that happens all at once is a transport swap nobody can bisect.
 */

export interface ServerApiConfig {
  /** `https://<ref>.supabase.co/functions/v1/council-editor-api` */
  url: string;
  /** The project's publishable key. Not a secret, and not identity. */
  apiKey: string;
  /** The sign-in token from the Keychain. This is what says who you are. */
  token: string;
}

export class ServerApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ServerApiError";
  }
}

export function configured(config: Partial<ServerApiConfig> | null | undefined): boolean {
  return Boolean(config?.url?.trim() && config?.apiKey?.trim());
}

/**
 * One call.
 *
 * Errors arrive as a JSON `{ ok: false, error }` with a real status code, so a
 * 401 can be told from a 500 without parsing prose. A non-JSON reply means
 * something in front of the function answered — a gateway, a redirect — and
 * saying so is more useful than a parse error.
 */
export async function call<T>(
  config: ServerApiConfig,
  op: string,
  args: Record<string, unknown> = {},
  init: { signal?: AbortSignal } = {}
): Promise<T> {
  const res = await fetch(config.url.trim(), {
    method: "POST",
    signal: init.signal,
    headers: {
      "content-type": "application/json",
      apikey: config.apiKey.trim(),
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ op, args }),
  });

  const text = await res.text();
  let body: { ok?: boolean; data?: T; error?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ServerApiError(
      res.status,
      `The API answered ${res.status} with something that was not JSON.`
    );
  }

  if (!res.ok || body.ok === false) {
    throw new ServerApiError(res.status, body.error || `The API answered ${res.status}.`);
  }
  return body.data as T;
}

/** Proves the URL, the key and the token in one round trip. */
export async function whoami(config: ServerApiConfig): Promise<{ username: string; userId: string }> {
  return call(config, "auth.whoami");
}
