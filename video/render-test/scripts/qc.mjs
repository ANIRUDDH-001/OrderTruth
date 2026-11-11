import fs from 'node:fs';
import assert from 'node:assert/strict';
const [mode, file] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const publicReport = {mode, ok: r.ok === true, browserSkipped: r.browserSkipped, sections: {}};
const names = mode === 'lint' ? ['lint'] : ['lint','runtime','layout','motion','contrast','craft','audio'];
let accepted = r.ok === true;
for (const name of names) {
  const s = mode === 'lint' ? r : r[name];
  if (!s) { accepted = false; continue; }
  publicReport.sections[name] = {ok:s.ok,errorCount:s.errorCount,warningCount:s.warningCount,
    enabled:s.enabled, samples:s.samples, findings:(s.findings ?? []).map(f=>({code:f.code,severity:f.severity}))};
  if (s.ok !== true || s.errorCount !== 0) accepted = false;
  // Approved five-second timing has one known craft warning. Any new warning stops the test.
  if ((s.findings ?? []).some(f => f.severity === 'warning' && !(name === 'craft' && f.code === 'line_unread'))) accepted = false;
}
if (mode === 'check' && (r.browserSkipped !== false || !Array.isArray(r.layout?.samples) || r.layout.samples.length < 9 || r.contrast?.enabled !== true)) accepted = false;
publicReport.accepted = accepted;
fs.writeFileSync(`qc/${mode}-public.json`,JSON.stringify(publicReport,null,2));
assert(accepted, `${mode} gate rejected; inspect finding codes`);
