import {expect,it} from "vitest";
import {recordedCapture} from "../src/merchant/recorded-capture.ts";
import {parseScenario} from "../web/judge/recovery.ts";
const evidence={http_status:200,evidence_class:"PAYPAL_API_READBACK",summary_json:JSON.stringify({provenance:"PAYPAL_SANDBOX_GET",id:"ORDER",status:"COMPLETED",purchase_units:[{captures:[{id:"CAPTURE",status:"COMPLETED",amount:{currency_code:"USD",value:"12.34"}}]}]})};
it("exposes only the immutable recorded capture amount, never a merchant total",()=>{
  expect(recordedCapture(evidence,"ORDER")).toEqual({status:"COMPLETED",currency:"USD",value:"12.34"});
  const scenario={run:{id:"run",label:"controlled"},orders:[],paymentReference:{attemptId:"attempt",evidenceSeq:1,observedAt:"2026-11-07T00:00:00.000Z",provenance:"PAYPAL_SANDBOX_GET",note:"historical",recordedCapture:recordedCapture(evidence,"ORDER")}};
  expect(parseScenario(scenario).paymentReference.recordedCapture?.value).toBe("12.34");
  expect(()=>parseScenario({...scenario,paymentReference:{...scenario.paymentReference,provenance:"SYNTHETIC_QUALIFICATION"}})).toThrow();
  expect(()=>parseScenario({...scenario,paymentReference:{...scenario.paymentReference,recordedCapture:{status:"COMPLETED",currency:"USD",value:"not-money"}}})).toThrow();
});
it("refuses synthetic, malformed, ambiguous and unrelated observations",()=>{
  expect(recordedCapture(evidence,"OTHER")).toBeNull();
  expect(recordedCapture({...evidence,http_status:503},"ORDER")).toBeNull();
  for(const summary of ["{}","{",evidence.summary_json.replace("PAYPAL_SANDBOX_GET","SYNTHETIC_QUALIFICATION"),evidence.summary_json.replace('"12.34"','"not-money"')])
    expect(recordedCapture({...evidence,summary_json:summary},"ORDER")).toBeNull();
});
