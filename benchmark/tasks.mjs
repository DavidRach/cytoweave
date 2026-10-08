// The benchmark's tasks. Each is an analysis a user would ask an agent for, on an example
// experiment generated with a seed of its own (so an answer cannot be remembered from the
// example's defaults), worded as a user would word it, with the tools left to the agent. Each
// task has:
//   example: { id, options (seed, scale, faults), gates (add the example's suggested gates) }
//   prompt(context): the request (context.outputs: a folder the agent may write to)
//   truth(generated): the answer, from the simulator's own record of the experiment
//   grade({ answer, text, page, truth, outputs, toolCalls }): { parts: [{ name, weight, score,
//     detail }] }, scores between 0 and 1; a run's score is their weighted sum
//   expert(call, context): the reference solution, through the same MCP tools; returns the reply
// Grading is deterministic: from the window's state, the files written and the answer line the
// prompt asks for, never by a model.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PBMC_PANEL, SCREEN_COMPOUNDS, generateExample } from '../web/lib/examples.js';
import { INSTRUMENTS, buildPanel } from '../web/lib/simulate.js';
import { createTransform } from '../web/lib/transforms.js';
import { readPDF } from '../validation/document-readers.mjs';

// 2: every prompt starts with OPEN_DATA (in version 1, prompts that echoed an example's description
// led agents to open that example, replacing the task's experiment with another copy of it).
export const BENCHMARK_VERSION = '2';

// What every request starts with: where the data are, as a user would say it.
export const OPEN_DATA = 'The data for this are already open in CytoWeave, in the workspace "Experiment": analyze them there.';

// The PBMC example as benchmark version 2 used it: without the FMO tube, the rainbow beads and the
// second day's detector settings it gained later (examples change; a version's data do not).
const PBMC_V2 = { fmos: [], calibrationBeads: false, secondBatch: null };

// --- Answers and scores ---------------------------------------------------------------------------

const answerLine = (shape) => `When you are done, end your reply with one line that starts with ANSWER: followed by JSON of this form: ${shape}`;

