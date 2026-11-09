import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const NETWORK_PROOF_HEADER = "x-ordertruth-network-proof";
const mac = (key: string, input: string) => createHmac("sha256", Buffer.from(key,"hex")).update(input).digest("hex");

function network(ip: string): string | null {
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6 || ip.includes("%")) return null;
  const [left,right] = new URL(`http://[${ip}]`).hostname.slice(1,-1).split("::");
  const prefix = left ? left.split(":") : [];
  const suffix = right ? right.split(":") : [];
  const groups = right === undefined ? prefix : [...prefix,...Array<string>(8-prefix.length-suffix.length).fill("0"),...suffix];
  if (groups.slice(0,6).join(":") === "0:0:0:0:0:ffff") {
    const address = Number.parseInt(groups[6]!+groups[7]!.padStart(4,"0"),16);
    return [24,16,8,0].map(shift => (address >>> shift) & 255).join(".");
  }
  return groups.slice(0,4).join(":")+"::/64";
}

/** Only the public ingress can attest a network. The backend receives a keyed
 * group and path-bound proof, never the client address. */
export function attestNetwork(key: string, ip: string, path: string, now = Date.now()): string | null {
  const group = network(ip);
  if (!group) return null;
  const day = new Date(now).toISOString().slice(0,10);
  const opaque = mac(key,`network-v1\n${day}\n${group}`);
  return `${now}.${opaque}.${mac(key,`proof-v1\n${path}\n${now}\n${opaque}`)}`;
}

export function verifyNetwork(key: string, value: unknown, path: string, now = Date.now()): string | null {
  if (typeof value !== "string" || !/^\d{13}\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) return null;
  const [issued,group,signature] = value.split(".") as [string,string,string];
  if (Math.abs(now-Number(issued)) > 30_000 || Math.floor(now/86_400_000) !== Math.floor(Number(issued)/86_400_000)) return null;
  const expected = mac(key,`proof-v1\n${path}\n${issued}\n${group}`);
  return timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(signature,"hex")) ? `${new Date(Number(issued)).toISOString().slice(0,10)}:${group}` : null;
}
