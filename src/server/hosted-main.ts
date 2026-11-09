import { buildHostedApp } from "./hosted-app.ts";
import { appEnvironment } from "./hosted-environment.ts";
import { loadPostgresConfig } from "../config.ts";
import { maintenanceState } from "./release-barrier.ts";
import { buildMaintenanceApp } from "./maintenance-app.ts";
try {
  const local = process.argv.includes("--local");
  const { env } = appEnvironment(local); const config = loadPostgresConfig(env);
  const maintenance=maintenanceState(env);
  if(!local && env.ORDERTRUTH_BARRIER_FILE) throw new Error("Hosted maintenance must use persistent release mode, not an ephemeral file");
  if(env.ORDERTRUTH_MIGRATION && env.ORDERTRUTH_MIGRATION!=="apply-v9") throw new Error("Invalid migration authorization mode");
  const started=performance.now();
  const sourceSha=env.RENDER_GIT_COMMIT;
  if(!local && (!sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha))) throw new Error("Hosted release requires Render source identity");
  const app = env.ORDERTRUTH_RELEASE_MODE === "maintenance"
    ? await buildMaintenanceApp(config.databaseUrl)
    : await buildHostedApp(config,{ staticFiles: local || env.SERVE_FRONTEND !== "false",maintenance,...(sourceSha ? {sourceSha} : {}),
      migration: local || env.ORDERTRUTH_MIGRATION==="apply-v9" ? "apply" : "check" });
  console.log(JSON.stringify({evt:"startup_database_ready",elapsedMs:Math.round(performance.now()-started),maintenance:maintenance()}));
  const close = async () => { await app.close(); process.exit(0); };
  process.once("SIGINT",close); process.once("SIGTERM",close);
  await app.listen({ host: local ? "127.0.0.1" : "0.0.0.0",port: config.port });
  console.log(`OrderTruth listening at ${config.origin}; Sandbox only. Due verified webhook readbacks may resume; no new payment or model request is started.`);
} catch (error) {
  console.error(error instanceof Error ? `Application startup failed (${error.name}); inspect private configuration without printing credentials.` : "Application startup failed");
  process.exitCode = 1;
}
