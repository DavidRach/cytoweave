// Headless runs (cytoweave run): a template applied to a folder of FCS files without a window,
// checked against the same analysis done in the window and against Node.
//
// The PBMC example's twelve samples, an annotations table and the analysis of the templates suite
// saved as a template file (run-cases.mjs) are run twice with "cytoweave run"; then CytoWeave is
// started with the same files on its command line, as a user would, and in its window (a headless
// Chrome) the template is applied through its Apply dialog and every output exported with the
// window's own buttons and menus (the table's CSV, the Excel workbook, the batch report, the
// workspace file, the methods). The outputs must agree; each population's count in run.json must
// equal the count Node computes from the same files and template.
//
//   node validation/headless-run.mjs [--verbose]
//
// Needs Go (to build CytoWeave from source) and Chrome, Chromium, Edge or Brave (CHROME=path).
// Exits with status 1 when a check fails.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, findChrome, sleep } from '../docs/capture/cdp.mjs';
import { readPDF, readXLSX } from './document-readers.mjs';
import { writeRunInputs } from './run-cases.mjs';
import { countsOf, loadSamples } from './template-cases.mjs';
import { applyTemplate } from '../web/lib/templates.js';
import { gatePath } from '../web/lib/workspace.js';
import { buildCertificate, readCertificate, shortFingerprint, verifyCertificate } from '../web/lib/certificate.js';
import { createZip, readZip } from '../web/lib/zip.js';
import { certifiableExample } from './certificate-cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8797;
const verbose = process.argv.includes('--verbose');
const results = [];
function check(name, value, ok, required) {
  results.push({ name, ok });
  if (verbose || !ok) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${value} (required ${required})`);
}

const temp = mkdtempSync(join(tmpdir(), 'cytoweave-run-'));
const binary = join(temp, process.platform === 'win32' ? 'cytoweave.exe' : 'cytoweave');
let server = null;
let b = null;

function run(output, extra = []) {
  const started = performance.now();
  const result = spawnSync(binary, ['run', '--template', inputs.template, '--annotations', inputs.annotations, '--output', output, '--chrome', findChrome(), ...extra, inputs.fcs], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, seconds: (performance.now() - started) / 1000 };
}

async function waitFor(expression, timeout = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await b.eval(expression)) return;
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

// A download of the window: waits until a file with this name is complete in the folder.
async function downloaded(folder, name, timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const path = join(folder, name);
    if (existsSync(path) && !readdirSync(folder).some((f) => f.endsWith('.crdownload'))) {
      const size = statSync(path).size;
      await sleep(300);
      if (statSync(path).size === size && size > 0) return path;
    }
    await sleep(300);
  }
  throw new Error(`The window did not download ${name}`);
}

// A download named by the window (after the workspace, the figure): the first file with this
// extension.
async function downloadedLike(folder, extension, timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const name = readdirSync(folder).find((f) => f.endsWith(extension));
    if (name) return downloaded(folder, name, timeout);
    await sleep(300);
  }
  throw new Error(`The window did not download a ${extension} file`);
}

// The workspace as the outputs show it, without the ids and times that differ between sessions.
function canonical(ws) {
  const name = (id) => (id ? gatePath(ws, id) : null);
  return {
    samples: ws.samples.map((s) => ({ name: s.name, sha256: s.sha256, meta: s.meta, compensation: s.compensationId })),
    gates: ws.gates.map((g) => ({ path: gatePath(ws, g.id), parent: name(g.parentId), type: g.type, dims: g.dims, geometry: g.geometry?.operands ? { ...g.geometry, operands: g.geometry.operands.map(name) } : g.geometry, meta: Object.fromEntries(Object.entries(g.meta ?? {}).filter(([k]) => k !== 'created')) })),
    tables: ws.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ population: name(c.gateId), stat: c.stat, channel: c.channel ?? null })) })),
    figures: ws.figures.map((f) => ({ name: f.name, items: f.items.map((i) => i.kind) })),
    channelSettings: ws.channelSettings,
    proposals: (ws.proposals ?? []).filter((p) => !p.closed).length,
  };
}

// A PDF's pages and the text on them.
function pdfText(path) {
  const { pages } = readPDF(readFileSync(path));
  return { pages: pages.length, text: pages.map((p) => p.strings.join('\n')).join('\f') };
}

// The values of every sheet but About (which holds the export's date).
function sheetValues(book) {
  return book.sheets.filter((s) => !/^About/i.test(s.name)).map((s) => ({ name: s.name, rows: s.rows }));
}

const inputs = writeRunInputs(join(temp, 'in'));
try {
  const build = spawnSync('go', ['build', '-o', binary, '.'], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`);

  // 1. Two headless runs.
  const a = run(join(temp, 'a'));
  const b2 = run(join(temp, 'b'));
  const record = JSON.parse(readFileSync(join(temp, 'a', 'run.json'), 'utf8'));
  const expected = ['tables.xlsx', 'Frequencies.csv', 'report.pdf', 'workspace.cwz', 'methods.txt', 'run.json'];
  check('cytoweave run: exits 0 and writes the tables, report, workspace, methods and run.json', `exit ${a.status} in ${a.seconds.toFixed(1)} s; ${readdirSync(join(temp, 'a')).sort().join(', ')}${a.status ? `; ${a.stderr.trim()}` : ''}`, a.status === 0 && expected.every((f) => existsSync(join(temp, 'a', f))) && record.ok, 'exit 0, all written');
  check('run.json: every input with its checksum, each step ok, every output with its size and checksum', `${record.inputs.length} inputs, ${record.steps.filter((s) => s.ok).length} of ${record.steps.length} steps ok, ${record.outputs.length} outputs`, record.inputs.length === 13 && record.inputs.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)) && record.steps.every((s) => s.ok) && record.outputs.length === 5 && record.template?.sha256, '13 inputs; all ok; 5 outputs');
  const same = (file) => readFileSync(join(temp, 'a', file)).equals(readFileSync(join(temp, 'b', file)));
  const workspaceA = canonical(JSON.parse(readFileSync(join(temp, 'a', 'workspace.cwz'), 'utf8')));
  const workspaceB = canonical(JSON.parse(readFileSync(join(temp, 'b', 'workspace.cwz'), 'utf8')));
  const pdfA = pdfText(join(temp, 'a', 'report.pdf'));
  const pdfB = pdfText(join(temp, 'b', 'report.pdf'));
  check('a second run of the same files gives the same outputs', `CSV ${same('Frequencies.csv') ? 'identical' : 'differs'}, methods ${same('methods.txt') ? 'identical' : 'differs'}, workbook ${JSON.stringify(sheetValues(await readXLSX(readFileSync(join(temp, 'a', 'tables.xlsx'))))) === JSON.stringify(sheetValues(await readXLSX(readFileSync(join(temp, 'b', 'tables.xlsx'))))) ? 'same values' : 'differs'}, report ${pdfA.text === pdfB.text ? 'same text' : 'differs'}, workspace ${JSON.stringify(workspaceA) === JSON.stringify(workspaceB) ? 'same' : 'differs'} (exit ${b2.status})`, b2.status === 0 && same('Frequencies.csv') && same('methods.txt') && pdfA.text === pdfB.text && JSON.stringify(workspaceA) === JSON.stringify(workspaceB), 'identical');

  // 2. The same analysis in the window.
  const data = join(temp, 'window-library');
  server = spawn(binary, ['--window', 'none', '--port', String(PORT), '--data-dir', data, inputs.fcs, inputs.annotations], { stdio: ['ignore', 'pipe', 'pipe'] });
  let url = null;
  server.stdout.on('data', (chunk) => {
    const m = /running at (http:\/\/\S+)/.exec(String(chunk));
    if (m) url = `${m[1]}/`;
  });
  for (let i = 0; i < 100 && !url; i += 1) await sleep(200);
  if (!url) throw new Error('CytoWeave did not start');
  b = await launch({ port: 9341 });
  const downloads = join(temp, 'window');
  mkdirSync(downloads);
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await b.goto(url, 3000);
  const page = (code) => b.eval(`(async () => { const app = window.cytoweave; ${code} })()`);
  await waitFor(`window.cytoweave?.store.ws.samples.length === 12 && window.cytoweave.store.ws.samples.every((s) => s.meta?.subject) && !document.querySelector('.progress-toast')`);
  const text = readFileSync(inputs.template);
  await page(`await app.openTemplateFile({ name: 'panel.cwt', bytes: new Uint8Array(${JSON.stringify([...text])}) }); return true;`);
  await waitFor(`[...document.querySelectorAll('.dialog button')].some((e) => e.textContent.trim() === 'Apply')`);
  await page(`[...document.querySelectorAll('.dialog button')].find((e) => e.textContent.trim() === 'Apply').click(); return true;`);
  await waitFor('window.cytoweave.store.ws.gates.length === 19');
  // The table's CSV from the Tables view's button (after computing every sample).
  await page(`await app.setMode('tables'); return true;`);
  await sleep(800);
  await page(`[...document.querySelectorAll('button')].find((e) => /^Compute all/.test(e.textContent.trim()))?.click(); return true;`);
  await waitFor(`!document.querySelector('.progress-toast') && ![...document.querySelectorAll('button')].some((e) => /^Compute all/.test(e.textContent.trim()))`);
  await page(`[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'CSV').click(); return true;`);
  const csv = await downloaded(downloads, 'Frequencies.csv');
  // The Excel workbook (File menu → Tables as an Excel workbook).
  await page(`const m = await import('/ui/mode-tables.js'); await m.exportTablesWorkbook(app); return true;`);
  const xlsx = await downloadedLike(downloads, '.xlsx');
  // The batch report (Figures → Batch report… → Export), with the dialog's choices.
  await page(`const { batchReportDialog } = await import('/ui/report-dialog.js'); batchReportDialog(app, app.store.ws.figures.at(-1)); return true;`);
  await waitFor(`[...document.querySelectorAll('.dialog button')].some((e) => e.textContent.trim() === 'Export')`);
  await page(`[...document.querySelectorAll('.dialog button')].find((e) => e.textContent.trim() === 'Export').click(); return true;`);
  const pdf = await downloadedLike(downloads, '.pdf');
  // The workspace file (command palette → Export workspace file) and the methods (Report → Methods → Markdown).
  await page(`app.commands().find((c) => c.label === 'Export workspace file').run(); return true;`);
  const cwz = await downloadedLike(downloads, '.cwz');
  await page(`await app.setMode('report'); return true;`);
  await sleep(1000);
  await page(`[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Markdown').click(); return true;`);
  const methods = await downloaded(downloads, 'methods.md');

  const out = (f) => join(temp, 'a', f);
  check('the table as the window\'s CSV button writes it: the same bytes', `${readFileSync(csv).equals(readFileSync(out('Frequencies.csv'))) ? 'identical' : 'differs'} (${statSync(csv).size} bytes)`, readFileSync(csv).equals(readFileSync(out('Frequencies.csv'))), 'identical');
  const bookWindow = sheetValues(await readXLSX(readFileSync(xlsx)));
  const bookRun = sheetValues(await readXLSX(readFileSync(out('tables.xlsx'))));
  check('the Excel workbook as the window exports it: every sheet\'s values the same (About, with the export\'s date, left out)', `${bookRun.map((s) => s.name).join(', ')}: ${JSON.stringify(bookWindow) === JSON.stringify(bookRun) ? 'same' : 'differ'}`, JSON.stringify(bookWindow) === JSON.stringify(bookRun), 'same');
  const reportWindow = pdfText(pdf);
  check('the batch report as the window\'s dialog exports it: the same pages and text', `${reportWindow.pages} and ${pdfA.pages} pages; text ${reportWindow.text === pdfA.text ? 'the same' : 'differs'}`, reportWindow.pages === pdfA.pages && reportWindow.text === pdfA.text && pdfA.pages === 12, '12 pages, same text');
  const workspaceWindow = canonical(JSON.parse(readFileSync(cwz, 'utf8')));
  const differences = Object.keys(workspaceA).filter((k) => JSON.stringify(workspaceA[k]) !== JSON.stringify(workspaceWindow[k]));
  check('the workspace file as the window saves it: samples, annotations, gates, tables, figures and scales the same', differences.length ? `differs in ${differences.join(', ')}` : `the same (${workspaceA.gates.length} populations, no open proposals)`, !differences.length && workspaceA.proposals === 0, 'the same');
  check('the methods as the window\'s Report view writes them', readFileSync(methods, 'utf8').trim() === readFileSync(out('methods.txt'), 'utf8').trim() ? 'the same text' : 'differs', readFileSync(methods, 'utf8').trim() === readFileSync(out('methods.txt'), 'utf8').trim(), 'the same');

  // 3. Every population's count against Node.
  const { ws: loaded, views } = loadSamples(inputs.files, 'node');
  const applied = applyTemplate(loaded, inputs.templateValue, { scales: 'keep' }).ws;
  const node = countsOf(applied, views);
  const rows = record.steps.find((s) => s.action === 'statistics_table').data.rows;
  let compared = 0;
  let differing = 0;
  for (const row of rows) {
    for (const [path, count] of Object.entries(row.values)) {
      compared += 1;
      if (node.get(path)?.get(row.sample) !== count) differing += 1;
    }
  }
  check('every population\'s count in run.json equal to Node\'s from the same files and template', `${compared - differing} of ${compared}`, compared === 12 * 19 && differing === 0, 'all');

  // 4. Certificates: a run's certificate verified in Node and by cytoweave verify; a certificate
  // made in Node verified by cytoweave verify, without its files and with them; one edited, refused.
  const verify = (...args) => {
    const result = spawnSync(binary, ['verify', '--chrome', findChrome(), ...args], { encoding: 'utf8' });
    return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() };
  };
  const c = run(join(temp, 'c'), ['--certificate']);
  const certificatePath = join(temp, 'c', 'certificate.acs');
  const fromRun = existsSync(certificatePath) ? await readCertificate(readFileSync(certificatePath)) : null;
  const inNode = fromRun ? await verifyCertificate(fromRun, { version: fromRun.certificate.software.version }) : null;
  const saved = JSON.parse(readFileSync(join(temp, 'c', 'workspace.cwz'), 'utf8'));
  const logged = fromRun && saved.provenance.some((e) => e.action === 'certify' && e.detail.includes(shortFingerprint(fromRun.certificate.fingerprint)));
  check('cytoweave run --certificate: the window\'s certificate confirmed in Node, bit for bit, and recorded in the workspace\'s change log', fromRun ? `exit ${c.status}; ${inNode.summary}${logged ? ' Recorded in workspace.cwz.' : ' Not in the log.'}` : `no certificate (exit ${c.status}: ${c.stderr.trim()})`, c.status === 0 && inNode?.verdict === 'confirmed' && inNode.numbers.same + inNode.numbers.close === fromRun.certificate.total && logged, 'confirmed, recorded');
  const ofRun = verify(certificatePath);
  check('cytoweave verify of that certificate: confirmed, exit 0', `exit ${ofRun.status}: ${ofRun.out.split('\n')[1] ?? ofRun.out}`, ofRun.status === 0 && /Confirmed/.test(ofRun.out), 'exit 0');
  const example = await certifiableExample('pbmc-immunophenotyping');
  const dataFolder = join(temp, 'certificate-data');
  mkdirSync(dataFolder);
  for (const s of example.ws.samples) writeFileSync(join(dataFolder, s.fileName), example.files.get(s.sha256));
  const lean = await buildCertificate(example.ws, example.source, { version: 'validation', includeData: false });
  writeFileSync(join(temp, 'lean.acs'), lean.bytes);
  const without = verify(join(temp, 'lean.acs'));
  const withData = verify(join(temp, 'lean.acs'), '--data', dataFolder, '--report', join(temp, 'verification.json'));
  const written = existsSync(join(temp, 'verification.json')) ? JSON.parse(readFileSync(join(temp, 'verification.json'), 'utf8')) : null;
  check('a certificate made in Node (stored k-means clusters and a saved comparison) verified by cytoweave verify in Chrome: without its files incomplete (exit 3), with --data confirmed (exit 0; numbers through logarithms may differ between the engines in the last digits) and the report written', `exit ${without.status}, then ${withData.status}; report: ${written ? `${written.verdict}, ${written.numbers.identical} of ${written.numbers.checked} numbers identical and ${written.numbers.equalTo12Digits} equal to 12 digits (largest relative difference ${written.numbers.largestRelativeDifference.toExponential(1)}; ${written.engines.certificate} and ${written.engines.verifier})` : 'missing'}`, without.status === 3 && withData.status === 0 && written?.verdict === 'confirmed' && written.numbers.identical + written.numbers.equalTo12Digits === lean.certificate.total, 'exit 3, then 0');
  // certificate.json edited inside the archive (a count raised by one).
  const entries = await readZip(lean.bytes);
  const edited = JSON.parse(new TextDecoder().decode(entries.get('certificate.json')));
  edited.numbers.counts.samples[0].values[0] += 1;
  entries.set('certificate.json', new TextEncoder().encode(JSON.stringify(edited)));
  writeFileSync(join(temp, 'edited.acs'), await createZip([...entries].map(([name, data]) => ({ name, data }))));
  const editedRun = verify(join(temp, 'edited.acs'), '--data', dataFolder);
  check('an edited certificate.json refused: not confirmed, exit 1', `exit ${editedRun.status}: ${editedRun.out.split('\n')[1] ?? editedRun.out}`, editedRun.status === 1 && /fingerprint does not match/.test(editedRun.out), 'exit 1');
} catch (error) {
  check('the session ran', error.stack?.split('\n').slice(0, 3).join(' | ') ?? error.message, false, 'no error');
} finally {
  await b?.close();
  server?.kill();
  rmSync(temp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} headless-run checks passed.`);
if (failed.length) process.exit(1);
