/**
 * Test-only capture authority (spec §6.1, §6.2). Issues TEST-authority capabilities from the committed SYNTHETIC_FIXTURE
 * through the same issuance code as production. The production entry point (../index.ts) never imports this module.
 */
import type { GuardPools, RunHooks } from "../commit.ts";
import { issueCapability, type CaptureCapability, type Observation } from "../capability.ts";

export type SyntheticFixture = { provenance: "SYNTHETIC_FIXTURE"; merchants: string[]; observations: Array<Observation & { observationId: string }> };

export function createTestCaptureAuthority(a: { pools: GuardPools; merchantId: string; fixture: SyntheticFixture; key: Buffer; buildId?: string; hooks?: RunHooks }):
  { issue(observationId: string): Promise<CaptureCapability> } {
  return {
    async issue(observationId: string) {
      if (a.fixture.provenance !== "SYNTHETIC_FIXTURE") throw new Error("test authority: fixture is not SYNTHETIC_FIXTURE");
      const found = a.fixture.observations.find(o => o.observationId === observationId);
      if (!found) throw new Error(`test authority: unknown observation ${observationId}`);
      if (found.authority !== "TEST" || found.provenance !== "SYNTHETIC_FIXTURE") throw new Error("test authority: only TEST authority, SYNTHETIC_FIXTURE observations");
      const { observationId: _id, ...observation } = found;
      return issueCapability(a.pools, { ...observation, merchantId: a.merchantId }, a.key,
        { ...(a.buildId ? { buildId: a.buildId } : {}), ...(a.hooks ? { hooks: a.hooks } : {}) });
    },
  };
}
