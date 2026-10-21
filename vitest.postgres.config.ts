import { defineConfig } from "vitest/config";

// Explicit opt-in: the ordinary offline suite never opens a database socket.
export default defineConfig({ test: {
  include: ["tests/postgres/**/*.integration.ts"],
  environment: "node", testTimeout: 15_000, hookTimeout: 15_000,
} });
