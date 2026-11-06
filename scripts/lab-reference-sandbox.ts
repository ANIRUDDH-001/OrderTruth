/** Manual owner entry point. No .env load or provider execution happens on import. */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { bootstrapSourceIdentity, openApprovedBootstrap, parseBootstrapCommand } from "../src/merchant/lab-reference-bootstrap.ts";

export async function main(args=process.argv.slice(2)) {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
  const command=parseBootstrapCommand(args);
  if(command.action==="source-identity") { process.stdout.write(`${JSON.stringify(bootstrapSourceIdentity(root),null,2)}\n`);return; }
  const run=await openApprovedBootstrap(root,command);
  if(run.initialized) {process.stdout.write(`${JSON.stringify(run)}\n`);return;}
  const readline=createInterface({input:process.stdin,output:process.stdout});
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{readline.close();await run.close();})();
  const signal=()=>{void close();};
  process.once("SIGINT",signal);process.once("SIGTERM",signal);
  try {
    process.stdout.write("LOCAL_BOOTSTRAP_INVOCATION: loopback webhook ingress ready. This is not a browser return route.\n");
    while(true) {
      const input=await readline.question("G2 owner command (stop to finish): ");
      if(input.trim()==="stop")break;
      try {process.stdout.write(`${JSON.stringify(await run.command(input))}\n`);}catch {process.stderr.write("G2 command refused or failed; inspect sanitized local evidence. No automatic retry.\n");}
    }
  } finally {process.off("SIGINT",signal);process.off("SIGTERM",signal);await close();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(()=>{process.stderr.write("G2 bootstrap refused or failed. No credentials are printed; inspect owner configuration and sanitized evidence.\n");process.exitCode=1;});
}
