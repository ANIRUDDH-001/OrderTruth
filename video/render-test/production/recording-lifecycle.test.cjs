'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {finalizeRecording}=require('./resume-existing-case.cjs');
function setup(options={}){
 const calls=[];let open=true,contextClosed=false,phase='capture',failedPhase=null;
 const diag={phase(x){phase=x;},fail(){failedPhase??=phase;}};
 const context={async close(){calls.push('context.close');if(options.contextError)throw Error('CONTEXT_FAILED');contextClosed=true;}};
 const browser={async close(){calls.push('browser.close');open=false;if(options.browserError)throw Error('BROWSER_FAILED');}};
 const video={async saveAs(file){calls.push('video.saveAs');assert(contextClosed,'Video must be finalized');assert(open,'Artifact transport must remain open');assert.equal(file,'synthetic.webm');if(options.saveError)throw Error('SAVE_FAILED');}};
 return {calls,diag,args:{context,browser,video,rawPath:'synthetic.webm',shouldSave:true},failed:()=>failedPhase};
}
test('finalized video is saved with transport alive before browser shutdown',async()=>{const x=setup();await finalizeRecording(x.args,x.diag);assert.deepEqual(x.calls,['context.close','video.saveAs','browser.close']);});
test('video-save failure closes browser and preserves failing phase',async()=>{const x=setup({saveError:true});await assert.rejects(finalizeRecording(x.args,x.diag),/SAVE_FAILED/);assert.deepEqual(x.calls,['context.close','video.saveAs','browser.close']);assert.equal(x.failed(),'video-save');});
test('context-close failure prevents saving and still closes browser',async()=>{const x=setup({contextError:true});await assert.rejects(finalizeRecording(x.args,x.diag),/CONTEXT_FAILED/);assert.deepEqual(x.calls,['context.close','browser.close']);});
test('earlier capture failure closes resources without trying to save',async()=>{const x=setup();x.args.shouldSave=false;await finalizeRecording(x.args,x.diag);assert.deepEqual(x.calls,['context.close','browser.close']);});
test('browser-close failure propagates after save and prevents encoding continuation',async()=>{const x=setup({browserError:true});let encodeStarted=false;await assert.rejects(async()=>{await finalizeRecording(x.args,x.diag);encodeStarted=true;},/BROWSER_FAILED/);assert.equal(encodeStarted,false);assert.equal(x.failed(),'browser-close');});
test('missing video fails closed and still closes browser',async()=>{const x=setup();x.args.video=null;await assert.rejects(finalizeRecording(x.args,x.diag),/Recorded video missing/);assert.deepEqual(x.calls,['context.close','browser.close']);});
