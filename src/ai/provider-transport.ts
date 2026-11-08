/** Bounded server-only transport. No raw provider body/error is returned on failure. */
export class ProviderTransportError extends Error {
 constructor(readonly code:"TIMEOUT"|"PROVIDER_REDIRECT_REJECTED"|"PROVIDER_RESPONSE_TOO_LARGE"|"INVALID_PROVIDER_RESPONSE"){
  super(code);this.name="ProviderTransportError";
 }
}
const MAX_BODY_BYTES=65_536;
function discard(response:Response){void response.body?.cancel().catch(()=>{});}
function beforeDeadline<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)return Promise.reject(new ProviderTransportError("TIMEOUT"));
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(new ProviderTransportError("TIMEOUT"));
  signal.addEventListener("abort",abort,{once:true});
  pending.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort)).catch(()=>{});
 });
}
async function boundedJson(response:Response,signal:AbortSignal):Promise<unknown>{
 const length=response.headers.get("content-length");
 if(length&&/^\d+$/.test(length)&&Number(length)>MAX_BODY_BYTES){discard(response);throw new ProviderTransportError("PROVIDER_RESPONSE_TOO_LARGE");}
 if(!response.body)throw new ProviderTransportError("INVALID_PROVIDER_RESPONSE");
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,finished=false;
 try{
  while(true){
   const chunk=await beforeDeadline(reader.read(),signal);if(chunk.done){finished=true;break;}
   bytes+=chunk.value.byteLength;
   if(bytes>MAX_BODY_BYTES)throw new ProviderTransportError("PROVIDER_RESPONSE_TOO_LARGE");
   chunks.push(chunk.value);
  }
  if(signal.aborted)throw new ProviderTransportError("TIMEOUT");
  const buffer=Buffer.concat(chunks,bytes);
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer));}
  catch{throw new ProviderTransportError("INVALID_PROVIDER_RESPONSE");}
 }finally{
  if(!finished)void reader.cancel().catch(()=>{});
  reader.releaseLock();
 }
}
/** The same signal bounds connection, headers and streamed body consumption. */
export async function providerJson(url:string,init:RequestInit,signal:AbortSignal,fetchImpl:typeof fetch=fetch){
 if(!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[a-z0-9.-]{1,80}:generateContent$/.test(url)&&url!=="https://api.groq.com/openai/v1/chat/completions")throw new ProviderTransportError("PROVIDER_REDIRECT_REJECTED");
 const origin=new URL(url).origin;
 const pending=fetchImpl(url,{...init,signal,redirect:"error"});
 // A conforming fetch observes signal; discard late results from injected or
 // unusual implementations too, without allowing their body to outlive a call.
 void pending.then(response=>{if(signal.aborted)discard(response);}).catch(()=>{});
 const response=await beforeDeadline(pending,signal);
 if(response.redirected||(response.status>=300&&response.status<400)||(response.url&&new URL(response.url).origin!==origin)){
  discard(response);throw new ProviderTransportError("PROVIDER_REDIRECT_REJECTED");
 }
 if(!response.ok){discard(response);return {response,body:null};}
 return {response,body:await boundedJson(response,signal)};
}
