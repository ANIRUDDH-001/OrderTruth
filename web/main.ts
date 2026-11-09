// Gate 0 PayPal JS SDK v6 one-time checkout, following the official sample
// (paypal-examples/v6-web-sdk-sample-integration, paypalPayments/oneTimePayment/typescript).
// Minimal local typings instead of @paypal/paypal-js to keep Gate 0 dependency-light.
import {ownerOutcome,mayApplyPresentationEvent,type OwnerOutcome} from './owner-state.ts';
import {sandboxApprovalLink} from '../src/paypal/approval-link.ts';

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
const approvalLink=document.querySelector<HTMLAnchorElement>('#approval-link')!;
const captureApproved=document.querySelector<HTMLButtonElement>('#capture-approved')!;
const ORDER_NAME='ordertruth.activePayPalOrder';
const APPROVAL_LINK='ordertruth.activePayPalApproval';
let activeOrder:string|null=null,locked=false,busy=false,captureBusy=false,sdkReady=false;
let acceptedOutcome:OwnerOutcome|null=null;
let reauthenticationRequired=false;
let approved=false,captureRequested=false,approvalUrl:string|null=null;
try{const saved=localStorage.getItem(ORDER_NAME);if(saved&&/^[A-Za-z0-9]{1,64}$/.test(saved)){activeOrder=saved;approvalUrl=sandboxApprovalLink(localStorage.getItem(APPROVAL_LINK),saved);}}catch{}
function rememberOrder(id:string,link?:unknown){
 if(!/^[A-Za-z0-9]{1,64}$/.test(id))throw Error('Invalid Sandbox order identity');
 approvalUrl=sandboxApprovalLink(link,id)??(id===activeOrder?approvalUrl:null);activeOrder=id;recheck.hidden=false;
 try{localStorage.setItem(ORDER_NAME,id);if(approvalUrl)localStorage.setItem(APPROVAL_LINK,approvalUrl);else localStorage.removeItem(APPROVAL_LINK);}catch{}
}
function announce(kind:string,title:string,detail:string){outcomeEl.dataset.kind=kind;heading.textContent=title;statusEl.textContent=detail;}
function requireOwnerConfirmation(){
 reauthenticationRequired=true;locked=true;button.hidden=true;newPurchase.hidden=true;retrySetup.hidden=true;approvalLink.hidden=true;captureApproved.hidden=true;
 recheck.hidden=true;
 ownerAccess.href='/?view=overview&reauth=1';ownerAccess.textContent='Confirm owner access';ownerAccess.hidden=false;
 const continuation = activeOrder
  ? 'Reopen this saved checkout after signing in. Its order and checkout key are preserved. Do not start another purchase.'
  : 'If you have a saved checkout, reopen it after signing in.';
 announce('review','Confirm owner access',`No payment action was accepted by this request. ${continuation}`);
}
function needsOwnerConfirmation(error:unknown){
 return error instanceof ApiError&&(error.code==='owner_reauthentication_required'||error.code==='owner_sign_in_required');
}
function showOutcome(raw:unknown){
 const outcome=ownerOutcome(raw);acceptedOutcome=outcome;approved=outcome.kind==='approval'&&(raw as {state?:string}).state==='approved';
 announce(outcome.kind,outcome.heading,approved?'Buyer approval is recorded. Capture this same Sandbox payment only if you intend to complete it.':outcome.detail);
 locked=outcome.kind!=='approval'||approved||reauthenticationRequired;button.hidden=locked||!sdkReady;newPurchase.hidden=!outcome.canStartAnother;recheck.hidden=!activeOrder;
 approvalLink.hidden=locked||!approvalUrl||captureRequested;if(!approvalLink.hidden)approvalLink.href=approvalUrl!;
 captureApproved.hidden=!approved||captureRequested||reauthenticationRequired;return outcome;
}
function offerSameOrderApproval(){
 if(!activeOrder||!approvalUrl||approved||captureRequested||captureBusy||reauthenticationRequired||acceptedOutcome?.kind!=='approval')return false;
 locked=true;button.hidden=true;approvalLink.href=approvalUrl;approvalLink.hidden=false;retrySetup.hidden=true;
 announce('review','Continue the saved Sandbox order','Open PayPal directly to approve this same order. Then return here and recheck its evidence. Do not start another purchase.');return true;
}

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
  const body = (await res.json().catch(() => ({}))) as T & { code?: string; error?: string; message?: string; correlationId?: string };
  if (!res.ok) throw new ApiError(`${path} -> HTTP ${res.status} ${body.error ?? ""} ${body.message ?? ""} corr=${body.correlationId ?? res.headers.get("x-correlation-id") ?? "?"}`, body.code??body.error);
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
    const o = await api<{ orderId: string; status: string; reused?: boolean;approvalUrl?:string }>("/api/orders", { method: "POST", body: "{}", headers: { "x-checkout-key": checkoutKey() } });
    log("info", `order ${o.reused ? "resumed" : "created"} ${o.orderId} (${o.status}); waiting for buyer approval in PayPal window`);
    rememberOrder(o.orderId,o.approvalUrl);showOutcome({state:o.status});button.hidden=true;
    if(!approved)announce('pending','Waiting for buyer approval','Approve this same reference checkout in PayPal Sandbox. If the popup fails, use the saved order link.');return { orderId: o.orderId };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : undefined;
    if(needsOwnerConfirmation(e))requireOwnerConfirmation();
    else if (code === "checkout_already_paid") {
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

async function captureSavedOrder(id:string){
  if(captureRequested||captureBusy||reauthenticationRequired||acceptedOutcome?.kind!=='approval'||id!==activeOrder)return;
  captureRequested=true;captureBusy=true;button.hidden=true;approvalLink.hidden=true;captureApproved.hidden=true;recheck.disabled=true;
  announce('pending','Verifying the approved payment','The server will claim capture once, then verify the outcome through PayPal readback.');
  try{
    const result=await api<unknown>(`/api/orders/${encodeURIComponent(id)}/capture`,{method:'POST',body:'{}'});
    const outcome=showOutcome(result);log(outcome.kind==='verified'?'ok':'info',outcome.heading);
  }catch(error){
    log('error',`Capture request did not return a verified outcome: ${error instanceof Error?error.message:'unknown error'}`);
    if(needsOwnerConfirmation(error))requireOwnerConfirmation();else showOutcome({state:'uncertain'});
  }finally{captureBusy=false;recheck.disabled=false;}
}

async function main() {
  const cfg = await api<{ clientId: string; environment: string; sdkUrl: string;paymentActionsAllowed?:boolean }>("/api/paypal/browser-config");
  if (cfg.environment !== "sandbox" || !cfg.sdkUrl.startsWith("https://www.sandbox.paypal.com/")) throw new Error("refusing non-sandbox SDK configuration");
  if(activeOrder){
    recheck.hidden=false;
    const stored=showOutcome(await api<unknown>(`/api/orders/${encodeURIComponent(activeOrder)}`));
    if(stored.kind!=='approval')return;
  }
  if(cfg.paymentActionsAllowed===false){requireOwnerConfirmation();return;}
  if(approved)return;
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
      if(captureRequested||reauthenticationRequired||!mayApplyPresentationEvent(acceptedOutcome,captureBusy))return;
      if(!activeOrder||data.orderId!==activeOrder){showOutcome(null);announce('review','Checkout identity needs review','The approval does not match this saved checkout. No capture was requested.');return;}
      await captureSavedOrder(data.orderId);
    },
    onCancel(d) {
      log("info", `buyer approval interrupted for ${d.orderId ?? "saved checkout"}`);
      if(!reauthenticationRequired&&mayApplyPresentationEvent(acceptedOutcome,captureBusy)&&!offerSameOrderApproval()&&!approved){locked=true;button.hidden=true;announce('review','Buyer approval interrupted','The saved checkout is retained. Recheck its evidence before paying again; cancellation does not establish rollback.');}
    },
    onError(e) {
      log("error", 'Sandbox payment window could not complete');
      if(!reauthenticationRequired&&mayApplyPresentationEvent(acceptedOutcome,captureBusy)&&!offerSameOrderApproval()&&!approved){showOutcome({state:'uncertain'});retrySetup.hidden=false;}
    },
  });
  sdkReady=true;button.removeAttribute("hidden");
  button.addEventListener("click", () => {
    if(locked||busy||captureBusy)return;
    // Do not await createOrder before start(): preserves transient user activation (per official sample).
    busy=true;button.hidden=true;
    session.start({ presentationMode: "auto" }, createOrder()).catch(() => {log("error", 'Sandbox payment presentation stopped');if(!locked&&!captureBusy&&!offerSameOrderApproval())showOutcome({state:'uncertain'});}).finally(()=>{busy=false;if(!locked&&!captureBusy)button.hidden=false;});
  });
  log("info", "PayPal button ready");
  announce('approval','Ready for Sandbox approval','Use the official button to approve the server-priced USD1.00 reference purchase.');
}

