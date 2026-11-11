"""Sequential, one-thread editor. Requires real, fully verified capture; no placeholder footage."""
from pathlib import Path
import sys,json,re,textwrap,subprocess,hashlib,math,os,shutil
ROOT=Path(__file__).resolve().parents[1]
RUN=Path(sys.argv[1]).resolve()
assert RUN.is_relative_to(ROOT), 'Run directory must be inside video workspace'
FFMPEG=os.environ.get('FFMPEG_PATH') or shutil.which('ffmpeg')
FFPROBE=os.environ.get('FFPROBE_PATH') or shutil.which('ffprobe')
assert FFMPEG and FFPROBE, 'Pinned FFmpeg tools must be supplied'
def command(args,**kwargs):return subprocess.run([str(x) for x in args],check=True,**kwargs)
def probe(file):return json.loads(subprocess.check_output([str(FFPROBE),'-v','error','-show_streams','-show_format','-of','json',str(file)]))
def seconds(file):return float(probe(file)['format']['duration'])
def sha256_file(file):
    digest=hashlib.sha256()
    with Path(file).open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()
capture=json.loads((RUN/'capture.json').read_text())
assert capture.get('complete') and capture.get('receipt',{}).get('verifiedCurrent'), 'Verified same-case receipt capture is required'
scenes=json.loads((ROOT/'phase-a/preproduction/timeline.json').read_text())['scenes']
if capture.get('paused'):
    scenes[7]['text']='Autopilot has paused. Its recorded checks are saved, and the explanations remain hypotheses. I can review the evidence and decide on a correction. The model cannot authorize that decision.'
audio=RUN/'audio';audio.mkdir(exist_ok=True)
tasks=[]
for scene in scenes:
    chunks=[]
    for sentence in re.split(r'(?<=[.!?])\s+',scene['text']):
        chunks.extend(textwrap.wrap(sentence,width=76,break_long_words=False,break_on_hyphens=False))
    for i,chunk in enumerate(chunks):tasks.append({'scene':scene['id'],'index':i,'text':chunk,'wav':str(audio/f"{scene['id']}-{i:02}.wav")})
