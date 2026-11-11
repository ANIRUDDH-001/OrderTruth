'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const stages = {validate:'NONE',plan:'PREPARE_FRESH_PLAN',approve:'APPROVE_EXACT_PLAN',execute:'EXECUTE_EXACT_PLAN','assemble-review':'ASSEMBLE_REVIEW','assemble-final':'ASSEMBLE_FINAL'};
function validate(config,event,env,parent,changed) {
  assert.deepEqual(Object.keys(config).sort(), ['authorization','expectedBefore','manifest','reviewedPlanId','reviewedPlanSha256','stage','version'].sort());
  assert.equal(config.version,1);
  assert(Object.hasOwn(stages,config.stage));
  assert.equal(config.authorization,stages[config.stage]);
  assert.equal(env.GITHUB_EVENT_NAME,'push');
  assert.equal(env.GITHUB_REF,'refs/heads/video/cloud-render');
  assert.equal(env.GITHUB_RUN_ATTEMPT,'1');
  assert.equal(event.repository.full_name,'ANIRUDDH-001/OrderTruth');
  assert.equal(event.repository.private,false);
  assert.equal(event.deleted,false);
  assert.equal(event.forced,false);
  assert.match(config.expectedBefore,/^[a-f0-9]{40}$/);
  assert.equal(event.before,config.expectedBefore);
  assert.equal(parent,config.expectedBefore,'Only one reviewed commit per push; no replay');
  assert.equal(event.after,env.GITHUB_SHA);
  assert.match(event.head_commit.message,/\[skip render\]/);
  assert(changed.length && changed.every(p=>p==='.github/workflows/video-render.yml'||p.startsWith('video/render-test/')),'Publication exceeds video scope');
  assert.equal(config.manifest,'production/scene-sources.'+(config.stage==='assemble-final'?'final':'review')+'.json');
  if(['approve','execute'].includes(config.stage)) {
    assert.match(config.reviewedPlanId,/^rp_[a-f0-9-]{36}$/);
    assert.match(config.reviewedPlanSha256,/^[a-f0-9]{64}$/);
  } else { assert.equal(config.reviewedPlanId,''); assert.equal(config.reviewedPlanSha256,''); }
  return config;
}
if(require.main===module) {
  try {
    const config=JSON.parse(fs.readFileSync('production/cloud-stage.json','utf8'));
    const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
    const parent=execFileSync('git',['rev-parse','HEAD^'],{encoding:'utf8'}).trim();
    const changed=execFileSync('git',['diff','--name-only',parent,'HEAD'],{encoding:'utf8'}).trim().split(/\r?\n/);
    validate(config,event,process.env,parent,changed);
    const rules=JSON.parse(fs.readFileSync('../../vercel.json','utf8')).git.deploymentEnabled;
    assert.equal(rules['video/cloud-render'],false);
    assert(Object.values(rules).every(v=>v===false));
    fs.appendFileSync(process.env.GITHUB_ENV,`CLOUD_STAGE=${config.stage}\nCAPTURE_STAGE=${config.stage}\nOWNER_AUTHORIZATION=${config.authorization}\nREVIEWED_PLAN_ID=${config.reviewedPlanId}\nREVIEWED_PLAN_SHA256=${config.reviewedPlanSha256}\nASSEMBLY_MANIFEST=${config.manifest}\n`);
    console.log('PASS: bounded video-only branch push; first attempt; exact predecessor and stage.');
  } catch { console.error('Stage guard rejected configuration or publication scope.');process.exitCode=1; }
}
module.exports={validate};
