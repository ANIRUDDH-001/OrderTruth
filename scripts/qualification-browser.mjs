/** Reusable workflows for Codex's built-in browser Tab API, not a DOM mock.
 * Invoke from cua_repl with a bound tab. All interactions remain on loopback.
 * Locators match the integrated Phase 1 UI; payment provenance is never rewritten.
 */
const origin = 'http://127.0.0.1:3003';
function local(url) { const parsed = new URL(url); if (parsed.origin !== origin) throw Error('Local qualification only'); }
async function button(tab,name) { await tab.playwright.getByRole('button',{ name,exact: true }).click(); await tab.getAXState({emit:false}); }
async function visible(tab,text) { await tab.playwright.getByText(text,{ exact: true }).waitFor({ state: 'visible',timeoutMs: 15000 }); }
export async function startup(tab) {
  await tab.goto(origin+'/qualification/'); await tab.getAXState({emit:false});
  await button(tab,'Start local test session and fixture');
  await visible(tab,'Synthetic qualification observation');
  const url = await tab.url(); local(url); return { url,provenance: 'SYNTHETIC_QUALIFICATION' };
}
export async function readOnlyLoad(tab,url) {
  local(url); await tab.goto(url); await tab.getAXState({emit:false});
  await visible(tab,'Synthetic qualification observation');
  await button(tab,'Resume/Recheck Case');
  return { url: await tab.url(),console: await tab.dev.logs({ levels: ['error','warn'],limit: 20 }) };
}
export async function controlledJourney(tab) {
  local(await tab.url());
  await button(tab,'Introduce duplicate');
  await tab.playwright.getByRole('button',{name:'Detect anomaly',exact:true}).waitFor({state:'visible',timeoutMs:15000});
  await button(tab,'Detect anomaly');
  await tab.playwright.getByRole('button',{name:'Review exact repair plan',exact:true}).waitFor({state:'visible',timeoutMs:15000});
  await button(tab,'Investigate with AI'); // Disabled adapter must return honest unavailable + baseline.
  await button(tab,'Review exact repair plan');
  await tab.playwright.getByRole('button',{name:'Approve this exact merchant-only plan',exact:true}).waitFor({state:'visible',timeoutMs:15000});
  await button(tab,'Approve this exact merchant-only plan');
  await tab.playwright.getByRole('button',{name:'Execute approved local repair',exact:true}).waitFor({state:'visible',timeoutMs:15000});
  await button(tab,'Execute approved local repair');
  await tab.playwright.getByRole('heading',{ name: 'Merchant correction verified',exact: true }).waitFor({ state: 'visible',timeoutMs: 15000 });
  return { url: await tab.url(),console: await tab.dev.logs({ levels: ['error','warn'],limit: 20 }) };
}
export async function reopenReceipt(tab,url) {
  local(url); await tab.goto(url); await tab.getAXState({emit:false});
  await tab.playwright.getByRole('heading',{ name: 'Merchant correction verified',exact: true }).waitFor({ state: 'visible',timeoutMs: 15000 });
  await button(tab,'Recheck committed receipt');
  return { url: await tab.url(),console: await tab.dev.logs({ levels: ['error','warn'],limit: 20 }) };
}