if '--prepare-audio' in sys.argv:
    (RUN/'tts-tasks.json').write_text(json.dumps(tasks,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Offline narration tasks prepared from the existing script.');sys.exit(0)
assert all(Path(t['wav']).exists() for t in tasks),'Local narration is incomplete'
raw=Path(capture['webm']);assert raw.is_file()
raw_length=seconds(raw)
assert abs(raw_length-float(capture['captureEnd']))<2,'Recording clock discrepancy exceeds 2s; automatic edit refused'
# Align the last captured frame with the observed browser-close boundary. 2s handles cover startup jitter.
offset=raw_length-float(capture['captureEnd'])
FONT="fontfile='"+str(Path(os.environ['WINDIR'])/'Fonts/arialbd.ttf').replace('\\','/').replace(':','\\:')+"'"
segments=RUN/'segments';segments.mkdir(exist_ok=True)
subtitles=[];media=[]
def stamp(s):
    n=round(s*1000);return f'{n//3600000:02}:{n//60000%60:02}:{n//1000%60:02},{n%1000:03}'
def note_filter(text,key):
    file=RUN/f'{key}.txt';file.write_text(text,encoding='utf-8')
    esc=str(file).replace('\\','/').replace(':','\\:')
    return f"drawtext={FONT}:textfile='{esc}':fontsize=28:fontcolor=white:box=1:boxcolor=black@0.80:boxborderw=12:x=80:y=35"
for scene in scenes:
    sid=scene['id'];duration=scene['end']-scene['start'];target=segments/f'{sid}.mp4'
    assert not target.exists(),'Preserving existing encoded segment; use a separate new run after review'
    current=[t for t in tasks if t['scene']==sid]
    lengths=[seconds(t['wav']) for t in current]
    assert all(d>0.25 for d in lengths),'Empty or implausibly short synthesized speech'
    # Each spoken subtitle chunk is a separately measured WAV. Tempo adjustment also retimes its captions.
    speech_length=sum(lengths)+0.12*max(0,len(current)-1)
    tempo=max(1.0,speech_length/(duration-0.7));assert tempo<=1.25,'Narration would require excessive acceleration'
    args=[FFMPEG,'-hide_banner','-loglevel','error'];vf=[];video_input_count=0
    pieces=[]
    if sid in ['S03','S11']:
        card=ROOT/'renders'/('S03-title-1080p.mp4' if sid=='S03' else 'S11-end-card-1080p.mp4')
        pieces.append((card,None,None))
    else:
        if sid=='S02':
            pieces.append((ROOT/'renders/S02-source-card-1080p.mp4',None,None))
        for interval in capture['shots'][sid]:
            start=max(0,float(interval[0])+offset);end=min(raw_length,float(interval[1])+offset)
            assert end>start and end-start>=0.2,'Invalid real-footage interval'
            pieces.append((raw,start,end))
    # Decode one video at a time. The previous multi-input concat graph could hold
    # decoded frames from several future clips while the first clip was playing.
    if len(pieces)>1:
        parts=[]
        for part_index,(file,start,end) in enumerate(pieces):
            part=segments/f'{sid}-part-{part_index:02}.mp4';assert not part.exists()
            part_args=[FFMPEG,'-v','error','-threads','1']
            if start is not None:part_args.extend(['-ss',f'{start:.6f}','-t',f'{end-start:.6f}'])
            part_args.extend(['-i',file,'-map','0:v:0','-vf','fps=30,scale=1920:1080,setsar=1,setpts=PTS-STARTPTS',
              '-an','-c:v','libx264','-preset','veryfast','-tune','zerolatency','-crf','16','-threads','1','-filter_threads','1','-pix_fmt','yuv420p','-n',part])
            command(part_args,cwd=ROOT);parts.append(part)
        parts_list=segments/f'{sid}-parts.txt'
        parts_list.write_text('\n'.join("file '"+p.as_posix().replace("'","'\\''")+"'" for p in parts)+'\n',encoding='utf-8')
        joined=segments/f'{sid}-picture.mp4';assert not joined.exists()
        command([FFMPEG,'-v','error','-f','concat','-safe','0','-i',parts_list,'-c','copy','-n',joined])
        pieces=[(joined,None,None)]
    file,start,end=pieces[0]
    args.extend(['-threads','1'])
    if start is not None:args.extend(['-ss',f'{start:.6f}','-t',f'{end-start:.6f}'])
    args.extend(['-i',file]);video_input_count=1
    selected_length=(end-start) if start is not None else seconds(file)
    vf.append('[0:v]fps=30,scale=1920:1080,setsar=1,setpts=PTS-STARTPTS[v0]')
    speed=max(1.0,selected_length/duration);assert speed<=2.0,'Recorded activity would exceed 2x; review required'
    video_label='v0'
    filters=f'setpts=(PTS-STARTPTS)/{speed:.9f},tpad=stop_mode=clone:stop_duration={duration},trim=duration={duration},fps=30'
    if sid not in ['S03','S11']:
        note='PayPal Sandbox | Controlled merchant scenario'
        if sid=='S04':note+=' | Stored observation reused'
        if sid=='S05':note+=' | Earlier in this same case | Waiting shortened'
        if sid in ['S06','S07','S09','S10']:note+=' | Waiting shortened'
        if speed>1.01:note+=f' | {speed:.2f}x'
        filters+=','+note_filter(note,sid+'-scope')
    vf.append(f'[{video_label}]{filters}[vfinal]')
    audio_labels=[]
    for i,t in enumerate(current):
        idx=video_input_count+i;args.extend(['-i',t['wav']]);label=f'a{i}'
        tail=',apad=pad_dur=0.12' if i<len(current)-1 else ''
        vf.append(f'[{idx}:a]aresample=48000,aformat=channel_layouts=mono,asetpts=PTS-STARTPTS{tail}[{label}]');audio_labels.append(f'[{label}]')
    vf.append(''.join(audio_labels)+f'concat=n={len(audio_labels)}:v=0:a=1,atempo={tempo:.9f},adelay=350:all=1,apad,atrim=duration={duration},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[afinal]')
    elapsed=0.35
    for t,length in zip(current,lengths):
        start=scene['start']+elapsed;end=min(scene['end']-0.1,start+length/tempo)
        assert end>start
        subtitles.append((start,end,'\n'.join(textwrap.wrap(t['text'],width=42,break_long_words=False,break_on_hyphens=False))))
        elapsed+=(length+0.12)/tempo
    graph=RUN/f'{sid}.filter';graph.write_text(';\n'.join(vf),encoding='utf-8')
    args.extend(['-/filter_complex',graph,'-map','[vfinal]','-map','[afinal]','-t',str(duration),'-r','30',
      '-c:v','libx264','-preset','veryfast','-tune','zerolatency','-crf','20','-pix_fmt','yuv420p','-threads','1','-filter_complex_threads','1',
      '-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart','-n',target])
    command(args,cwd=ROOT);m=probe(target);assert abs(float(m['format']['duration'])-duration)<0.10
    media.append(target);print('Encoded '+sid+' from actual footage/approved graphic and measured local narration.',flush=True)
local_srt=RUN/'OrderTruth-Final-Demo.srt'
local_srt.write_text('\n\n'.join(f'{i+1}\n{stamp(s)} --> {stamp(e)}\n{text}' for i,(s,e,text) in enumerate(subtitles))+'\n',encoding='utf-8')
listing=RUN/'segments.txt';listing.write_text('\n'.join("file '"+p.as_posix().replace("'","'\\''")+"'" for p in media)+'\n',encoding='utf-8')
rough=RUN/'OrderTruth-Rough-Cut.mp4'
command([FFMPEG,'-v','error','-f','concat','-safe','0','-i',listing,'-c','copy','-movflags','+faststart','-n',rough])
final_dir=ROOT/'final';final_dir.mkdir(exist_ok=True);final=final_dir/'OrderTruth-Final-Demo.mp4';assert not final.exists(),'Preserving existing final output'
subpath=local_srt.as_posix().replace(':','\\:').replace("'","\\'")
command([FFMPEG,'-v','error','-threads','1','-i',rough,'-vf',f"subtitles=filename='{subpath}':force_style='FontName=Arial,FontSize=14,Outline=1,Shadow=0,MarginV=14'",
 '-t','162','-r','30','-c:v','libx264','-preset','veryfast','-tune','zerolatency','-crf','20','-threads','1','-filter_threads','1','-pix_fmt','yuv420p',
 '-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart','-n',final])
m=probe(final);v=next(s for s in m['streams'] if s['codec_type']=='video');a=next(s for s in m['streams'] if s['codec_type']=='audio')
assert v['width']==1920 and v['height']==1080 and v['avg_frame_rate']=='30/1' and v['codec_name']=='h264' and v['pix_fmt']=='yuv420p'
assert a['codec_name']=='aac' and int(a['sample_rate'])==48000 and abs(float(m['format']['duration'])-162)<0.15 and float(m['format']['duration'])<180
command([FFMPEG,'-v','error','-xerror','-threads','1','-i',final,'-f','null','-'])
frame_info=json.loads(subprocess.check_output([str(FFPROBE),'-v','error','-threads','1','-select_streams','v:0','-count_frames','-show_entries','stream=nb_read_frames','-of','json',str(final)]));assert int(frame_info['streams'][0]['nb_read_frames'])==4860
level=subprocess.run([str(FFMPEG),'-hide_banner','-i',str(final),'-vn','-af','volumedetect','-f','null','-'],capture_output=True,text=True,check=True).stderr
peak=re.search(r'max_volume: ([\-\w.]+) dB',level);mean=re.search(r'mean_volume: ([\-\w.]+) dB',level)
assert peak and mean and math.isfinite(float(mean[1])) and -40<float(mean[1])<-5 and float(peak[1])<=0,'Narration signal/level validation failed'
(final_dir/'OrderTruth-Final-Demo.srt').write_bytes(local_srt.read_bytes())
report={'passed':True,'durationSeconds':float(m['format']['duration']),'videoFrames':4860,'video':v,'audio':a,'fullDecode':'PASS','audioMeanDb':float(mean[1]),'audioPeakDb':float(peak[1]),
 'actualProductPictureSeconds':138,'editorialGraphicSeconds':24,'captureReceipt':capture['receipt'],'rawFootageSha256':sha256_file(raw),
 'finalSha256':sha256_file(final),'voice':'Offline installed Windows voice; subjective voice-quality review still required','ffprobe':m}
(final_dir/'OrderTruth-Final-Demo.ffprobe.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print('FINAL '+str(final));print('ROUGH CUT '+str(rough))
