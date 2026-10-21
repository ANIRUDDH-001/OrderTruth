import { buildHostedApp } from "./hosted-app.ts";
import { appEnvironment } from "./hosted-environment.ts";
import { loadPostgresConfig } from "../config.ts";
try {
  const local = process.argv.includes("--local");
  const { env } = appEnvironment(local); const config = loadPostgresConfig(env);
  const app = await buildHostedApp(config,{ staticFiles: local || env.SERVE_FRONTEND !== "false" });
  const close = async () => { await app.close(); process.exit(0); };
  process.once("SIGINT",close); process.once("SIGTERM",close);
  await app.listen({ host: local ? "127.0.0.1" : "0.0.0.0",port: config.port });
  console.log(`OrderTruth listening at ${config.origin}; PayPal Sandbox only. No model or payment call occurs on startup.`);
} catch (error) {
  console.error(error instanceof Error ? `Application startup failed (${error.name}); inspect private configuration without printing credentials.` : "Application startup failed");
  process.exitCode = 1;
}
