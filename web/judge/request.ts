/** Browser requests for the judge UI. Free-tier hosting sleeps when idle, so a
 * GET may meet a gateway error while the API wakes. Only GETs are retried:
 * state-changing POSTs are sent once and their failure is reported, never replayed. */
export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "RequestError"; }
}
const RETRYABLE = new Set([502, 503, 504]);
const NETWORK_MESSAGE = "Could not reach the OrderTruth server. Your committed case is preserved; try again shortly.";

export async function requestJson<T>(path: string, body?: unknown, options: {
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; attempts?: number;
} = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const post = body !== undefined;
  const attempts = post ? 1 : Math.max(1, options.attempts ?? 6);
  let failure = new RequestError(NETWORK_MESSAGE, 0);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 10_000));
    let response: Response;
    try {
      response = await fetchImpl(path, { credentials: "same-origin", ...(post ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    } catch { failure = new RequestError(NETWORK_MESSAGE, 0); continue; }
    const data = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
    if (response.ok) return data;
    failure = new RequestError(data.message ?? data.error ?? `Request unavailable (${response.status})`, response.status);
    if (!RETRYABLE.has(response.status)) break;
  }
  throw failure;
}

/** Shown while a request is still pending, so a cold start reads as waking, not frozen. */
export function slowNotice(elapsedMs: number) {
  if (elapsedMs < 5000) return "";
  return `Still working (${Math.round(elapsedMs / 1000)} s). The free-tier server sleeps when idle and can take up to a minute to start.`;
}
