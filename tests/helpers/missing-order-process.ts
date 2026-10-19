/** Synthetic test child only. Intentionally exits with an open transaction to test WAL recovery. */
import { Store } from "../../src/db/store.ts";
import { InvariantChecker } from "../../src/merchant/checker.ts";
import { REFERENCE_ORG } from "../../src/merchant/repo.ts";
const [path, intentId, mode] = process.argv.slice(2);
if (!path || !intentId) throw Error("synthetic database and intent required");
const s = new Store(path);
if (mode === "crash-before-commit") {
  s.db.function("synthetic_process_exit", () => process.exit(77));
  s.db.exec("CREATE TEMP TRIGGER synthetic_crash BEFORE INSERT ON main.incident_evidence BEGIN SELECT synthetic_process_exit(); END");
}
const result = new InvariantChecker(s, { now: () => Date.parse("2026-10-19T00:05:00.001Z") }).evaluateIntent(REFERENCE_ORG, intentId);
if (mode === "crash-after-commit") process.exit(78);
process.stdout.write(JSON.stringify(result));
s.close();
