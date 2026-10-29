/**
 * Network boundary for the live arm. Only the Gemini API origin; redirects refused at the platform
 * (redirect: "error") and re-checked on the response; an absolute attempt cap counting every
 * attempt, including ones that throw. A refusal is recorded so the runner can stop.
 */
export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com/";

export type GuardEvent = { attempt: number; kind: "REFUSED_ORIGIN" | "REFUSED_CAP" | "REFUSED_REDIRECT" | "SENT"; status?: number; modelVersion?: string | null; body?: string | null };
export function guardedGeminiFetch(inner: typeof fetch, cap: number) {
  if (!Number.isInteger(cap) || cap < 0) throw new Error("Invalid cap");
  let attempts = 0;
  const events: GuardEvent[] = [];
  const refusals = () => events.filter(e => e.kind !== "SENT").length;
  const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(GEMINI_ORIGIN)) { events.push({ attempt: attempts, kind: "REFUSED_ORIGIN" }); throw new Error(`Network request refused: only ${GEMINI_ORIGIN} is allowed`); }
    if (attempts >= cap) { events.push({ attempt: attempts, kind: "REFUSED_CAP" }); throw new Error(`Absolute live attempt cap of ${cap} reached`); }
    attempts++;
    let response: Response;
    try { response = await inner(input, { ...init, redirect: "error" }); } catch (error) {
      // undici reports a refused redirect as a TypeError whose cause mentions the redirect.
      const text = `${String((error as Error)?.message ?? "")} ${String(((error as { cause?: Error })?.cause)?.message ?? "")}`;
      if (/redirect/i.test(text)) events.push({ attempt: attempts, kind: "REFUSED_REDIRECT" });
      throw error;
    }
    if ((response.status >= 300 && response.status < 400) || response.redirected || (response.url && !response.url.startsWith(GEMINI_ORIGIN))) {
      events.push({ attempt: attempts, kind: "REFUSED_REDIRECT", status: response.status });
      throw new Error("Unexpected redirect or off-origin response refused");
    }
    // Keep the raw provider body for audit; the key travels only in a request header, never in this body.
    const body = await response.clone().text().catch(() => null);
    let modelVersion: string | null = null;
    try { const parsed = body ? JSON.parse(body) as { modelVersion?: unknown } : null; modelVersion = typeof parsed?.modelVersion === "string" ? parsed.modelVersion : null; } catch { /* non-JSON body is recorded as-is */ }
    events.push({ attempt: attempts, kind: "SENT", status: response.status, modelVersion, body });
    return response;
  }) as typeof fetch;
  return { fetch: guarded, attempts: () => attempts, events, refusals };
}
