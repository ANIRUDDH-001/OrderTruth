import { Store } from '../../src/db/store.ts';
import { InvariantChecker } from '../../src/merchant/checker.ts';
import { ReferenceMerchant } from '../../src/merchant/reference-merchant.ts';
import { injectDuplicateOrderRace } from '../../src/merchant/fault-injection.ts';
import { REFERENCE_ORG,MerchantRepo } from '../../src/merchant/repo.ts';

/** New synthetic database only. No historical inputs or recovery execution. */
export async function createInvestigationFixture(path: string) {
  const store=new Store(path);
  try {
    new MerchantRepo(store).createOrganization('org_other','Synthetic isolation control');
    const intent='ci_00000000-0000-4000-8000-000000001042';
    store.createIntentWithAttempt({id:intent,sku:'SYNTHETIC-SKU',currency:'USD',amount_minor:4800,correlation_id:'synthetic-gate2d'}, {id:'pa_gate2d_fixture',createRequestId:'synthetic-create',captureRequestId:'synthetic-capture'});
    store.attachOrder('pa_gate2d_fixture','SYNTHETIC-ORDER','CREATED');
    store.transition('pa_gate2d_fixture','captured',{capture_id:'SYNTHETIC-CAPTURE',capture_status:'COMPLETED',captured_minor:4800,captured_currency:'USD'});
    const summary={id:'SYNTHETIC-ORDER',status:'COMPLETED',purchase_units:[{custom_id:intent,captures:[{id:'SYNTHETIC-CAPTURE',status:'COMPLETED',amount:{currency_code:'USD',value:'48.00'}}]}]};
    store.db.prepare("INSERT INTO evidence(attempt_id,evidence_class,operation,http_status,correlation_id,summary_json,created_at) VALUES('pa_gate2d_fixture','PAYPAL_API_READBACK','GET',200,'synthetic-gate2d',?,'2026-10-19T09:40:04Z')").run(JSON.stringify(summary));
    await injectDuplicateOrderRace(new ReferenceMerchant(store),REFERENCE_ORG,intent);
    const check=new InvariantChecker(store).evaluateIntent(REFERENCE_ORG,intent);
    if(!check.incidentId)throw Error('Synthetic incident missing');
    return {store,id:check.incidentId};
  } catch(error){store.close();throw error;}
}
