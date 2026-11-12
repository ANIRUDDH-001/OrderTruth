import copy,json,unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from assembly_media_qc import stream_report,require_streams,write_stream_report

def valid():return {'streams':[{'codec_type':'video','width':1920,'height':1080,'avg_frame_rate':'30/1','r_frame_rate':'30/1','codec_name':'h264','pix_fmt':'yuv420p','nb_frames':'4860'},{'codec_type':'audio','codec_name':'aac','sample_rate':'48000'}],'format':{'duration':'162.0'}}

class MediaTests(unittest.TestCase):
 def test_exact_properties_pass_but_do_not_claim_full_qc(self):
  r=stream_report(valid());require_streams(r);self.assertFalse(r['submissionReady']);self.assertEqual(r['fullDecode'],'NOT_REACHED')
 def test_each_video_mismatch_names_actual_field(self):
  for key,value in {'width':1280,'height':720,'avg_frame_rate':'30000/1001','codec_name':'hevc','pix_fmt':'yuv444p'}.items():
   with self.subTest(key=key):
    m=valid();m['streams'][0][key]=value;r=stream_report(m)
    self.assertEqual(r['actualVideo'][key],value);self.assertEqual(r['mismatches'],['video.'+key]);self.assertRaises(ValueError,require_streams,r)
 def test_nominal_fps_does_not_hide_average_fps_failure(self):
  m=valid();m['streams'][0]['avg_frame_rate']='145800/4861';r=stream_report(m)
  self.assertEqual(r['actualVideo']['r_frame_rate'],'30/1');self.assertEqual(r['mismatches'],['video.avg_frame_rate'])
 def test_audio_and_duration_requirements_remain(self):
  for change,key in [(lambda m:m['streams'][1].update(codec_name='mp3'),'audio.codec_name'),(lambda m:m['streams'][1].update(sample_rate='44100'),'audio.sample_rate'),(lambda m:m['format'].update(duration='163'),'format.duration')]:
   m=valid();change(m);r=stream_report(m);self.assertEqual(r['mismatches'],[key]);self.assertRaises(ValueError,require_streams,r)
 def test_missing_streams_and_nonfinite_duration_fail_with_report(self):
  r=stream_report({'streams':[],'format':{'duration':'nan'}});self.assertFalse(r['streamChecksPassed']);self.assertIsNone(r['durationSeconds']);self.assertRaises(ValueError,require_streams,r)
 def test_private_metadata_never_enters_report(self):
  m=valid();m['format'].update(filename='SYNTHETIC_PRIVATE_MARKER',tags={'cookie':'SYNTHETIC_PRIVATE_MARKER'});m['streams'][0]['tags']={'token':'SYNTHETIC_PRIVATE_MARKER'}
  self.assertNotIn('SYNTHETIC_PRIVATE_MARKER',json.dumps(stream_report(m)))
 def test_report_is_written_before_failing_validation(self):
  m=valid();m['streams'][0]['width']=1280
  with TemporaryDirectory() as t:
   p=Path(t)/'diagnostics.json';r=write_stream_report(m,p);self.assertRaises(ValueError,require_streams,r);self.assertEqual(json.loads(p.read_text())['actualVideo']['width'],1280)

if __name__=='__main__':unittest.main()
