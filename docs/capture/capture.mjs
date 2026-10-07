// Captures the documentation screenshots from the bundled examples, in the light and dark themes,
// as docs/images/<scene>-<theme>.webp: the README shows the one matching the reader's theme, and
// the website (docs/site/build.mjs copies them) the one matching the page's. It starts its own
// CytoWeave (built from source, with an empty library), so every run gives the same pictures.
//
//   node docs/capture/capture.mjs [scene …] [--theme light|dark|both] [--audit [--no-shots]]
//
// --audit runs axe-core (fetched by node validation/fetch.mjs axe-core) in every scene, with the
// WCAG 2.1 A and AA rules, and writes the violations to docs/capture/audit.json (one entry per
// scene and theme) and a summary to the console; with --no-shots, no picture is written.
//
// Needs Go (to run CytoWeave from source) and Chrome, Chromium, Edge or Brave (CHROME=path).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';
import { generateExample } from '../../web/lib/examples.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGES = join(ROOT, 'docs/images');
const PORT = 8790;
let URL = `http://127.0.0.1:${PORT}/`;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const themes = { light: ['light'], dark: ['dark'], both: ['light', 'dark'] }[option('theme') ?? 'both'];
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--theme');
const audit = args.includes('--audit');
const shots = !args.includes('--no-shots');
const AXE = join(ROOT, 'validation/cache/axe-core/axe.min.js');
if (audit && !existsSync(AXE)) throw new Error('axe-core is missing: run node validation/fetch.mjs axe-core');

// --- CytoWeave ------------------------------------------------------------------------------------

// Built and run directly (not with `go run`, whose child would outlive it), on the port it reports:
// another program on PORT moves it to the next free one.
async function startCytoWeave() {
  const temp = mkdtempSync(join(tmpdir(), 'cytoweave-capture-'));
  const library = join(temp, 'library');
  const binary = join(temp, process.platform === 'win32' ? 'cytoweave.exe' : 'cytoweave');
  await new Promise((done, fail) => spawn('go', ['build', '-o', binary, '.'], { cwd: ROOT, stdio: 'inherit' }).on('exit', (code) => (code ? fail(new Error('go build failed (is Go installed?)')) : done())));
  const server = spawn(binary, ['--dev', '--remote-control', '--window', 'none', '--port', String(PORT), '--data-dir', library], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  const stop = () => { server.kill(); rmSync(temp, { recursive: true, force: true }); };
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 300; i += 1) {
    const address = /running at (http:\/\/[\d.]+:\d+)/.exec(output)?.[1];
    if (address) {
      URL = `${address}/`;
      try {
        if ((await fetch(`${URL}api/info`)).ok) return { stop };
      } catch { /* starting */ }
    }
    await sleep(200);
  }
  stop();
  throw new Error('CytoWeave did not start.');
}

// An action as an AI agent would send it (remote control), under the agent's name.
async function agent(action, actionArgs = {}, client = 'Claude Code') {
  const response = await fetch(`${URL}api/remote/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args: actionArgs, client }) });
  const result = await response.json();
  if (!result.ok) throw new Error(`${action}: ${result.message ?? result.error}`);
  return result;
}

// --- Page helpers ---------------------------------------------------------------------------------

let b;
const js = (expression) => b.eval(expression);
const app = (code) => js(`(async () => { const app = window.cytoweave; ${code} })()`);
const mainText = `(document.querySelector('main')?.innerText ?? '')`;

async function waitFor(expression, timeout = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await js(expression)) return true;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function click(text, scope = 'button') {
  const ok = await js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.offsetParent !== null && e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`No ${scope} "${text}"`);
  await sleep(400);
}

async function example(id, { gates = true, options = {} } = {}) {
  await app(`await app.openExample(${JSON.stringify(id)}, ${JSON.stringify(options)});`);
  await waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.progress-toast')`, 240000);
  await sleep(1500);
  if (gates) {
    await click('Add suggested gates');
    await sleep(1500);
  }
}

const mode = async (name, wait = 1800) => {
  await app(`await app.setMode(${JSON.stringify(name)});`);
  await sleep(wait);
};
const selectSample = async (name) => {
  await app(`app.selectSample(app.store.ws.samples.find((s) => s.name === ${JSON.stringify(name)}).id);`);
  await sleep(1500);
};
const selectGate = async (name) => {
  await app(`app.selectGate(${name ? `app.store.ws.gates.find((g) => g.name === ${JSON.stringify(name)}).id` : 'null'});`);
  await sleep(1800);
};
const scrollTo = async (selector, block = 'start') => {
  await js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: ${JSON.stringify(block)} })`);
  await sleep(800);
};
const clearToasts = () => js(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
const gateId = (name) => `app.store.ws.gates.find((g) => g.name === ${JSON.stringify(name)}).id`;
const sampleId = (name) => `app.store.ws.samples.find((s) => s.name === ${JSON.stringify(name)}).id`;

// Adds a plot of a population on two markers (or channels) of the current sample.
async function addPlot(population, x, y = null, type = 'pseudocolor') {
  await app(`
    const { addPlot } = await import('/lib/workspace.js');
    const view = app.data.view(app.store.ui.sampleId);
    const channel = (m) => (m ? view.parameters.find((p) => p.marker === m || p.name === m)?.name : null);
    const populationId = ${population ? gateId(population) : "'root'"};
    app.store.commit(addPlot(app.store.ws, { populationId, x: channel(${JSON.stringify(x)}), y: channel(${JSON.stringify(y)}), type: ${JSON.stringify(type)} }).ws, 'Add plot', ['plots']);
  `);
  await sleep(1500);
}

// Chooses the option (matching text or value) of the select labeled `label` in the main view.
async function choose(label, match) {
  const ok = await js(`(() => {
    const select = [...document.querySelectorAll('main select, .dialog select')].find((s) => (s.closest('label, .field')?.querySelector('span, .field-label')?.textContent?.trim() ?? s.getAttribute('aria-label')) === ${JSON.stringify(label)});
    if (!select) return false;
    const re = new RegExp(${JSON.stringify(match)});
    const option = [...select.options].find((o) => re.test(o.textContent.trim()) || re.test(o.value));
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`No option ${match} in "${label}"`);
  await sleep(1200);
}

