import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/store.ts';
import { buildIncidentApi } from '../src/merchant/api.ts';
import { mountInvestigation } from '../src/merchant/investigation-static.ts';
import {createInvestigationFixture} from './helpers/gate2d-fixture.ts';
import {mapIncident} from '../web/investigation/model.ts';

it('serves only dedicated assets and valid deep links without exposing database paths or allowing writes', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ot-ui-'));mkdirSync(join(dir,'assets'));writeFileSync(join(dir,'index.html'),'<h1>Investigation</h1>');writeFileSync(join(dir,'assets','ui.js'),'// ui');writeFileSync(join(dir,'private.sqlite'),'not-public');
  const store=new Store(':memory:');const app=await buildIncidentApi({store});
  try {
    await mountInvestigation(app,dir);
    for(const url of ['/investigation/','/investigation/inc_00000000-0000-4000-8000-000000000024/']) {const r=await app.inject(url);expect(r.statusCode).toBe(200);expect(r.body).toContain('Investigation');expect(r.headers['content-security-policy']).toContain("connect-src 'self'");}
    expect((await app.inject('/investigation/assets/ui.js')).statusCode).toBe(200);
    for(const url of ['/investigation/private.sqlite','/.env','/investigation/invalid/','/api/repair']) expect((await app.inject(url)).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:'/investigation/'})).statusCode).toBe(405);
    expect((await app.inject('/api/incidents')).statusCode).toBe(401);
    expect((await app.inject('/investigation/')).headers['access-control-allow-origin']).toBeUndefined();
  } finally {await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

it('maps the real read-only API on a NEW persisted synthetic fixture after restart with no read-side mutations',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ot-api-ui-'));const path=join(dir,'synthetic.sqlite');
  const fixture=await createInvestigationFixture(path);const id=fixture.id;fixture.store.close();
  const store=new Store(path);const app=await buildIncidentApi({store});
  try {
    const changes=()=>store.db.prepare('SELECT total_changes() n').get()!.n;const before=changes();
    const response=await app.inject({url:`/api/incidents/${id}`,headers:{'x-ordertruth-org':'org_reference'}});
    expect(response.statusCode).toBe(200);const raw=response.json();const view=mapIncident(raw,'org_reference');
    expect(view.opening.result).toBe('VIOLATED');expect(view.opening.count).toBe(2);expect(view.observations).toHaveLength(2);expect(view.provider.title).toBe('Persisted completed capture');
    expect(raw.repairHistory.voids).toEqual([]);expect(raw.repairHistory.resolutions).toEqual([]);
    expect(view.receipt).toHaveLength(0);expect(view.state).toBe('open');expect(changes()).toBe(before);
    expect((await app.inject({url:`/api/incidents/${id}`,headers:{'x-ordertruth-org':'org_other'}})).statusCode).toBe(404);
    for(const method of ['POST','PUT','DELETE'] as const)expect((await app.inject({method,url:`/api/incidents/${id}`,headers:{'x-ordertruth-org':'org_reference'}})).statusCode).toBe(405);
    expect(changes()).toBe(before);
  }finally{await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
