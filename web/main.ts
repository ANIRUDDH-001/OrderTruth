// Gate 0 PayPal JS SDK v6 one-time checkout, following the official sample
// (paypal-examples/v6-web-sdk-sample-integration, paypalPayments/oneTimePayment/typescript).
// Minimal local typings instead of @paypal/paypal-js to keep Gate 0 dependency-light.

type OnApproveData = { orderId: string; payerId?: string };
type Session = { start(opts: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<{ orderId: string }>): Promise<void> };
type SdkInstance = {
  findEligibleMethods(o: { currencyCode: string }): Promise<{ isEligible(m: string): boolean }>;
  createPayPalOneTimePaymentSession(o: {
    onApprove(d: OnApproveData): Promise<void> | void;
    onCancel(d: { orderId?: string }): void;
    onError(e: unknown): void;
  }): Session;
};
declare global {
  interface Window {
    paypal?: { createInstance(o: { clientId: string; components: string[]; pageType?: string }): Promise<SdkInstance> };
  }
}

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const logEl = document.querySelector<HTMLDivElement>("#log")!;
const button = document.querySelector<HTMLElement>("#paypal-button")!;

function log(kind: "info" | "ok" | "error", msg: string) {
  const line = document.createElement("div");
  line.dataset.kind = kind;
  line.textContent = `${new Date().toISOString()}  ${msg}`; // textContent: never inject HTML
  logEl.append(line);
  statusEl.textContent = msg;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string; correlationId?: string };
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status} ${body.error ?? ""} ${body.message ?? ""} corr=${body.correlationId ?? res.headers.get("x-correlation-id") ?? "?"}`);
  return body;
}

function loadSdk(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(s);
  });
}

async function createOrder(): Promise<{ orderId: string }> {
  // No amount is sent: the server owns price and currency.
  const o = await api<{ orderId: string; status: string }>("/api/orders", { method: "POST", body: "{}" });
  log("info", `order created ${o.orderId} (${o.status}); waiting for buyer approval in PayPal window`);
  return { orderId: o.orderId };
}

async function main() {
  const cfg = await api<{ clientId: string; environment: string; sdkUrl: string }>("/api/paypal/browser-config");
  if (cfg.environment !== "sandbox" || !cfg.sdkUrl.startsWith("https://www.sandbox.paypal.com/")) throw new Error("refusing non-sandbox SDK configuration");
  await loadSdk(cfg.sdkUrl);
  if (!window.paypal) throw new Error("PayPal SDK global missing after load");
  const sdk = await window.paypal.createInstance({ clientId: cfg.clientId, components: ["paypal-payments"], pageType: "checkout" });
  log("info", "SDK v6 createInstance({ clientId }) succeeded");
  const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
  if (!methods.isEligible("paypal")) {
    log("error", "PayPal not eligible for this session; use the CLI approval-URL fallback (pnpm cli create --redirect)");
    return;
  }
  const session = sdk.createPayPalOneTimePaymentSession({
    async onApprove(data) {
      log("info", `buyer approved ${data.orderId}; capturing on server…`);
      try {
        const r = await api<{ state: string; captureId: string | null; captureStatus: string | null; amount: { currency: string; value: string } | null; reasons: string[] }>(
          `/api/orders/${encodeURIComponent(data.orderId)}/capture`,
          { method: "POST", body: "{}" },
        );
        const kind = r.state === "captured" ? "ok" : "error";
        log(kind, `verdict=${r.state} capture=${r.captureId ?? "-"} status=${r.captureStatus ?? "-"} amount=${r.amount ? `${r.amount.currency} ${r.amount.value}` : "-"} (${r.reasons.join("; ")})`);
      } catch (e) {
        log("error", `capture request failed: ${(e as Error).message}. Do NOT retry blindly; run readback.`);
      }
    },
    onCancel(d) {
      log("error", `buyer cancelled ${d.orderId ?? ""}; nothing captured`);
    },
    onError(e) {
      log("error", `SDK onError: ${String((e as Error)?.message ?? e)}`);
    },
  });
  button.removeAttribute("hidden");
  button.addEventListener("click", () => {
    // Do not await createOrder before start(): preserves transient user activation (per official sample).
    session.start({ presentationMode: "auto" }, createOrder()).catch((e: unknown) => log("error", `session.start failed: ${String((e as Error)?.message ?? e)}`));
  });
  log("info", "PayPal button ready");
}

main().catch((e: unknown) => log("error", `init failed: ${(e as Error).message}`));

export {};
