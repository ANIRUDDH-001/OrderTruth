/** Offline only. Explicit input paths, no implicit live-artifact discovery.
 * Invoke only after A2's committed sheet/adapter gates are satisfied. */
import { createHash } from "node:crypto";
import { readFileSync,writeFileSync,existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeReviewer } from "./adapter.ts";

export function runAnalysisCli(args: string[]) {
  const names = ["--reviewer","--stage1","--stage2","--key","--report","--output"];
  const values = new Map<string,string>();
  for (let i=0;i<args.length;i+=2) {
    if (!names.includes(args[i]!) || !args[i+1] || args[i+1]!.startsWith("--") || values.has(args[i]!)) throw new Error("Provide each named input and output exactly once");
    values.set(args[i]!,args[i+1]!);
  }
  if (values.size !== names.length) throw new Error("Missing reviewer-analysis arguments");
  const output=resolve(values.get("--output")!);
  const files=Object.fromEntries(["stage1","stage2","key","report"].map(name=>[name,resolve(values.get(`--${name}`)!)]));
  if (existsSync(output) || Object.values(files).includes(output)) throw new Error("Refusing to overwrite an input or existing analysis");
  const inputs=Object.fromEntries(Object.entries(files).map(([name,path])=>[name,readFileSync(path)]));
  const result=analyzeReviewer({reviewer:values.get("--reviewer")!,stage1Csv:inputs.stage1!.toString("utf8"),stage2Csv:inputs.stage2!.toString("utf8"),
    armKey:JSON.parse(inputs.key!.toString("utf8")),report:JSON.parse(inputs.report!.toString("utf8"))});
  const sourceHashes=Object.fromEntries(Object.entries(inputs).map(([name,bytes])=>[name,createHash("sha256").update(bytes).digest("hex")]));
  const bytes=JSON.stringify({sourceHashes,...result},null,2)+"\n";
  writeFileSync(output,bytes,{flag:"wx"});
  return {reviewer:result.reviewer,records:result.records.length,outputSha256:createHash("sha256").update(bytes).digest("hex")};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runAnalysisCli(process.argv.slice(2)))); }
  catch { console.error("Reviewer analysis refused invalid inputs; no provider calls or automatic retries");process.exitCode=1; }
}
