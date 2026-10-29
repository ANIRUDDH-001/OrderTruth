import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve,join } from 'node:path';
import { runAnalysisCli } from '../../../src/ai/reviewer-analysis/cli.ts';
import { CASES } from '../../../src/ai/investigator-eval/fixtures.ts';
import { verifySnapshot } from './snapshot-checkpoint.mjs';
const root=resolve('.'),dest=join(root,'docs/evidence/investigator-eval-stage2');
const live=join(root,'.work/metrics/investigator-eval-live-2026-10-23T08-26-02-339Z');
const log=join(root,'.work/runs/ai-analysis-completion/unblinding-record.json');
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000}).trim();
if(!['--after-verified-commits','--after-verified-snapshot'].includes(process.argv[2]??''))throw new Error('Explicit verified-checkpoint flag required');
if(existsSync(log))throw new Error('Prior unblinding attempt exists; inspect it rather than rerunning silently');
let checkpoint:Record<string,unknown>;
if(process.argv[2]==='--after-verified-snapshot'){
 const verified=verifySnapshot(root,process.argv[3],true);
 checkpoint={protocol:'A4_USER_APPROVED_UNCOMMITTED_SNAPSHOT',snapshotSha256:verified.manifestSha256,snapshotCreatedAt:verified.manifest.createdAt,head:verified.manifest.head,stage2EvidenceCommit:null,adapterCheckpointCommit:null};
}else{
const manifestPath=join(dest,'adapter-pre-unblinding-manifest.json');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
const checkpointCommit=git('log','-1','--format=%H','--','docs/evidence/investigator-eval-stage2/adapter-pre-unblinding-manifest.json');
if(!/^[a-f0-9]{40}$/.test(checkpointCommit)||!git('show',`${checkpointCommit}:docs/evidence/investigator-eval-stage2/adapter-pre-unblinding-manifest.json`))throw new Error('Adapter checkpoint not committed');
git('merge-base','--is-ancestor',manifest.stage2EvidenceCommit,checkpointCommit);
for(const file of manifest.files){
 if(sha(readFileSync(file.path))!==file.sha256 || git('hash-object',file.path)!==git('rev-parse',`${checkpointCommit}:${file.path}`))throw new Error('Adapter bytes differ from committed checkpoint');
}
if(sha(readFileSync(manifestPath))!==sha(Buffer.from(execFileSync('git',['show',`${checkpointCommit}:docs/evidence/investigator-eval-stage2/adapter-pre-unblinding-manifest.json`],{cwd:root,windowsHide:true}))))throw new Error('Checkpoint manifest working bytes differ');
checkpoint={protocol:'A2_COMMITTED_CHECKPOINTS',stage2EvidenceCommit:manifest.stage2EvidenceCommit,adapterCheckpointCommit:checkpointCommit};
}
const inputManifest=JSON.parse(readFileSync(join(dest,'stage2-input-manifest.json'),'utf8'));
for(const [name,record]of Object.entries(inputManifest.files) as Array<[string,{sha256:string}]>)if(sha(readFileSync(join(dest,name)))!==record.sha256)throw new Error('Review input hash differs');
const sealedHashes:Record<string,string>={};
for(const line of readFileSync(join(live,'SEAL-MANIFEST.txt'),'utf8').split(/\r?\n/)){
 const match=/^([a-f0-9]{64}) \*(.+)$/.exec(line);if(!match)continue;
 const hash=sha(readFileSync(join(live,match[2]!)));if(hash!==match[1])throw new Error('Sealed artifact hash differs');sealedHashes[match[2]!]=hash;
}
const opening={openedAt:new Date().toISOString(),...checkpoint,sealedHashes,
  opened:['sealed/arm-key.json','sealed/report.json'],notOpened:'sealed/consensus.csv (hash-only integrity check)',status:'OPENING_STARTED'};
