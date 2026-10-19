/** TEST ONLY: separate OS process, no network/client. Hard kills expose SQLite commit boundaries. */
import { Store } from '../../src/db/store.ts';
import { RepairService } from '../../src/merchant/repair.ts';
import { writeFileSync, existsSync } from 'node:fs';
const [path,plan,crash='',marker='',release='']=process.argv.slice(2);
const s=new Store(path!);
const wait=new Int32Array(new SharedArrayBuffer(4));
const service=new RepairService(s,'org_reference',{boundary:b=>{
 if(b===crash)process.kill(process.pid,'SIGKILL');
 if(crash==='after_rollback'&&b==='after_voids')throw Error('forced failure before rollback');
 if(b==='after_begin'&&marker){writeFileSync(marker,'locked');const deadline=Date.now()+10000;while(!existsSync(release)){if(Date.now()>deadline)throw Error('test barrier timeout');Atomics.wait(wait,0,0,10);}}
}});
try{console.log(JSON.stringify(service.execute(plan!)));}finally{s.close();}
