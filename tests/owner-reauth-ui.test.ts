import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
const order='SYNTHETICORDER1',approvalUrl=`https://www.sandbox.paypal.com/checkoutnow?token=${order}`;
async function mount(expired=false,popupFails=false,readback?:()=>Response){
 const nodes=new Map<string,any>(),calls:string[]=[],storage=new Map([['ordertruth.checkoutKey','ck_preserved_qualification']]);let callbacks:any;
 const node=()=>({hidden:true,disabled:false,textContent:'',dataset:{},listeners:{} as Record<string,()=>void>,append(){},removeAttribute(k:string){if(k==='hidden')this.hidden=false;},addEventListener(k:string,fn:()=>void){this.listeners[k]=fn;}});
 for(const id of ['status','log','paypal-button','outcome','outcome-heading','recheck','new-purchase','retry-setup','owner-access','approval-link','capture-approved'])nodes.set('#'+id,node());
 const doc={querySelector:(id:string)=>nodes.get(id),createElement:()=>node(),head:{append:(s:any)=>s.onload()}};
 vi.stubGlobal('document',doc);vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});
 const sdk={createInstance:vi.fn(async()=>({findEligibleMethods:async()=>({isEligible:()=>true}),createPayPalOneTimePaymentSession:(c:any)=>{callbacks=c;return {start:async(_:unknown,p:Promise<unknown>)=>{try{await p;if(popupFails)throw Error('Sandbox popup rejected before approval');}catch(e){c.onError(e);throw e;}}};}}))};vi.stubGlobal('window',{paypal:sdk});
 vi.stubGlobal('fetch',async(path:string)=>{calls.push(path);
  if(path.endsWith('browser-config'))return Response.json({environment:'sandbox',sdkUrl:'https://www.sandbox.paypal.com/web-sdk/v6/core',clientId:'synthetic',paymentActionsAllowed:!expired});
  if(popupFails){
   if(path==='/api/orders')return Response.json({orderId:order,status:'awaiting_buyer_approval',approvalUrl});
   if(path===`/api/orders/${order}/readback`)return readback?.()??Response.json({state:'approved'});
   if(path===`/api/orders/${order}/capture`)return Response.json({state:'captured',captureId:'SYNTHETICCAPTURE',captureStatus:'COMPLETED',amount:{currency:'USD',value:'1.00'},reasons:['capture COMPLETED; amount, currency and order id match intent']});
  }
  return Response.json({error:'owner_reauthentication_required'},{status:403});
 });
 await import('../web/main.ts');for(let i=0;i<20;i++)await Promise.resolve();return {nodes,calls,storage,sdk,callbacks:()=>callbacks};
}
it('preflights expired owner access before loading the SDK or starting a payment',async()=>{
 const u=await mount(true);expect(u.sdk.createInstance).not.toHaveBeenCalled();expect(u.nodes.get('#outcome-heading').textContent).toBe('Confirm owner access');expect(u.nodes.get('#owner-access').href).toContain('reauth=1');expect(u.storage.get('ordertruth.checkoutKey')).toBe('ck_preserved_qualification');
});
it('continues a popup failure on the exact saved order and waits for explicit capture after stored approval',async()=>{
 const u=await mount(false,true);u.nodes.get('#paypal-button').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 expect(u.nodes.get('#approval-link')).toMatchObject({hidden:false,href:approvalUrl});expect(u.nodes.get('#capture-approved').hidden).toBe(true);
 expect(u.calls).toEqual(['/api/paypal/browser-config','/api/orders']);
 u.nodes.get('#recheck').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 expect(u.nodes.get('#approval-link').hidden).toBe(true);expect(u.nodes.get('#capture-approved').hidden).toBe(false);
 u.nodes.get('#capture-approved').listeners.click();u.nodes.get('#capture-approved').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 expect(u.calls.filter(p=>p.endsWith('/capture'))).toEqual([`/api/orders/${order}/capture`]);
 expect(u.nodes.get('#outcome-heading').textContent).toBe('Sandbox payment verified');expect(u.storage.get('ordertruth.activePayPalOrder')).toBe(order);
});
it('preserves explicit reauthentication refusal across late SDK errors without uncertain payment wording',async()=>{
 const u=await mount();u.nodes.get('#paypal-button').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 expect(u.calls.filter(p=>p==='/api/orders')).toHaveLength(1);expect(u.nodes.get('#outcome-heading').textContent).toBe('Confirm owner access');expect(u.nodes.get('#status').textContent).toContain('No payment action was accepted');expect(u.nodes.get('#paypal-button').hidden).toBe(true);expect(u.storage.get('ordertruth.checkoutKey')).toBe('ck_preserved_qualification');
});
it('offers owner sign-in when the session expires during a saved order recheck',async()=>{
 const u=await mount(false,true,()=>Response.json({code:'owner_sign_in_required',error:'Owner sign-in required; judges cannot perform payment actions'},{status:403}));
 u.nodes.get('#paypal-button').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 u.nodes.get('#recheck').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 expect(u.nodes.get('#outcome-heading').textContent).toBe('Confirm owner access');
 expect(u.nodes.get('#owner-access')).toMatchObject({hidden:false,href:'/?view=overview&reauth=1'});
 expect(u.nodes.get('#recheck').hidden).toBe(true);
 u.nodes.get('#recheck').listeners.click();
 expect(u.calls.filter(p=>p.endsWith('/readback'))).toHaveLength(1);
 expect(u.storage.get('ordertruth.activePayPalOrder')).toBe(order);
 expect(u.calls.filter(p=>p.endsWith('/capture'))).toHaveLength(0);
});
it('still handles the active order approval once when evidence has not settled',async()=>{
 const u=await mount(false,true);
 u.nodes.get('#paypal-button').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 await u.callbacks().onApprove({orderId:order});
 await u.callbacks().onApprove({orderId:order});
 expect(u.calls.filter(p=>p.endsWith('/capture'))).toEqual([`/api/orders/${order}/capture`]);
 expect(u.nodes.get('#outcome-heading').textContent).toBe('Sandbox payment verified');
});
it('keeps verified evidence when a late popup approval reports another order',async()=>{
 const u=await mount(false,true,()=>Response.json({state:'captured',captureId:'SYNTHETICCAPTURE',captureStatus:'COMPLETED',amount:{currency:'USD',value:'1.00'},reasons:['capture COMPLETED; amount, currency and order id match intent']}));
 u.nodes.get('#paypal-button').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 u.nodes.get('#recheck').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 expect(u.nodes.get('#outcome-heading').textContent).toBe('Sandbox payment verified');
 await u.callbacks().onApprove({orderId:'OTHERORDER1'});
 expect(u.nodes.get('#outcome-heading').textContent).toBe('Sandbox payment verified');
 expect(u.calls.filter(p=>p.endsWith('/capture'))).toHaveLength(0);
});
