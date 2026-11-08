import {afterEach,expect,it,vi} from "vitest";
import Fastify,{type FastifyInstance} from "fastify";
import type {createSessionAuth} from "../src/server/auth.ts";
import {registerSessionApi} from "../src/server/session-api.ts";

const origin="http://127.0.0.1:3333";
const apps:FastifyInstance[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
function fixture(identity:"anonymous"|"owner"|null=null){
 const getSession=vi.fn(async()=>identity?{user:{id:identity,isAnonymous:identity==='anonymous'},session:{createdAt:new Date()}}:null);
 const handler=vi.fn(async(_request:Request)=>new Response(JSON.stringify({token:'synthetic-token',user:{id:'new-guest'}}),{headers:{'content-type':'application/json','set-cookie':'synthetic_session=fixture; HttpOnly; SameSite=Lax'}}));
 const reserveGuestAdmission=vi.fn(async()=>true);
 const auth={api:{getSession},handler,reserveGuestAdmission} as unknown as ReturnType<typeof createSessionAuth>;
 const app=Fastify({logger:false});apps.push(app);registerSessionApi(app,auth,origin,new Set(['owner']));
 return{app,getSession,handler,reserveGuestAdmission};
}
it("reserves anonymous admission across peers while preserving real peer attribution and rejecting forged headers",async()=>{
 const {app,handler,reserveGuestAdmission}=fixture();
 for(const remoteAddress of ['192.0.2.10','192.0.2.20']){
  const response=await app.inject({method:'POST',url:'/api/auth/sign-in/anonymous',headers:{origin,'x-ordertruth-client-ip':'203.0.113.2','x-forwarded-for':'203.0.113.3',forwarded:'for=203.0.113.4'},remoteAddress,payload:{}});
  expect(response.statusCode).toBe(200);expect(response.json()).toEqual({ok:true});
 }
 expect(handler.mock.calls.map(([request])=>request.headers.get('x-ordertruth-client-ip'))).toEqual(['192.0.2.10','192.0.2.20']);
 expect(reserveGuestAdmission).toHaveBeenCalledTimes(2);
});
it("reuses an authenticated guest without creating an identity or consuming the new-guest bucket",async()=>{
 const {app,handler,reserveGuestAdmission}=fixture('anonymous');
 const response=await app.inject({method:'POST',url:'/api/auth/sign-in/anonymous',headers:{origin,cookie:'synthetic_session=fixture'},payload:{}});
 expect(response.statusCode).toBe(200);expect(response.json()).toEqual({ok:true});expect(handler).not.toHaveBeenCalled();
 expect(response.headers['set-cookie']).toBeUndefined();
 expect(reserveGuestAdmission).not.toHaveBeenCalled();
});
it("returns bounded admission recovery without invoking authentication when capacity is exhausted",async()=>{
 const {app,handler,reserveGuestAdmission}=fixture();reserveGuestAdmission.mockResolvedValueOnce(false);
 const response=await app.inject({method:'POST',url:'/api/auth/sign-in/anonymous',headers:{origin},payload:{}});
 expect(response.statusCode).toBe(429);expect(response.headers['retry-after']).toBe('60');expect(handler).not.toHaveBeenCalled();
 reserveGuestAdmission.mockRejectedValueOnce(new Error('synthetic database failure detail'));
 const failed=await app.inject({method:'POST',url:'/api/auth/sign-in/anonymous',headers:{origin},payload:{}});
 expect(failed.statusCode).toBe(503);expect(failed.json()).toEqual({error:'Authentication unavailable'});expect(handler).not.toHaveBeenCalled();
});
it("does not mistake an owner for a reusable guest and preserves owner login peer throttling",async()=>{
 const {app,handler}=fixture('owner');
 await app.inject({method:'POST',url:'/api/auth/sign-in/anonymous',headers:{origin,cookie:'synthetic_session=owner'},remoteAddress:'192.0.2.10',payload:{}});
 await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin,'x-ordertruth-client-ip':'203.0.113.7','x-forwarded-for':'203.0.113.8'},remoteAddress:'192.0.2.10',payload:{}});
 expect(handler).toHaveBeenCalledTimes(2);
 expect(handler.mock.calls[1]![0].headers.get('x-ordertruth-client-ip')).toBe('192.0.2.10');
});
it("checks origin before guest reuse and fails closed on session lookup failure",async()=>{
 const {app,handler,getSession}=fixture('anonymous');
 const foreign=await app.inject({method:'POST',url:'/api/auth/sign-in/anonymous',headers:{origin:'https://foreign.invalid',cookie:'synthetic_session=fixture'},payload:{}});
 expect(foreign.statusCode).toBe(403);expect(getSession).not.toHaveBeenCalled();expect(handler).not.toHaveBeenCalled();
 getSession.mockRejectedValueOnce(new Error('synthetic private failure detail'));
 const failed=await app.inject({method:'POST',url:'/api/auth/sign-in/anonymous',headers:{origin,cookie:'synthetic_session=fixture'},payload:{}});
 expect(failed.statusCode).toBe(503);expect(failed.json()).toEqual({error:'Authentication unavailable'});expect(handler).not.toHaveBeenCalled();
});
