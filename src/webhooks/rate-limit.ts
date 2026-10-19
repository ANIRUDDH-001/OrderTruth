/**
 * Pre-persistence ingress limiter: one global token bucket in front of the webhook route. It runs
 * before body parsing and before any SQLite write, so an unauthenticated flood costs neither a
 * delivery row nor a PayPal postback. Global (not per source): behind the tunnel every request
 * arrives from cloudflared on loopback, and PayPal itself sends from many addresses.
 *
 * Throttled requests get a non-2xx (429 + Retry-After); PayPal treats any non-2xx as a failed
 * delivery and retries it (documented: up to 25 times over 3 days), so legitimate traffic that is
 * throttled is delayed, not lost.
 */
export type RateLimitOptions = { perMinute: number; burst: number; now?: () => number };

export class TokenBucket {
  #tokens: number;
  #last: number;
  readonly #now: () => number;
  readonly #perMs: number;
  readonly #burst: number;

  constructor(o: RateLimitOptions) {
    if (!(o.perMinute > 0) || !(o.burst >= 1)) throw new Error("rate limit must allow at least one request");
    this.#now = o.now ?? Date.now;
    this.#perMs = o.perMinute / 60_000;
    this.#burst = o.burst;
    this.#tokens = o.burst;
    this.#last = this.#now();
  }

  /** Take one token. On refusal, how long until one is available (for Retry-After). */
  take(): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.#now();
    if (t > this.#last) {
      this.#tokens = Math.min(this.#burst, this.#tokens + (t - this.#last) * this.#perMs);
      this.#last = t;
    }
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.ceil((1 - this.#tokens) / this.#perMs) };
  }
}