// Accepts every open proposal, as the user would from the review strip.
async function acceptProposals() {
  await app(`const { acceptProposal, openProposals } = await import('/lib/proposals.js'); for (const p of openProposals(app.store.ws)) app.store.commit(acceptProposal(app.store.ws, p.id), 'Accept');`);
  await sleep(1200);
}

// As a user would: compute the matrix from the single-stain controls and apply it to every sample.
async function compensateFromControls() {
  await mode('compensate');
  await click('Compute spillover');
  await waitFor(`window.cytoweave.store.ws.compensations.length > 0`);
  await sleep(1200);
  await click('Apply to');
  await click('All samples', 'button.menu-item');
  await sleep(1200);
}

// --- Scenes ---------------------------------------------------------------------------------------
//
// Each scene starts from a fresh page and leaves the window as it should be captured.

const scenes = {
  // The start page: examples and the ways to open data. First, while the library is empty.
  async start() {
    await mode('welcome', 1500);
  },
  // The Gate view: the gating path of T cells in the PBMC example.
  async gate() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('gate');
    await selectGate('T cells');
    await addPlot('T cells', 'CD45RA', 'CCR7');
  },
  // Compensation diagnostics: the planted APC → Alexa Fluor 700 error, found from the controls.
  async compensate() {
    await example('pbmc-immunophenotyping');
    await selectGate('Lymphocytes');
    await mode('compensate');
    await click('Check against the controls');
    await waitFor(`Boolean(document.querySelector('.lean'))`);
    await sleep(1200);
    await scrollTo('.lean', 'center');
  },
  // Spectral: reference spectra from the controls and autofluorescence signatures.
  async spectral() {
    await example('spectral-25color', { gates: false });
    await mode('spectral');
    await waitFor(`/Gate all controls/.test(${mainText})`, 60000);
    await click('Gate all controls');
    await waitFor(`/Extract signatures/.test(${mainText})`, 300000);
    await sleep(1500);
    await click('Extract signatures');
    await waitFor(`/Extract again/.test(${mainText})`, 300000);
    await sleep(2500);
  },
  // The unmixing doctor on the spectral example with PE-Cy7 degraded by 10% in the samples.
  async doctor() {
    await example('spectral-25color', { gates: false, options: { tandemDegradation: { 'PE-Cy7': 0.1 }, degradationIn: 'samples' } });
    await mode('spectral');
    await waitFor(`/Gate all controls/.test(${mainText})`, 60000);
    await click('Gate all controls');
    await waitFor(`/Extract signatures/.test(${mainText})`, 300000);
    await sleep(1500);
    await click('Extract signatures');
    await waitFor(`/Extract again/.test(${mainText})`, 300000);
    await sleep(1500);
    await app(`app.selectSample(app.store.ws.samples.find((s) => s.role === 'sample').id);`);
    await sleep(800);
    await click('Diagnose');
    await sleep(800);
    await js(`[...document.querySelectorAll('main button.btn.primary')].find((e) => e.textContent.trim() === 'Diagnose')?.click()`);
    await waitFor(`/the most likely first|No fault found/.test(${mainText})`, 300000);
    await sleep(2000);
    await js(`[...document.querySelectorAll('main h3')].find((e) => /^Diagnosis/.test(e.textContent.trim()))?.scrollIntoView({ block: 'start' })`);
    await sleep(800);
  },
  // Kinetics: the Indo-1 ratio of T cells after the high anti-CD3 dose, the other tubes overlaid.
  async kinetics() {
    await example('calcium-flux');
    await selectSample('aCD3_high');
    await mode('gate');
    await selectGate('T cells');
    await app(`const m = await import('/ui/kinetics.js'); m.openKinetics(app, app.store.ui.gateId, app.store.ui.sampleId);`);
    await sleep(3000);
    await js(`[...document.querySelectorAll('.kinetics-overlay label')].filter((l) => /Buffer|aCD3_low|Ionomycin/.test(l.textContent) && !/injected/.test(l.textContent)).forEach((l) => l.querySelector('input').click())`);
    await sleep(3500);
    await js(`[...document.querySelectorAll('.dialog h3')].find((e) => /^Kinetics/.test(e.textContent.trim()))?.scrollIntoView({ block: 'start' })`);
    await sleep(800);
  },
  // Acquisition QC of the QC plate, with a clogged well open.
  async qc() {
    await example('qc-showcase', { gates: false });
    await mode('qc');
    await click('Run QC on');
    await waitFor(`!document.querySelector('.progress-toast') && /Cohort overview/.test(${mainText}) && !/not checked/.test(${mainText})`);
    await sleep(2500);
    await js(`(() => { const row = [...document.querySelectorAll('main *')].find((e) => e.children.length < 6 && /^A02/.test(e.textContent.trim()) && e.offsetParent); row?.click(); })()`);
    await sleep(2500);
  },
  // Explore: FlowSOM clusters on a UMAP of live cells from 12 samples, with the faithfulness report.
  async explore() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await selectGate('Live');
    await mode('explore');
    await click('Run');
    await waitFor(`/How faithful/.test(${mainText}) && /Trustworthiness/.test(${mainText}) && !/Running…/.test(${mainText})`, 400000);
    await sleep(3000);
  },
  // Review across samples: every sample's T-cell frequency, outliers first, with boundary ratings.
  async review() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('gate');
    await selectGate('Lymphocytes');
    await app(`app.reviewGate(${gateId('Lymphocytes')});`);
    await waitFor(`/Review/.test(document.querySelector('.dialog')?.innerText ?? '') && !document.querySelector('.progress-toast')`, 120000);
    await sleep(2500);
  },
  // A Boolean population: lymphocytes or monocytes, with its live count.
  async boolean() {
    await example('pbmc-immunophenotyping');
    await mode('gate');
    await selectGate('Live');
    await app(`const m = await import('/ui/boolean-gate.js'); m.openBooleanGate(app, { operands: [${gateId('Lymphocytes')}, ${gateId('Monocytes')}] });`);
    await sleep(800);
    await click('Any of');
    await sleep(800);
  },
  // An AI agent's proposal waiting for review: gates drawn by the agent, a held compensation matrix.
  async agents() {
    await example('pbmc-immunophenotyping', { gates: false });
    await mode('gate');
    await agent('auto_gate', { method: 'singlets', x: 'FSC-A', y: 'FSC-H', name: 'Single cells' });
    await agent('create_gate', { parent: 'Single cells', type: 'split', x: 'Viability', coordinates: { threshold: 2000 } });
    await agent('edit_gate', { population: 'Single cells / Viability−', name: 'Live' });
    await agent('propose_compensation', { method: 'median' });
    await sleep(1500);
    await selectGate('Live');
  },
  // The same proposal opened for review.
  async 'agents-review'() {
    await scenes.agents();
    await click('Review');
    await sleep(1500);
  },
  // Index sorting: the plate of sorted cells colored by population, one well marked on the plots.
  async indexsort() {
    await example('index-sort', { gates: false });
    await selectSample('Presort');
    await agent('create_gate', { type: 'split', x: 'CD19', coordinates: { threshold: 2000 }, sample: 'Presort' });
    await agent('create_gate', { parent: 'CD19+', type: 'quadrant', x: 'CD27', y: 'IgD', coordinates: { at: [2000, 1500] }, sample: 'Presort' });
    await acceptProposals();
    await selectSample('Plate1_IndexSort');
    await mode('gate');
    await selectGate(null);
    await app(`app.store.setUI({ tileSize: 260 }, ['tiles']);`);
    await addPlot(null, 'CD27', 'IgD');
    await js(`[...document.querySelectorAll('.plate-well')].find((w) => w.title.startsWith('C3'))?.click()`);
    await sleep(1200);
    await scrollTo('.plot-grid', 'start');
  },
  // Plates: the drug screen's % CD69+ of T cells across the plate, with Z′ from its controls.
  async plates() {
    await example('plate-screen');
    await mode('plates');
    await click('Heat map');
    await sleep(800);
    await js(`[...document.querySelectorAll('button')].find((e) => /^Compute all/.test(e.textContent.trim()))?.click()`);
    await waitFor(`!document.querySelector('.progress-toast') && document.querySelectorAll('.plates-well:not(.empty)').length === 96 && /Z′/.test(${mainText})`, 120000);
    await sleep(1200);
  },
  // Dose-response curves of the screen's six compounds.
  async doseresponse() {
    await example('plate-screen');
    await mode('plates');
    await app(`const m = await import('/ui/dose-response.js'); m.openDoseResponse(app, { plateName: 'Screen plate 1', spec: { gateId: app.store.ws.gates.at(-1).id, stat: 'freqParent' } });`);
    await waitFor(`!document.querySelector('.progress-toast') && !!document.querySelector('.curve-results')`, 120000);
    await sleep(1500);
    await js(`[...document.querySelectorAll('.dialog h3')].find((e) => /^Dose-response/.test(e.textContent.trim()))?.scrollIntoView({ block: 'start' })`);
    await sleep(800);
  },
  // A bead immunoassay: the bead levels and the standard curves of an 8-plex.
  async beadassay() {
    await example('bead-immunoassay');
    await mode('plates');
    await app(`const m = await import('/ui/bead-assay.js'); m.openBeadAssay(app, { plateName: 'Cytokine plate 1' });`);
    await sleep(2000);
    await js(`(() => { const areas = document.querySelectorAll('.bead-group textarea'); areas[0].value = 'IL-2\\nIL-4\\nIL-6\\nIL-10'; areas[0].dispatchEvent(new Event('change')); areas[1].value = 'IL-17A\\nIFN-γ\\nTNF-α\\nIL-1β'; areas[1].dispatchEvent(new Event('change')); return true; })()`);
    await click('Analyze');
    await waitFor(`!document.querySelector('.progress-toast') && document.querySelectorAll('.bead-curves canvas').length === 8`, 120000);
    await sleep(1500);
    await js(`[...document.querySelectorAll('.dialog h3')].find((e) => /^Bead levels/.test(e.textContent.trim()))?.scrollIntoView({ block: 'start' })`);
    await sleep(800);
  },
  // CytoNorm: two batches of a mass cytometry cohort, before and after.
  async normalize() {
    await example('cytof-cohort', { gates: false });
    await mode('qc');
    await click('Normalize');
    await sleep(800);
    await click('Train and normalize');
    await waitFor(`/Mean distance of each batch/.test(${mainText}) && !document.querySelector('.progress-toast')`, 120000);
    await sleep(1500);
    await js(`[...document.querySelectorAll('main h3')].find((e) => /^Result/.test(e.textContent.trim()))?.scrollIntoView({ block: 'start' })`);
    await sleep(1200);
  },
  // Debarcoding a palladium-barcoded plate.
  async debarcode() {
    await example('cytof-barcoded', { gates: false });
    await mode('qc');
    await click('Debarcode');
    await sleep(1500);
    await click('Debarcode ', 'main button');
    await waitFor(`!document.querySelector('.progress-toast') && /Result · /.test(${mainText})`, 180000);
    await sleep(2000);
    await js(`[...document.querySelectorAll('main h3')].find((e) => /^Result · /.test(e.textContent.trim()))?.scrollIntoView({ block: 'start' })`);
    await sleep(1200);
  },
  // The cell-cycle model: Dean–Jett–Fox on the nocodazole-arrested culture.
  async cellcycle() {
    await example('cell-cycle');
    await selectSample('Nocodazole_16h');
    await mode('gate');
    const singlets = await app(`return app.store.ws.gates.at(-1).name;`);
    await selectGate(singlets);
    await app(`const m = await import('/ui/platforms.js'); await m.openCellCycle(app, app.store.ui.gateId, app.store.ui.sampleId);`);
    await sleep(3500);
    await js(`[...document.querySelectorAll('.dialog *')].find((e) => e.children.length < 4 && /^Fitted DNA histogram/.test(e.textContent.trim()))?.scrollIntoView({ block: 'start' })`);
    await sleep(800);
  },
  // The proliferation model: generations of dye dilution in stimulated CD4 T cells.
  async proliferation() {
    await example('proliferation', { gates: false });
    await mode('gate');
    await selectSample('Day4_aCD3CD28');
    await agent('create_gate', { type: 'quadrant', x: 'CD4', y: 'CD8', coordinates: { at: [1500, 1500] }, sample: 'Day4_aCD3CD28' });
    await acceptProposals();
    await selectGate('CD4+ CD8−');
    await app(`const m = await import('/ui/platforms.js'); await m.openProliferation(app, app.store.ui.gateId, app.store.ui.sampleId);`);
    await sleep(3500);
    await js(`[...document.querySelectorAll('.dialog *')].find((e) => e.children.length < 4 && /^Fitted generations/.test(e.textContent.trim()))?.scrollIntoView({ block: 'start' })`);
    await sleep(800);
  },
  // A FlowJo workspace migrated, with the comparison of every count.
  async flowjo() {
    await example('flowjo-workspace', { gates: false });
    await waitFor(`/Import/.test(document.querySelector('.dialog')?.innerText ?? '')`, 60000);
    await click('Import', '.dialog-foot button');
    await waitFor(`/FlowJo/.test(document.querySelector('.dialog')?.innerText ?? '') && /CytoWeave/.test(document.querySelector('.dialog')?.innerText ?? '') && !document.querySelector('.progress-toast')`, 180000);
    await sleep(2000);
  },
  // Tables: statistics of every population across the samples.
  async tables() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('tables');
    await click('Create a table of every population');
    await waitFor(`document.querySelectorAll('main table td').length > 20`, 120000);
    await sleep(2000);
  },
  // Compare: a population's frequency between stimulated and unstimulated samples.
  async compare() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('compare');
    await choose('Population', 'T cells$');
    await choose('Statistic', '^median$');
    await choose('Channel', 'CD25');
    await waitFor(`/p = /.test(${mainText})`, 60000);
    await sleep(1500);
  },
  // A sample against a control: CD25 on T cells of a stimulated sample, the same donor's
  // unstimulated sample overlaid, and the comparison under the histogram.
  async 'compare-control'() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('gate');
    await selectSample('D01_Stim');
    await selectGate('T cells');
    await app(`
      const { addPlot, updatePlot } = await import('/lib/workspace.js');
      const ws = app.store.ws;
      const view = app.data.view(app.store.ui.sampleId);
      const x = view.parameters.find((p) => p.marker === 'CD25').name;
      const control = ws.samples.find((s) => s.name === 'D01_Unstim');
      const added = addPlot({ ...ws, plots: [] }, { populationId: ws.gates.find((g) => g.name === 'T cells').id, x, type: 'histogram' });
      app.store.commit(updatePlot(added.ws, added.plot.id, { overlays: [{ sampleId: control.id, color: '#e45756', label: control.name }] }), 'Compare with a control', ['plots']);`);
    await waitFor(`[...document.querySelectorAll('.plot-compare')].some((e) => /positive \\(SED\\)/.test(e.textContent))`, 60000);
    await sleep(1500);
  },
  // Compare: robustness of "monocytes do not change with stimulation" to analysis choices.
  async 'compare-robustness'() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('compare');
    await choose('Population', 'Monocytes$');
    await choose('Statistic', 'parent');
    await waitFor(`/p = /.test(${mainText})`, 60000);
    await sleep(1000);
    await js(`[...document.querySelectorAll('.pane')].find((p) => /Robustness/.test(p.querySelector('h3')?.textContent))?.querySelector('h3 button')?.click()`);
    await waitFor(`Boolean([...document.querySelectorAll('.pane')].find((p) => /Robustness/.test(p.querySelector('h3')?.textContent))?.querySelector('.callout'))`, 300000);
    await js(`[...document.querySelectorAll('.pane')].find((p) => /Robustness/.test(p.querySelector('h3')?.textContent)).scrollIntoView({ block: 'start' })`);
    await sleep(1500);
  },
  // Compare: differential state (diffcyt-DS-limma) of the activation markers in FlowSOM clusters of
  // live cells made from lineage markers, stimulated against unstimulated, paired by donor.
  async 'compare-states'() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await agent('explore', { population: 'Live', markers: ['CD45', 'CD3', 'CD4', 'CD8', 'CD19', 'CD56', 'CD14', 'CD16'], clustering: 'flowsom', embedding: 'none', k: 10, eventsPerSample: 3000 });
    await mode('compare');
    await app(`
      const live = app.store.ws.gates.find((g) => g.name === 'Live').id;
      app.store.ui.compare = { ...app.store.ui.compare, tab: 'states', stateUnits: 'clusters', stateMarkers: null, clusterParent: live, groupBy: 'meta:condition', levels: ['Unstimulated', 'Stimulated'], reference: 'Unstimulated', pairBy: 'meta:subject', covariates: [] };`);
    await mode('tables');
    await mode('compare');
    await click('Run screen');
    await waitFor(`/cluster × marker tests/.test(${mainText}) && !document.querySelector('.progress-toast')`, 300000);
    await sleep(2000);
  },
  // Figures: a publication figure assembled from live plots.
  async figures() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('gate');
    await selectGate('T cells');
    await mode('figures');
    await click('Gating strategy of the selected population');
    await sleep(3000);
  },
  // A batch report: the T-cell figure with a statistics item, repeated for each subject.
  async 'batch-report'() {
    await scenes.figures();
    await app(`
      const W = await import('/lib/workspace.js');
      const ws = app.store.ws;
      const ids = ['T cells', 'B cells', 'NK cells', 'Monocytes'].map((n) => ws.gates.find((g) => g.name === n)?.id).filter(Boolean);
      const table = { id: 'docs-table', name: 'Populations', heatmap: true, groupId: null, columns: ids.map((id, k) => ({ id: 'docs-c' + k, gateId: id, stat: 'freqParent' })) };
      const fig = ws.figures.at(-1);
      const subtitle = fig.items.filter((i) => i.kind === 'text')[1];
      const items = fig.items.map((i) => (i === subtitle ? { ...i, text: '{sample} · subject {subject} · {condition}' } : i));
      items.push({ id: 'docs-stats', kind: 'stats', x: 40, y: fig.height + 10, w: 760, h: 140, tableId: table.id, rows: 'page', size: 13 });
      const next = { ...fig, height: fig.height + 170, items };
      let w = W.setCollection(ws, 'tables', [...ws.tables, table], 'edit-table');
      w = W.setCollection(w, 'figures', ws.figures.map((f) => (f.id === fig.id ? next : f)), 'edit-figure');
      app.store.commit(w, 'Statistics in the figure', ['tables', 'figures']);
    `);
    await sleep(2500);
    await click('Batch report');
    await choose('Repeat for', 'subject');
    await sleep(800);
  },
  // Export events: lymphocytes of every sample, 5,000 each, as AnnData.
  async 'export-events'() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await app(`app.exportEventsDialog({ populationId: app.store.ws.gates.find((g) => g.name === 'Lymphocytes').id, format: 'h5ad' });`);
    await sleep(600);
    await choose('Events', 'number');
    await js(`(() => { const input = [...document.querySelectorAll('.dialog input[type=number]')][0]; input.value = 5000; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(600);
  },
  // Events from a CSV file exported by FlowJo, checked before import.
  async 'csv-import'() {
    await example('pbmc-immunophenotyping');
    await app(`
      const s = app.store.ws.samples.find((x) => x.name === 'D01_Unstim');
      const v = await app.data.ensure(s.id);
      const head = ['Event #', ...v.parameters.map((p) => (p.type === 'fluorescence' ? 'Comp-' + p.name + ' :: ' + (p.marker || p.name) : p.name))];
      const cols = v.parameters.map((p) => v.column(p.name));
      const lines = [head.join(',')];
      for (let e = 0; e < 3000; e += 1) lines.push([e + 1, ...cols.map((c) => c[e])].join(','));
      app.importEventCSVs([{ name: 'D01_Unstim_export.csv', text: lines.join(String.fromCharCode(10)) }]);
    `);
    await waitFor(`/Import events/.test(document.querySelector('.dialog')?.innerText ?? '')`, 30000);
    await sleep(800);
  },
  // Spectral panel quality: similarity of the reference spectra and the complexity index.
  async 'spectral-quality'() {
    await scenes.spectral();
    await click('Panel quality');
    await sleep(3000);
  },
  // Color-vision-friendly colors: the Gate view with the setting on, the Appearance menu open.
  async 'color-vision'() {
    await example('pbmc-immunophenotyping');
    await selectGate('Lymphocytes');
    await sleep(1500);
    await js(`document.getElementById('theme-button').click()`);
    await sleep(300);
    await click('Color-vision-friendly colors', '.menu-item');
    await sleep(1500);
    await clearToasts();
    await js(`document.getElementById('theme-button').click()`);
    await sleep(800);
  },
  // QC → Live: the QC showcase's wells written one by one into a watched export folder, and a
  // fifth file still being written.
  async 'qc-live'() {
    const folder = join(mkdtempSync(join(tmpdir(), 'cytoweave-capture-')), 'Fortessa exports');
    mkdirSync(folder);
    const { files } = generateExample('qc-showcase', {});
    // Show an export folder's path rather than this run's temporary one, as for the library.
    await js(`(() => { const real = window.fetch; window.fetch = async (...args) => { const response = await real(...args); if (!String(args[0]).startsWith('api/watch')) return response; const body = await response.clone().json(); if (body.folder) body.folder = '/Volumes/Cytometry/Fortessa exports'; return new Response(JSON.stringify(body), { status: response.status, headers: response.headers }); }; })()`);
    // One CytoWeave serves every theme: stop the watch an earlier run left, and start afresh.
    await app(`if (app.live.status?.watching) await app.live.stop(); while (app.live.busy) await new Promise((r) => setTimeout(r, 200)); await app.newWorkspace(); await app.openLiveQC(); await app.live.start(${JSON.stringify(folder)});`);
    for (const file of files) {
      writeFileSync(join(folder, file.name), file.bytes);
      await sleep(1600);
    }
    writeFileSync(join(folder, 'A05.fcs'), files[0].bytes.subarray(0, files[0].bytes.length >> 1));
    await waitFor(`window.cytoweave.live.queue.length === ${files.length} && window.cytoweave.live.queue.every((q) => q.state === 'checked') && (window.cytoweave.live.status?.pending ?? []).length === 1`, 180000);
    await sleep(1500);
  },
  // Spectral: Panel design, with the noise fitted to the controls and BV711 left out.
  async 'spectral-design'() {
    await scenes.spectral();
    await click('Panel quality');
    await sleep(1000);
    await click('Compute');
    await waitFor(`window.cytoweave.store.ws.derived.some((d) => d.kind === 'spectral-setup' && d.spreading?.noise) && !document.querySelector('.progress-toast')`, 400000);
    await click('Panel design');
    await sleep(1000);
    await click('BV711', '.spectral-legend .chip');
    await sleep(2500);
  },
  // Explore: the cluster heatmap with marker-enrichment names.
  async 'explore-clusters'() {
    await scenes.explore();
    await js(`[...document.querySelectorAll('main h3')].find((e) => /clusters \\(/.test(e.textContent))?.scrollIntoView({ block: 'start' })`);
    await sleep(1500);
  },
  // Explore: samples placed on a finished UMAP (map of one sample, two more placed on it).
  async 'explore-placed'() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await selectSample('D01_Unstim');
    await selectGate('Live');
    await mode('explore');
    await choose('Samples', 'current');
    await click('Run');
    await waitFor(`/How faithful/.test(${mainText}) && /Trustworthiness/.test(${mainText}) && !/Running…/.test(${mainText})`, 400000);
    await sleep(2000);
    await click('Place samples on this map');
    await sleep(800);
    await js(`[...document.querySelectorAll('.dialog .boolean-option')].forEach((o) => { const keep = /D01_Stim|D02_Stim/.test(o.textContent); const box = o.querySelector('input'); if (box.checked !== keep) box.click(); })`);
    await click('Place', '.dialog-foot button');
    await waitFor(`/With the placed samples/.test(${mainText}) && !document.querySelector('.progress-toast')`, 180000);
    await sleep(2500);
  },
  // Autogating: the PBMC example acquired with drifting detector gains (up to about 2× between
  // samples); the monocyte gate drawn on D01_Unstim, adapted to every other sample.
  async autogate() {
    await example('pbmc-immunophenotyping', { options: { instrumentShift: 0.8 } });
    await app(`const W = await import('/lib/workspace.js'); const g = app.store.ws.gates.find((x) => x.name === 'Monocytes'); app.store.commit(W.updateGate(app.store.ws, g.id, { meta: { ...g.meta, drawnOn: ${sampleId('D01_Unstim')} } }), 'Drawn on D01_Unstim');`);
    await mode('gate');
    await selectSample('D02_Stim');
    await selectGate('Monocytes');
    await app(`app.adaptGate(${gateId('Monocytes')});`);
    await waitFor(`/Adapt .* to each sample/.test(document.querySelector('.dialog')?.innerText ?? '') && !document.querySelector('.progress-toast')`, 180000);
    await sleep(1500);
  },
  // QC → Instrument: Q and B of every detector on the last of 30 daily bead runs.
  async instrument() {
    await example('bead-qc', { gates: false });
    await mode('qc');
    await click('Instrument');
    await click('Measure 30');
    await waitFor(`window.cytoweave.store.ws.derived.some((d) => d.kind === 'instrument-qc') && !document.querySelector('.progress-toast')`, 180000);
    await sleep(1500);
    await js(`[...document.querySelectorAll('main table.data tbody tr')].find((tr) => tr.firstChild?.textContent === 'BV421-A')?.click()`);
    await sleep(1500);
    await js(`[...document.querySelectorAll('main h3')].find((e) => /Beads_2026/.test(e.textContent))?.scrollIntoView({ block: 'start' })`);
    await sleep(1200);
  },
  // Workspace → Apply a template: OMIP-101 on the PBMC example, its gates to be placed on
  // D01_Unstim's events.
  async strategy() {
    await example('pbmc-immunophenotyping', { gates: false });
    await selectSample('D01_Unstim');
    await app(`app.applyTemplateDialog();`);
    await sleep(1000);
    await click('Choose', '.dialog button');
    await waitFor(`/OMIP-101: major leukocyte populations/.test(document.querySelector('.dialog')?.innerText ?? '') && /populations will be added/.test(document.querySelector('.dialog')?.innerText ?? '')`, 60000);
    await sleep(1500);
  },
  // The cell type the inspector suggests for NK cells placed by OMIP-101.
  async 'cell-types'() {
    await scenes.strategy();
    await click('Apply', '.dialog-foot button');
    await sleep(2500);
    await mode('gate');
    await selectGate('NK cells');
    await sleep(2000);
    await js(`[...document.querySelectorAll('.section-title')].find((e) => /Cell type/.test(e.textContent))?.scrollIntoView({ block: 'center' })`);
    await sleep(800);
  },
  // QC → Titration: the CD4-PE titration within the lymphocytes, with the recommended amount.
  async titration() {
    await example('titration-voltage');
    await mode('qc');
    await click('Titration', '.workbench-head [role="tab"]');
    await sleep(800);
    await click('Analyze 10 amounts');
    await waitFor(`/recommended 125 ng per test/.test(${mainText})`, 120000);
    await sleep(1500);
    await js(`[...document.querySelectorAll('main h3')].find((e) => /titration:/.test(e.textContent))?.scrollIntoView({ block: 'start' })`);
    await sleep(1200);
  },
  // QC → Calibration: 8-level beads (simulated in the page: a detector of slope 1.05 whose
  // brightest level saturates) calibrated on FITC-A in MEFL.
  async calibration() {
    await app(`
      const { encodeFCS } = await import('/lib/simulate.js');
      const { createRandom } = await import('/lib/random.js');
      const random = createRandom(21);
      const mef = [0, 792, 2079, 6588, 16471, 47497, 137049, 271647];
      const read = (v) => Math.min(16383, ((v / Math.exp(2)) ** (1 / 1.05)) * 10 ** (0.0128 * random.gaussian()) + 5 * random.gaussian());
      const n = 8 * 1500;
      const cols = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      for (let e = 0; e < n; e += 1) {
        const level = e % 8;
        cols[0][e] = 40000 + 1500 * random.gaussian();
        cols[1][e] = 12000 + 600 * random.gaussian();
        cols[2][e] = read(mef[level] + 1500);
        cols[3][e] = read(2.5 * (mef[level] + 1500));
      }
      const params = [['FSC-A', 262144], ['SSC-A', 262144], ['FITC-A', 16384], ['PE-A', 16384]].map(([name, range]) => ({ name, label: '', range }));
      const bytes = encodeFCS(params, cols, { $CYT: 'Simulated cytometer', $FIL: 'Rainbow beads.fcs' });
      await app.importFiles([new File([bytes], 'Rainbow beads.fcs')]);
`);
    await waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.progress-toast')`, 60000);
    await app(`await app.openCalibration();`);
    await sleep(1200);
    await app(`
      const S = app.qcState.calibration;
      S.values = { 'FITC-A': '0, 792, 2079, 6588, 16471, 47497, 137049, 271647' };
      S.units = { 'FITC-A': 'MEFL' };
      S.clustering = ['FITC-A', 'PE-A'];
      app.store.setUI({}, ['selection']);`);
    await sleep(1000);
    await click('Calibrate', 'main button');
    await waitFor(`/FITC-A → MEFL/.test(${mainText})`, 60000);
    await sleep(1500);
    await js(`[...document.querySelectorAll('main h3')].find((e) => /bead events/.test(e.textContent))?.scrollIntoView({ block: 'start' })`);
    await sleep(1200);
  },
  // A formula channel: CD4/CD8 on the PBMC example.
  async formula() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('gate');
    await selectGate('T cells');
    await app(`app.formulaDialog();`);
    await sleep(800);
    await js(`(() => {
      const dialog = document.querySelector('.dialog');
      const name = dialog.querySelector('input[aria-label="Channel name"]');
      name.value = 'CD4/CD8';
      const text = dialog.querySelector('textarea');
      text.value = '[CD4] / [CD8]';
      text.dispatchEvent(new Event('input'));
    })()`);
    await sleep(1500);
  },
  // The Levey–Jennings chart of the aging detector's Q across the 30 runs.
  async 'levey-jennings'() {
    await scenes.instrument();
    await js(`[...document.querySelectorAll('main h3')].find((e) => /Levey–Jennings/.test(e.textContent))?.closest('.pane')?.scrollIntoView({ block: 'end' })`);
    await sleep(1200);
  },
  // The spectral library: a later experiment whose PE-Cy7 has degraded, against the spectra saved
  // from the first.
  async 'spectral-library'() {
    await scenes.spectral();
    await click('Library');
    await sleep(1500);
    await click('Save 25 spectra');
    await sleep(2000);
    await app(`await app.openExample('spectral-25color', { seed: 20260601, tandemDegradation: { 'PE-Cy7': 0.1 } });`);
    await waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.progress-toast')`, 240000);
    await sleep(1500);
    await mode('spectral');
    await waitFor(`/Gate all controls/.test(${mainText})`, 60000);
    await click('Gate all controls');
    await waitFor(`/Extract signatures/.test(${mainText})`, 300000);
    await sleep(1500);
    await click('Library');
    await waitFor(`Boolean(document.querySelector('main .badge.danger'))`, 30000);
    await sleep(1500);
    await js(`[...document.querySelectorAll('main h3')].find((e) => /against the library/.test(e.textContent))?.closest('.pane')?.scrollIntoView({ block: 'end' })`);
    await sleep(1200);
  },
  // An exported figure opened again after a gate moved: where it came from, and what changed.
  async 'figure-provenance'() {
    await scenes.figures();
    await app(`
      const lib = await import('/lib/figure-provenance.js');
      const W = await import('/lib/workspace.js');
      const G = await import('/lib/gates.js');
      const fig = app.store.ws.figures.at(-1);
      const views = new Map();
      for (const item of fig.items) if (item.kind === 'plot' && !views.has(item.sampleId)) views.set(item.sampleId, await app.data.ensure(item.sampleId));
      const record = lib.buildProvenance(app.store.ws, fig, { views, version: app.version });
      const bytes = new TextEncoder().encode(lib.embedSVG('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', record));
      const g = app.store.ws.gates.find((x) => x.name === 'T cells');
      app.store.commit(W.setGateGeometry(app.store.ws, g.id, G.offsetGeometry(g.type, g.geometry, 0.03)), 'Widen T cells');
      await app.openFigureFile({ name: 'T cells gating strategy.svg', bytes });
    `);
    await waitFor(`/would look the same/.test(document.querySelector('.dialog')?.innerText ?? '')`, 60000);
    await sleep(1500);
  },
  // Export as a FlowJo workspace: the fidelity report and the options.
  async 'flowjo-export'() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await app(`await app.exportFlowJo();`);
    await waitFor(`/FlowJo workspace/.test(document.querySelector('.dialog')?.innerText ?? '')`, 60000);
    await sleep(1200);
  },
  // The Report view: methods paragraph and MIFlowCyt checklist.
  async report() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('report');
  },
  // The PBMC analysis's review report, opened in the browser, a plot's percentage traced.
  async 'review-report'() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await app(`const ui = await import('./ui/review.js'); const out = await ui.makeReviewReport(app, {}); window.__review = out.html;`);
    // Opened from a file, as a reader opens it.
    const file = join(mkdtempSync(join(tmpdir(), 'cytoweave-review-')), 'review.html');
    writeFileSync(file, await js('window.__review'));
    await b.goto(`file://${file}`, 1500);
    await js(`(() => { const section = document.getElementById('plots'); window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY - 12); [...section.querySelectorAll('button.n')][1].click(); return true; })()`);
    await sleep(600);
  },
  // A reproducibility certificate of the PBMC analysis, opened and verified.
  async certificate() {
    await example('pbmc-immunophenotyping');
    await compensateFromControls();
    await mode('report');
    await app(`const ui = await import('./ui/certificates.js'); const lib = await import('./lib/certificate.js'); const built = await lib.buildCertificate(app.store.ws, ui.certificateSource(app), { version: app.version }); ui.showVerification(app, built.bytes, 'PBMC immunophenotyping.certificate.acs', { open: () => {} });`);
    await waitFor(`/Confirmed/.test(document.querySelector('.dialog')?.innerText ?? '')`, 180000);
    await sleep(800);
  },
};

