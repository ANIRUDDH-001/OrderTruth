import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const file='renders/motion-test-720p.mp4';
const ff=process.env.HYPERFRAMES_FFMPEG_PATH || 'ffmpeg';
const probe=process.env.HYPERFRAMES_FFPROBE_PATH || 'ffprobe';
const report={ok:false};
try {
  assert(fs.statSync(file).size>0);
  const r=JSON.parse(execFileSync(probe,['-v','error','-count_frames','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));
  const v=r.streams.filter(s=>s.codec_type==='video');assert.equal(v.length,1);assert.equal(r.streams.length,1);
  const s=v[0];const duration=Number(r.format.duration);
  assert.equal(s.width,1280);assert.equal(s.height,720);assert.equal(s.codec_name,'h264');assert.equal(s.pix_fmt,'yuv420p');
  assert.equal(s.avg_frame_rate,'30/1');assert.equal(Number(s.nb_read_frames),150);assert(Math.abs(duration-5)<0.05);
  execFileSync(ff,['-v','error','-xerror','-i',file,'-f','null','-'],{stdio:'pipe'});
  const hashes=[];
  for(const n of [15,66,135]) {
    const b=execFileSync(ff,['-v','error','-i',file,'-vf',`select=eq(n\\,${n})`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:8*1024*1024});
    assert.equal(b.length,1280*720*3);hashes.push(createHash('sha256').update(b).digest('hex'));
    // Each later reveal must add a meaningful area of bright text, catching missing/frozen titles.
    let bright=0;for(let i=0;i<b.length;i+=3)if(b[i]>140&&b[i+1]>140&&b[i+2]>140)bright++;
    (report.brightPixels ??= []).push(bright);
  }
  assert.equal(new Set(hashes).size,3);assert(report.brightPixels[0]>1000);
  assert(report.brightPixels[1]>report.brightPixels[0]+1000);assert(report.brightPixels[2]>report.brightPixels[1]+1000);
  Object.assign(report,{ok:true,width:1280,height:720,fps:30,frames:150,duration,codec:s.codec_name,pixelFormat:s.pix_fmt,decodedFrameHashes:hashes,
    mp4Sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),visualReview:'Owner must inspect text fit and smoothness before Phase B acceptance.'});
} finally {fs.writeFileSync('qc/video-public.json',JSON.stringify(report,null,2));}
