// Stage 1C read-only incident API: its own process, 127.0.0.1 only (default port 3003).
// Serves an ISOLATED demo/test copy. It refuses the live database, because opening it through
// Store would migrate it. The x-ordertruth-org header is a dev-only scope, NOT authentication.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "../db/store.ts";
import { buildIncidentApi } from "./api.ts";

const { values: a } = parseArgs({ options: { db: { type: "string" }, port: { type: "string", default: "3003" } } });
const fail = (m: string): never => {
  console.error(`incident api refused: ${m}`);
  process.exit(2);
};
if (!a.db) fail("--db <isolated copy, e.g. .work/stage1c/fault.sqlite> is required");
const db = resolve(a.db!);
if (db === resolve(".work/ordertruth.sqlite")) fail("refusing the live database; run `pnpm stage1c` and serve a copy");
if (!existsSync(db)) fail("database not found");
const port = Number(a.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("invalid --port");

const store = new Store(db);
const app = await buildIncidentApi({ store, logger: true });
const stop = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await app.listen({ host: "127.0.0.1", port });
