import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/store.ts';
import { buildIncidentApi } from '../src/merchant/api.ts';
import { mountConsole } from '../src/merchant/console-static.ts';
import {createInvestigationFixture} from './helpers/gate2d-fixture.ts';
import {mapIncident} from '../web/console/evidence.ts';

it('retired /investigation links redirect into the console; only dedicated assets are served and nothing is writable', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ot-ui-'));mkdirSync(join(dir,'assets'));writeFileSync(join(dir,'index.html'),'<h1>Console</h1>');writeFileSync(join(dir,'assets','ui.js'),'// ui');writeFileSync(join(dir,'private.sqlite'),'not-public');
  const store=new Store(':memory:');const app=await buildIncidentApi({store});
  const id='inc_00000000-0000-4000-8000-000000000024';
  try {
    await mountConsole(app,dir);
    for(const url of [`/investigation/${id}/`,`/investigation/${id}`]) {const r=await app.inject(url);expect(r.statusCode).toBe(302);expect(r.headers.location).toBe(`/console/incidents/${id}?lens=eng`);}
    // Gate 3A: an org in a legacy link is kept (it was dropped before), never silently defaulted.
    {const r=await app.inject(`/investigation/${id}/?mode=local&org=org_reference`);expect(r.statusCode).toBe(302);expect(r.headers.location).toBe(`/console/incidents/${id}?lens=eng&org=org_reference`);}
    for(const url of ['/investigation','/investigation/','/investigation/?mode=demo']) {const r=await app.inject(url);expect(r.statusCode).toBe(302);expect(r.headers.location).toBe('/console/incidents');}
    const deep=await app.inject(`/console/incidents/${id}`);expect(deep.statusCode).toBe(200);expect(deep.body).toContain('Console');expect(deep.headers['content-security-policy']).toContain("connect-src 'self'");
    expect((await app.inject('/console/assets/ui.js')).statusCode).toBe(200);
    for(const url of ['/investigation/invalid/','/investigation/assets/ui.js']) {const r=await app.inject(url);expect(r.statusCode).toBe(404);expect(r.headers['content-security-policy']).toContain("default-src 'self'");}
    for(const url of ['/console/private.sqlite','/console/assets/../private.sqlite','/.env','/api/repair']) expect((await app.inject(url)).statusCode).toBe(404);
    for(const method of ['POST','PUT','DELETE'] as const) expect((await app.inject({method,url:`/investigation/${id}/`})).statusCode).toBe(405);
    expect((await app.inject('/api/incidents')).statusCode).toBe(401);
    expect((await app.inject(`/investigation/${id}/`)).headers['access-control-allow-origin']).toBeUndefined();
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
