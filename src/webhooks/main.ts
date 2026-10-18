import { ConfigError } from "../config.ts";
import { createRuntime } from "../runtime.ts";
import { assembleWebhookService, startWebhookListener } from "./runtime.ts";

// Stage 1B webhook listener: its own process, 127.0.0.1:WEBHOOK_PORT (default 3002), one route.
// Never the main app port. Not reachable from outside the host unless a tunnel is explicitly opened.
try {
  const rt = createRuntime();
  const svc = await assembleWebhookService(rt);
  const close = async () => {
    await svc.app.close();
    rt.store.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  const s = await startWebhookListener(svc);
  rt.log.info({ evt: "webhook_listening", host: rt.config.webhook.host, port: s.port, abandoned: s.abandoned });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error (keys: ${err.keys.join(", ")}): ${err.message}`);
    process.exit(2);
  }
  throw err;
}
