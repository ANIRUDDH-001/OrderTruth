import {expect,it} from 'vitest';
import {providerApprovalLink,sandboxApprovalLink} from '../src/paypal/approval-link.ts';
const id='SYNTHETICORDER1',safe=`https://www.sandbox.paypal.com/checkoutnow?token=${id}`;
it('accepts the exact provider approval relation for the bound Sandbox order',()=>{
 for(const rel of ['approve','payer-action'])expect(providerApprovalLink([{rel,href:safe,method:'GET'}],id)).toBe(safe);
 expect(providerApprovalLink([{rel:'capture',href:safe}],id)).toBeNull();
 expect(providerApprovalLink([{rel:'approve',href:safe,method:'POST'}],id)).toBeNull();
 expect(providerApprovalLink({rel:'approve',href:safe},id)).toBeNull();
});
it('rejects live, mismatched, ambiguous and redirect-capable approval URLs',()=>{
 for(const url of [safe.replace('sandbox.',''),safe.replace('https:','http:'),safe.replace('/checkoutnow','/redirect'),safe.replace(id,'SYNTHETICORDER2'),`${safe}&token=${id}`,`${safe}&redirect=https://example.test`,`${safe}#fragment`,safe.replace('www.','example.test@www.')])
   expect(sandboxApprovalLink(url,id)).toBeNull();
});
