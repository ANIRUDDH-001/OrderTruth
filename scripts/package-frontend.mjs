import { cpSync,existsSync } from "node:fs";
// Copy only built public assets. Never copy the repository or private env files.
if (!existsSync("dist/judge/index.html") || !existsSync("dist/owner/index.html")) throw new Error("Build both public frontends first");
cpSync("dist/owner","dist/judge/owner",{ recursive: true });
