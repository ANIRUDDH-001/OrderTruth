import { attestNetwork, NETWORK_PROOF_HEADER } from "./src/server/network-attribution.ts";

export const config = { runtime: "nodejs", matcher: ["/api/auth/sign-in/anonymous", "/api/scenarios/:runId/investigate", "/api/scenarios/:runId/autopilot"] };
const backend = "https://ordertruth.onrender.com";
const requestHeaders = ["content-type","origin","cookie","x-ordertruth-source"];
const responseHeaders = ["content-type","retry-after","x-retry-after","x-request-id"];

export default async function middleware(request: Request) {
  const { pathname } = new URL(request.url);
  const guest = pathname === "/api/auth/sign-in/anonymous";
  if (!guest && !/^\/api\/scenarios\/[A-Za-z0-9_-]{1,100}\/(?:investigate|autopilot)$/.test(pathname)) return new Response(null,{status:404});
  if (request.method !== "POST") return new Response(null,{status:405,headers:{allow:"POST"}});
  const limit = guest ? 16_384 : 4096;
  const body = Buffer.alloc(limit);
  let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done,value } = await reader.read();
      if (done) break;
      if (length+value.byteLength > limit) {
        await reader.cancel();
        return Response.json({ error:"Request body too large" },{status:413});
      }
      body.set(value,length);
      length += value.byteLength;
    }
  }
  const key = process.env.ORDERTRUTH_INGRESS_KEY;
  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name,value);
  }
  if (key && /^[a-f0-9]{64}$/.test(key)) {
    // Vercel supplies x-real-ip at its public boundary. This proof is sent
    // upstream only. Render never trusts inbound forwarding headers.
    const address = request.headers.get("x-real-ip");
    const proof = address && attestNetwork(key,address,pathname);
    if (proof) headers.set(NETWORK_PROOF_HEADER,proof);
  }
  try {
    const response = await fetch(backend+pathname,{ method:"POST",headers,body:body.subarray(0,length),
      redirect:"error",cache:"no-store",signal:AbortSignal.timeout(44_000) });
    const result = new Headers({"cache-control":"no-store"});
    for (const name of responseHeaders) {
      const value = response.headers.get(name);
      if (value) result.set(name,value);
    }
    for (const cookie of response.headers.getSetCookie()) result.append("set-cookie",cookie);
    return new Response(response.body,{ status:response.status,headers:result });
  } catch {
    return Response.json({error:"The service could not confirm the request. Recheck your session or case before trying again."},
      {status:502,headers:{"cache-control":"no-store"}});
  }
}
