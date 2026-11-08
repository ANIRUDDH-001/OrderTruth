import { expect,it } from "vitest";
import { PayPalClient,PayPalError } from "../src/paypal/client.ts";
import { SANDBOX_API_BASE } from "../src/config.ts";

it("classifies an interrupted HTTP response body as a nonauthoritative transport failure", async () => {
  let calls = 0;
  const client = new PayPalClient({ env: "sandbox",apiBase: SANDBOX_API_BASE,clientId: "synthetic",clientSecret: "synthetic",webhookId: undefined,timeoutMs: 1000 },async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ access_token: "synthetic",expires_in: 300 }));
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("synthetic disconnect")); } }),{ status: 200 });
  });
  const error = await client.getOrder("SYNTHETIC123",{ correlationId: "synthetic" }).catch(e => e);
  expect(error).toBeInstanceOf(PayPalError);
  expect(error.kind).toBe("network");
  expect(error.httpStatus).toBe(200);
});
