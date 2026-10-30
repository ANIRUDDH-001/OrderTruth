import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
export async function checkPackagedLab(root: string): Promise<{ routes: string[]; assets: string[] }> {
  const app = Fastify();
  await app.register(staticFiles, { root: resolve(root), prefix: "/" });
  const routes = ["/", "/lab/", "/lab/index.html", "/owner/"], assets = new Set<string>();
  try {
    for (const route of routes) {
      const response = await app.inject({ method: "GET", url: route });
      if (response.statusCode !== 200 || !String(response.headers["content-type"]).includes("text/html")) throw new Error(`packaged route failed: ${route}`);
      for (const match of response.body.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)) {
        const asset = new URL(match[1]!, "http://packaged.invalid" + route);
        if (asset.origin !== "http://packaged.invalid") throw new Error("external packaged asset is not locally verified");
        assets.add(asset.pathname);
      }
    }
    for (const asset of assets) {
      const response = await app.inject({ method: "GET", url: asset });
      if (response.statusCode !== 200 || String(response.headers["content-type"]).includes("text/html")) throw new Error(`packaged asset failed: ${asset}`);
    }
    return { routes, assets: [...assets].sort() };
  } finally { await app.close(); }
}
