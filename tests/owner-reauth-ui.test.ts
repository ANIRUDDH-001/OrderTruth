import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
async function mount(expired=false){
 const nodes=new Map<string,any>(),calls:string[]=[],storage=new Map([['ordertruth.checkoutKey','ck_preserved_qualification']]);let callbacks:any;
 const node=()=>({hidden:true,disabled:false,textContent:'',dataset:{},listeners:{} as Record<string,()=>void>,append(){},removeAttribute(k:string){if(k==='hidden')this.hidden=false;},addEventListener(k:string,fn:()=>void){this.listeners[k]=fn;}});
 for(const id of ['status','log','paypal-button','outcome','outcome-heading','recheck','new-purchase','retry-setup','owner-access'])nodes.set('#'+id,node());
 const doc={querySelector:(id:string)=>nodes.get(id),createElement:()=>node(),head:{append:(s:any)=>s.onload()}};
 vi.stubGlobal('document',doc);vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});
 const sdk={createInstance:vi.fn(async()=>({findEligibleMethods:async()=>({isEligible:()=>true}),createPayPalOneTimePaymentSession:(c:any)=>{callbacks=c;return {start:async(_:unknown,p:Promise<unknown>)=>{try{await p;}catch(e){c.onError(e);throw e;}}};}}))};vi.stubGlobal('window',{paypal:sdk});
 vi.stubGlobal('fetch',async(path:string)=>{calls.push(path);return path.endsWith('browser-config')?Response.json({environment:'sandbox',sdkUrl:'https://www.sandbox.paypal.com/web-sdk/v6/core',clientId:'synthetic',paymentActionsAllowed:!expired}):Response.json({error:'owner_reauthentication_required'},{status:403});});
 await import('../web/main.ts');for(let i=0;i<20;i++)await Promise.resolve();return {nodes,calls,storage,sdk};
}
it('preflights expired owner access before loading the SDK or starting a payment',async()=>{
 const u=await mount(true);expect(u.sdk.createInstance).not.toHaveBeenCalled();expect(u.nodes.get('#outcome-heading').textContent).toBe('Confirm owner access');expect(u.nodes.get('#owner-access').href).toContain('reauth=1');expect(u.storage.get('ordertruth.checkoutKey')).toBe('ck_preserved_qualification');
});
it('preserves explicit reauthentication refusal across late SDK errors without uncertain payment wording',async()=>{
 const u=await mount();u.nodes.get('#paypal-button').listeners.click();for(let i=0;i<30;i++)await Promise.resolve();
 expect(u.calls.filter(p=>p==='/api/orders')).toHaveLength(1);expect(u.nodes.get('#outcome-heading').textContent).toBe('Confirm owner access');expect(u.nodes.get('#status').textContent).toContain('No payment action was accepted');expect(u.nodes.get('#paypal-button').hidden).toBe(true);expect(u.storage.get('ordertruth.checkoutKey')).toBe('ck_preserved_qualification');
});
