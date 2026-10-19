// Standalone acceptance runner. Use an existing Playwright install; no added dependency.
// Start `pnpm investigation` first. PLAYWRIGHT_MODULE can name an installed module directory.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ANIRUDDH/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path');
const output=path.resolve('.work/runs/gate2d/browser');fs.mkdirSync(output,{recursive:true});
const base=process.env.INVESTIGATION_URL||'http://127.0.0.1:3004';
const checks=[],errors=[],requests=[];
function check(ok,name){if(!ok)throw Error(name);checks.push(name);}
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try {
    for(const width of [1440,390]) {
      const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1});
      await page.emulateMedia({reducedMotion:'reduce'});
      page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
      await page.goto(base+'/investigation/?mode=demo');await page.locator('#workspace').waitFor({state:'visible'});
      check((await page.locator('#mode-label').innerText()).includes('SYNTHETIC DEMO'),width+' persistent explicit synthetic label');
      check(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),width+' no horizontal overflow');
      check((await page.locator('#contract-result').innerText())==='1:2 VIOLATED',width+' detection violated');
      await page.screenshot({path:path.join(output,`${width}-detection.png`)});
      if(width===390)await page.screenshot({path:path.join(output,'mobile-full.png'),fullPage:true});
      if(width===1440){const box=await page.locator('.canvas').boundingBox();check(box.y+box.height<900,'desktop truth gap above fold');await page.screenshot({path:path.join(output,'desktop-full.png'),fullPage:true});}
      await page.locator('[data-entity="order:demo-keeper"]').focus();await page.keyboard.press('Enter');
      const target=width===390?'#dialog-body':'#inspect-fields';
      check((await page.locator(target).innerText()).includes('demo-keeper'),width+' keyboard selects keeper identity');
      if(width===390){await page.keyboard.press('Escape');check(await page.locator('[data-entity="order:demo-keeper"]').evaluate(e=>document.activeElement===e),'mobile Escape restores focus');}
      await page.locator('[data-entity="order:demo-duplicate"]').click();check((await page.locator(target).innerText()).includes('demo-duplicate'),width+' duplicate distinct selection');
      await page.screenshot({path:path.join(output,`${width}-duplicate-inspector.png`)});
      if(width===390)await page.keyboard.press('Escape');
      await page.locator('[data-state="latest"]').click();check((await page.locator('#contract-result').innerText())==='1:1 HOLDS',width+' latest holds');
      check(await page.locator('[data-entity="order:demo-duplicate"]').evaluate(e=>e.classList.contains('voided')),width+' original duplicate retained with effective void');
      check((await page.locator('#inspect-fields').innerText()).includes('voided_duplicate'),width+' selected inspector updates on time switch');
      await page.screenshot({path:path.join(output,`${width}-latest.png`)});
      await page.locator('[data-state="detection"]').click();check((await page.locator('#contract-result').innerText())==='1:2 VIOLATED',width+' historical finding preserved');
      await page.locator('[data-hyp="delivery"]').click();check((await page.locator('#hypbody').innerText()).includes('dedup'),width+' hypothesis missing proof shown');
      await page.locator('#diagnostic').click();check((await page.locator('#dialog-body').innerText()).includes('does not execute'),width+' safe diagnostic specification');await page.keyboard.press('Escape');
      await page.locator('[data-evidence="source:4"]').click();check((await page.locator(width===390?'#dialog-body':'#sourcedetail').innerText()).includes('not provider truth'),width+' evidence trust limitations');if(width===390)await page.keyboard.press('Escape');
      await page.locator('#receipt-open').click();check((await page.locator('#dialog-body').innerText()).includes('demo-plan'),width+' recovery receipt plan');check((await page.locator('#dialog-body').innerText()).includes('provider_before_sha256'),width+' preservation hash provenance');
      await page.screenshot({path:path.join(output,`${width}-receipt.png`)});await page.keyboard.press('Escape');check(await page.locator('#receipt-open').evaluate(e=>document.activeElement===e),width+' receipt focus restoration');
      await page.goto(base+'/investigation/inc_00000000-0000-4000-8000-000000000024/?mode=demo');await page.reload();await page.locator('#workspace').waitFor({state:'visible'});check((await page.locator('#incident-id').innerText()).startsWith('inc_'),width+' deep link and reload');
      await page.goto(base+'/investigation/?mode=local');check((await page.locator('#load-status').innerText()).includes('requires'),width+' missing local config useful error');check(await page.locator('#workspace').isHidden(),width+' error never synthetic fallback');
      await page.close();
    }
    // Optional real incident API acceptance host, always a NEW disposable synthetic DB.
    const apiBase=process.env.SYNTHETIC_API_URL;
    if(apiBase) {
      const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
      const listing=await page.request.get(apiBase+'/api/incidents',{headers:{'x-ordertruth-org':'org_reference'}});const id=(await listing.json()).incidents[0].id;
      const url=apiBase+`/investigation/${id}/?mode=local&org=org_reference`;
      await page.goto(url);await page.locator('#workspace').waitFor({state:'visible'});
      check((await page.locator('#mode-label').innerText()).includes('LOCAL INCIDENT API'),'actual API mode labelled');check(!(await page.locator('#workspace').innerText()).includes('demo-keeper'),'actual API never substituted demo');
      check((await page.locator('#contract-result').innerText())==='1:2 VIOLATED','actual API detection mapped');await page.screenshot({path:path.join(output,'local-api-synthetic-fixture.png')});
      const orders=page.locator('[data-entity^="order:"]');check(await orders.count()===2,'actual API two distinct persisted merchant records');
      await orders.nth(1).click();const second=await orders.nth(1).getAttribute('data-entity');check((await page.locator('#inspect-title').innerText())===second.slice(6),'actual API duplicate selection identity');
      await page.reload();await page.locator('#workspace').waitFor({state:'visible'});check((await page.locator('#incident-id').innerText())===id,'actual API deep link reload');
      await page.locator('#receipt-open').click();check((await page.locator('#dialog-body').innerText()).includes('unavailable'),'open API incident no fabricated receipt');await page.keyboard.press('Escape');
      await page.goto(url.replace('org_reference','org_other'));await page.locator('#load-status[role="alert"]').waitFor();check((await page.locator('#load-status').innerText()).includes('HTTP 404'),'cross-org returns404 without data');check(await page.locator('#workspace').isHidden(),'cross-org no hidden demo fallback');
      // Adversarial API contract responses, not real persisted evidence.
      const raw=await (await page.request.get(apiBase+`/api/incidents/${id}`,{headers:{'x-ordertruth-org':'org_reference'}})).json();
      raw.class='UNRECOGNIZED';raw.title='<img src=x onerror="window.INJECTED=true">';
      await page.route('**/api/incidents/*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(raw)}));
      await page.goto(url);await page.locator('#workspace').waitFor({state:'visible'});check((await page.locator('#case-title').innerText())===raw.title,'hostile title is literal text');check(await page.locator('#case-title img').count()===0,'unsafe HTML never parsed');check(!await page.evaluate(()=>window.INJECTED),'hostile event handler never runs');
      await page.unroute('**/api/incidents/*');await page.route('**/api/incidents/*',route=>route.fulfill({status:500,body:'{}'}));
      await page.goto(url);await page.locator('#load-status[role="alert"]').waitFor();check((await page.locator('#load-status').innerText()).includes('HTTP 500'),'API500 actionable error');check(await page.locator('#workspace').isHidden(),'API500 no synthetic success');
      await page.unroute('**/api/incidents/*');await page.route('**/api/incidents/*',route=>route.fulfill({status:200,contentType:'application/json',body:'{"broken":true}'}));
      await page.goto(url);await page.locator('#load-status[role="alert"]').waitFor();check(await page.locator('#workspace').isHidden(),'malformed API does not render a successful case');
      await page.close();
    }
    check(errors.length===0,'zero browser script errors');check(requests.every(r=>(r.url.startsWith(base)||(apiBase&&r.url.startsWith(apiBase)))&&r.method==='GET'),'only same-origin GET requests; zero provider/repair/model calls');
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:checks.length,checks,errors,requests},null,2));console.log(JSON.stringify({passed:checks.length,errors}));
  } finally {await browser.close();}
})().catch(e=>{fs.writeFileSync(path.join(output,'failure.txt'),String(e.stack));console.error(e);process.exitCode=1;});
