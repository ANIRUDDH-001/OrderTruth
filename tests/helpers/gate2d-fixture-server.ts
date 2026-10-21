// Bounded local acceptance host; creates and cleans up a NEW disposable SQLite fixture.
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInvestigationFixture } from './gate2d-fixture.ts';
import { buildIncidentApi } from '../../src/merchant/api.ts';
import { mountConsole } from '../../src/merchant/console-static.ts';
const dir=mkdtempSync(join(tmpdir(),'ordertruth-gate2d-'));
const {store,id}=await createInvestigationFixture(join(dir,'synthetic.sqlite'));
const app=await buildIncidentApi({store});
try {
  await mountConsole(app);
  await app.listen({host:'127.0.0.1',port:3005});
} catch(error) {
  await app.close();store.close();rmSync(dir,{recursive:true,force:true});throw error;
}
console.log(`SYNTHETIC API acceptance only: http://127.0.0.1:3005/console/incidents/${id}?lens=eng (scope org_reference)`);
let closing=false;
const stop=async()=>{if(closing)return;closing=true;await app.close();store.close();rmSync(dir,{recursive:true,force:true});process.exit(0);};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
setTimeout(()=>void stop(),300000).unref();
