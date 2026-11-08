import type {InvestigationEvidence} from './investigation.ts';
const at='2026-11-08T00:00:00.000Z';
const payment:InvestigationEvidence={id:'synthetic-payment',source:'SYNTHETIC_PAYMENT_OBSERVATION',observedAt:at,facts:{orderStatus:'COMPLETED',purchaseUnits:[]}};
function merchant(active=2,listed=active):InvestigationEvidence{return {id:'synthetic-merchant',source:'CONTROLLED_MERCHANT_STATE',observedAt:at,facts:{activeOrders:active,orders:Array.from({length:listed},(_,i)=>({id:`synthetic-order-${i}`,status:'placed',amountMinor:100,currency:'USD'})),providerMutation:false}};}
function keys(distinct:number):InvestigationEvidence{return {id:'synthetic-keys',source:'MERCHANT_DIAGNOSTIC',observedAt:at,facts:{diagnostic:'IDEMPOTENCY_KEYS',distinctKeys:distinct,entries:[0,1].map(i=>({handler:i?'webhook_capture_completed':'capture_return',keySha256:(distinct===1?'a':i?'b':'a').repeat(64),merchantOrderId:`synthetic-order-${i}`})),scope:'CONTROLLED_MERCHANT_HANDLERS'}};}
function timing(overlap:boolean):InvestigationEvidence{return {id:'synthetic-timing',source:'MERCHANT_DIAGNOSTIC',observedAt:at,facts:{diagnostic:'HANDLER_TIMING',clockPrecision:'MILLISECOND',entries:[{handler:'capture_return',startedAt:at,finishedAt:'2026-11-08T00:00:01.000Z',durationMs:1000,merchantOrderId:'synthetic-order-0'},{handler:'webhook_capture_completed',startedAt:overlap?'2026-11-08T00:00:00.500Z':'2026-11-08T00:00:02.000Z',finishedAt:overlap?'2026-11-08T00:00:01.500Z':'2026-11-08T00:00:03.000Z',durationMs:1000,merchantOrderId:'synthetic-order-1'}],note:'Recorded intervals describe controlled handlers; they do not establish PayPal concurrency.'}};}
function writes(paths=2):InvestigationEvidence{return {id:'synthetic-writes',source:'MERCHANT_DIAGNOSTIC',observedAt:at,facts:{diagnostic:'MERCHANT_WRITE_OUTCOMES',committedWrites:2,entries:[0,1].map(i=>({handler:paths===1||i===0?'capture_return':'webhook_capture_completed',merchantOrderId:`synthetic-order-${i}`,outcome:'COMMITTED'})),limitation:'Only committed controlled merchant writes are observed here; absence of a row does not prove no failed attempt occurred.'}};}
/** Developer-authored synthetic pilot, not the frozen independent holdout. */
export const pilotCases=[
 {id:'P01',evidence:[payment,merchant()]},
 {id:'P02',evidence:[payment,merchant(),keys(2)]},
 {id:'P03',evidence:[payment,merchant(),keys(1)]},
 {id:'P04',evidence:[payment,merchant(),timing(false)]},
 {id:'P05',evidence:[payment,merchant(),timing(true)]},
 {id:'P06',evidence:[payment,merchant(),writes(1)]},
 {id:'P07',evidence:[payment,merchant(),writes(2)]},
 {id:'P08',evidence:[payment,merchant(),keys(2),timing(false),writes(2)]},
 {id:'P09',evidence:[payment,merchant(1,2),keys(2)]},
 {id:'P10',evidence:[payment,merchant(0)]},
] satisfies Array<{id:string;evidence:InvestigationEvidence[]}>;
