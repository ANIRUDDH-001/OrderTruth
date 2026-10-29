import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests must never reach a real network; each test injects a fake fetch.
    testTimeout: 15000,
  },
});
