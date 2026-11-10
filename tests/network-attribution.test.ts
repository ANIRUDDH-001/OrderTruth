import { afterEach, expect, it, vi } from "vitest";
import middleware from "../middleware.ts";
import { attestNetwork, NETWORK_PROOF_HEADER, verifyNetwork } from "../src/server/network-attribution.ts";

const key = "9a".repeat(32);
const path = "/api/auth/sign-in/anonymous";
const now = Date.parse("2026-11-09T09:30:00Z");
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("normalizes IPv4-mapped and rotating IPv6 addresses and binds proof to the route and UTC day", () => {
  const group = (ip: string) => verifyNetwork(key,attestNetwork(key,ip,path,now),path,now);
  expect(group("192.0.2.10")).toBe(group("::ffff:192.0.2.10"));
  expect(group("2001:db8:abcd::11")).toBe(group("2001:db8:abcd:0::ffff"));
  expect(group("2001:db8:abcd:1::11")).not.toBe(group("2001:db8:abcd::11"));
  expect(group("192.0.2.10, 203.0.113.42")).toBeNull();
  const proof = attestNetwork(key,"192.0.2.10",path,now)!;
  expect(verifyNetwork(key,proof,"/api/scenarios/run_a/investigate",now)).toBeNull();
  expect(verifyNetwork(key,proof,path,now+31_000)).toBeNull();
  expect(verifyNetwork("be".repeat(32),proof,path,now)).toBeNull();
  const midnight = Date.parse("2026-11-10T00:00:00Z");
  expect(verifyNetwork(key,attestNetwork(key,"192.0.2.10",path,midnight-1000),path,midnight)).toBeNull();
});

it("forwards only the Vercel-attested network and preserves a private session response", async () => {
  vi.stubEnv("ORDERTRUTH_INGRESS_KEY",key);
  vi.spyOn(Date,"now").mockReturnValue(now);
  const relay = vi.fn(async (_url: string,_init: RequestInit) => Response.json({ok:true},{
    headers:{"set-cookie":"fixture=synthetic; HttpOnly; Secure; SameSite=Lax","retry-after":"60",[NETWORK_PROOF_HEADER]:"never-echo"},
  }));
  vi.stubGlobal("fetch",relay);
  const request = (headers: HeadersInit,body="{}") => new Request(`https://order-truth.vercel.app${path}`, { method: "POST",headers,body });
  const spoofed = { "x-forwarded-for": "203.0.113.42",[NETWORK_PROOF_HEADER]: "spoofed",origin:"https://order-truth.vercel.app","content-type":"application/json" };
  await middleware(request(spoofed));
  expect(new Headers(relay.mock.calls[0]![1].headers).get(NETWORK_PROOF_HEADER)).toBeNull();
  const response = await middleware(request({ ...spoofed,"x-real-ip":"192.0.2.10" }));
  const [url,init] = relay.mock.calls[1]!;
  expect(url).toBe("https://ordertruth.onrender.com"+path);
  expect(Buffer.from(init.body as Uint8Array).toString()).toBe("{}");
  const proof = new Headers(init.headers).get(NETWORK_PROOF_HEADER);
  expect(proof).toBe(attestNetwork(key,"192.0.2.10",path,now));
  expect(proof).not.toContain("192.0.2.10");
  expect(new Headers(init.headers).get("x-forwarded-for")).toBeNull();
  expect(response.headers.get(NETWORK_PROOF_HEADER)).toBeNull();
  expect(response.headers.getSetCookie()).toEqual(["fixture=synthetic; HttpOnly; Secure; SameSite=Lax"]);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await middleware(request(spoofed,"x".repeat(16_385)))).status).toBe(413);
  expect(relay).toHaveBeenCalledTimes(2);
});

it('relays Autopilot POST with path-bound proof but leaves trace GET to the backend',async()=>{
 vi.stubEnv('ORDERTRUTH_INGRESS_KEY',key);vi.spyOn(Date,'now').mockReturnValue(now);
 const relay=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({ok:true}));vi.stubGlobal('fetch',relay);
 const route='/api/scenarios/run_a/autopilot';
 expect((await middleware(new Request('https://order-truth.vercel.app'+route,{method:'POST',headers:{origin:'https://order-truth.vercel.app','x-real-ip':'192.0.2.10','content-type':'application/json'},body:'{}'}))).status).toBe(200);
 const proof=new Headers(relay.mock.calls[0]![1].headers).get(NETWORK_PROOF_HEADER);
 expect(verifyNetwork(key,proof,route,now)).not.toBeNull();expect(verifyNetwork(key,proof,route+'/trace',now)).toBeNull();
 expect((await middleware(new Request('https://order-truth.vercel.app'+route))).status).toBe(405);
 expect((await middleware(new Request('https://order-truth.vercel.app'+route+'/trace'))).status).toBe(404);
});