writeFileSync(log,JSON.stringify(opening,null,2),{flag:'wx'});
// First semantic reads of these live artifacts, after verified A2/A4 checkpoint checks.
const keyBytes=readFileSync(join(live,'sealed/arm-key.json')),reportBytes=readFileSync(join(live,'sealed/report.json'));
const report=JSON.parse(reportBytes.toString('utf8'));
writeFileSync(join(dest,'live-arm-key.json'),keyBytes,{flag:'wx'});
writeFileSync(join(dest,'live-automated-report.json'),reportBytes,{flag:'wx'});
const summaries=[];
for(const reviewer of ['codex','claude']){
 const output=join(dest,`${reviewer}-analysis.json`);
 const summary=runAnalysisCli(['--reviewer',reviewer,'--stage1',join(dest,`${reviewer}-stage1.csv`),'--stage2',join(dest,reviewer==='codex'?'codex-stage2-normalized.csv':'claude-stage2.csv'),
  '--key',join(dest,'live-arm-key.json'),'--report',join(dest,'live-automated-report.json'),'--output',output]);
 const analysis=JSON.parse(readFileSync(output,'utf8'));
 const duplicateOutput=join(root,`.work/runs/ai-analysis-completion/${reviewer}-analysis-reproduction.json`);
 const reproduced=runAnalysisCli(['--reviewer',reviewer,'--stage1',join(dest,`${reviewer}-stage1.csv`),'--stage2',join(dest,reviewer==='codex'?'codex-stage2-normalized.csv':'claude-stage2.csv'),
  '--key',join(dest,'live-arm-key.json'),'--report',join(dest,'live-automated-report.json'),'--output',duplicateOutput]);
 if(reproduced.outputSha256!==summary.outputSha256)throw new Error('Analytical result is not reproducible');
 for(const control of ['C','A']){
  const result={reviewer,control,qualification:analysis.qualification,limitations:analysis.limitations,sourceHashes:analysis.sourceHashes,decision:analysis.decisions[`versus${control}`]};
  writeFileSync(join(dest,`${reviewer}-versus-${control}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 }
 const descriptive=[];
 for(const stratum of ['R','S','V','X'])for(const arm of ['A','B','C']){
  const rows=analysis.audit.filter((r:any)=>r.arm===arm&&CASES.find(c=>c.id===r.caseId)?.stratum===stratum);
  const dist=(field:string,stage:1|2)=>rows.reduce((out:Record<string,number>,r:any)=>{
    const value=(stage===1?r.rawStage1:r.rawStage2)?.[field]??'MISSING';out[value]=(out[value]??0)+1;return out;},{});
  const assessed=rows.filter((r:any)=>r.status==='OK'&&typeof r.record.P3case==='boolean');
  descriptive.push({stratum,arm,cases:rows.length,J1:dist('J1_conclusion',1),J2:dist('J2_uncertainty',1),H:dist('H_usefulness',1),P1k:dist('P1k_topk',2),P4:dist('P4_uncertainty_handling',2),
    P3:{observedFlaggedCases:rows.filter((r:any)=>r.record.P3case===true).length,unresolvedCases:rows.filter((r:any)=>r.record.P3case==='UNRESOLVED').map((r:any)=>r.caseId),
      unassessableCases:rows.filter((r:any)=>r.record.P3case==='UNASSESSABLE').map((r:any)=>r.caseId),
      hypothesisFlags:assessed.reduce((n:number,r:any)=>n+r.flaggedStatements.filter((s:string)=>/^h\d$/.test(s)).length,0),
      assessedHypotheses:assessed.reduce((n:number,r:any)=>n+r.hypothesisCount,0),summaryFlags:assessed.filter((r:any)=>r.flaggedStatements.includes('summary')).length,
      reasonFlags:assessed.filter((r:any)=>r.flaggedStatements.includes('reason')).length}});
 }
 writeFileSync(join(dest,`${reviewer}-descriptive.json`),JSON.stringify({reviewer,qualification:analysis.qualification,limitations:analysis.limitations,byStratum:descriptive,transitions:analysis.transitions},null,2)+'\n',{flag:'wx'});
 summaries.push({reviewer,analysisSha256:summary.outputSha256,reproductionMatched:true,versusC:analysis.decisions.versusC,versusA:analysis.decisions.versusA});
}
const complete={...opening,status:'COMPLETE',completedAt:new Date().toISOString(),summaries};
writeFileSync(log,JSON.stringify(complete,null,2));
writeFileSync(join(dest,'unblinding-audit.json'),JSON.stringify(complete,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summaries.map(s=>({reviewer:s.reviewer,reproduced:s.reproductionMatched,versusC:s.versusC,versusA:s.versusA})),null,2));
