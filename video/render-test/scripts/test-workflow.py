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
for step in steps:
    if 'uses' in step: assert re.fullmatch(r'actions/[a-z-]+@[0-9a-f]{40}',step['uses'])
    if 'upload-artifact' in step.get('uses',''):
        paths=step['with']['path'].splitlines()
        assert all('*' not in p and 'private' not in p and not p.endswith('.webm') for p in paths)
        assert step['if'].startswith('success()')
secret_steps=[s for s in steps if 'secrets.' in str(s)]
assert len(secret_steps)==1
assert secret_steps[0]['name']=='Capture exactly one authorized existing-case stage'
cleanup=steps[-1]
assert cleanup['if']=='always()'
assert 'ordertruth-session-private' in cleanup['run']
assert 'GetFullPath' in cleanup['run'] and 'StartsWith' in cleanup['run']
assert not any('workflow_dispatch' in str(s) for s in steps)
print('PASS: push-only stage workflow, pinned actions, secret isolation, explicit artifact paths, cleanup.')
