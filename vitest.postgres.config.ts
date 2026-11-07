import { defineConfig } from "vitest/config";

// Explicit opt-in: the ordinary offline suite never opens a database socket.
export default defineConfig({ test: {
  include: ["tests/postgres/**/*.integration.ts"],
  // Better Auth introspects PostgreSQL catalogs during cold initialization.
  // Concurrent unrelated DROP SCHEMA teardown can invalidate serial-sequence
  // lookups (42P01). Serialize file-owned DDL; within-test races stay explicit.
  fileParallelism: false,
  environment: "node", testTimeout: 15_000, hookTimeout: 15_000,
} });
