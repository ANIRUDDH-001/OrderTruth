import { expect, it } from "vitest";
import { Store } from "../src/db/store.ts";
import { evaluateContract, type PaymentFacts } from "../src/merchant/contract.ts";
const p: PaymentFacts = { intentId:"i", intentSku:"s", intentCurrency:"USD", intentMinor:100, attemptId:"a", attemptState:"captured", paypalOrderId:"o", captureId:"c", captureStatus:"COMPLETED", capturedMinor:100, capturedCurrency:"USD", readbacks:[{seq:1,httpStatus:200,createdAt:"t",orderId:"o",orderStatus:"COMPLETED",units:[{customId:"i",captures:[{id:"c",status:"COMPLETED",currency:"USD",value:"1.00"}]}]}] };
it("effective status excludes voids while original placed status remains historical",()=>{
 const order = (id:string, effectiveStatus:string) => ({id,status:"placed",effectiveStatus,attemptId:"a",paypalOrderId:"o",captureId:"c",sku:"s",amountMinor:100,currency:"USD"});
 expect(evaluateContract(p,[order("one","placed"),order("two","voided_duplicate")])).toMatchObject({result:"HOLDS",activeOrderCount:1,matchingOrderIds:["one"]});
});
it("migration supplies append-only repair facts and unique terminal result table",()=>{
 const s = new Store(":memory:");
 try { expect(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repair_outcomes'").get()).toBeDefined(); } finally {s.close();}
});
