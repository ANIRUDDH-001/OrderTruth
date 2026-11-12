"""Sequential cloud editor adapted for explicit per-scene source manifests; no new media generation."""
from pathlib import Path
import sys,json,re,textwrap,subprocess,hashlib,math,os,shutil
import argparse
from assembly_manifest import validate,safe_file,scene_tasks
from assembly_media_qc import write_stream_report,require_streams
parser=argparse.ArgumentParser(description='Manifest-driven adapter of the sequential cloud assembler')
parser.add_argument('run',type=Path)
parser.add_argument('--manifest',type=Path,required=True)
parser.add_argument('--validate-only',action='store_true')
options=parser.parse_args()
ROOT=Path(os.environ.get('VIDEO_WORKSPACE_ROOT',str(Path(__file__).resolve().parents[1]))).resolve()
RUN=options.run.resolve()
if not RUN.is_relative_to(ROOT):raise ValueError('Run directory must be inside video workspace')
manifest=json.loads(options.manifest.read_text(encoding='utf-8-sig'))
validation=validate(manifest,ROOT)
if options.validate_only:
    print(json.dumps(validation,indent=2));sys.exit(0)
if os.environ.get('GITHUB_ACTIONS')!='true':raise ValueError('Rendering is restricted to GitHub Actions')
if RUN.exists():raise ValueError('Use a new output directory; existing work is preserved')
RUN.mkdir(parents=True)
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
scenes=manifest['scenes']
qc=json.loads(safe_file(ROOT,manifest['narration']['qc']).read_text(encoding='utf-8'))
# Validate actual container lengths before encoding, in addition to hash validation.
for source in manifest['sources'].values():
    assert abs(seconds(safe_file(ROOT,source))-source['durationSeconds'])<0.10,'Source duration metadata mismatch'
font_path=os.environ.get('VIDEO_FONT_PATH')
FONT=("fontfile='"+Path(font_path).as_posix().replace(':','\\:')+"'") if font_path else "font='DejaVu Sans'"
name='OrderTruth-Final-Demo' if manifest['mode']=='final-demo' else 'OrderTruth-Incomplete-Review'
segments=RUN/'segments';segments.mkdir(exist_ok=True)
subtitles=[];media=[]
def stamp(s):
    n=round(s*1000);return f'{n//3600000:02}:{n//60000%60:02}:{n//1000%60:02},{n%1000:03}'
def note_filter(text,key,y=35):
    file=RUN/f'{key}.txt';file.write_text(text,encoding='utf-8')
    esc=str(file).replace('\\','/').replace(':','\\:')
    return f"drawtext={FONT}:textfile='{esc}':fontsize=28:fontcolor=white:box=1:boxcolor=black@0.80:boxborderw=12:x=80:y={y}"
for scene in scenes:
    sid=scene['id'];duration=scene['end']-scene['start'];target=segments/f'{sid}.mp4'
    assert not target.exists(),'Preserving existing encoded segment; use a separate new run after review'
    narration=safe_file(ROOT,manifest['narration']['scenes'][sid])
    assert abs(seconds(narration)-duration)<0.05,'Scene narration duration mismatch'
    args=[FFMPEG,'-hide_banner','-loglevel','error'];vf=[];video_input_count=0
    pieces=[(safe_file(ROOT,manifest['sources'][p['source']]),float(p['in']),float(p['out'])) for p in scene['pieces']]
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
    if manifest['mode']=='incomplete-review':
        vf[-1]=vf[-1].replace('[vfinal]',','+note_filter('INCOMPLETE REVIEW - AI / VERIFIED OUTCOME NOT CLAIMED',sid+'-review',90)+'[vfinal]')
    if manifest['mode']=='final-demo' and sid in ['S06','S07','S08']:
        ai_proofs=[json.loads(safe_file(ROOT,manifest['sources'][p['source']]['proof']).read_text(encoding='utf-8')) for p in scene['pieces'] if 'proof' in manifest['sources'][p['source']]]
        responses=[r for proof in ai_proofs for r in proof.get('aiResponses',[])]
        if responses and all(r.get('concluded') is False for r in responses):
            vf[-1]=vf[-1].replace('[vfinal]',','+note_filter('One recorded AI step | Investigation not concluded',sid+'-ai-scope',90)+'[vfinal]')
    args.extend(['-i',narration])
    audio_filters='aresample=48000'
    for cut in scene.get('omitNarration',[]):
        a,b=cut['start']-scene['start'],cut['end']-scene['start']
        audio_filters+=f",volume=0:enable='between(t,{a:.9f},{b:.9f})'"
    vf.append(f'[1:a]{audio_filters},apad,atrim=duration={duration}[afinal]')
    for task in scene_tasks(qc,scene):
        subtitles.append((task['start'],task['end'],'\n'.join(textwrap.wrap(task['text'],width=42,break_long_words=False,break_on_hyphens=False))))
    graph=RUN/f'{sid}.filter';graph.write_text(';\n'.join(vf),encoding='utf-8')
    args.extend(['-/filter_complex',graph,'-map','[vfinal]','-map','[afinal]','-t',str(duration),'-r','30',
      '-c:v','libx264','-preset','veryfast','-tune','zerolatency','-crf','20','-pix_fmt','yuv420p','-threads','1','-filter_complex_threads','1',
      '-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart','-n',target])
    command(args,cwd=ROOT);m=probe(target);assert abs(float(m['format']['duration'])-duration)<0.10
    media.append(target);print('Encoded '+sid+' from actual footage/approved graphic and measured local narration.',flush=True)