// The JSON after the last "ANSWER:" of a reply (in or out of a code block), or null.
export function parseAnswer(text) {
  const at = String(text ?? '').lastIndexOf('ANSWER:');
  if (at < 0) return null;
  const rest = text.slice(at + 7).replace(/^[\s`]*(json)?/i, '');
  const start = rest.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < rest.length; i += 1) {
    if (rest[i] === '{') depth += 1;
    else if (rest[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(rest.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const clamp = (v) => Math.max(0, Math.min(1, v));
// 1 at an error up to `full`, falling linearly to 0 at `zero`.
const closeness = (error, full, zero) => (Number.isFinite(error) ? clamp(1 - (error - full) / (zero - full)) : 0);
const number = (v) => (typeof v === 'number' ? v : Number.parseFloat(String(v ?? '').replace(/[^\d.eE+-]/g, '')));
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const part = (name, weight, score, detail) => ({ name, weight, score: clamp(score), detail });

// --- Gates as the expert draws them -------------------------------------------------------------

// create_gate calls for an example's suggested gates (stored in scale units, drawn in data values).
function gateCalls(gates) {
  const names = new Map(gates.map((g) => [g.id, g.name]));
  return gates.map((g) => {
    const fx = createTransform(g.dims[0].transform).inverse;
    const fy = g.dims[1] ? createTransform(g.dims[1].transform).inverse : null;
    const base = { name: g.name, parent: g.parentId ? names.get(g.parentId) : 'All events', x: g.dims[0].channel };
    if (g.type === 'polygon') return { ...base, type: 'polygon', y: g.dims[1].channel, coordinates: { vertices: g.geometry.vertices.map(([x, y]) => [fx(x), fy(y)]) } };
    if (g.type === 'range') return { ...base, type: 'range', coordinates: { ...(g.geometry.min !== null ? { min: fx(g.geometry.min) } : {}), ...(g.geometry.max !== null ? { max: fx(g.geometry.max) } : {}) } };
    throw new Error(`The expert does not draw ${g.type} gates.`);
  });
}

// An example's suggested gates (from a tiny copy of it: they do not depend on the events).
function suggestedGates(id, options) {
  return generateExample(id, { ...options, scale: 0.01 }).workspaceHints.suggestedGates;
}

// A named gate's population in a sample against the true events: { f1, precision, recall, n }.
async function gateAgainstTruth(page, sampleName, gateName, positives) {
  return page(`const { countOf, populationSet } = await import('/lib/engine.js');
    const ws = app.store.ws;
    const sample = ws.samples.find((s) => s.name === ${JSON.stringify(sampleName)});
    const gates = ws.gates.filter((g) => g.name.trim().toLowerCase() === ${JSON.stringify(gateName.toLowerCase())});
    if (!sample || !gates.length) return null;
    const view = await app.data.ensure(sample.id);
    const truth = ${JSON.stringify(positives)};
    let best = null;
    for (const gate of gates) {
      const set = populationSet(view, ws, gate.id);
      if (!set) continue;
      const n = countOf(set, view);
      let tp = 0;
      for (const e of truth) if (set.has(e)) tp += 1;
      const precision = n ? tp / n : 0;
      const recall = truth.length ? tp / truth.length : 0;
      const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
      if (!best || f1 > best.f1) best = { f1, precision, recall, n };
    }
    return best;`);
}

const isTCell = (name) => / T$|TEMRA$/.test(name);

// --- The tasks ------------------------------------------------------------------------------------

export const TASKS = [
  {
    id: 'pbmc-t-cells',
    category: 'gating',
    title: 'Gate T cells and report their frequency',
    example: { id: 'pbmc-immunophenotyping', options: { seed: 41001, scale: 0.3, ...PBMC_V2 } },
    prompt: () => `This workspace holds PBMC samples stained with a 14-color panel. Gate the T cells (single, live lymphocytes that are CD3+) and name that population "T cells". What percentage of all events in D01_Unstim are T cells?\n\n${answerLine('{"percent": <number>}')}`,
    truth(generated) {
      const file = generated.files.find((f) => f.name === 'D01_Unstim.fcs');
      const { labels, names } = file.meta.truth;
      const positives = [];
      labels.forEach((l, e) => { if (l >= 0 && isTCell(names[l])) positives.push(e); });
      return { positives, percent: (100 * positives.length) / labels.length };
    },
    async grade({ answer, page, truth }) {
      const gate = await gateAgainstTruth(page, 'D01_Unstim', 'T cells', truth.positives);
      const reported = number(answer?.percent);
      return { parts: [
        part('a "T cells" gate matching the true T cells (F1)', 0.6, gate ? closeness(1 - gate.f1, 0.1, 0.3) : 0, gate ? `F1 ${gate.f1.toFixed(3)} (precision ${gate.precision.toFixed(3)}, recall ${gate.recall.toFixed(3)})` : 'no gate named "T cells"'),
        part('the percentage of all events', 0.4, closeness(Math.abs(reported - truth.percent), 1.5, 5), `${Number.isFinite(reported) ? reported : 'none'} (true ${truth.percent.toFixed(2)})`),
      ] };
    },
    async expert(call, { task }) {
      for (const args of gateCalls(suggestedGates(task.example.id, task.example.options))) await call('create_gate', { ...args, sample: 'D01_Unstim' });
      const table = (await call('statistics_table', { statistic: 'freqTotal', populations: ['T cells'] })).data;
      const row = table.rows.find((r) => r.sample === 'D01_Unstim');
      const value = Object.values(row.values)[0];
      return `ANSWER: {"percent": ${value}}`;
    },
  },
  {
    id: 'pbmc-compensation-error',
    category: 'compensation',
    title: 'Find the wrong value in a spillover matrix',
    example: { id: 'pbmc-immunophenotyping', options: { seed: 41002, scale: 0.3, ...PBMC_V2 } },
    prompt: () => `These PBMC files came off the cytometer with its spillover matrix, and the stained samples use it. I suspect one value in it is wrong. Check the compensation, and tell me which spillover value is wrong and what it should be, in percent.\n\n${answerLine('{"from": "<channel the dye is read in>", "into": "<channel it spills into>", "correctPercent": <number>}')}`,
    truth() {
      const panel = buildPanel(INSTRUMENTS.fortessa, PBMC_PANEL);
      const n = panel.spill.channels.length;
      const i = panel.spill.channels.indexOf('APC-A');
      const j = panel.spill.channels.indexOf('Alexa Fluor 700-A');
      return { from: 'APC-A', into: 'Alexa Fluor 700-A', percent: 100 * panel.spill.matrix[i * n + j] };
    },
    async grade({ answer, truth }) {
      const is = (value, channel, words) => [norm(channel), norm(channel.replace(/-A$/, '')), ...words].includes(norm(value));
      const pair = is(answer?.from, truth.from, ['apc', 'cd8']) && is(answer?.into, truth.into, ['alexa fluor 700', 'af700', 'a700', 'cd4']);
      const value = number(answer?.correctPercent);
      return { parts: [
        part('the wrong entry (APC into Alexa Fluor 700)', 0.6, pair ? 1 : 0, `${answer?.from ?? '?'} → ${answer?.into ?? '?'}`),
        part('its correct value', 0.4, pair ? closeness(Math.abs(value - truth.percent), 1.5, 5) : 0, `${Number.isFinite(value) ? value : 'none'}% (true ${truth.percent.toFixed(2)}%)`),
      ] };
    },
    async expert(call) {
      const check = (await call('check_compensation', {})).data;
      const top = check.errors[0];
      return `ANSWER: ${JSON.stringify({ from: top.from, into: top.into, correctPercent: top.suggested })}`;
    },
  },
  {
    id: 'pbmc-stimulation-cd25',
    category: 'statistics',
    title: 'Test whether stimulation changes CD25+ CD4 T cells',
    example: { id: 'pbmc-immunophenotyping', options: { seed: 41003, scale: 0.3, ...PBMC_V2 }, gates: true },
    prompt: () => `Six donors' PBMC were acquired unstimulated and stimulated. Does stimulation change the percentage of CD25+ cells among CD4 T cells? Gate what you need, use an appropriate test for this design, and report the direction of the change and the p-value.\n\n${answerLine('{"direction": "up" | "down" | "no change", "p": <number>}')}`,
    truth: () => ({ direction: 'up' }),
    async grade({ answer, toolCalls }) {
      const direction = norm(answer?.direction);
      const p = number(answer?.p);
      const paired = toolCalls.some((c) => c.name === 'compare' && /subject|donor/i.test(String(c.input?.pairBy ?? '')))
        || toolCalls.some((c) => c.name === 'check_robustness' && /subject|donor/i.test(String(c.input?.pairBy ?? '')));
      return { parts: [
        part('the direction (CD25+ rises)', 0.5, /^(up|increase|increased|higher)$/.test(direction) ? 1 : 0, answer?.direction ?? 'none'),
        part('a significant p-value (p < 0.05)', 0.25, p > 0 && p < 0.05 ? 1 : 0, Number.isFinite(p) ? String(p) : 'none'),
        part('a test paired by donor', 0.25, paired ? 1 : 0, paired ? 'paired by subject' : 'no paired comparison'),
      ] };
    },
    async expert(call) {
      await call('create_gate', { parent: 'T cells', name: 'CD4 T cells', type: 'range', x: 'CD4', coordinates: { min: 2000 } });
      await call('auto_gate', { parent: 'CD4 T cells', name: 'CD25+', method: 'valley', x: 'CD25' });
      const result = (await call('compare', { population: 'CD25+', groupBy: 'condition', pairBy: 'subject' })).data;
      const p = result.tests.find((t) => /paired t/i.test(t.method))?.p ?? result.tests[0].p;
      const mean = (name) => result.groups.find((g) => g.group === name).mean;
      const direction = mean('Stimulated') > mean('Unstimulated') ? 'up' : 'down';
      return `ANSWER: ${JSON.stringify({ direction, p })}`;
    },
  },
  {
    id: 'qc-acquisition-problems',
    category: 'quality control',
    title: 'Name each acquisition\'s problem',
    example: { id: 'qc-showcase', options: { seed: 41004 } },
    prompt: () => `Here are four acquisitions of the same cells, A01 to A04. Check each one for problems during acquisition, and tell me which are clean and what went wrong with the others.\n\n${answerLine('{"A01": "<clean | clog | drift | bubble | other>", "A02": "...", "A03": "...", "A04": "..."}')}`,
    truth: () => ({ A01: 'clean', A02: 'clog', A03: 'drift', A04: 'bubble' }),
    async grade({ answer, truth }) {
      const kinds = { clean: /^(clean|none|ok|good|no problem)/, clog: /clog|block|flow (rate )?(drop|interrupt)|occlu/, drift: /drift|decay|declin|loss of signal|signal (drop|fall)/, bubble: /bubble|burst|air|spike/ };
      const parts = Object.entries(truth).map(([well, kind]) => {
        const said = norm(answer?.[well]);
        if (kind === 'clean') return part(`${well} is clean`, 0.25, kinds.clean.test(said) ? 1 : 0, said || 'none');
        const flagged = Boolean(said) && !kinds.clean.test(said);
        return part(`${well}: ${kind}`, 0.25, (flagged ? 0.6 : 0) + (kinds[kind].test(said) ? 0.4 : 0), said || 'none');
      });
      return { parts };
    },
    async expert(call) {
      const qc = (await call('run_qc', {})).data;
      const answer = {};
      for (const row of qc.rows) {
        const text = JSON.stringify(row.findings ?? row).toLowerCase();
        answer[row.sample] = row.score >= 90 ? 'clean' : /burst/.test(text) ? 'bubble' : /flow rate|clog/.test(text) ? 'clog' : /drift/.test(text) ? 'drift' : 'other';
      }
      return `ANSWER: ${JSON.stringify(answer)}`;
    },
  },
  {
    id: 'pbmc-acquisition-problem',
    category: 'quality control',
    title: 'Find the sample with an acquisition problem',
    example: { id: 'pbmc-immunophenotyping', options: { seed: 41005, scale: 0.3, ...PBMC_V2 } },
    prompt: () => `One of the twelve stained PBMC samples had a problem while it was acquired. Which one, and what kind of problem was it?\n\n${answerLine('{"sample": "<name>", "problem": "<what happened>"}')}`,
    truth: () => ({ sample: 'D05_Unstim', problem: 'clog' }),
    async grade({ answer, truth }) {
      const right = norm(answer?.sample).replace(/\.fcs$/, '') === norm(truth.sample);
      return { parts: [
        part('the sample (D05_Unstim)', 0.7, right ? 1 : 0, answer?.sample ?? 'none'),
        part('the problem (a clog)', 0.3, right && /clog|block|flow (rate )?(drop|interrupt)|occlu/.test(norm(answer?.problem)) ? 1 : 0, answer?.problem ?? 'none'),
      ] };
    },
    async expert(call) {
      const qc = (await call('run_qc', {})).data;
      const worst = [...qc.rows].sort((a, b) => a.score - b.score)[0];
      return `ANSWER: ${JSON.stringify({ sample: worst.sample, problem: worst.findings[0] })}`;
    },
  },
  {
    id: 'spectral-dye-fault',
    category: 'spectral unmixing',
    title: 'Find what is wrong with one dye in a spectral panel',
    example: { id: 'spectral-25color', options: { seed: 41006, scale: 0.4, tandemDegradation: { 'PE-Cy7': 0.1 }, degradationIn: 'samples' } },
    prompt: () => `This is a 25-color panel on a spectral cytometer: raw detector data, with single-stain reference controls, an unstained control and three donors. Unmix the donor samples. Something is off with one of the dyes in the donor samples. Which dye is it, and what is the most likely cause?\n\n${answerLine('{"dye": "<fluorochrome>", "cause": "<the most likely cause>"}')}`,
    truth: () => ({ dye: 'PE-Cy7', cause: 'degraded tandem' }),
    async grade({ answer }) {
      const dye = norm(answer?.dye);
      const right = ['pe cy7', 'pecy7', 'pe/cy7', 'cd45'].includes(dye);
      return { parts: [
        part('the dye (PE-Cy7)', 0.6, right ? 1 : 0, answer?.dye ?? 'none'),
        part('the cause (a degraded tandem)', 0.4, right && /degrad|break ?down|tandem|uncoupl|decoupl|acceptor/.test(norm(answer?.cause)) ? 1 : 0, answer?.cause ?? 'none'),
      ] };
    },
    async expert(call) {
      await call('unmix', {});
      const found = (await call('diagnose_unmixing', { sample: 'Donor_S1' })).data.findings[0];
      return `ANSWER: ${JSON.stringify({ dye: found.subject, cause: found.title })}`;
    },
  },
  {
    id: 'antibody-titration',
    category: 'assay setup',
    title: 'Choose an antibody amount from a titration',
    example: { id: 'titration-voltage', options: { seed: 41007, scale: 0.3 } },
    prompt: () => `We titrated our CD4-PE antibody on PBMC in two-fold steps (the tubes named "CD4-PE … ng", with an unstained tube). How much antibody per test should we use?\n\n${answerLine('{"amountNg": <number>}')}`,
    truth: () => ({ amount: 125 }),
    async grade({ answer, truth }) {
      const amount = number(answer?.amountNg);
      const score = Math.abs(amount - truth.amount) < 1 ? 1 : (Math.abs(amount - 62.5) < 1 || Math.abs(amount - 250) < 1) ? 0.4 : 0;
      return { parts: [part('the amount (125 ng: twice the amount near 90% of saturation)', 1, score, `${Number.isFinite(amount) ? amount : 'none'} ng`)] };
    },
    async expert(call) {
      const t = (await call('titration', { mode: 'titration' })).data;
      return `ANSWER: {"amountNg": ${number(t.recommended)}}`;
    },
  },
  {
    id: 'plate-dose-response',
    category: 'plates',
    title: 'Find the most potent compound on a plate',
    example: { id: 'plate-screen', options: { seed: 41008, scale: 0.6 }, gates: true },
    prompt: () => `This 96-well plate tests six compounds (CW-101 to CW-106) at ten doses each for inhibition of T-cell activation, measured as CD69+ among live T cells, with stimulated and unstimulated control wells. Which compound is the most potent inhibitor, and what is its IC50 in nM? Which compounds show no inhibition at the doses tested?\n\n${answerLine('{"mostPotent": "<compound>", "ic50nM": <number>, "inactive": ["<compound>", ...]}')}`,
    truth: () => {
      const potent = [...SCREEN_COMPOUNDS].filter((c) => c.inhibition >= 0.9).sort((a, b) => a.ic50 - b.ic50)[0];
      return { mostPotent: potent.name, ic50: potent.ic50, inactive: SCREEN_COMPOUNDS.filter((c) => !c.inhibition).map((c) => c.name), active: SCREEN_COMPOUNDS.filter((c) => c.inhibition && c.ic50 < 1000).map((c) => c.name) };
    },
    async grade({ answer, truth }) {
      const potent = norm(answer?.mostPotent) === norm(truth.mostPotent);
      const ic50 = number(answer?.ic50nM);
      const inactive = (Array.isArray(answer?.inactive) ? answer.inactive : []).map(norm);
      const inactiveRight = truth.inactive.every((c) => inactive.includes(norm(c))) && !truth.active.some((c) => inactive.includes(norm(c)));
      return { parts: [
        part(`the most potent compound (${truth.mostPotent})`, 0.4, potent ? 1 : 0, answer?.mostPotent ?? 'none'),
        part('its IC50 (within 2× of the truth)', 0.3, potent && ic50 > 0 ? closeness(Math.abs(Math.log2(ic50 / truth.ic50)), 1, 2) : 0, `${Number.isFinite(ic50) ? ic50 : 'none'} nM (true ${truth.ic50})`),
        part(`the inactive compounds (${truth.inactive.join(', ')}; CW-106 either way)`, 0.3, inactiveRight ? 1 : 0, inactive.join(', ') || 'none'),
      ] };
    },
    async expert(call) {
      const dr = (await call('dose_response', { population: 'Lymphocytes/Live/T cells/CD69+', statistic: 'freqParent' })).data;
      const fitted = dr.rows.filter((r) => Number.isFinite(r.ec50) && !r.flags.includes('extrapolated')).sort((a, b) => a.ec50 - b.ec50);
      const inactive = dr.rows.filter((r) => r.flags.includes('no-effect')).map((r) => r.group);
      return `ANSWER: ${JSON.stringify({ mostPotent: fitted[0].group, ic50nM: fitted[0].ec50, inactive })}`;
    },
  },
  {
    id: 'bead-assay-concentration',
    category: 'immunoassay',
    title: 'Read a serum concentration from a bead assay',
    example: { id: 'bead-immunoassay', options: { seed: 41009, scale: 0.6 }, gates: true },
    prompt: () => `This is a LEGENDplex-like cytokine bead assay on a plate: standards C0 (blank) to C7 (10,000 pg/mL top standard, 4-fold steps) and twenty sera, each diluted 2-fold, in duplicate. Beads A carry IL-2, IL-4, IL-6 and IL-10, beads B IL-17A, IFN-γ, TNF-α and IL-1β, each in that order from the dimmest to the brightest APC level. What is the IL-6 concentration in serum S07, in pg/mL of serum?\n\n${answerLine('{"il6": <number>}')}`,
    truth(generated) {
      const file = generated.files.find((f) => generated.workspaceHints.sampleMeta[f.name]?.specimen === 'S07');
      return { il6: file.meta.truth.beads.serum['IL-6'] };
    },
    async grade({ answer, truth }) {
      const value = number(answer?.il6);
      return { parts: [part('the IL-6 concentration (within 20%)', 1, value > 0 ? closeness(Math.abs(Math.log(value / truth.il6)), Math.log(1.2), Math.log(2)) : 0, `${Number.isFinite(value) ? value : 'none'} pg/mL (true ${truth.il6.toPrecision(4)})`)] };
    },
    async expert(call) {
      const assay = (await call('bead_assay', { groups: [{ population: 'Beads A', analytes: ['IL-2', 'IL-4', 'IL-6', 'IL-10'] }, { population: 'Beads B', analytes: ['IL-17A', 'IFN-γ', 'TNF-α', 'IL-1β'] }], top: 10000 })).data;
      const s07 = assay.samples.find((s) => s.name === 'S07');
      return `ANSWER: {"il6": ${s07.concentrations['IL-6'].mean}}`;
    },
  },
  {
    id: 'calcium-response',
    category: 'kinetics',
    title: 'Compare calcium responses to stimuli',
    example: { id: 'calcium-flux', options: { seed: 41010, scale: 0.5 } },
    prompt: () => `These tubes are a calcium flux assay with Indo-1: buffer, two doses of anti-CD3 and ionomycin, each added during acquisition. Which stimulus gives the strongest response, and what percentage of all cells respond to it?\n\n${answerLine('{"strongest": "<sample name>", "respondingPercent": <number>}')}`,
    truth(generated) {
      const rows = generated.files.map((f) => ({ name: f.name.replace(/\.fcs$/, ''), percent: (100 * f.meta.truth.responder.reduce((a, b) => a + b, 0)) / f.meta.truth.responder.length }));
      const strongest = rows.sort((a, b) => b.percent - a.percent)[0];
      return { strongest: strongest.name, percent: strongest.percent };
    },
    async grade({ answer, truth }) {
      const right = norm(answer?.strongest).replace(/\.fcs$/, '').includes('ionomycin');
      const value = number(answer?.respondingPercent);
      return { parts: [
        part('the strongest stimulus (ionomycin)', 0.5, right ? 1 : 0, answer?.strongest ?? 'none'),
        part('the percentage responding (within 10 points)', 0.5, right ? closeness(Math.abs(value - truth.percent), 10, 25) : 0, `${Number.isFinite(value) ? value : 'none'} (true ${truth.percent.toFixed(1)})`),
      ] };
    },
    async expert(call) {
      const flux = (await call('kinetics', {})).data;
      const best = [...flux.rows].sort((a, b) => b.respondingPercent - a.respondingPercent)[0];
      return `ANSWER: ${JSON.stringify({ strongest: best.sample, respondingPercent: best.respondingPercent })}`;
    },
  },
  {
    id: 'gating-report',
    category: 'reporting',
    title: 'Write a gating report as a PDF',
    example: { id: 'pbmc-immunophenotyping', options: { seed: 41011, scale: 0.2, ...PBMC_V2 }, gates: true },
    prompt: ({ outputs }) => `Make a PDF report of the gating strategy down to the T cells, one page for each of the twelve stained samples, and save it as ${join(outputs, 'gating-report.pdf')}.\n\n${answerLine('{"path": "<file>", "pages": <number>}')}`,
    truth: () => ({ pages: 12, gates: ['Cells', 'Single cells', 'Live', 'Lymphocytes', 'T cells'] }),
    async grade({ outputs, truth }) {
      const path = join(outputs, 'gating-report.pdf');
      if (!existsSync(path)) return { parts: [part('the PDF written', 0.4, 0, 'no file'), part('a page per stained sample', 0.3, 0, '—'), part('the gating strategy on its pages', 0.3, 0, '—')] };
      let pdf = null;
      try {
        pdf = readPDF(readFileSync(path));
      } catch {
        pdf = null;
      }
      const text = pdf ? pdf.pages.map((p) => p.strings.join('\n')).join('\f') : '';
      const found = truth.gates.filter((g) => text.includes(g)).length;
      return { parts: [
        part('the PDF written', 0.4, pdf ? 1 : 0.5, pdf ? `${pdf.pages.length} pages` : 'not a readable PDF'),
        part('a page per stained sample (12)', 0.3, pdf?.pages.length === truth.pages ? 1 : 0, pdf ? `${pdf.pages.length} pages` : '—'),
        part('the gating strategy on its pages', 0.3, found / truth.gates.length, `${found} of ${truth.gates.length} gates named`),
      ] };
    },
    async expert(call, { outputs }) {
      await call('build_figure', { population: 'T cells', kind: 'gating-strategy', sample: 'D01_Unstim' });
      const path = join(outputs, 'gating-report.pdf');
      const report = (await call('export_report', { path, by: 'sample' })).data;
      return `ANSWER: ${JSON.stringify({ path, pages: report.pages?.length ?? report.pages })}`;
    },
  },
];
