import { readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve,join,dirname,sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
const relative='docs/evidence/investigator-eval-stage2/pre-unblinding-snapshot';
const within=(base,path)=>{const p=resolve(base,path);if(!p.startsWith(resolve(base)+sep))throw new Error('Snapshot path escapes its root');return p;};
export function verifySnapshot(root,expectedHash,checkSources=true){
 const base=join(root,relative),bytes=readFileSync(join(base,'manifest.json'));
 if(!/^[a-f0-9]{64}$/.test(expectedHash)||sha(bytes)!==expectedHash)throw new Error('Published checkpoint hash differs');
 const manifest=JSON.parse(bytes.toString('utf8'));
 if(manifest.protocol!=='A4_USER_APPROVED_UNCOMMITTED_SNAPSHOT')throw new Error('Wrong checkpoint protocol');
 for(const f of manifest.files){
  const copy=readFileSync(within(base,f.copy));if(copy.length!==f.bytes||sha(copy)!==f.sha256)throw new Error('Snapshot copy differs: '+f.source);
  if(checkSources&&f.verifySourceBeforeUnblinding&&sha(readFileSync(within(root,f.source)))!==f.sha256)throw new Error('Working source differs: '+f.source);
 }
 return {manifest,manifestSha256:expectedHash};
}
export function captureSnapshot(root){
 const base=join(root,relative);if(existsSync(base))throw new Error('Snapshot already exists; do not overwrite');
 const bundle='docs/evidence/investigator-eval-stage2';
 const files=[
 '.gitattributes','package.json','pnpm-lock.yaml','tsconfig.json','vitest.config.ts',
 'docs/INVESTIGATOR_EVAL_PREREGISTRATION.md','docs/evidence/investigator-eval-stage1-log.md',
 'src/ai/reviewer-analysis/adapter.ts','src/ai/reviewer-analysis/cli.ts','src/ai/reviewer-analysis/normalize-csv.ts','tests/reviewer-analysis.test.ts',
 'src/ai/investigation.ts',...['fixtures','control','score','guard','runner','blind','decision'].map(n=>`src/ai/investigator-eval/${n}.ts`),
 ...readdirSync(join(root,bundle),{withFileTypes:true}).filter(f=>f.isFile()).map(f=>`${bundle}/${f.name}`),
 '.work/metrics/investigator-eval-prereg-e72556e.json',
 '.work/metrics/investigator-eval-live-2026-10-23T08-26-02-339Z/SEAL-MANIFEST.txt',
 ...['full-offline-03.log','adapter-tests-06.log','adapter-tests-A4.log','independent-adapter-review.md','A4-snapshot-review.md','freeze-identity-check.json','claude-stage2-execution.json','claude-stage2-audit.json','claude-stage2-validation.json','codex-stage2-execution.json','codex-stage2-preflight.json','codex-stage2-validation.json','snapshot-checkpoint.mjs','test-snapshot.mjs','unblind-and-analyze.ts'].map(n=>`.work/runs/ai-analysis-completion/${n}`),
 ];
 const entries=files.map(source=>{
  if(source.endsWith('/sealed/report.json')||source.endsWith('/sealed/arm-key.json')||source.includes('consensus.csv'))throw new Error('Withheld semantic artifact cannot enter this snapshot');
  const bytes=readFileSync(within(root,source));
  const copy='files/'+source.replace(/^\.work\//,'local-records/');const dest=within(base,copy);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,bytes,{flag:'wx'});
  return {source,copy,bytes:bytes.length,sha256:sha(bytes),verifySourceBeforeUnblinding:source!=='docs/evidence/investigator-eval-stage1-log.md'};
 });
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000}).trim();
 const manifest={protocol:'A4_USER_APPROVED_UNCOMMITTED_SNAPSHOT',createdAt:new Date().toISOString(),head:git('rev-parse','HEAD'),workingStatus:git('status','--short'),
  authorization:'User explicitly approved A4 and continuation without commits before unblinding.',files:entries,
  validation:{focused:'35/35; adapter-tests-06.log',offline:'700/700 across32files; full-offline-03.log',typecheck:'exit0 recorded by coordinator',runtime:'Node24.11.0; declared22 not requalified here'},
  limitations:['Uncommitted checkpoint replaces A2 commit sequence by explicit A4.','Hash identity is not externally attested time, adversarial immutability or proof of no prior reads.'],
 };
 const bytes=JSON.stringify(manifest,null,2)+'\n';writeFileSync(join(base,'manifest.json'),bytes,{flag:'wx'});
 const hash=sha(bytes);verifySnapshot(root,hash);return {manifestSha256:hash,fileCount:entries.length,createdAt:manifest.createdAt,path:relative+'/manifest.json'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv[2]==='capture')console.log(JSON.stringify(captureSnapshot(resolve('.'))));
 else if(process.argv[2]==='verify'){const checked=verifySnapshot(resolve('.'),process.argv[3]);console.log(JSON.stringify({verified:true,manifestSha256:checked.manifestSha256,fileCount:checked.manifest.files.length}));}
 else throw new Error('Use capture or verify <published-hash>');
}
