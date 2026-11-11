from pathlib import Path
import hashlib,json,math,re
CASE='run_0ddc4e8b-f040-4ad7-8ea2-098f8beeae95'
KEEP='mo_bf9bb97b-495c-473f-9905-1627b85dec99'
VOID='mo_fbf7e14b-8ebf-4b49-8385-0857ff21f04e'
BOUNDS=[0,12,25,32,50,65,78,102,114,133,151,162]
class ManifestError(ValueError):pass
def need(condition,message):
    if not condition:raise ManifestError(message)
def sha256_file(file):
    h=hashlib.sha256()
    with Path(file).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()
def safe_file(root,spec):
    relative=spec.get('path','')
    need(isinstance(relative,str) and relative and not Path(relative).is_absolute() and '\\' not in relative and ':' not in relative,'Asset path must be workspace-relative POSIX')
    need(not any(x in relative.lower() for x in ('private','session','secret','cookie','storage-state')),'Private material cannot be an asset')
    need(Path(relative).suffix in ('.mp4','.wav','.json'),'Asset format forbidden')
    path=(root/relative).resolve()
    need(path.is_relative_to(root.resolve()) and path.is_file(),'Asset absent or outside workspace')
    need(re.fullmatch('[0-9a-f]{64}',spec.get('sha256','')) is not None,'Asset hash missing')
    need(sha256_file(path)==spec['sha256'],'Asset hash mismatch')
    return path
