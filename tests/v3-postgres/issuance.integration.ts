import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { issueCapability, verifyMac } from "../../packages/guard/src/capability.ts";
import { createTestCaptureAuthority } from "../../packages/guard/src/testing/index.ts";
import { fixture, setupGuardEnv, type GuardEnv } from "./setup.ts";

let env: GuardEnv;
const key = Buffer.alloc(32, 7);
const previousMode = process.env.ORDERTRUTH_GUARD_MODE;
beforeAll(async () => { process.env.ORDERTRUTH_GUARD_MODE = "verifier"; env = await setupGuardEnv("SYN-M-A"); });
afterEach(() => { env.proxy.release(); env.proxy.reset(); });
afterAll(async () => { await env?.close(); if (previousMode === undefined) delete process.env.ORDERTRUTH_GUARD_MODE; else process.env.ORDERTRUTH_GUARD_MODE = previousMode; });
const count = async (sql: string, params: unknown[] = []) => Number((await env.db.client.query(sql, params)).rows[0].n);

describe("shared capability issuance (spec §6, §6.1; plan Task 4b)", () => {
  it("commits one evidence row, one capture.observed event and one delivery before returning a verifiable capability", async () => {
    const authority = createTestCaptureAuthority({ pools: env.pools, merchantId: "SYN-M-A", fixture, key });
    const cap = await authority.issue("SYN-OBS-2");
    expect(verifyMac(cap, key)).toBe(true);
    expect([cap.authority, cap.provenance, cap.captureId, cap.merchantId]).toEqual(["TEST", "SYNTHETIC_FIXTURE", "SYN-CAP-2", "SYN-M-A"]);
    expect(await count("SELECT count(*) AS n FROM ordertruth_guard.capture_evidence WHERE evidence_id = $1 AND capture_id = 'SYN-CAP-2'", [cap.evidenceId])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM ordertruth_guard.outbox WHERE kind = 'capture.observed' AND payload->>'evidenceId' = $1", [cap.evidenceId])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM ordertruth_guard.outbox_deliveries d JOIN ordertruth_guard.outbox o USING (event_id)
      WHERE o.payload->>'evidenceId' = $1 AND d.destination = 'cloud_evidence' AND d.state = 'PENDING'`, [cap.evidenceId])).toBe(1);
  });

  it("issues the same observation twice as one evidence record with an equal evidence ID", async () => {
    const authority = createTestCaptureAuthority({ pools: env.pools, merchantId: "SYN-M-A", fixture, key });
    const [a, b] = [await authority.issue("SYN-OBS-3"), await authority.issue("SYN-OBS-3")];
    expect(a.evidenceId).toBe(b.evidenceId);
    expect(await count("SELECT count(*) AS n FROM ordertruth_guard.capture_evidence WHERE capture_id = 'SYN-CAP-3'")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM ordertruth_guard.outbox WHERE kind = 'capture.observed' AND payload->>'evidenceId' = $1", [a.evidenceId])).toBe(1);
  });

  it("issuance fails closed", async () => {
    await env.db.client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_issuer') THEN CREATE ROLE ot_issuer LOGIN PASSWORD 'ot-issuer-disposable'; END IF; END $$`);
    await env.db.client.query(`GRANT USAGE ON SCHEMA ordertruth_guard TO ot_issuer;
      GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ordertruth_guard TO ot_issuer;
      REVOKE INSERT ON ordertruth_guard.capture_evidence FROM ot_issuer`);
    const as = (c: pg.PoolConfig) => new pg.Pool({ ...c, user: "ot_issuer", password: "ot-issuer-disposable" });
    const pools = { op: as(env.opConfig()), aux: as(env.auxConfig()) };
    try {
      const authority = createTestCaptureAuthority({ pools, merchantId: "SYN-M-A", fixture, key });
      await expect(authority.issue("SYN-OBS-1")).rejects.toThrow(/permission denied/);
      expect(await count("SELECT count(*) AS n FROM ordertruth_guard.capture_evidence WHERE capture_id = 'SYN-CAP-1'")).toBe(0);
      expect(await count("SELECT count(*) AS n FROM ordertruth_guard.outbox WHERE kind = 'capture.observed' AND payload->>'captureId' = 'SYN-CAP-1'")).toBe(0);
    } finally { await pools.op.end(); await pools.aux.end(); }
  });

  it("resolves a lost ISSUANCE acknowledgement as committed and still returns a verifiable capability", async () => {
    env.proxy.arm({ boundary: "ISSUANCE", mode: "drop-commit-ack" });
    const cap = await createTestCaptureAuthority({ pools: env.pools, merchantId: "SYN-M-A", fixture, key }).issue("SYN-OBS-1");
    expect(env.proxy.events().some(e => e.boundary === "ISSUANCE" && e.action === "commit-ack-dropped")).toBe(true);
    expect(verifyMac(cap, key)).toBe(true);
    expect(await count("SELECT count(*) AS n FROM ordertruth_guard.capture_evidence WHERE evidence_id = $1", [cap.evidenceId])).toBe(1);
  });

  it("re-issuing an evidence ID whose stored row differs in any field fails closed", async () => {
    const { observationId: _id, ...o } = fixture.observations.find(x => x.observationId === "SYN-OBS-2")!;
    await issueCapability(env.pools, o, key);
    await expect(issueCapability(env.pools, { ...o, responseHash: "SYN-RESP-OTHER" }, key)).rejects.toThrow(/different data/);
    await expect(issueCapability(env.pools, { ...o, observedAt: "2026-10-30T00:00:01.000Z" }, key)).rejects.toThrow(/different data/);
  });

  it("refuses observations that aren't valid synthetic fixture entries", async () => {
    const authority = createTestCaptureAuthority({ pools: env.pools, merchantId: "SYN-M-A", fixture, key });
    await expect(authority.issue("SYN-OBS-NOPE")).rejects.toThrow(/unknown observation/);
    const forged = { ...fixture, observations: fixture.observations.map(o => ({ ...o, authority: "PAYPAL" as const })) };
    await expect(createTestCaptureAuthority({ pools: env.pools, merchantId: "SYN-M-A", fixture: forged, key }).issue("SYN-OBS-1")).rejects.toThrow(/TEST authority/);
  });
});
