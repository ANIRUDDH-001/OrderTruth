import type {InvestigationEvidence} from '../../src/ai/investigation.ts';
import {parseDiagnostic} from './recovery.ts';

export function parseCaseDiagnostics(value:unknown):InvestigationEvidence[]{
 if(!Array.isArray(value)||value.length>3)throw Error('Current diagnostics unavailable');
 const rows=value.map(row=>parseDiagnostic(row,row?.facts?.diagnostic));
 if(new Set(rows.map(e=>e.id)).size!==rows.length||new Set(rows.map(e=>e.facts.diagnostic)).size!==rows.length)throw Error('Current diagnostics unavailable');
 return rows;
}

export function evidenceLabel(id:string,evidence:readonly InvestigationEvidence[]):string{
 const row=evidence.find(e=>e.id===id);
 if(!row)return 'Evidence reference unavailable';
 if(row.source==='PAYPAL_SANDBOX_OBSERVATION')return 'Recorded Sandbox payment';
 if(row.source==='SYNTHETIC_PAYMENT_OBSERVATION')return 'Synthetic payment input';
 if(row.source==='CONTROLLED_MERCHANT_STATE')return 'Merchant order records';
 return ({HANDLER_TIMING:'Handler timing check',IDEMPOTENCY_KEYS:'Merchant write-key comparison',MERCHANT_WRITE_OUTCOMES:'Merchant write outcomes'} as Record<string,string>)[String(row.facts.diagnostic)]??'Recorded merchant diagnostic';
}
export function hasNewDiagnostics(snapshot:readonly InvestigationEvidence[],current:readonly InvestigationEvidence[]):boolean{
 const recorded=new Set(snapshot.map(e=>e.id));
 return current.some(e=>e.source==='MERCHANT_DIAGNOSTIC'&&!recorded.has(e.id));
}