// --- Run ------------------------------------------------------------------------------------------

// axe-core in the page: violations of the WCAG 2.1 A and AA rules, with up to five elements each.
async function runAxe() {
  await js(`if (!window.axe) (0, eval)(${JSON.stringify(readFileSync(AXE, 'utf8'))});`);
  return js(`(async () => {
    const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
    return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target.join(' '), summary: n.failureSummary?.split('\\n').slice(0, 3).join(' ') })), count: v.nodes.length }));
  })()`);
}
const audits = [];

const names = wanted.length ? wanted : Object.keys(scenes);
for (const name of names) if (!scenes[name]) throw new Error(`Unknown scene ${name}. Scenes: ${Object.keys(scenes).join(', ')}`);
mkdirSync(IMAGES, { recursive: true });
const cytoweave = await startCytoWeave();
try {
  for (const theme of themes) {
    for (const name of names) {
      b = await launch();
      try {
        await b.theme(theme === 'dark');
        await b.goto(URL);
        await waitFor('Boolean(window.cytoweave)', 30000);
        // Show the default library location rather than this run's temporary one.
        await js(`window.cytoweave.data.library.location = '~/Library/Application Support/CytoWeave'; window.cytoweave.store.notify(['saved', 'library'])`);
        await scenes[name]();
        await clearToasts();
        await sleep(600);
        if (shots) await b.capture(join(IMAGES, `${name}-${theme}.webp`), { format: 'webp', quality: 86 });
        if (audit) {
          const found = await runAxe();
          audits.push({ scene: name, theme, violations: found });
          console.log(`${name} (${theme}): ${found.length ? found.map((v) => `${v.id} ×${v.count} (${v.impact})`).join(', ') : 'no violations'}`);
        } else console.log(`${name} (${theme})`);
      } catch (error) {
        console.error(`${name} (${theme}) failed: ${error.message}`);
        process.exitCode = 1;
      } finally {
        // The watch runs in the program, which serves every later scene: stop it, or their
        // status bars show it.
        if (name === 'qc-live') await app(`if (app.live.status?.watching) await app.live.stop();`).catch(() => {});
        await b.close();
      }
    }
  }
} finally {
  cytoweave.stop();
  if (audit) {
    writeFileSync(join(ROOT, 'docs/capture/audit.json'), `${JSON.stringify(audits, null, 1)}\n`);
    const byRule = new Map();
    for (const a of audits) for (const v of a.violations) byRule.set(v.id, { ...v, scenes: [...(byRule.get(v.id)?.scenes ?? []), `${a.scene} (${a.theme})`] });
    console.log(`\naxe-core: ${audits.length} scene captures, ${byRule.size} rules violated${byRule.size ? `: ${[...byRule.values()].map((v) => `${v.id} (${v.impact}) in ${v.scenes.length}`).join('; ')}` : ''}. Details: docs/capture/audit.json`);
  }
}
