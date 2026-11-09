/** Only a provider-returned Sandbox approval link for this exact order may be
 * displayed. Never derive an approval destination from arbitrary URLs. */
export function sandboxApprovalLink(value:unknown,orderId:string):string|null {
  if(typeof value!=='string'||value.length>512||!/^[A-Z0-9]{8,36}$/.test(orderId))return null;
  try{
    const url=new URL(value);
    if(!['https://www.sandbox.paypal.com','https://sandbox.paypal.com'].includes(url.origin)||url.pathname!=='/checkoutnow'||url.username||url.password||url.hash)return null;
    if(url.searchParams.getAll('token').length!==1||url.searchParams.get('token')!==orderId)return null;
    for(const [name,param] of url.searchParams)if(name!=='token'&&(name!=='useraction'||!['commit','continue'].includes(param)||url.searchParams.getAll(name).length!==1))return null;
    return url.href;
  }catch{return null;}
}

export function providerApprovalLink(links:unknown,orderId:string){
  if(!Array.isArray(links)||links.length>20)return null;
  for(const link of links){
    if(!link||typeof link!=='object')continue;
    if(!['approve','payer-action'].includes(link.rel)||(link.method!==undefined&&link.method!=='GET'))continue;
    const approved=sandboxApprovalLink(link.href,orderId);if(approved)return approved;
  }
  return null;
}
