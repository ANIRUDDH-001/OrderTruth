/** Small DOM fixture for the judge entry module; real Chromium checks remain separate. */
import { vi } from "vitest";

export class JudgeNode {
  children: JudgeNode[] = []; parent: JudgeNode|null = null; attrs = new Map<string,string>(); listeners = new Map<string,Array<(event: { preventDefault(): void }) => void>>();
  id = ""; className = ""; disabled = false; value = ""; type = ""; name = ""; required = false; selectionStart = 0; selectionEnd = 0;
  private text = "";
  constructor(readonly tag: string,readonly doc: JudgeDocument) {}
  get textContent(): string { return this.text + this.children.map(n => n.textContent).join(""); }
  set textContent(text: string) { this.replaceChildren(); this.text = text; }
  append(...nodes: JudgeNode[]) { for (const node of nodes) { node.detach(); node.parent = this; this.children.push(node); } }
  private detach() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  replaceChildren(...nodes: JudgeNode[]) { if (this.doc.activeElement && this.children.some(n => n.contains(this.doc.activeElement!))) this.doc.activeElement = null; for (const n of this.children) n.parent = null; this.children = []; this.text = ""; this.append(...nodes); }
  replaceWith(node: JudgeNode) { if (!this.parent) return; const parent = this.parent,index = parent.children.indexOf(this); if (this.doc.activeElement && this.contains(this.doc.activeElement)) this.doc.activeElement = null; this.parent = null; node.detach(); parent.children[index] = node; node.parent = parent; }
  contains(node: JudgeNode): boolean { return this === node || this.children.some(c => c.contains(node)); }
  setAttribute(key: string,value: string) { this.attrs.set(key,value); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  addEventListener(kind: string,fn: (event: { preventDefault(): void }) => void) { this.listeners.set(kind,[...(this.listeners.get(kind) ?? []),fn]); }
  fire(kind: string) { if (kind === "click" && this.disabled) throw new Error("Fixture refused disabled control"); for (const fn of this.listeners.get(kind) ?? []) fn({ preventDefault() {} }); }
  focus() { this.doc.activeElement = this; }
  querySelectorAll(selector: string): JudgeNode[] {
    const matches = (n: JudgeNode) => selector.startsWith("#") ? n.id === selector.slice(1) : selector === "p.notice[role=status]" ? n.tag === "p" && n.className === "notice" && n.getAttribute("role") === "status" : n.tag === selector;
    return this.children.flatMap(n => [...(matches(n) ? [n] : []),...n.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}
class JudgeDocument {
  activeElement: JudgeNode|null = null; root = new JudgeNode("div",this);
  constructor() { this.root.id = "app"; }
  createElement(tag: string) { return new JudgeNode(tag,this); }
  querySelector(selector: string) { return selector === "#app" ? this.root : this.root.querySelector(selector); }
}
export type UiCall = { method: string; path: string };
export function scenario(id: string) {
  return { run: { id,label: "CONTROLLED_MERCHANT_SCENARIO" },orders: [{ id: `order_${id}`,effective_status: "placed",amount_minor: 100,currency: "USD" }],paymentReference: { attemptId: "synthetic_observation",evidenceSeq: 1,observedAt: "2026-10-26T00:00:00Z",provenance: "SYNTHETIC_QUALIFICATION",note: "Synthetic UI fixture" },latestPlan: null };
}
// settle: false returns while the page's first request may still be pending (slow-load tests).
export async function mountJudge(handler: (call: UiCall,body: unknown) => unknown|Promise<unknown>,runId = "",storage = new Map<string,string>(),{ settle = true } = {}) {
  vi.useFakeTimers(); vi.resetModules(); const doc = new JudgeDocument(),location = { href: `http://127.0.0.1:3333/${runId ? `?run=${runId}` : ""}` },calls: UiCall[] = [];
  vi.stubGlobal("document",doc); vi.stubGlobal("location",location); vi.stubGlobal("history",{ replaceState: (_a: unknown,_b: unknown,url: URL|string) => { location.href = String(url); } });
  vi.stubGlobal("localStorage",{ getItem: (k: string) => storage.get(k) ?? null,setItem: (k: string,v: string) => storage.set(k,v),removeItem: (k: string) => storage.delete(k) });
  vi.stubGlobal("fetch",async (p: string,init?: RequestInit) => { const call = { method: init?.method ?? "GET",path: p }; calls.push(call); const value = await handler(call,init?.body ? JSON.parse(String(init.body)) : undefined); return value instanceof Response ? value : new Response(JSON.stringify(value),{ status: 200,headers: { "content-type": "application/json" } }); });
  const idle = async () => { for (let n = 0;n < 80;n++) { await vi.advanceTimersByTimeAsync(0); const buttons = doc.root.querySelectorAll("button"); if (buttons.length && buttons.some(b => !b.disabled)) return; } throw new Error("UI fixture failed to settle"); };
  await import("../../web/judge/main.ts"); if (settle) await idle();
  const button = (name: string) => { const b = doc.root.querySelectorAll("button").find(b => b.textContent === name); if (!b) throw new Error(`Missing control: ${name}`); return b; };
  return { doc,calls,location,storage,idle,button,async click(name: string) { button(name).fire("click"); await idle(); } };
}
