import fs from 'node:fs';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const version=(file,args)=>execFileSync(file,args,{encoding:'utf8'}).split(/\r?\n/)[0].replace(/[^\w .+()/-]/g,'').slice(0,180);
fs.writeFileSync('qc/tools-public.json',JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,
  runnerImage:process.env.ImageOS,runnerImageVersion:process.env.ImageVersion,
  totalMemoryGiB:Number((os.totalmem()/2**30).toFixed(2)),
  hyperframes:JSON.parse(fs.readFileSync('node_modules/hyperframes/package.json')).version,
  chrome:version(process.env.HYPERFRAMES_BROWSER_PATH,['--version']),
  ffmpeg:version(process.env.HYPERFRAMES_FFMPEG_PATH,['-version']),
  ffprobe:version(process.env.HYPERFRAMES_FFPROBE_PATH,['-version'])},null,2));
