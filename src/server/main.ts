import { createRuntime } from "../runtime.ts";
import { buildApp } from "./app.ts";
import { ConfigError } from "../config.ts";

try {
  const rt = createRuntime();
  const app = await buildApp({ config: rt.config, checkout: rt.checkout });
  const close = async () => {
    await app.close();
    rt.store.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  await app.listen({ host: "127.0.0.1", port: rt.config.port });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error (keys: ${err.keys.join(", ")}): ${err.message}`);
    process.exit(2);
  }
  throw err;
}
