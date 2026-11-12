"""Allowlisted final-stream diagnostics. No filenames, tags or raw ffprobe data."""
import json,math,re

EXPECTED_VIDEO={'width':1920,'height':1080,'avg_frame_rate':'30/1','codec_name':'h264','pix_fmt':'yuv420p'}

def safe_text(value,pattern=r'[A-Za-z0-9_./-]{1,40}'):
    return value if isinstance(value,str) and re.fullmatch(pattern,value) else None

def number(value):
    if isinstance(value,bool):return None
    try:result=float(value)
    except (ValueError,TypeError):return None
    return result if math.isfinite(result) else None

def stream_report(meta):
    streams=meta.get('streams',[])
    video=next((s for s in streams if s.get('codec_type')=='video'),{})
    audio=next((s for s in streams if s.get('codec_type')=='audio'),{})
    actual_video={k:(video.get(k) if type(video.get(k)) is int else None) for k in ('width','height')}
    actual_video.update({k:safe_text(video.get(k)) for k in ('avg_frame_rate','r_frame_rate','codec_name','pix_fmt','nb_frames')})
    actual_video.update({k:number(video.get(k)) for k in ('start_time','duration')})
    actual_audio={'codec_name':safe_text(audio.get('codec_name')),'sample_rate':number(audio.get('sample_rate'))}
    duration=number(meta.get('format',{}).get('duration'))
    # Preserve the original exact video checks, including the literal FPS fraction.
    checks={'video.'+k:video.get(k)==expected for k,expected in EXPECTED_VIDEO.items()}
    checks.update({'audio.codec_name':audio.get('codec_name')=='aac',
                   'audio.sample_rate':actual_audio['sample_rate']==48000,
                   'format.duration':duration is not None and abs(duration-162)<0.15 and duration<180})
    return {'schemaVersion':1,'status':'STREAM_PROPERTIES_ONLY','submissionReady':False,
            'expectedVideo':EXPECTED_VIDEO,'actualVideo':actual_video,'actualAudio':actual_audio,
            'durationSeconds':duration,'checks':checks,'mismatches':[k for k,ok in checks.items() if not ok],
            'streamChecksPassed':all(checks.values()),'fullDecode':'NOT_REACHED','frameCount':'NOT_REACHED','audioLevels':'NOT_REACHED'}

def write_stream_report(meta,file):
    report=stream_report(meta)
    file.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print('ASSEMBLY_STREAM_PROPERTIES '+json.dumps(report,separators=(',',':')),flush=True)
    return report

def require_streams(report):
    if not report['streamChecksPassed']:
        raise ValueError('Final stream contract failed: '+', '.join(report['mismatches']))