recheck.addEventListener('click',async()=>{
 if(!activeOrder||busy||captureBusy||reauthenticationRequired)return;busy=true;recheck.disabled=true;button.hidden=true;
 try{showOutcome(await api<unknown>(`/api/orders/${encodeURIComponent(activeOrder)}/readback`,{method:'POST',body:'{}'}));}
 catch(error){
  if(needsOwnerConfirmation(error))requireOwnerConfirmation();else showOutcome({state:'uncertain'});
  log('error',`Readback unavailable: ${error instanceof Error?error.message:'unknown error'}`);
 }
 finally{busy=false;recheck.disabled=false;}
});
captureApproved.addEventListener('click',()=>{if(!busy&&approved&&activeOrder)void captureSavedOrder(activeOrder);});
newPurchase.addEventListener('click',()=>{if(busy||captureBusy)return;endCheckout();try{localStorage.removeItem(ORDER_NAME);localStorage.removeItem(APPROVAL_LINK);}catch{}location.reload();});
retrySetup.addEventListener('click',()=>{if(!busy&&!captureBusy)location.reload();});
main().catch((e: unknown) => {
 log("error", `init failed: ${(e as Error).message}`);button.hidden=true;
 if(needsOwnerConfirmation(e)){requireOwnerConfirmation();return;}
 if(offerSameOrderApproval())return;
 announce('review','Owner checkout could not start','No new payment was started by this page. Retry the connection, or return to the workspace for owner sign-in.');retrySetup.hidden=false;ownerAccess.hidden=false;
});

export {};
