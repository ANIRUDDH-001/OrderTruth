import { defineConfig } from "vitest/config";

// v3 Gate A database tests. Explicit opt-in, kept apart from the v2 suite (vitest.postgres.config.ts) and from CI.
// Requires V3_PG_URL pointing at a disposable PostgreSQL 18 (the compose service in `pnpm v3:qualify`).
export default defineConfig({ test: {
  include: ["tests/v3-postgres/**/*.integration.ts"],
  environment: "node", testTimeout: 30_000, hookTimeout: 30_000,
} });
