import {createHash} from "node:crypto";
import {lstatSync,readdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";

/** Public build provenance. Hash only generated serving files, never environment or source files. */
export function writeReleaseManifest(root:string,sourceSha:string|null,target:string,now=new Date()) {
 if(!sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Release requires a full source SHA");
 if(!["production","local","ci"].includes(target)) throw new Error("Invalid build target");
 for(const path of ["index.html","lab/index.html","owner/index.html"]) if(!lstatSync(join(root,path)).isFile()) throw new Error("Missing public entry point");
 const html=readFileSync(join(root,"index.html"),"utf8");
 const judge=html.match(/src=["'](\/assets\/judge-[\w-]+\.js)["']/)?.[1];
 if(!judge) throw new Error("Missing generated judge entry");
 const code=readFileSync(join(root,judge.slice(1)),"utf8");
 const embedded=new Set([...code.matchAll(/["'`]([a-f0-9]{40})["'`]/g)].map(m=>m[1]));
 if(embedded.size!==1 || !embedded.has(sourceSha)) throw new Error("Generated judge source differs from release");
 const assets:Array<{path:string;bytes:number;sha256:string}>=[];
 function walk(path="") {for(const entry of readdirSync(join(root,path)).sort()){
  if(!path && entry==="release.json")continue;
  const relative=path?`${path}/${entry}`:entry; const full=join(root,relative);const stat=lstatSync(full);
  if(stat.isSymbolicLink())throw new Error("Release assets cannot be symbolic links");
  if(stat.isDirectory())walk(relative);
  else if(stat.isFile()){const bytes=readFileSync(full);assets.push({path:`/${relative}`,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});}
 }}
 walk();
 const manifest={sourceSha,builtAt:now.toISOString(),target,backendContract:"phase1-core-v1",judgeEntry:judge,assets};
 writeFileSync(join(root,"release.json"),JSON.stringify(manifest,null,2)+"\n");return manifest;
}
