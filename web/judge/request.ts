/** Browser requests for the judge UI. Free-tier hosting sleeps when idle, so a
 * GET may meet a gateway error while the API wakes. Only GETs are retried:
 * state-changing POSTs are sent once and their failure is reported, never replayed. */
export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly kind: "HTTP"|"NETWORK"|"TIMEOUT"|"INVALID_RESPONSE" = "HTTP",readonly outcomeUnknown = false) { super(message); this.name = "RequestError"; }
}
// Local waiting budgets, not host availability guarantees. One budget includes
// every attempt, backoff and body read. Optional history has its own shorter budget.
export const REQUEST_BUDGET_MS = { read: 90_000,write: 45_000,history: 8_000 } as const;
const RETRYABLE = new Set([502, 503, 504]);
const NETWORK_MESSAGE = "Could not reach the OrderTruth server. Your committed case is preserved; try again shortly.";

export async function requestJson<T>(path: string, body?: unknown, options: {
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; attempts?: number; deadlineMs?: number;
} = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const post = body !== undefined;
  const attempts = post ? 1 : Math.min(6,Math.max(1,Math.floor(options.attempts ?? 6)));
  const budget = options.deadlineMs ?? (post ? REQUEST_BUDGET_MS.write : REQUEST_BUDGET_MS.read);
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(attempts)) throw new Error("Invalid request wait budget");
  const controller = new AbortController();
  const timeoutError = new RequestError(`Request wait limit reached. Resume/Recheck Case${post ? "; the operation may have committed. A timeout does not mean rollback" : " to retry read-only recovery"}.`,0,"TIMEOUT",post);
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve,reject) => { timer = setTimeout(() => { controller.abort(); reject(timeoutError); },budget); });
  const bounded = <V>(promise: Promise<V>): Promise<V> => Promise.race([promise,deadline]);
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => {
    const stop = () => { clearTimeout(wait); resolve(); };
    const wait = setTimeout(() => { controller.signal.removeEventListener("abort",stop); resolve(); },ms);
    controller.signal.addEventListener("abort",stop,{ once: true });
  }));
  let failure = new RequestError(NETWORK_MESSAGE,0,"NETWORK",post);
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await bounded(sleep(Math.min(2000 * 2 ** (attempt - 1),10_000)));
      if (controller.signal.aborted) throw timeoutError;
      let response: Response;
      try {
        response = await bounded(fetchImpl(path,{ credentials: "same-origin",signal: controller.signal,...(post ? { method: "POST",headers: { "content-type": "application/json" },body: JSON.stringify(body) } : {}) }));
      } catch { if (controller.signal.aborted) throw timeoutError; failure = new RequestError(NETWORK_MESSAGE,0,"NETWORK",post); continue; }
      let data: unknown;
      try { data = await bounded(response.json()); }
      catch {
        if (controller.signal.aborted) throw timeoutError;
        if (response.ok) throw new RequestError("Server returned invalid JSON. Resume/Recheck Case before continuing.",response.status,"INVALID_RESPONSE",post);
        data = null;
      }
      if (response.ok) return data as T;
      const detail = data && typeof data === "object" ? data as { message?: unknown; error?: unknown } : null;
      const message = typeof detail?.message === "string" ? detail.message : typeof detail?.error === "string" ? detail.error : `Request unavailable (${response.status})`;
      failure = new RequestError(message,response.status,"HTTP",post && response.status >= 500);
      if (!RETRYABLE.has(response.status)) break;
    }
    throw failure;
  } finally {
    clearTimeout(timer!);
  }
}

/** Shown while a request is still pending, so a cold start reads as waking, not frozen.
 * Only actions that send GET requests alone may pass "read"; anything else keeps the write warning. */
export function slowNotice(elapsedMs: number,kind: "read"|"write" = "write") {
  if (elapsedMs < 2000) return "";
  const waking = `Still working (${Math.round(elapsedMs / 1000)} s). The server may be waking from idle or busy.`;
  return kind === "read" ? `${waking} This step only reads saved records; it does not submit or repeat a payment or repair action.`
    : `${waking} Waiting is bounded. If this is interrupted, the action may still have committed; use Resume/Recheck Case before acting again.`;
}
