import {z} from "zod";
const observation=z.object({provenance:z.literal("PAYPAL_SANDBOX_GET"),id:z.string(),status:z.literal("COMPLETED"),
  purchase_units:z.array(z.object({captures:z.array(z.object({id:z.string().min(1),status:z.literal("COMPLETED"),
    amount:z.object({currency_code:z.string().regex(/^[A-Z]{3}$/),value:z.string().regex(/^\d{1,12}\.\d{2}$/)})})).length(1)})).length(1)});
/** Historical facts from the selected immutable, previously validated observation.
 * No merchant totals, latest-attempt inference, provider IDs or raw payload leak. */
export function recordedCapture(row:{http_status:number|null;evidence_class:string;summary_json:string},orderId:string|null) {
  if(row.http_status!==200 || row.evidence_class!=="PAYPAL_API_READBACK" || !orderId) return null;
  try{
    const parsed=observation.safeParse(JSON.parse(row.summary_json));
    if(!parsed.success || parsed.data.id!==orderId) return null;
    const capture=parsed.data.purchase_units[0]!.captures[0]!;
    return {status:capture.status,currency:capture.amount.currency_code,value:capture.amount.value};
  }catch{return null;}
}
