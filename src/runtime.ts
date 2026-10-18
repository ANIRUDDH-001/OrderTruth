import { resolve } from "node:path";
import { loadConfigFromDotEnv, type AppConfig } from "./config.ts";
import { CheckoutService, type Logger } from "./checkout-service.ts";
import { Store } from "./db/store.ts";
import { PayPalClient } from "./paypal/client.ts";
import { redactValue } from "./redact.ts";

/** Wire real dependencies from `.env`. Used by the server and CLI, never by unit tests. */
export function createRuntime(log?: Logger): { config: AppConfig; store: Store; paypal: PayPalClient; checkout: CheckoutService } {
  const config = loadConfigFromDotEnv();
  const store = new Store(resolve(config.databasePath));
  const paypal = new PayPalClient(config.paypal);
  const logger: Logger =
    log ??
    (() => {
      const w = (lvl: string) => (obj: object, msg?: string) =>
        console.error(JSON.stringify({ lvl, t: new Date().toISOString(), msg, ...(redactValue(obj, config.secrets) as object) }));
      return { info: w("info"), warn: w("warn"), error: w("error") };
    })();
  const checkout = new CheckoutService(paypal, store, logger, { evidenceDir: resolve(".work/runs/gate0"), secrets: config.secrets });
  return { config, store, paypal, checkout };
}
