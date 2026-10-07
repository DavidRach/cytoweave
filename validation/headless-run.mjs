// Headless runs (cytoweave run): a template applied to a folder of FCS files without a window,
// checked against the same analysis done in the window and against Node.
//
// The PBMC example's twelve samples, an annotations table and the analysis of the templates suite
// saved as a template file (run-cases.mjs) are run twice with "cytoweave run"; then CytoWeave is
// started with the same files on its command line, as a user would, and in its window (a headless
// Chrome) the template is applied through its Apply dialog and every output exported with the
// window's own buttons and menus (the table's CSV, the Excel workbook, the batch report, the
// workspace file, the methods). The outputs must agree; each population's count in run.json must
// equal the count Node computes from the same files and template. Last, the window across
// workspaces: what only views do (state kept while another workspace is opened, work that
// finishes after it was).
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
  b = await launch();
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
  const c = run(join(temp, 'c'), ['--certificate', '--review']);
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
  // 5. The run's review report opened in Chrome: nothing requested beyond the file, no script
  // error, and a number's trace shown when it is clicked.
  const reviewPath = join(temp, 'c', 'review.html');
  const requests = [];
  const errors = [];
  b ??= await launch();
  await b.send('Network.enable');
  b.on('Network.requestWillBeSent', (event) => requests.push(event.request.url));
  b.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text));
  await b.goto(`file://${reviewPath}`, 3000);
  const opened = await b.eval(`(async () => {
    const numbers = document.querySelectorAll('button.n');
    const plot = document.querySelector('#plots button.n');
    plot?.click();
    await new Promise((r) => setTimeout(r, 200));
    return { numbers: numbers.length, figures: document.querySelectorAll('#plots figure.plot').length, trace: document.getElementById('trace').innerText };
  })()`);
  const outsideRequests = requests.filter((url) => !url.startsWith('data:') && url !== `file://${reviewPath}`);
  check('cytoweave run --review: the review report opened in Chrome requests nothing but itself, runs without errors, and shows a number\'s source when clicked', `${opened.numbers} traced numbers, ${opened.figures} plots; ${requests.length} requests (${outsideRequests.length} outside the file${outsideRequests.length ? `: ${outsideRequests.slice(0, 3).join(', ')}` : ''}); ${errors.length} errors; trace: ${opened.trace.split('\n').slice(1, 3).join(' / ')}`, existsSync(reviewPath) && outsideRequests.length === 0 && errors.length === 0 && opened.numbers > 500 && opened.figures > 0 && opened.figures % 12 === 0 && /% of parent/.test(opened.trace) && /SHA-256/.test(opened.trace), 'nothing outside; no errors; traced');

  // The report's accessibility (axe-core, WCAG 2.1 A and AA), in both themes.
  const AXE = join(ROOT, 'validation/cache/axe-core/axe.min.js');
  const audits = [];
  if (existsSync(AXE)) {
    await b.eval(`(0, eval)(${JSON.stringify(readFileSync(AXE, 'utf8'))}); true`);
    for (const dark of [false, true]) {
      await b.theme(dark);
      audits.push(...await b.eval(`(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })).violations.map((v) => '${dark ? 'dark' : 'light'} ' + v.id + ' (' + v.nodes.length + ')'))()`));
    }
    await b.theme(false);
  }
  check('the review report accessible (axe-core, WCAG 2.1 A and AA, light and dark)', existsSync(AXE) ? (audits.length ? audits.join(', ') : 'no violations') : 'axe-core missing (node validation/fetch.mjs axe-core)', existsSync(AXE) && audits.length === 0, 'no violations');

  // certificate.json edited inside the archive (a count raised by one).
  const entries = await readZip(lean.bytes);
  const edited = JSON.parse(new TextDecoder().decode(entries.get('certificate.json')));
  edited.numbers.counts.samples[0].values[0] += 1;
  entries.set('certificate.json', new TextEncoder().encode(JSON.stringify(edited)));
  writeFileSync(join(temp, 'edited.acs'), await createZip([...entries].map(([name, data]) => ({ name, data }))));
  const editedRun = verify(join(temp, 'edited.acs'), '--data', dataFolder);
  check('an edited certificate.json refused: not confirmed, exit 1', `exit ${editedRun.status}: ${editedRun.out.split('\n')[1] ?? editedRun.out}`, editedRun.status === 1 && /fingerprint does not match/.test(editedRun.out), 'exit 1');

  // 6. The window across workspaces. The suites above test the analyses; these test what only the
  // window does: views that keep state while another workspace is opened, and work that finishes
  // after it was opened. Each one failed before it was fixed.
  await b.goto(url, 3000);
  await waitFor('Boolean(window.cytoweave?.store)');
  const lifecycle = (code) => page(code);
  // A reload starts on the start page with a new workspace, the last one offered there.
  const start = await lifecycle(`await new Promise((r) => setTimeout(r, 1500));
    return { mode: app.store.ui.mode, samples: app.store.ws.samples.length, badge: [...document.querySelectorAll('.welcome-grid .badge')].some((e) => e.textContent === 'Last opened') };`);
  check('a reload starts on the start page with a new, empty workspace, the last one marked among the recent workspaces', `${start.mode}, ${start.samples} samples, ${start.badge ? 'last opened marked' : 'not marked'}`, start.mode === 'welcome' && start.samples === 0 && start.badge, 'start page, empty, marked');
  // Views opened on one workspace and shown again after another was opened while they were closed.
  await lifecycle(`await app.openExample('pbmc-immunophenotyping', { scale: 0.3 }); return true;`);
  await waitFor(`window.cytoweave.store.ws.samples.length > 20 && !document.querySelector('.progress-toast')`);
  const before = await lifecycle(`await app.setMode('explore'); await new Promise((r) => setTimeout(r, 800));
    await app.setMode('compare'); await new Promise((r) => setTimeout(r, 800));
    await app.setMode('qc'); await new Promise((r) => setTimeout(r, 800));
    app.qcState.settings.mad = 7;
    app.qcState.norm.result = { stale: true };
    await app.setMode('gate');
    return { markers: [...app.store.state.ui.explore.settings.markers], compare: app.store.ui.compare.groupBy };`);
  await lifecycle(`await app.openExample('plate-screen', {}); return true;`);
  await waitFor(`window.cytoweave.store.ws.name.startsWith('Drug screen') && window.cytoweave.store.ws.samples.length === 96 && !document.querySelector('.progress-toast')`);
  const after = await lifecycle(`await app.setMode('explore'); await new Promise((r) => setTimeout(r, 800));
    const channels = new Set(app.store.ws.samples[0].channels.map((c) => c.name));
    const markers = [...app.store.state.ui.explore.settings.markers];
    await app.setMode('compare'); await new Promise((r) => setTimeout(r, 800));
    const compare = app.store.ui.compare;
    await app.setMode('qc'); await new Promise((r) => setTimeout(r, 800));
    return { markers, foreign: markers.filter((m) => !channels.has(m)), run: Boolean(app.store.state.ui.explore.run), compareFresh: compare.generation === app.store.state.generation, groupBy: compare.groupBy, mad: app.qcState.settings.mad, normResult: Boolean(app.qcState.norm.result) };`);
  check('views shown again after another workspace was opened while they were closed: Explore, Compare and QC start from the new workspace (QC keeps its settings)', `Explore ${before.markers.length} → ${after.markers.length} markers (${after.foreign.length} the new samples lack), no old map: ${!after.run}; Compare grouped by ${before.compare} → ${after.groupBy}; QC settings kept: ${after.mad === 7}, old normalization shown: ${after.normResult}`, after.markers.length > 0 && !after.foreign.length && !after.run && after.compareFresh && after.groupBy !== before.compare && after.mad === 7 && !after.normResult, 'fresh state, settings kept');
  // A clustering and map still being computed when another workspace is opened: not added to it.
  // (A UMAP of 96 samples takes long enough to be running at the switch; every commit is logged
  // with the workspace it went to.)
  const late = await lifecycle(`await app.setMode('explore'); await new Promise((r) => setTimeout(r, 800));
    Object.assign(app.store.state.ui.explore.settings, { embedding: 'umap', clustering: 'kmeans', k: 4, perSample: 300 });
    const commits = [];
    const commit = app.store.commit;
    app.store.commit = function (next, label, topics) { commits.push(label + ' → ' + app.store.ws.name); return commit.call(this, next, label, topics); };
    const seen = new Set();
    const watch = setInterval(() => { for (const t of document.querySelectorAll('.toast')) seen.add(t.innerText.split('\\n')[0]); }, 100);
    [...document.querySelectorAll('main button')].find((e) => e.textContent.trim() === 'Run').click();
    await new Promise((r) => setTimeout(r, 1500));
    const running = /Running/.test(document.querySelector('main').innerText);
    await app.openExample('pbmc-immunophenotyping', { scale: 0.3 });
    const t0 = Date.now();
    while (Date.now() - t0 < 180000 && ![...seen].some((t) => /Another workspace was opened|Done:/.test(t))) await new Promise((r) => setTimeout(r, 250));
    clearInterval(watch);
    app.store.commit = commit;
    return { running, workspace: app.store.ws.name, derived: app.store.ws.derived.map((d) => d.kind), refused: [...seen].some((t) => /Another workspace was opened/.test(t)), commits };`);
  check('an Explore run still going when another workspace is opened: its result refused, not added to the new workspace', `running at the switch: ${late.running}; ${late.workspace} has ${late.derived.length ? late.derived.join(', ') : 'no derived results'}; ${late.refused ? 'refused with a message' : 'no message'}${late.refused ? '' : `; commits: ${late.commits.join('; ')}`}`, late.running && late.workspace.startsWith('PBMC') && !late.derived.length && late.refused, 'refused');
  // The same with a fast run (k-means and PCA) whose result is being stored when the other
  // workspace opens, at several delays: whatever the timing, nothing reaches the new workspace.
  const fast = await lifecycle(`const out = [];
    for (const delay of [0, 150, 400]) {
      await app.openExample('plate-screen', {});
      await new Promise((r) => setTimeout(r, 1500));
      await app.setMode('explore'); await new Promise((r) => setTimeout(r, 600));
      Object.assign(app.store.state.ui.explore.settings, { embedding: 'pca', clustering: 'kmeans', k: 4, perSample: 300 });
      [...document.querySelectorAll('main button')].find((e) => e.textContent.trim() === 'Run').click();
      await new Promise((r) => setTimeout(r, delay));
      await app.openExample('pbmc-immunophenotyping', { scale: 0.3 });
      await new Promise((r) => setTimeout(r, 2500));
      out.push({ delay, derived: app.store.ws.derived.map((d) => d.kind) });
    }
    return out;`);
  check('a fast Explore run whose result is being stored when another workspace opens (switch after 0, 150 and 400 ms): nothing added to the new workspace', fast.map((x) => `${x.delay} ms: ${x.derived.length ? x.derived.join(', ') : 'clean'}`).join('; '), fast.every((x) => !x.derived.length), 'clean every time');
  // Two examples opened in quick succession: the second holds only its own files.
  const quick = await lifecycle(`const first = app.openExample('cell-cycle', {}); await new Promise((r) => setTimeout(r, 150));
    const second = app.openExample('plate-screen', {}); await Promise.all([first, second]); await new Promise((r) => setTimeout(r, 1000));
    return { name: app.store.ws.name, samples: app.store.ws.samples.length, foreign: app.store.ws.samples.filter((s) => /Asynchronous|Nocodazole/.test(s.name)).length };`);
  check('two examples opened in quick succession are not mixed', `${quick.name}: ${quick.samples} samples, ${quick.foreign} of the other example's`, quick.name.startsWith('Drug screen') && quick.samples === 96 && quick.foreign === 0, 'only its own');
  // A per-sample result in the inspector, with samples as real files give them (one shared
  // compensation, no simulated truth channel): the same view version for every sample.
  const robust = await lifecycle(`await app.openExample('pbmc-immunophenotyping', { scale: 0.3 });
    const { addCompensation, addGates, setSampleCompensation } = await import('/lib/workspace.js');
    const { generateExample } = await import('/lib/examples.js');
    let ws = app.store.ws;
    ws = addGates(ws, generateExample('pbmc-immunophenotyping', { samples: ['Unstained.fcs'] }).workspaceHints.suggestedGates.map((g) => ({ ...g, overrides: {} })), 'add-suggested-gates').ws;
    const samples = ws.samples.filter((s) => s.role === 'sample');
    const channels = samples[0].channels.filter((c) => c.type === 'fluorescence').map((c) => c.name);
    const added = addCompensation(ws, { name: 'Shared', channels, matrix: channels.flatMap((_, i) => channels.map((__, j) => (i === j ? 1 : 0))), source: 'manual' });
    app.store.commit(setSampleCompensation(added.ws, samples.map((s) => s.id), added.compensation.id), 'Shared compensation');
    app.data.removeDerived('Truth (simulated)');
    const lymphocytes = app.store.ws.gates.find((g) => g.name === 'Lymphocytes').id;
    const button = () => [...document.querySelectorAll('button')].find((e) => /Check boundary robustness/.test(e.textContent));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    app.selectSample(samples[0].id); app.selectGate(lymphocytes); await app.data.ensure(samples[0].id); await app.data.ensure(samples[1].id); await wait(1500);
    button().click(); await wait(800);
    const shared = app.data.view(samples[0].id).version === app.data.view(samples[1].id).version;
    app.selectSample(samples[1].id); await wait(1500);
    return { shared, offered: Boolean(button()) };`);
  check('the inspector\'s boundary robustness of one sample is not shown for another (samples sharing a view version)', `versions shared: ${robust.shared}; the other sample ${robust.offered ? 'offers its own check' : 'shows the first one\'s result'}`, robust.shared && robust.offered, 'its own');
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
