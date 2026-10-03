// Captures the documentation screenshots from the bundled examples, in the light and dark themes,
// as docs/images/<scene>-<theme>.webp: the README shows the one matching the reader's theme, and
// the website (docs/site/build.mjs copies them) the one matching the page's. It starts its own
// CytoWeave (built from source, with an empty library), so every run gives the same pictures.
//
//   node docs/capture/capture.mjs [scene …] [--theme light|dark|both]
//
// Needs Go (to run CytoWeave from source) and Chrome, Chromium, Edge or Brave (CHROME=path).

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

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

// Chooses the option (matching text or value) of the select labelled `label` in the main view.
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
  // Spectral panel quality: similarity of the reference spectra and the complexity index.
  async 'spectral-quality'() {
    await scenes.spectral();
    await click('Panel quality');
    await sleep(3000);
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
  // The Levey–Jennings chart of the ageing detector's Q across the 30 runs.
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
};

// --- Run ------------------------------------------------------------------------------------------

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
        await b.capture(join(IMAGES, `${name}-${theme}.webp`), { format: 'webp', quality: 86 });
        console.log(`${name} (${theme})`);
      } catch (error) {
        console.error(`${name} (${theme}) failed: ${error.message}`);
        process.exitCode = 1;
      } finally {
        await b.close();
      }
    }
  }
} finally {
  cytoweave.stop();
}
