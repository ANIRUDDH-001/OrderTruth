// Gate 0 PayPal JS SDK v6 one-time checkout, following the official sample
// (paypal-examples/v6-web-sdk-sample-integration, paypalPayments/oneTimePayment/typescript).
// Minimal local typings instead of @paypal/paypal-js to keep Gate 0 dependency-light.
import {ownerOutcome,mayApplyPresentationEvent,type OwnerOutcome} from './owner-state.ts';

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
const outcomeEl=document.querySelector<HTMLElement>('#outcome')!;
const heading=document.querySelector<HTMLElement>('#outcome-heading')!;
const recheck=document.querySelector<HTMLButtonElement>('#recheck')!;
const newPurchase=document.querySelector<HTMLButtonElement>('#new-purchase')!;
const retrySetup=document.querySelector<HTMLButtonElement>('#retry-setup')!;
const ownerAccess=document.querySelector<HTMLAnchorElement>('#owner-access')!;
const ORDER_NAME='ordertruth.activePayPalOrder';
let activeOrder:string|null=null,locked=false,busy=false,captureBusy=false,sdkReady=false;
let acceptedOutcome:OwnerOutcome|null=null;
try{const saved=localStorage.getItem(ORDER_NAME);if(saved&&/^[A-Za-z0-9]{1,64}$/.test(saved))activeOrder=saved;}catch{}
function rememberOrder(id:string){if(!/^[A-Za-z0-9]{1,64}$/.test(id))throw Error('Invalid Sandbox order identity');activeOrder=id;recheck.hidden=false;try{localStorage.setItem(ORDER_NAME,id);}catch{}}
function announce(kind:string,title:string,detail:string){outcomeEl.dataset.kind=kind;heading.textContent=title;statusEl.textContent=detail;}
function showOutcome(raw:unknown){const outcome=ownerOutcome(raw);acceptedOutcome=outcome;announce(outcome.kind,outcome.heading,outcome.detail);locked=outcome.kind!=='approval';button.hidden=locked||!sdkReady;newPurchase.hidden=!outcome.canStartAnother;recheck.hidden=!activeOrder;return outcome;}

function log(kind: "info" | "ok" | "error", msg: string) {
  const line = document.createElement("div");
  line.dataset.kind = kind;
  line.textContent = `${new Date().toISOString()}  ${msg}`; // textContent: never inject HTML
  logEl.append(line);
}

class ApiError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init,signal:AbortSignal.timeout(40_000), headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string; correlationId?: string };
  if (!res.ok) throw new ApiError(`${path} -> HTTP ${res.status} ${body.error ?? ""} ${body.message ?? ""} corr=${body.correlationId ?? res.headers.get("x-correlation-id") ?? "?"}`, body.error);
  return body;
}

// Durable checkout key (Gate 1A, F2): kept until this checkout reaches a final state so a retry
// or reload resumes the same checkout instead of starting a second payment. Storage may be
// unavailable (private mode); then it lives for this page only.
const KEY_NAME = "ordertruth.checkoutKey";
let memoryKey: string | null = null;
function checkoutKey(): string {
  try {
    const k = localStorage.getItem(KEY_NAME);
    if (k) return k;
  } catch {
    /* storage unavailable */
  }
  const k = memoryKey ?? `ck_${crypto.randomUUID().replace(/-/g, "")}`;
  memoryKey = k;
  try {
    localStorage.setItem(KEY_NAME, k);
  } catch {
    /* storage unavailable */
  }
  return k;
}
function endCheckout() {
  memoryKey = null;
  try {
    localStorage.removeItem(KEY_NAME);
  } catch {
    /* storage unavailable */
  }
}
const DO_NOT_PAY_AGAIN = new Set(["outcome_unknown", "capture_outcome_pending", "capture_in_progress", "checkout_in_progress"]);

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
  try {
    const o = await api<{ orderId: string; status: string; reused?: boolean }>("/api/orders", { method: "POST", body: "{}", headers: { "x-checkout-key": checkoutKey() } });
    log("info", `order ${o.reused ? "resumed" : "created"} ${o.orderId} (${o.status}); waiting for buyer approval in PayPal window`);
    rememberOrder(o.orderId);announce('pending','Waiting for buyer approval','Approve this same reference checkout in the official PayPal Sandbox window.');return { orderId: o.orderId };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : undefined;
    if (code === "checkout_already_paid") {
      locked=true;button.hidden=true;
      announce('review','This checkout is already paid','Keep this checkout and recheck its recorded evidence. Do not start another payment to recover this one.');
    } else if (code === "checkout_closed") {
      locked=true;button.hidden=true;announce('review','This checkout is closed','Return to the workspace to inspect its recorded outcome before beginning another checkout.');
    } else if (code && DO_NOT_PAY_AGAIN.has(code)) {
      log("error", "A payment for this checkout is in progress or not yet confirmed. Do NOT pay again; check status later.");
      showOutcome({state:'uncertain'});
    }
    throw e;
  }
}

