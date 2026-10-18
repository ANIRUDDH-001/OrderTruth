import { defineConfig } from "vite";

// Temporary Gate 0 Sandbox checkout page only. Built to dist/web and served by Fastify.
export default defineConfig({
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true },
});
