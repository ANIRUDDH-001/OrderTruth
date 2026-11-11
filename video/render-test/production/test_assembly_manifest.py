import copy,hashlib,json,tempfile,unittest
from pathlib import Path
from assembly_manifest import validate,ManifestError,CASE,KEEP,VOID,BOUNDS
class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        def file(name,body):
            data=body.encode();(self.root/name).write_bytes(data);return {'path':name,'sha256':hashlib.sha256(data).hexdigest()}
        media=file('source.mp4','synthetic - never decoded');wav=file('audio.wav','synthetic audio')
        scenes=[];tasks=[];events=[]
        for i in range(11):
            sid=f'S{i+1:02}';a,b=BOUNDS[i:i+2]
            scenes.append({'id':sid,'start':a,'end':b,'text':'Synthetic narration.','pieces':[{'source':'take','in':a,'out':b}]})
            tasks.append({'scene':sid,'start':a+.5,'end':b-.5,'text':'Synthetic narration.'})
            kind={'S06':'ai-investigation','S07':'ai-investigation','S08':'ai-investigation','S09':'repair-executed','S10':'receipt-reopened'}.get(sid)
            if kind:events.append({'type':kind,'start':a+1,'end':b-1,'caseId':CASE,'receiptId':'receipt-synthetic','keeperId':KEEP,'duplicateId':VOID,'verifiedCurrent':True,'afterReload':True,'validRecordedInvestigation':True,'providerRequestCount':1,'schemaValidated':True,'evaluationOnly':False,'freshModelExecution':True,'status':'success'})
        qc=file('qc.json',json.dumps({'ok':True,'method':'FFmpeg 9.0.2 bundled offline libflite','voice':'slt','duration':162,'approvedScriptUnchanged':True,'tasks':tasks}))
        proof=file('proof.json',json.dumps({'caseId':CASE,'sourceSha256':media['sha256'],'events':events,'receipt':{'id':'receipt-synthetic','verifiedCurrent':True,'activeOrders':1,'matchingKeeper':1,'providerUnchanged':True,'reopened':True},'aiResponses':[{'freshModelExecution':True,'schemaValidated':True,'status':'success','evaluationOnly':False}]}))
        self.m={'schemaVersion':1,'mode':'final-demo','caseId':CASE,'keeperId':KEEP,'duplicateId':VOID,'durationSeconds':162,'fps':30,'receiptId':'receipt-synthetic','sources':{'take':{**media,'kind':'product','caseId':CASE,'durationSeconds':162,'events':events,'proof':proof}},'narration':{'qc':qc,'scenes':{s['id']:wav for s in scenes}},'scenes':scenes}
    def rejects(self):
        with self.assertRaises((ManifestError,KeyError)):validate(self.m,self.root)
    def update_proof(self,change=None):
        source=self.m['sources']['take'];p=self.root/'proof.json'
        proof=json.loads(p.read_text());proof['events']=source['events']
        if change:change(proof)
        p.write_text(json.dumps(proof));source['proof']['sha256']=hashlib.sha256(p.read_bytes()).hexdigest()
    def test_valid_final(self):self.assertTrue(validate(self.m,self.root)['finalDemoComplete'])
    def test_proof_hash_mismatch(self):self.m['sources']['take']['proof']['sha256']='0'*64;self.rejects()
    def test_missing_proof(self):self.m['sources']['take'].pop('proof');self.rejects()
    def test_wrong_case(self):self.m['caseId']='wrong';self.rejects()
    def test_source_wrong_case(self):self.m['sources']['take']['caseId']='wrong';self.rejects()
    def test_orders_changed(self):self.m['keeperId']='wrong';self.rejects()
    def test_hash_mismatch(self):self.m['sources']['take']['sha256']='0'*64;self.rejects()
    def test_missing_asset(self):self.m['sources']['take']['path']='absent.mp4';self.rejects()
    def test_traversal(self):self.m['sources']['take']['path']='../source.mp4';self.rejects()
    def test_missing_scene(self):self.m['scenes'].pop();self.rejects()
    def test_out_of_bounds(self):self.m['scenes'][0]['pieces'][0]['out']=163;self.rejects()
    def test_duration_changed(self):self.m['scenes'][0]['end']=11;self.rejects()
    def test_missing_ai(self):self.m['sources']['take']['events']=[e for e in self.m['sources']['take']['events'] if e['type']!='ai-investigation'];self.rejects()
    def test_consistent_proof_still_requires_ai(self):
        self.m['sources']['take']['events']=[e for e in self.m['sources']['take']['events'] if e['type']!='ai-investigation'];self.update_proof();self.rejects()
    def test_proof_without_actual_ai_response(self):
        self.update_proof(lambda p:p.update(aiResponses=[]));self.rejects()
    def test_consistent_invalid_evaluation_rejected(self):
        self.m['sources']['take']['events'][0]['evaluationOnly']=True;self.update_proof();self.rejects()
    def test_consistent_proof_requires_verified_receipt(self):
        self.update_proof(lambda p:p['receipt'].update(verifiedCurrent=False));self.rejects()
    def test_invalid_evaluation(self):self.m['sources']['take']['events'][0]['evaluationOnly']=True;self.rejects()
    def test_no_provider_calls(self):self.m['sources']['take']['events'][0]['providerRequestCount']=0;self.rejects()
    def test_wrong_receipt(self):self.m['receiptId']='wrong';self.rejects()
    def test_missing_reload(self):self.m['sources']['take']['events'][-1]['afterReload']=False;self.rejects()
    def test_unverified_receipt(self):self.m['sources']['take']['events'][-1]['verifiedCurrent']=False;self.rejects()
    def test_event_outside_cut(self):self.m['sources']['take']['events'][-1]['end']=155;self.rejects()
    def test_private_field(self):self.m['sessionState']={'token':'synthetic'};self.rejects()
    def test_private_asset(self):self.m['sources']['take']['path']='private/session.json';self.rejects()
    def test_explicit_review(self):
        self.m['mode']='incomplete-review';self.m['sources']['take']['events']=[]
        report=validate(self.m,self.root);self.assertFalse(report['finalDemoComplete']);self.assertEqual(report['actualProductPictureSeconds'],162)
        self.assertNotIn('sources',report);self.assertNotIn('narration',report.get('coverage',{}))
    def test_coverage_excludes_hold(self):
        self.m['mode']='incomplete-review';self.m['sources']['take']['events']=[];self.m['scenes'][0]['pieces'][0]['out']=6
        report=validate(self.m,self.root);self.assertEqual(report['actualProductPictureSeconds'],156);self.assertEqual(report['heldFrameSeconds'],6)
    def test_encode_disabled_outside_actions(self):
        import subprocess,sys,os
        p=self.root/'manifest.json';p.write_text(json.dumps(self.m));env={**os.environ,'VIDEO_WORKSPACE_ROOT':str(self.root),'GITHUB_ACTIONS':'false'}
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('assemble-host.py')),str(self.root/'output'),'--manifest',str(p)],env=env,capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0);self.assertIn('restricted to GitHub Actions',result.stderr);self.assertFalse((self.root/'output').exists())
if __name__=='__main__':unittest.main()