async function main() {
  const cfg = await api<{ clientId: string; environment: string; sdkUrl: string }>("/api/paypal/browser-config");
  if (cfg.environment !== "sandbox" || !cfg.sdkUrl.startsWith("https://www.sandbox.paypal.com/")) throw new Error("refusing non-sandbox SDK configuration");
  if(activeOrder){
    recheck.hidden=false;
    const stored=showOutcome(await api<unknown>(`/api/orders/${encodeURIComponent(activeOrder)}`));
    if(stored.kind!=='approval')return;
  }
  await loadSdk(cfg.sdkUrl);
  if (!window.paypal) throw new Error("PayPal SDK global missing after load");
  const sdk = await window.paypal.createInstance({ clientId: cfg.clientId, components: ["paypal-payments"], pageType: "checkout" });
  log("info", "SDK v6 createInstance({ clientId }) succeeded");
  const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
  if (!methods.isEligible("paypal")) {
    announce('review','Sandbox payment method unavailable','The official SDK did not offer PayPal for this session. Recheck the connection or return to the workspace.');retrySetup.hidden=false;
    return;
  }
  const session = sdk.createPayPalOneTimePaymentSession({
    async onApprove(data) {
      if(!activeOrder||data.orderId!==activeOrder){locked=true;button.hidden=true;announce('review','Checkout identity needs review','The approval does not match this saved checkout. No capture was requested.');return;}
      captureBusy=true;button.hidden=true;recheck.disabled=true;announce('pending','Verifying the approved payment','The server will claim capture once, then verify the outcome through PayPal readback.');
      log("info", `buyer approved ${data.orderId}; capturing on server…`);
      try {
        const r = await api<{ state: string; captureId: string | null; captureStatus: string | null; amount: { currency: string; value: string } | null; reasons: string[] }>(
          `/api/orders/${encodeURIComponent(data.orderId)}/capture`,
          { method: "POST", body: "{}" },
        );
        const kind = r.state === "captured" ? "ok" : "error";
        log(kind, `verdict=${r.state} capture=${r.captureId ?? "-"} status=${r.captureStatus ?? "-"} amount=${r.amount ? `${r.amount.currency} ${r.amount.value}` : "-"} (${r.reasons.join("; ")})`);
        showOutcome(r);
      } catch (e) {
        const code = e instanceof ApiError ? e.code : undefined;
        if (code && DO_NOT_PAY_AGAIN.has(code)) log("error", `The payment may have completed. Do NOT pay again; the outcome is confirmed by PayPal readback. (${(e as Error).message})`);
        else log("error", `capture request failed: ${(e as Error).message}. Do NOT retry blindly; run readback.`);
        showOutcome({state:'uncertain'});
      }finally{captureBusy=false;recheck.disabled=false;}
    },
    onCancel(d) {
      log("info", `buyer approval interrupted for ${d.orderId ?? "saved checkout"}`);
      if(mayApplyPresentationEvent(acceptedOutcome,captureBusy)){locked=true;button.hidden=true;announce('review','Buyer approval interrupted','The saved checkout is retained. Recheck its evidence before paying again; cancellation does not establish rollback.');}
    },
    onError(e) {
      log("error", `SDK onError: ${String((e as Error)?.message ?? e)}`);
      if(mayApplyPresentationEvent(acceptedOutcome,captureBusy)){showOutcome({state:'uncertain'});retrySetup.hidden=false;}
    },
  });
  sdkReady=true;button.removeAttribute("hidden");
  button.addEventListener("click", () => {
    if(locked||busy||captureBusy)return;
    // Do not await createOrder before start(): preserves transient user activation (per official sample).
    busy=true;button.hidden=true;
    session.start({ presentationMode: "auto" }, createOrder()).catch((e: unknown) => {log("error", `session.start failed: ${String((e as Error)?.message ?? e)}`);if(!locked&&!captureBusy)showOutcome({state:'uncertain'});}).finally(()=>{busy=false;if(!locked&&!captureBusy)button.hidden=false;});
  });
  log("info", "PayPal button ready");
  announce('approval','Ready for Sandbox approval','Use the official button to approve the server-priced USD1.00 reference purchase.');
}

recheck.addEventListener('click',async()=>{
 if(!activeOrder||busy||captureBusy)return;busy=true;recheck.disabled=true;button.hidden=true;
 try{showOutcome(await api<unknown>(`/api/orders/${encodeURIComponent(activeOrder)}/readback`,{method:'POST',body:'{}'}));}
 catch(error){showOutcome({state:'uncertain'});log('error',`Readback unavailable: ${error instanceof Error?error.message:'unknown error'}`);}
 finally{busy=false;recheck.disabled=false;}
});
newPurchase.addEventListener('click',()=>{if(busy||captureBusy)return;endCheckout();try{localStorage.removeItem(ORDER_NAME);}catch{}location.reload();});
retrySetup.addEventListener('click',()=>{if(!busy&&!captureBusy)location.reload();});
main().catch((e: unknown) => {log("error", `init failed: ${(e as Error).message}`);button.hidden=true;announce('review','Owner checkout could not start','No new payment was started by this page. Retry the connection, or return to the workspace for owner sign-in.');retrySetup.hidden=false;ownerAccess.hidden=false;});

export {};
