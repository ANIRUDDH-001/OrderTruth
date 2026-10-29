"""Independent standard-library CSV/JSON check; does not import the TS adapter."""
import csv, json, re, hashlib
from pathlib import Path
base=Path('docs/evidence/investigator-eval-stage2')
key=json.loads((base/'live-arm-key.json').read_text())['cases']
report=json.loads((base/'live-automated-report.json').read_text())
scores={r['id']:r for r in report['rows']}
primary=['R1','R2','R3','R4','R5','R6','R7','R9']
def section(path,stage):
    rows=list(csv.reader(path.open(encoding='utf-8-sig',newline='')))
    header=rows[0]; out={}
    for row in rows[1:]:
        if not row or not any(row):continue
        if row[:2]==['reviewer','transition']:break
        assert len(row)==len(header)
        d=dict(zip(header,row)); identity=(d['case_code'],d['output'])
        assert identity not in out; out[identity]=d
    assert len(out)==48
    return out
checks=[]
for reviewer in ['codex','claude']:
    first=section(base/f'{reviewer}-stage1.csv',1)
    second=section(base/('codex-stage2-normalized.csv' if reviewer=='codex' else 'claude-stage2.csv'),2)
    normalized=json.loads((base/f'{reviewer}-analysis.json').read_text())
    assert len(normalized['records'])==48
    tallies={a:dict(P1correct=0,P2=0,P3flags=0) for a in ['A','B','C']}
    for code,mapping in key.items():
        cid=mapping['caseId']
        for letter,arm in mapping['letters'].items():
            one,two=first[(code,letter)],second[(code,letter)]
            assert one['reviewer']==reviewer and two['reviewer']==reviewer
            p3=one['P3_flagged_statements'].strip().lower()
            assert p3=='none' or re.match(r'^(summary|h[1-4]|reason)\s*:',p3)
            assert one['U1_unsafe'].strip().lower()=='no'
            if cid not in primary:continue
            t=tallies[arm]
            t['P1correct']+=two['P1_correctness'].strip().lower()=='correct'
            t['P3flags']+=p3!='none'
            t['P2']+=scores[cid]['scores'][arm]['P2_discriminating'] is True
    for control in ['C','A']:
        result=normalized['decisions']['versus'+control]
        for field in ['P1correct','P2','P3flags']:
            assert result['b'][field]==tallies['B'][field]
            assert result['c'][field]==tallies[control][field]
        assert (result['b']['P1total'],result['b']['P2total'],result['b']['P3total'])==(8,5,8)
        p1diff=tallies['B']['P1correct']-tallies[control]['P1correct']
        p3diff=tallies[control]['P3flags']-tallies['B']['P3flags']
        assert result['diff']['P1']==p1diff and result['diff']['P3']==p3diff
        assert result['outcome']=='REGRESSION' and (p1diff<=-2 or p3diff<=-2)
        assert result['regression']['basis']=='OBSERVED'
        assert result['unresolvedFields']==0 and not result['bFailures']
        checks.append(dict(reviewer=reviewer,control=control,matched=True,model=tallies['B'],comparator=tallies[control],outcome=result['outcome']))
manifest=json.loads((base/'pre-unblinding-snapshot/manifest.json').read_text())
for f in manifest['files']:
    assert hashlib.sha256((base/'pre-unblinding-snapshot'/f['copy']).read_bytes()).hexdigest()==f['sha256']
output=dict(method='Independent Python standard-library CSV/JSON arithmetic; no TypeScript adapter import',comparisons=checks,snapshotCopiesVerified=len(manifest['files']),allPassed=True)
(base/'independent-arithmetic.json').write_text(json.dumps(output,indent=2)+'\n',encoding='utf-8')
print(json.dumps(output))
