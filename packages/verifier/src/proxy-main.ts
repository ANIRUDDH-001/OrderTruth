/**
 * Fault proxy entry point for the verifier's `faultproxy` container (plan Task 10). Data on PROXY_LISTEN_PORT, all interfaces
 * (the candidate's internal network); control only on PROXY_CONTROL_HOST (the container's own loopback in the verifier, reached
 * by the controller through `docker compose exec`), and only with PROXY_CONTROL_TOKEN. The token is never printed.
 */
import { startFaultProxy } from "./proxy.ts";

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`proxy: ${name} is not set`);
  return v;
};
const port = (name: string, fallback: string) => {
  const n = Number(env(name, fallback));
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`proxy: ${name} must be a TCP port`);
  return n;
};

const proxy = await startFaultProxy({
  listenPort: port("PROXY_LISTEN_PORT", "6432"), host: "0.0.0.0",
  target: { host: env("PROXY_TARGET_HOST", "postgres"), port: port("PROXY_TARGET_PORT", "5432") },
  controlPort: port("PROXY_CONTROL_PORT", "7070"), controlHost: env("PROXY_CONTROL_HOST"), controlToken: env("PROXY_CONTROL_TOKEN"),
});
console.log(JSON.stringify({ proxy: "listening", port: proxy.port, controlPort: proxy.controlPort }));
const stop = () => { void proxy.close().then(() => process.exit(0)); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
