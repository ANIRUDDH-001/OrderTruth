import {describe,it,expect} from "vitest";
import {preflightPayee} from "../src/merchant/lab-payee-preflight.ts";
describe("offline payee compatibility preflight",()=>{
 it("accepts the exact merchant_id readback shape used by the mock provider",()=>{
  expect(preflightPayee({purchase_units:[{payee:{merchant_id:"MERCHANTFAKE123"}}]},"MERCHANTFAKE123").eligible).toBe(true);
 });
 it("fails closed on email-only or absent merchant identity without a purchase",()=>{
  expect(preflightPayee({purchase_units:[{payee:{email_address:"fixture@example.com"}}]},"MERCHANTFAKE123").reason).toBe("PAYEE_MERCHANT_ID_MISSING");
  expect(preflightPayee({purchase_units:[{}]},"MERCHANTFAKE123").eligible).toBe(false);
 });
 it("rejects another merchant and ambiguous purchase units",()=>{
  expect(preflightPayee({purchase_units:[{payee:{merchant_id:"OTHER"}}]},"MERCHANTFAKE123").eligible).toBe(false);
  expect(preflightPayee({purchase_units:[{},{}]},"MERCHANTFAKE123").eligible).toBe(false);
 });
});
