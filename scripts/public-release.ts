import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {z} from "zod";
const manifestSchema=z.object({sourceSha:z.string().regex(/^[a-f0-9]{40}$/),builtAt:z.string().datetime(),target:z.literal("production"),backendContract:z.literal("phase1-core-v1"),judgeEntry:z.string(),assets:z.array(z.object({path:z.string().regex(/^\/(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+$/),bytes:z.number().int().nonnegative().max(2_000_000),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).min(1).max(256)});
/** Read-only serving-byte verification: no auth, bypass credentials, or application writes. */
export async function verifyPublicRelease(origin:string,expectedSha:string,fetcher:typeof fetch=fetch){
 const url=new URL(origin);if(url.protocol!=="https:"||url.origin!==origin||url.username||url.password)throw new Error("Public HTTPS origin required");
 const read=async(path:string)=>{const r=await fetcher(new URL(path,origin),{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(30_000)});if(!r.ok)throw new Error(`Public asset HTTP ${r.status}`);const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>2_000_000)throw new Error("Asset size limit");return bytes;};
 const manifestBytes=await read('/release.json?verify='+Date.now());
 const manifest=manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
 if(manifest.sourceSha!==expectedSha)throw new Error("Public frontend source mismatch");
 if(!/^\/assets\/judge-[\w-]+\.js$/.test(manifest.judgeEntry)||manifest.assets.some(a=>a.path.startsWith('/api/'))||['/index.html','/lab/index.html','/owner/index.html',manifest.judgeEntry].some(path=>!manifest.assets.some(a=>a.path===path)))throw new Error("Incomplete or unsafe public asset inventory");
 if(new Set(manifest.assets.map(a=>a.path)).size!==manifest.assets.length||manifest.assets.reduce((n,a)=>n+a.bytes,0)>10_000_000)throw new Error("Invalid public asset inventory");
 let judge:Buffer|undefined,index:Buffer|undefined;let cursor=0;
 await Promise.all(Array.from({length:4},async()=>{while(cursor<manifest.assets.length){const asset=manifest.assets[cursor++]!;const bytes=await read(asset.path);if(bytes.length!==asset.bytes||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error(`Public asset integrity mismatch: ${asset.path}`);if(asset.path===manifest.judgeEntry)judge=bytes;if(asset.path==='/index.html')index=bytes;}}));
 if(!index?.toString('utf8').includes(`src="${manifest.judgeEntry}"`)&&!index?.toString('utf8').includes(`src='${manifest.judgeEntry}'`))throw new Error("Public entry does not load the verified judge bundle");
 const identities=new Set([...(judge?.toString('utf8')??'').matchAll(/["'`]([a-f0-9]{40})["'`]/g)].map(m=>m[1]));
 if(identities.size!==1||!identities.has(expectedSha))throw new Error("Compiled frontend identity mismatch");
 return {sourceSha:expectedSha,backendContract:manifest.backendContract,builtAt:manifest.builtAt,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex'),assetsVerified:manifest.assets.length,judgeEntry:manifest.judgeEntry,verifiedAt:new Date().toISOString()};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const [origin,sha]=process.argv.slice(2);if(!origin||!sha)throw new Error("Usage: public-release.ts https://public-origin fullSHA");
 console.log(JSON.stringify(await verifyPublicRelease(origin,sha)));
}
