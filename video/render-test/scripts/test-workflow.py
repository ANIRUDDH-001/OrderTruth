"""Offline structural checks: never talks to GitHub or starts tools/browsers."""
from pathlib import Path
import re
import yaml

root=Path(__file__).resolve().parents[3]
workflow=root/'.github/workflows/video-render.yml'
doc=yaml.safe_load(workflow.read_text(encoding='utf-8-sig'))
trigger=doc.get('on',doc.get(True))  # PyYAML YAML 1.1 treats 'on' as boolean.
assert set(trigger)=={'push'}
assert trigger['push']['branches']==['video/cloud-render']
assert 'vercel.json' not in trigger['push']['paths']
assert doc['permissions']=={'contents':'read'}
job=doc['jobs']['continuation']
assert job['environment']=='ordertruth-video'
assert 'github.run_attempt == 1' in job['if']
assert 'run_number' not in workflow.read_text(encoding='utf-8-sig')
steps=job['steps']
checkout_index=next(i for i,s in enumerate(steps) if s.get('uses','').startswith('actions/checkout@'))
byte_step=steps[0]
assert checkout_index==1, 'Byte-preserving configuration must precede checkout'
assert byte_step['name']=='Preserve committed bytes before checkout'
assert byte_step['working-directory']=='${{ runner.temp }}', 'Video folder does not exist before checkout'
assert 'git config --global core.autocrlf false' in byte_step['run']
assert 'git config --global core.eol lf' in byte_step['run']
assert byte_step['run'].count('if ($LASTEXITCODE -ne 0)')==2
for step in steps:
    if 'uses' in step: assert re.fullmatch(r'actions/[a-z-]+@[0-9a-f]{40}',step['uses'])
    if 'upload-artifact' in step.get('uses',''):
        paths=step['with']['path'].splitlines()
        assert all('*' not in p and 'private' not in p and not p.endswith('.webm') for p in paths)
        if step['name']=='Preserve fixed sanitized capture failure report':
            assert step['if']=="failure() && (env.CLOUD_STAGE == 'plan' || env.CLOUD_STAGE == 'approve' || env.CLOUD_STAGE == 'execute')"
            assert paths==['${{ runner.temp }}/ordertruth-continuation/public/failure-report.json']
        elif step['name']=='Preserve sanitized smoke failure QC':
            assert step['if']=="failure() && env.CLOUD_STAGE == 'recording-smoke'"
            assert paths==['${{ runner.temp }}/ordertruth-recording-smoke/public/qc.json']
        else:assert step['if'].startswith('success()')
secret_steps=[s for s in steps if 'secrets.' in str(s)]
assert len(secret_steps)==1
assert secret_steps[0]['name']=='Capture exactly one authorized existing-case stage'
assert secret_steps[0]['if']=="env.CLOUD_STAGE == 'plan' || env.CLOUD_STAGE == 'approve' || env.CLOUD_STAGE == 'execute'"
by_name={s.get('name'):s for s in steps}
smoke=by_name['Record local HTML lifecycle smoke test']
assert smoke['if']=="env.CLOUD_STAGE == 'recording-smoke'" and 'env' not in smoke
assert smoke['run'].count('node production/recording-smoke.cjs')==1
assert by_name['Browser-free policy and manifest checks']['if']=="env.CLOUD_STAGE != 'recording-smoke'"
assert by_name['Assemble reviewed manifest sequentially']['if']=="env.CLOUD_STAGE == 'assemble-review' || env.CLOUD_STAGE == 'assemble-final'"
assert by_name['Upload verified recording smoke only']['with']['path'].splitlines()==['${{ runner.temp }}/ordertruth-recording-smoke/public/recording-smoke.mp4','${{ runner.temp }}/ordertruth-recording-smoke/public/qc.json']
cleanup=steps[-1]
assert cleanup['if']=='always()'
assert 'ordertruth-session-private' in cleanup['run']
assert 'ordertruth-recording-smoke' in cleanup['run']
assert 'GetFullPath' in cleanup['run'] and 'StartsWith' in cleanup['run']
failure_index=next(i for i,s in enumerate(steps) if s.get('name')=='Preserve fixed sanitized capture failure report')
assert failure_index==len(steps)-2, 'Failure report must be uploaded before cleanup'
assert not any('workflow_dispatch' in str(s) for s in steps)
print('PASS: push-only stage workflow, pinned actions, secret isolation, explicit artifact paths, cleanup.')
