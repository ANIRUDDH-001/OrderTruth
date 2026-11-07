import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { labPlugin,readBuildIdentity } from "./scripts/lab-build.ts";
import { frontendSource } from "./scripts/frontend-source.ts";
const root = fileURLToPath(new URL("./", import.meta.url));
export default defineConfig({ root: "web/judge", base: "/", envDir: false,
  define:{__ORDERTRUTH_SOURCE__:JSON.stringify(frontendSource(process.env,readBuildIdentity(root).commit))},
  plugins: [labPlugin({ projectRoot: root, publicationRoot: resolve(root, "docs/evidence/lab") })],
  build: { outDir: "../../dist/judge", emptyOutDir: true, rollupOptions: { input: { judge: resolve(root, "web/judge/index.html"), lab: resolve(root, "web/judge/lab/index.html") } } } });