local_srt=RUN/(name+'.srt')
local_srt.write_text('\n\n'.join(f'{i+1}\n{stamp(s)} --> {stamp(e)}\n{text}' for i,(s,e,text) in enumerate(subtitles))+'\n',encoding='utf-8')
listing=RUN/'segments.txt';listing.write_text('\n'.join("file '"+p.as_posix().replace("'","'\\''")+"'" for p in media)+'\n',encoding='utf-8')
rough=RUN/'OrderTruth-Rough-Cut.mp4'
command([FFMPEG,'-v','error','-f','concat','-safe','0','-i',listing,'-c','copy','-movflags','+faststart','-n',rough])
final_dir=RUN;final=final_dir/(name+'.mp4');assert not final.exists(),'Preserving existing final output'
subpath=local_srt.as_posix().replace(':','\\:').replace("'","\\'")
command([FFMPEG,'-v','error','-threads','1','-i',rough,'-vf',f"subtitles=filename='{subpath}':force_style='FontName=Arial,FontSize=14,Outline=1,Shadow=0,MarginV=14',scale=out_range=tv,format=yuv420p",
 '-t','162','-r','30','-c:v','libx264','-preset','veryfast','-tune','zerolatency','-crf','20','-threads','1','-filter_threads','1','-pix_fmt','yuv420p','-color_range','tv',
 '-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart','-n',final])
m=probe(final)
diagnostics=write_stream_report(m,final_dir/'assembly-diagnostics.json')
require_streams(diagnostics)
v=next(s for s in m['streams'] if s['codec_type']=='video');a=next(s for s in m['streams'] if s['codec_type']=='audio')
command([FFMPEG,'-v','error','-xerror','-threads','1','-i',final,'-f','null','-'])
frame_info=json.loads(subprocess.check_output([str(FFPROBE),'-v','error','-threads','1','-select_streams','v:0','-count_frames','-show_entries','stream=nb_read_frames','-of','json',str(final)]));assert int(frame_info['streams'][0]['nb_read_frames'])==4860
level=subprocess.run([str(FFMPEG),'-hide_banner','-i',str(final),'-vn','-af','volumedetect','-f','null','-'],capture_output=True,text=True,check=True).stderr
peak=re.search(r'max_volume: ([\-\w.]+) dB',level);mean=re.search(r'mean_volume: ([\-\w.]+) dB',level)
assert peak and mean and math.isfinite(float(mean[1])) and -40<float(mean[1])<-5 and float(peak[1])<=0,'Narration signal/level validation failed'
report={**validation,'durationSeconds':float(m['format']['duration']),'videoFrames':4860,'video':v,'audio':a,'fullDecode':'PASS','audioMeanDb':float(mean[1]),'audioPeakDb':float(peak[1]),
 'finalSha256':sha256_file(final),'sourceHashes':{key:source['sha256'] for key,source in manifest['sources'].items()},'ffprobe':m}
# ffprobe contains only completed public output media information, never capture/session state.
(final_dir/(name+'.qc.json')).write_text(json.dumps(report,indent=2),encoding='utf-8')
print('OUTPUT '+str(final))
