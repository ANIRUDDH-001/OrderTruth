'use strict';
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {CASE}=require('./capture-policy.cjs');
const PHASES=['preflight','session-validation','browser-launch','context-create','initial-case-read','current-case-read','case-validation','plan-validation','panel-locate','before-action-hold','control-check','action-click','await-plan','plan-detail','plan-hold','await-approval','await-receipt','receipt-reload','browser-close','video-save','encode','probe','clock-check','full-decode','public-metadata','complete'];
function createDiagnostics(file,stage){
 const state={schemaVersion:1,caseId:CASE,stage:['plan','approve','execute'].includes(stage)?stage:'unknown',phase:'preflight',failedPhase:null,status:'RUNNING',postAdmitted:false,postOperation:null,postOutcome:'NOT_SENT',responseClass:null,privateCleanup:'NOT_REACHED'};
 function snapshot(){return {...state};}
 // Synchronous, fsynced write must succeed BEFORE route.continue can send a POST.
 function persist(){const temporary=file+'.tmp',fd=fs.openSync(temporary,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(snapshot(),null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);}
 persist();
 return {
  phase(value){assert(PHASES.includes(value));state.phase=value;persist();},
  admit(operation){assert(['plan','approve','execute'].includes(operation)&&operation===state.stage&&!state.postAdmitted);state.postAdmitted=true;state.postOperation=operation;state.postOutcome='UNKNOWN';persist();},
  response(status){assert(Number.isInteger(status)&&status>=100&&status<=599);if(!state.postAdmitted)return;state.responseClass=Math.floor(status/100)+'xx';state.postOutcome=status>=200&&status<300?'HTTP_SUCCESS':'HTTP_FAILURE';persist();},
  observed(){assert(state.postAdmitted);state.postOutcome='STATE_OBSERVED';persist();},
  cleanup(ok){state.privateCleanup=ok?'SUCCEEDED':'FAILED';persist();},
  fail(){state.failedPhase??=state.phase;state.status='FAILED';persist();},
  complete(){state.phase='complete';state.status='SUCCEEDED';persist();},
  snapshot
 };
}
module.exports={createDiagnostics,PHASES};