def validate(manifest,root):
    def privacy(value):
        if isinstance(value,dict):
            for key,item in value.items():
                need(not any(term in key.lower() for term in ('cookie','session','secret','token','authorization','storage_state')),'Private fields forbidden')
                privacy(item)
        elif isinstance(value,list):
            for item in value:privacy(item)
    privacy(manifest)
    need(manifest.get('schemaVersion')==1,'Unsupported manifest')
    need(manifest.get('mode') in ('incomplete-review','final-demo'),'Explicit edit mode required')
    final=manifest['mode']=='final-demo'
    need(manifest.get('caseId')==CASE,'Wrong case')
    need(manifest.get('keeperId')==KEEP and manifest.get('duplicateId')==VOID,'Changed orders')
    need(manifest.get('durationSeconds')==162 and manifest.get('fps')==30,'Approved duration/fps required')
    sources=manifest.get('sources',{})
    need(bool(sources),'Sources missing')
    for key,s in sources.items():
        safe_file(root,s)
        need(s.get('kind') in ('product','approved-graphic'),'Unknown source kind')
        need(isinstance(s.get('durationSeconds'),(float,int)) and math.isfinite(s['durationSeconds']) and s['durationSeconds']>0,'Invalid source duration')
        if s['kind']=='product':need(s.get('caseId')==CASE,'Source case mismatch')
    # Proof is a separately hashed, sanitized capture sidecar, never inline declarations.
    proofs={}
    for key,source in sources.items():
        if source.get('events'):
            need('proof' in source,'Evidence requires hash-verified capture sidecar')
            proof=json.loads(safe_file(root,source['proof']).read_text(encoding='utf-8'))
            privacy(proof)
            need(proof.get('caseId')==CASE and proof.get('sourceSha256')==source['sha256'],'Capture sidecar source/case mismatch')
            need(proof.get('events')==source['events'],'Manifest events differ from capture proof')
            proofs[key]=proof
    audio=manifest['narration'];qc=json.loads(safe_file(root,audio['qc']).read_text(encoding='utf-8'))
    need(qc.get('ok') is True and qc.get('method')=='FFmpeg 9.0.2 bundled offline libflite' and qc.get('voice')=='slt','Known narration provenance required')
    need(qc.get('duration')==162,'Narration duration mismatch')
    if final:need(qc.get('approvedScriptUnchanged') is True,'Final requires original approved narration')
    scenes=manifest.get('scenes',[]);need(len(scenes)==11,'All 11 scenes required')
    coverage=[];used_events=set();last_caption=0;source_intervals={}
    required={'S06':'ai-investigation','S07':'ai-investigation','S08':'ai-investigation','S09':'repair-executed','S10':'receipt-reopened'}
    for index,scene in enumerate(scenes):
        sid=f'S{index+1:02}';duration=BOUNDS[index+1]-BOUNDS[index]
        need(scene.get('id')==sid and scene.get('start')==BOUNDS[index] and scene.get('end')==BOUNDS[index+1],'Scene structure changed')
        safe_file(root,audio['scenes'][sid])
        tasks=[t for t in qc['tasks'] if t['scene']==sid]
        need(tasks and ' '.join(t['text'] for t in tasks)==scene.get('text'),'Narration/caption text mismatch')
        for task in tasks:
            need(BOUNDS[index]<=task['start']<task['end']<=BOUNDS[index+1] and task['start']>=last_caption,'Caption timing mismatch')
            last_caption=task['end']
        pieces=scene.get('pieces',[]);need(pieces,'Scene coverage missing')
        product=0.;graphic=0.;events=set()
        for p in pieces:
            need(p.get('source') in sources,'Unknown source')
            s=sources[p['source']];a=p.get('in');b=p.get('out')
            need(all(isinstance(x,(int,float)) and math.isfinite(x) for x in (a,b)) and 0<=a<b<=s['durationSeconds']+0.001,'Source interval invalid')
            if s['kind']=='product':
                product+=b-a
                source_intervals.setdefault(p['source'],[]).append((a,b))
            else:graphic+=b-a
            for event in s.get('events',[]):
                need(all(isinstance(event.get(k),(int,float)) and math.isfinite(event[k]) for k in ('start','end')) and 0<=event['start']<event['end']<=s['durationSeconds'],'Invalid evidence interval')
                if event.get('start',-1)>=a and event.get('end',s['durationSeconds']+1)<=b:
                    need(event.get('caseId')==CASE,'Evidence event case mismatch')
                    evidence=event.get('type');events.add(evidence);used_events.add(evidence)
                    proof=proofs[p['source']]
                    if evidence=='ai-investigation':
                        need(any(response.get('freshModelExecution') is True and response.get('schemaValidated') is True and response.get('status')=='success' and response.get('evaluationOnly') is False for response in proof.get('aiResponses',[])),'Capture sidecar lacks genuine successful AI response')
                        need(event.get('validRecordedInvestigation') is True and event.get('providerRequestCount',0)>0 and event.get('schemaValidated') is True and event.get('evaluationOnly') is False and event.get('freshModelExecution') is True and event.get('status')=='success','Invalid AI evidence')
                    if evidence in ('repair-executed','receipt-reopened'):
                        receipt=proof.get('receipt',{})
                        need(receipt.get('id')==event.get('receiptId') and receipt.get('verifiedCurrent') is True and receipt.get('activeOrders')==1 and receipt.get('matchingKeeper')==1 and receipt.get('providerUnchanged') is True,'Capture receipt verification incomplete')
                        need(event.get('receiptId') and event['receiptId']==manifest.get('receiptId'),'Receipt identity mismatch')
                        need(event.get('keeperId')==KEEP and event.get('duplicateId')==VOID,'Receipt orders mismatch')
                        need(event.get('verifiedCurrent') is True,'Receipt verification absent')
                    if evidence=='receipt-reopened':need(event.get('afterReload') is True and receipt.get('reopened') is True,'Persisted receipt reload absent')
        total=product+graphic;speed=max(1,total/duration)
        need(speed<=2,'Scene speed exceeds 2x')
        if final and sid in required:need(required[sid] in events,'Final scene lacks required evidence: '+sid)
        coverage.append({'scene':sid,'selectedProductSourceSeconds':round(product,6),'actualProductPictureSeconds':round(product/speed,6),'editorialGraphicSeconds':round(graphic/speed,6),'heldFrameSeconds':round(max(0,duration-total),6),'speed':speed})
    if final:need({'ai-investigation','repair-executed','receipt-reopened'}<=used_events,'Final evidence incomplete')
    unique_seconds=0.
    for intervals in source_intervals.values():
        merged=[]
        for a,b in sorted(intervals):
            if merged and a<=merged[-1][1]:merged[-1]=(merged[-1][0],max(b,merged[-1][1]))
            else:merged.append((a,b))
        unique_seconds+=sum(b-a for a,b in merged)
    return {'uniqueProductSourceSeconds':round(unique_seconds,6),'passed':True,'mode':manifest['mode'],'finalDemoComplete':final,'caseId':CASE,'receiptId':manifest.get('receiptId'),'durationSeconds':162,'coverage':coverage,'actualProductPictureSeconds':round(sum(x['actualProductPictureSeconds'] for x in coverage),6),'heldFrameSeconds':round(sum(x['heldFrameSeconds'] for x in coverage),6),'narration':'FFmpeg 9.0.2 bundled offline libflite; voice slt','liveBehavior':'NOT_TESTED'}
