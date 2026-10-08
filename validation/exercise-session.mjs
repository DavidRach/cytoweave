// Teaching mode in the real window (a headless Chrome), every exercise from start to check:
//   - an exercise's workspace holds none of the simulator's truth (no truth channel, no annotation
//     naming a fault, a neutral name, no files offered with the example, only the exercise's id and
//     seed in the workspace);
//   - each exercise is solved with CytoWeave's own tools where an agent tool does the analysis
//     (driven through remote control, as the benchmark's reference solutions are), and answered
//     from the truth computed here where the analysis is done in a dialog without a tool (cell
//     cycle, proliferation, Q and B, the CyTOF cohort; their accuracy against the truth is checked
//     by the validation suites cellcycle, proliferation, flowqb and clustering); the answers go in
//     through the panel's own controls and its Check button, and must score full marks (at least
//     0.8 for gates drawn by a script);
//   - revealing the truth adds the truth channel and the explanation and colors the missed events;
//     after a reload the answer key is made again from the seed, and refused when the files are
//     not the exercise's; undo keeps the answers; the panel shows only in an exercise's workspace.
//
//   node validation/exercise-session.mjs [--verbose] [--only id,id]
//
// Needs Go (to build CytoWeave from source) and Chrome, Chromium, Edge or Brave (CHROME=path).
// Exits with status 1 when a check fails.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../docs/capture/cdp.mjs';
import { generateExample } from '../web/lib/examples.js';
import { EXERCISES, exerciseAttempt, exerciseById, exerciseTruth } from '../web/lib/exercises.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8793;
const SEED = 271828;
const verbose = process.argv.includes('--verbose');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const results = [];
function check(name, value, ok, required) {
  results.push({ name, ok });
  if (verbose || !ok) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${value} (required ${required})`);
}

let URL = `http://127.0.0.1:${PORT}/`;
let token = '';
const temp = mkdtempSync(join(tmpdir(), 'cytoweave-exercises-'));

async function startCytoWeave() {
  const binary = join(temp, process.platform === 'win32' ? 'cytoweave.exe' : 'cytoweave');
  await new Promise((done, fail) => spawn('go', ['build', '-o', binary, '.'], { cwd: ROOT, stdio: 'inherit' }).on('exit', (code) => (code ? fail(new Error('go build failed (is Go installed?)')) : done())));
  const server = spawn(binary, ['--remote-control', '--window', 'none', '--port', String(PORT), '--data-dir', join(temp, 'library')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 300; i += 1) {
    const address = /running at (http:\/\/[\d.]+:\d+)/.exec(output)?.[1];
    token = /X-CytoWeave-Token: (\S+)/.exec(output)?.[1] ?? token;
    if (address && token) {
      URL = `${address}/`;
      try {
        if ((await fetch(`${URL}api/info`)).ok) return () => server.kill();
      } catch { /* starting */ }
    }
    await sleep(200);
  }
  server.kill();
  throw new Error('CytoWeave did not start.');
}

async function tool(name, args = {}) {
  const response = await fetch(`${URL}api/remote/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CytoWeave-Token': token }, body: JSON.stringify({ action: name, args, client: 'Validation' }) });
  const result = await response.json();
  if (!result.ok) throw new Error(`${name}: ${result.message ?? result.error}`);
  return result.data ?? result.result?.data ?? result;
}

let b = null;
const page = (code) => b.eval(`(async () => { const app = window.cytoweave; ${code} })()`);
async function waitFor(expression, timeout = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page(`return Boolean(${expression});`)) return;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

// The example's suggested gates added (as a learner would draw them).
async function addSuggestedGates(exampleId, options) {
  const gates = generateExample(exampleId, { ...options, scale: 0.01 }).workspaceHints.suggestedGates;
  await page(`const { addGates } = await import('/lib/workspace.js'); app.store.commit(addGates(app.store.ws, ${JSON.stringify(gates)}.map((g) => ({ ...g, overrides: {} })), 'validation').ws, 'Add gates'); return true;`);
}
const gateId = (name) => page(`return app.store.ws.gates.find((g) => g.name === ${JSON.stringify(name)})?.id ?? null;`);
const accept = () => tool('accept_proposals', {}).catch(() => null);

// --- Each exercise's solution: its answers ({ question id: value }) and how they were found ---------

const SOLUTIONS = {
  async 'gate-t-cells'({ options }) {
    await addSuggestedGates('pbmc-immunophenotyping', options);
    const table = await tool('statistics_table', { statistic: 'freqTotal', populations: ['T cells'] });
    return { how: 'tools', answers: { tCells: await gateId('T cells'), percent: Object.values(table.rows.find((r) => r.sample === 'D01_Unstim').values)[0] } };
  },
  async 'gate-tregs'() {
    await tool('create_gate', { sample: 'D01_Unstim', parent: 'T cells', name: 'CD4 T cells', type: 'rectangle', x: 'Alexa Fluor 700-A', y: 'APC-A', coordinates: { xMin: 3000, yMax: 2000 } });
    await tool('create_gate', { sample: 'D01_Unstim', parent: 'CD4 T cells', name: 'Tregs', type: 'rectangle', x: 'PE-A', y: 'PE-Cy7-A', coordinates: { xMin: 1400, yMax: 1500 } });
    await accept();
    const table = await tool('statistics_table', { statistic: 'freqParent', populations: ['Tregs'] });
    return { how: 'tools', answers: { tregs: await gateId('Tregs'), percent: Object.values(table.rows.find((r) => r.sample === 'D01_Unstim').values)[0] } };
  },
  async 'compensation-error'() {
    const top = (await tool('check_compensation', {})).errors[0];
    return { how: 'tools', answers: { from: top.from, into: top.into, value: top.suggested } };
  },
  async 'find-clog'() {
    const qc = await tool('run_qc', {});
    const worst = [...qc.rows].sort((a, b) => a.score - b.score)[0];
    return { how: 'tools', answers: { sample: worst.sample, problem: /clog|flow rate/i.test(JSON.stringify(worst.findings)) ? 'clog' : 'bubble' } };
  },
  async 'qc-four-wells'() {
    const qc = await tool('run_qc', {});
    const answers = {};
    for (const row of qc.rows) {
      const text = JSON.stringify(row.findings ?? row).toLowerCase();
      answers[row.sample] = row.score >= 90 ? 'clean' : /burst/.test(text) ? 'bubble' : /flow rate|clog/.test(text) ? 'clog' : /drift/.test(text) ? 'drift' : 'clean';
    }
    return { how: 'tools', answers };
  },
  async 'stimulation-test'() {
    await tool('create_gate', { sample: 'D01_Unstim', parent: 'T cells', name: 'CD4 T cells', type: 'rectangle', x: 'Alexa Fluor 700-A', y: 'APC-A', coordinates: { xMin: 3000, yMax: 2000 } });
    await accept();
    await tool('auto_gate', { parent: 'CD4 T cells', name: 'CD25+', method: 'valley', x: 'CD25' });
    await accept();
    const result = await tool('compare', { population: 'CD25+', groupBy: 'condition', pairBy: 'subject' });
    const p = result.tests.find((t) => /paired t/i.test(t.method))?.p ?? result.tests[0].p;
    const mean = (name) => result.groups.find((g) => g.group === name).mean;
    return { how: 'tools', answers: { direction: mean('Stimulated') > mean('Unstimulated') ? 'up' : 'down', test: 'paired', p } };
  },
  async 'spectral-tandem'() {
    await tool('unmix', {});
    const found = (await tool('diagnose_unmixing', { sample: 'Donor_S1' })).findings[0];
    return { how: 'tools', answers: { dye: found.subject, cause: /degraded-tandem/.test(found.kind) ? 'tandem' : 'wrong-control' } };
  },
  async titration() {
    const t = await tool('titration', { mode: 'titration' });
    return { how: 'tools', answers: { amount: String(Number.parseFloat(t.recommended)) } };
  },
  async 'dose-response'() {
    const dr = await tool('dose_response', { population: 'Lymphocytes/Live/T cells/CD69+', statistic: 'freqParent' });
    const fitted = dr.rows.filter((r) => Number.isFinite(r.ec50) && !r.flags.includes('extrapolated')).sort((a, b) => a.ec50 - b.ec50);
    return { how: 'tools', answers: { mostPotent: fitted[0].group, ic50: fitted[0].ec50, inactive: dr.rows.filter((r) => r.flags.includes('no-effect')).map((r) => r.group) } };
  },
  async 'bead-assay'({ setup }) {
    const assay = await tool('bead_assay', { groups: [{ population: 'Beads A', analytes: ['IL-2', 'IL-4', 'IL-6', 'IL-10'] }, { population: 'Beads B', analytes: ['IL-17A', 'IFN-γ', 'TNF-α', 'IL-1β'] }], top: 10000 });
    return { how: 'tools', answers: { concentration: assay.samples.find((s) => s.name === setup.serum).concentrations[setup.analyte].mean } };
  },
  async 'calcium-flux'() {
    const flux = await tool('kinetics', {});
    const best = [...flux.rows].sort((a, b) => b.respondingPercent - a.respondingPercent)[0];
    return { how: 'tools', answers: { strongest: best.sample, percent: best.respondingPercent } };
  },
  async 'cell-cycle'({ truth }) {
    return { how: 'truth', answers: { s: truth.asynchronous.S, g2m: truth.nocodazole.G2M } };
  },
  async proliferation({ truth }) {
    return { how: 'truth', answers: { divided: truth.divided } };
  },
  async 'bead-qc'({ truth }) {
    return { how: 'truth', answers: { detector: truth.detector, from: truth.from, run25: truth.run25 } };
  },
  async 'cytof-differential'({ truth }) {
    return { how: 'truth', answers: { population: truth.population, direction: truth.direction } };
  },
  async 'absolute-counts'({ setup, options }) {
    await addSuggestedGates('absolute-counts', options);
    const table = await tool('statistics_table', { statistic: 'absoluteCount', populations: ['CD4 T cells'], beadPopulation: 'Counting beads', beadsPerTube: 50000, sampleVolume: 50 });
    return { how: 'tools', answers: { count: Object.values(table.rows.find((r) => r.sample.startsWith(setup.patient)).values)[0] } };
  },
  async 'spectral-day-two'() {
    await tool('unmix', {});
    const findings = (await tool('diagnose_unmixing', { sample: 'Donor_S4' })).findings.filter((f) => f.severity !== 'low');
    return { how: 'tools', answers: { degraded: findings.find((f) => /degraded-tandem/.test(f.kind))?.subject, wrongDye: findings.find((f) => !/degraded-tandem/.test(f.kind))?.subject } };
  },
  async 'batch-gates'({ setup }) {
    // Each gate of the T-cell strategy adapted to every sample (learned from the first day's), the
    // proposals accepted.
    for (const name of ['Cells', 'Single cells', 'Live', 'Lymphocytes', 'T cells']) {
      await tool('adapt_gate', { population: name }).catch(() => null);
      await accept();
    }
    return { how: 'tools', answers: { tCells: await gateId('T cells') }, note: setup.sample };
  },
};

// The answers typed and chosen through the panel's controls, then its Check button: the score.
async function answerAndCheck(answers) {
  const before = await page('return app.store.ws.exercise.checks.length;');
  await page(`
    const answers = ${JSON.stringify(answers)};
    for (const [id, value] of Object.entries(answers)) {
      const control = document.querySelector('#exercise-panel [data-question="' + id + '"]');
      if (!control) throw new Error('no control for ' + id);
      if (control.tagName === 'DIV') {
        for (const box of control.querySelectorAll('input[type=checkbox]')) {
          const want = (value ?? []).includes(box.value);
          if (box.checked !== want) { box.checked = want; box.dispatchEvent(new Event('change')); }
        }
      } else {
        control.value = value === undefined || value === null ? '' : String(value);
        control.dispatchEvent(new Event('change'));
      }
    }
    document.querySelector('#exercise-panel [data-action="check"]').click();
    return true;`);
  await waitFor(`app.store.ws.exercise.checks.length > ${before}`, 300000);
  return page('const c = app.store.ws.exercise.checks.at(-1); return c;');
}

// --- The session ----------------------------------------------------------------------------------

const stop = await startCytoWeave();
try {
  b = await launch();
  await b.goto(URL, 3000);
  await waitFor('window.cytoweave?.startExercise');

  // An example opened outside an exercise: no panel.
  await page(`await app.openExample('qc-showcase', { scale: 0.2 }); return true;`);
  await waitFor('app.store.ws.samples.length === 4 && !document.querySelector(".progress-toast")');
  const plain = await page(`return { hidden: document.getElementById('exercise-panel').hidden, margin: document.getElementById('app').classList.contains('with-exercise'), truth: app.store.ws.samples.some((s) => app.data.view(s.id)?.derived?.has?.('Truth (simulated)')) };`);
  check('an example opened as usual: no exercise panel, and its truth channel as before', JSON.stringify(plain), plain.hidden && !plain.margin, 'panel hidden');

  for (const exercise of EXERCISES) {
    if (only && !only.includes(exercise.id)) continue;
    const { setup, options } = exerciseAttempt(exercise, SEED);
    const files = exercise.truthSamples(setup);
    const truth = exerciseTruth(exercise, SEED, files === null ? null : generateExample(exercise.example.id, { ...options, ...(files === 'all' ? {} : { samples: files }) }));
    await page(`await app.startExercise(${JSON.stringify(exercise.id)}, { seed: ${SEED} }); return true;`);
    await waitFor(`app.store.ws.exercise?.id === ${JSON.stringify(exercise.id)} && !document.querySelector('.progress-toast') && !document.getElementById('exercise-panel').hidden`);
    await page('await app.loadAll?.(); return true;');
    const leaks = await page(`
      const ws = app.store.ws;
      return {
        name: ws.name,
        truthChannel: ws.samples.filter((s) => app.data.view(s.id)?.derived?.has?.('Truth (simulated)')).length,
        anomaly: ws.samples.filter((s) => s.meta?.anomaly).length,
        exerciseKeys: Object.keys(ws.exercise).sort().join(','),
        offered: app.exampleFiles().length,
        panel: document.querySelector('#exercise-panel h3')?.textContent,
      };`);
    check(`${exercise.id}: the workspace holds no truth (no truth channel, no fault annotation, a neutral name, no files offered, only the exercise's id, seed and progress)`, JSON.stringify(leaks), leaks.name === `Exercise: ${exercise.title}` && leaks.truthChannel === 0 && leaks.anomaly === 0 && leaks.exerciseKeys === 'answers,checks,hints,id,revealed,seed,started,version' && leaks.offered === 0 && leaks.panel === exercise.title, 'none');
    let solution;
    try {
      solution = await SOLUTIONS[exercise.id]({ setup, options, truth });
    } catch (error) {
      check(`${exercise.id}: solved`, error.message, false, 'solved');
      continue;
    }
    const scored = await answerAndCheck(solution.answers);
    const population = exercise.questions(setup).some((q) => q.kind === 'population');
    const required = solution.how === 'truth' || !population ? 1 : 0.8;
    check(`${exercise.id}: ${solution.how === 'tools' ? 'solved with CytoWeave\'s tools' : 'answered from the truth'}, answers entered in the panel and checked`, `${(100 * scored.score).toFixed(1)}%: ${scored.parts.map((p) => `${p.name} ${(100 * p.score).toFixed(0)}%`).join('; ')}`, scored.score >= required - 1e-9, required === 1 ? 'full marks' : 'at least 80%');
  }

  // Revealing, after a reload, the answer key's guard, and undo (the T-cell exercise).
  if (!only || only.includes('gate-t-cells')) {
    await page(`await app.startExercise('gate-t-cells', { seed: ${SEED} }); return true;`);
    await waitFor(`app.store.ws.exercise?.id === 'gate-t-cells' && !document.querySelector('.progress-toast')`);
    const options = exerciseAttempt(exerciseById('gate-t-cells'), SEED).options;
    await addSuggestedGates('pbmc-immunophenotyping', options);
    // A looser lymphocyte gate: some events taken in wrongly, for the plots to show.
    await page(`const { setGateGeometry } = await import('/lib/workspace.js'); const g = app.store.ws.gates.find((x) => x.name === 'Lymphocytes'); const v = g.geometry.vertices.map(([x, y]) => [x, y * 1.6]); app.store.commit(setGateGeometry(app.store.ws, g.id, { vertices: v }), 'loosen'); return true;`);
    const loose = await answerAndCheck({ tCells: await gateId('T cells'), percent: 42 });
    await page(`document.querySelector('#exercise-panel [data-action="reveal"]').click(); return true;`);
    await waitFor('[...document.querySelectorAll(".dialog button")].some((x) => x.textContent === "Reveal")');
    await page(`[...document.querySelectorAll('.dialog button')].find((x) => x.textContent === 'Reveal').click(); return true;`);
    await waitFor('app.store.ws.exercise.revealed && document.querySelector("#exercise-panel .exercise-truth")');
    const revealed = await page(`
      const s = app.store.ws.samples.find((x) => x.name === 'D01_Unstim');
      return { truth: Boolean(app.data.view(s.id)?.derived?.has?.('Truth (simulated)')), overlays: app.exerciseOverlays(s.id).map((o) => o.label + ' ' + o.indices.count), explanation: document.querySelector('#exercise-panel .exercise-truth').innerText.length };`);
    check('revealing the truth: the truth channel, the explanation, and the events the gate took in wrongly drawn on the plots', `${(100 * loose.score).toFixed(1)}% with a loose lymphocyte gate; truth channel ${revealed.truth}; overlays ${revealed.overlays.join(', ') || 'none'}; explanation ${revealed.explanation} characters`, revealed.truth && revealed.overlays.some((o) => o.startsWith('Extra')) && revealed.explanation > 200 && loose.score < 1, 'all three, and less than full marks');

    // Undo keeps the exercise's progress.
    const undo = await page(`const checks = app.store.ws.exercise.checks.length; app.store.undo(); return { checks, after: app.store.ws.exercise?.checks.length, revealed: app.store.ws.exercise?.revealed };`);
    check('undo of an analysis edit keeps the exercise\'s answers, checks and revealed state', JSON.stringify(undo), undo.after === undo.checks && undo.revealed, 'kept');

    // After a reload: the answer key made again from the seed, and refused for files that are not the exercise's.
    const id = await page('await app.saveNow(); return app.store.ws.id;');
    await b.goto(URL, 3000);
    await waitFor('window.cytoweave?.openWorkspace');
    await page(`await app.openWorkspace(${JSON.stringify(id)}); return true;`);
    await waitFor(`app.store.ws.exercise?.id === 'gate-t-cells' && !document.getElementById('exercise-panel').hidden`);
    const again = await answerAndCheck({ tCells: await gateId('T cells'), percent: 42 });
    check('after a reload: the answer key made again from the seed (the files\' checksums verified), the same score', `${(100 * again.score).toFixed(1)}% (before the reload ${(100 * loose.score).toFixed(1)}%)`, Math.abs(again.score - loose.score) < 1e-9, 'the same');
    await page(`await app.saveNow(); return true;`);
    await b.goto(URL, 3000);
    await waitFor('window.cytoweave?.openWorkspace');
    await page(`await app.openWorkspace(${JSON.stringify(id)}); app.store.replace({ ...app.store.ws, exercise: { ...app.store.ws.exercise, seed: ${SEED + 1} } }); return true;`);
    await waitFor(`!document.getElementById('exercise-panel').hidden`);
    const checks = await page('return app.store.ws.exercise.checks.length;');
    await page(`document.querySelector('#exercise-panel [data-action="check"]').click(); return true;`);
    await sleep(8000);
    const refused = await page(`return { checks: app.store.ws.exercise.checks.length, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ') };`);
    check('the answer key refused for a workspace whose files are not its seed\'s (no check recorded, the reason shown)', `${refused.checks - checks} checks added; ${refused.toast.slice(0, 160)}`, refused.checks === checks && /not the file this exercise made/.test(refused.toast), 'refused');
  }
} catch (error) {
  check('session ran', error.stack?.split('\n').slice(0, 3).join(' | ') ?? error.message, false, 'no error');
} finally {
  await b?.close();
  stop();
  rmSync(temp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} exercise-session checks passed.`);
process.exit(failed.length ? 1 : 0);
