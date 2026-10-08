// The panel optimizer in the app (lib/panel-optimizer.js). What a design starts from: the dyes of
// an experiment's reference controls and the instrument's spectral library (spectral), or the
// dyes of a compensation computed from single-stain controls (conventional); the noise fitted to
// the controls, kept for the instrument or from its bead runs; the unstained control's background.
// The view edits the markers, their expression and the groups of co-expressed markers, runs the
// optimizer in the spectral worker and shows the design; a spectral design can be kept in the
// instrument's spectral library and checked against the run of the panel once its controls are
// measured. The Spectral view (Panel design), the Compensate view (a dialog) and agents
// (remote.js design_panel) use it.

import { h, icon, clear, downloadBlob, formatCount } from './dom.js';
import { toast } from './overlays.js';
import { dyeInfo } from '../lib/dyes.js';
import { LEVELS, compareWithRun, defaultSignalScale, levelLabel, levelValue } from '../lib/panel-optimizer.js';
import { latestEntries, spectrumOn } from '../lib/spectral-library.js';
import { c1FromRuns, detectorLaser, noiseOn } from '../lib/spread.js';
import { copyColumns, thinIndices } from '../lib/spectral-ui.js';
import { LIMITS, SEED, spectralState, unstainedColumns } from './spectral-run.js';

// The detectors and lasers a noise model is read on.
export function detectorModel(detectors) {
  const lasers = [];
  for (const d of detectors) {
    const l = detectorLaser(d);
    if (l && !lasers.includes(l)) lasers.push(l);
  }
  return { detectors: [...detectors], D: detectors.length, lasers };
}

// The noise sources available on a model's detectors: [{ id, label, noise ({ c1, laserCV } on the
// model), note }]. ctx.fitted: the noise fitted to this experiment's controls ({ record, check,
// computed }), ctx.library: the instrument's spectral library record (its kept noise), ctx.runs:
// its bead runs.
export function noiseSources(model, ctx) {
  const out = [];
  const fromControls = noiseOn(model, ctx.fitted?.record);
  if (fromControls) {
    const c = ctx.fitted.check;
    out.push({
      id: 'controls',
      label: 'This experiment\'s controls',
      noise: fromControls,
      note: `Fitted to the spread of ${ctx.fitted.record.controls ?? '?'} controls (${new Date(ctx.fitted.computed).toLocaleDateString()}).${c && c.measurable ? ` Check: each control's spread predicted from the others is within a factor ${c.medianRatio.toFixed(2)} of the observed (median), and within 2× for ${Math.round(100 * c.within2x)}% of ${c.measurable} clearly measured pairs.` : ''}`,
    });
  }
  const kept = ctx.library?.noise;
  const saved = noiseOn(model, kept);
  if (saved) out.push({ id: 'library', label: `Kept for ${ctx.instrumentName ?? 'the instrument'}`, noise: saved, note: `Fitted ${new Date(kept.fitted).toLocaleDateString()}${kept.workspace ? ` in ${kept.workspace}` : ''} and kept in the library for this instrument.` });
  const beads = c1FromRuns(model, ctx.runs ?? []);
  if (beads) {
    const lasers = (fromControls ?? saved)?.laserCV ?? new Float64Array(model.lasers.length);
    const found = beads.found.reduce((a, b) => a + b, 0);
    out.push({ id: 'beads', label: 'Bead runs', noise: { c1: beads.c1, laserCV: lasers, source: 'beads' }, note: `Photon noise (1/Q) of ${found} of ${model.D} detectors from the instrument's bead runs (median of ${(ctx.runs ?? []).length}); the others take the median. ${fromControls || saved ? 'Laser fluctuations from the controls.' : 'Without controls, laser fluctuations are left out, so dyes excited by several lasers are predicted to spread less than they will.'} Q depends on detector gains: use runs at this experiment's settings.` });
  }
  return out;
}

const noiseRecordOf = (model, noise) => ({ detectors: model.detectors, c1: Array.from(noise.c1), lasers: model.lasers, laserCV: Array.from(noise.laserCV ?? []) });

// The dye a channel or control name carries: the dye table's name, else the name without "-A".
const dyeName = (name) => {
  const stripped = String(name).replace(/-[AHW]$/, '');
  return dyeInfo(stripped)?.name ?? stripped;
};

// A spectral experiment's design inputs: { kind, detectors, range, candidates: [{ name, spectrum,
// source }], current ({ marker: dye } of the controls), markers (defaults), sources (noise),
// unstained (sample or null) }. Library spectra of the instrument join the panel's dyes.
export function spectralInputs(ws, { library = null, runs = [], instrumentName = null } = {}) {
  const state = spectralState(ws);
  const detectors = state.setup?.params?.detectors ?? state.panelDetectors();
  const refs = state.activeRefs();
  const candidates = refs.map((r) => ({ name: r.name, spectrum: Array.from(r.ref.spectrum), source: r.sample.library ? 'library' : 'control' }));
  for (const e of latestEntries(library, detectors).values()) {
    if (candidates.some((c) => c.name.toLowerCase() === e.fluorochrome.toLowerCase())) continue;
    candidates.push({ name: e.fluorochrome, spectrum: Array.from(spectrumOn(e, detectors)), source: 'library' });
  }
  const current = {};
  for (const r of refs) if (r.marker && !current[r.marker]) current[r.marker] = r.name;
  const spreading = state.setup?.spreading;
  const model = detectorModel(detectors);
  const sources = noiseSources(model, { fitted: spreading?.noise ? { record: spreading.noise, check: spreading.check, computed: spreading.computed } : null, library, runs, instrumentName }).map((s) => ({ ...s, record: noiseRecordOf(model, s.noise) }));
  return { kind: 'spectral', detectors, range: state.detectorRange(detectors), candidates, current, markers: Object.keys(current).map((name) => ({ name, level: 'medium' })), sources, unstained: state.unstainedSample, background: keptBackground(library, detectors), spreading };
}

// The unstained control's background kept with the instrument's noise, on these detectors.
function keptBackground(record, detectors) {
  const b = record?.background;
  return b?.detectors?.join('\u0000') === detectors.join('\u0000') ? { covariance: b.covariance, source: 'kept' } : null;
}

// The detectors most of a library's entries share (all of them on one instrument, normally).
export function libraryDetectors(record) {
  const counts = new Map();
  for (const e of latestEntries(record, null).values()) {
    const key = e.detectors.join('\u0000');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0].split('\u0000') : [];
}

// Design inputs from an instrument's spectral library alone (no experiment).
export function libraryInputs(record, detectors, runs = []) {
  const candidates = [...latestEntries(record, detectors).values()].map((e) => ({ name: e.fluorochrome, spectrum: Array.from(spectrumOn(e, detectors)), source: 'library' }));
  const model = detectorModel(detectors);
  const sources = noiseSources(model, { library: record, runs, instrumentName: record?.name }).map((s) => ({ ...s, record: noiseRecordOf(model, s.noise) }));
  return { kind: 'spectral', detectors, range: 4194304, candidates, current: null, markers: [], sources, unstained: null, background: keptBackground(record, detectors) };
}

// A conventional experiment's design inputs from a compensation with its spread (computed from
// single-stain controls): each control's dye, read in its own detector.
export function compensationInputs(ws, compensation) {
  const record = compensation.spread;
  const detectors = record.detectors;
  const channelOf = new Map(ws.samples.flatMap((s) => s.channels).map((c) => [c.name, c]));
  const candidates = record.names.map((name, i) => ({ name: dyeName(record.channels?.[i] ?? name), spectrum: record.spectra[i], detector: detectors[i], source: 'control' }));
  const current = {};
  candidates.forEach((c) => {
    const marker = channelOf.get(c.detector)?.marker;
    if (marker && !current[marker]) current[marker] = c.name;
  });
  const range = Math.max(0, ...detectors.map((d) => channelOf.get(d)?.range ?? 0)) || 262144;
  return {
    kind: 'conventional',
    detectors,
    range,
    candidates,
    current,
    markers: Object.keys(current).map((name) => ({ name, level: 'medium' })),
    sources: [{ id: 'controls', label: 'This experiment\'s controls', record: record.noise, note: `Fitted to the spread of the single-stain controls when "${compensation.name}" was computed.` }],
    unstained: ws.samples.find((s) => s.role === 'unstained') ?? null,
  };
}

// The unstained control's raw detector columns (thinned), or null.
async function backgroundColumns(app, inputs) {
  if (!inputs.unstained) return null;
  if (inputs.kind === 'spectral') return unstainedColumns(app, spectralState(app.store.ws), inputs.detectors);
  const view = await app.data.ensure(inputs.unstained.id);
  if (!inputs.detectors.every((d) => view.raw.has(d))) return null;
  return copyColumns(inputs.detectors.map((d) => view.raw.get(d)), thinIndices(null, view.eventCount, LIMITS.unstained));
}

// Runs a design in the spectral worker. spec: { markers: [{ name, level, dye?, weight? }], groups:
// [{ name, markers }], exclude (dye names left out), brightness ({ dye: value }), source (noise
// id), seed }. Returns { result (designPanel), noise (label), background ('unstained' | 'kept' |
// 'assumed'), spec, inputs summary }.
export async function runDesign(app, inputs, spec, { onProgress, track = (job) => job } = {}) {
  const source = inputs.sources.find((s) => s.id === spec.source) ?? inputs.sources[0];
  if (!source) throw new Error('No noise model: compute the spreading matrix from the controls (Spectral → Panel quality, or Compensate from the controls), keep one for the instrument, or run multi-level beads (QC → Instrument).');
  const exclude = new Set(spec.exclude ?? []);
  const dyes = inputs.candidates.filter((c) => !exclude.has(c.name)).map((c) => ({ name: c.name, spectrum: c.spectrum, detector: c.detector, brightness: spec.brightness?.[c.name] ?? null }));
  const unstained = await backgroundColumns(app, inputs);
  const input = {
    markers: spec.markers,
    groups: spec.groups,
    dyes,
    detectors: inputs.detectors,
    noise: source.record,
    background: unstained ? null : inputs.background ?? null,
    signalScale: defaultSignalScale(inputs.range),
    square: inputs.kind === 'conventional',
  };
  const compare = {};
  if (inputs.current && spec.markers.every((m) => inputs.current[m.name])) compare['This experiment\'s panel'] = inputs.current;
  const job = track(app.worker('spectral').run('designPanel', { input, options: { seed: spec.seed ?? SEED, compare }, unstained }, { onProgress, transfer: unstained ? unstained.map((c) => c.buffer) : [] }));
  const result = await job.promise;
  return { result, noise: source.label, background: unstained ? 'unstained' : inputs.background ? 'kept' : 'assumed', spec: structuredClone(spec), detectors: inputs.detectors };
}

// --- Kept designs ------------------------------------------------------------------------------

// A design as kept in the instrument's spectral library (doc.designs).
export function keptDesign(run, name) {
  return {
    id: `design-${Date.now().toString(36)}`,
    name,
    created: new Date().toISOString(),
    noise: run.noise,
    background: run.background,
    markers: run.spec.markers,
    groups: run.spec.groups,
    assignments: run.result.assignments.map((a) => ({ marker: a.marker, level: a.level, dye: a.dye, stainIndex: +a.stainIndex.toPrecision(4) })),
    cost: run.result.cost,
    spread: run.result.spread,
  };
}

// Kept designs against a run's spreading matrix: [{ design, check (compareWithRun) }] for those
// sharing at least three dyes with it.
export function designsAgainstRun(designs, spreading) {
  if (!spreading?.observations?.length) return [];
  return (designs ?? []).map((design) => ({ design, check: compareWithRun(design.spread, spreading) })).filter((x) => x.check.shared >= 3);
}

// --- The view ----------------------------------------------------------------------------------

const states = new Map();
const LEVEL_NAMES = Object.keys(LEVELS);

// The editor's state for a context key (kept for the session): { markers, groups, exclude,
// brightness, source, run, busy }.
function stateFor(key, inputs) {
  if (!states.has(key)) {
    const markers = inputs.markers.length ? inputs.markers.map((m) => ({ ...m, dye: '' })) : [{ name: '', level: 'high', dye: '' }];
    states.set(key, { markers, groups: [{ name: 'Group 1', members: new Set(markers.map((_, k) => k)) }], exclude: new Set(), brightness: {}, source: null, run: null, busy: false, error: null });
  }
  return states.get(key);
}

// The spec a state describes, or throws with what is missing.
function specOf(state) {
  const markers = state.markers.map((m) => ({ name: m.name.trim(), level: m.level, dye: m.dye || null })).filter((m) => m.name);
  if (!markers.length) throw new Error('Name the markers of the panel.');
  const names = markers.map((m) => m.name);
  const dup = names.find((n, k) => names.indexOf(n) !== k);
  if (dup) throw new Error(`${dup} is listed twice.`);
  for (const m of markers) levelValue(m.level);
  const index = state.markers.map((m) => (m.name.trim() ? names.indexOf(m.name.trim()) : -1));
  const groups = state.groups.map((g) => ({ name: g.name.trim() || 'Group', markers: [...g.members].map((k) => names[index[k]]).filter(Boolean) })).filter((g) => g.markers.length > 1);
  return { markers, groups, exclude: [...state.exclude], brightness: { ...state.brightness }, source: state.source, seed: SEED };
}

// The optimizer's pane. ctx: { key, inputs, rerender, onUse(run) (show the design's dyes in the
// design view), onKeep(run) (keep in the library) }.
export function optimizerPane(app, ctx) {
  const { inputs } = ctx;
  const state = stateFor(ctx.key, inputs);
  const host = h('div');
  const render = () => {
    clear(host);
    host.append(editor(app, ctx, state, render));
    if (state.run) host.append(resultView(ctx, state.run));
  };
  render();
  return host;
}

function editor(app, ctx, state, render) {
  const { inputs } = ctx;
  const pane = h('div.pane', h('h3', 'Optimize the panel', h('span.muted', { style: { fontWeight: 500 } }, `${inputs.candidates.length - state.exclude.size} dyes for ${state.markers.filter((m) => m.name.trim()).length} markers`)));
  pane.append(h('p.muted', { style: { marginTop: 0 } }, 'Which dye each marker should carry: the optimizer predicts every marker\'s resolution from the dyes\' spectra, the instrument\'s noise and the unstained control\'s background, with the spread of every co-expressed marker at its own brightness, and searches the assignments for the best. Give each marker its expression (high ≈ 10⁵ molecules per cell, medium 10⁴, low 10³, or a number) and tick the markers found on the same cells in each group.'));

  // Markers × groups.
  const head = h('tr', h('th', 'Marker'), h('th', 'Expression'), h('th', 'Dye'),
    state.groups.map((g, k) => h('th', h('input.input.small', { value: g.name, 'aria-label': `Name of group ${k + 1}`, style: { width: '96px' }, onchange: (e) => { g.name = e.target.value; } }),
      state.groups.length > 1 ? h('button.icon-button.small', { type: 'button', title: `Remove ${g.name}`, 'aria-label': `Remove ${g.name}`, onclick: () => { state.groups.splice(k, 1); render(); } }, icon('close')) : null)),
    h('th', h('button.btn.small.ghost', { type: 'button', onclick: () => { state.groups.push({ name: `Group ${state.groups.length + 1}`, members: new Set() }); render(); } }, icon('plus'), 'Group')));
  const levelSelect = (m, k) => {
    const custom = !LEVEL_NAMES.includes(String(m.level));
    const select = h('select.input.small', { 'aria-label': `Expression of marker ${k + 1}`, style: { width: '96px' }, onchange: (e) => { m.level = e.target.value === 'number' ? 5000 : e.target.value; render(); } },
      LEVEL_NAMES.map((l) => h('option', { value: l, selected: m.level === l }, l)), h('option', { value: 'number', selected: custom }, 'number…'));
    return h('div.row', select, custom ? h('input.input.small', { type: 'number', min: 1, value: m.level, 'aria-label': `Molecules per cell of marker ${k + 1}`, style: { width: '84px' }, onchange: (e) => { m.level = Number(e.target.value) > 0 ? Number(e.target.value) : 5000; } }) : null);
  };
  const body = h('tbody', state.markers.map((m, k) => h('tr',
    h('td', h('input.input.small', { value: m.name, placeholder: 'CD4', 'aria-label': `Marker ${k + 1}`, style: { width: '110px' }, onchange: (e) => { m.name = e.target.value; } })),
    h('td', levelSelect(m, k)),
    h('td', h('select.input.small', { 'aria-label': `Dye of marker ${k + 1}`, style: { width: '130px' }, title: 'Any: the optimizer chooses; or fix this marker\'s dye', onchange: (e) => { m.dye = e.target.value; } },
      h('option', { value: '' }, 'any'), inputs.candidates.map((c) => h('option', { value: c.name, selected: m.dye === c.name }, c.name)))),
    state.groups.map((g) => h('td', { style: { textAlign: 'center' } }, h('input', { type: 'checkbox', checked: g.members.has(k), 'aria-label': `${m.name || `Marker ${k + 1}`} in ${g.name}`, onchange: (e) => { if (e.target.checked) g.members.add(k); else g.members.delete(k); } }))),
    h('td', h('button.icon-button.small', { type: 'button', title: 'Remove the marker', 'aria-label': `Remove ${m.name || `marker ${k + 1}`}`, onclick: () => {
      state.markers.splice(k, 1);
      for (const g of state.groups) g.members = new Set([...g.members].filter((x) => x !== k).map((x) => (x > k ? x - 1 : x)));
      render();
    } }, icon('close'))))));
  pane.append(h('div', { style: { overflow: 'auto', maxHeight: '420px' } }, h('table.data', h('thead', head), body)),
    h('div.btn-row', { style: { marginTop: '8px' } },
      h('button.btn.small', { type: 'button', onclick: () => { state.markers.push({ name: '', level: 'medium', dye: '' }); render(); } }, icon('plus'), 'Marker'),
      inputs.current && Object.keys(inputs.current).length ? h('button.btn.small.ghost', { type: 'button', title: 'The markers of this experiment\'s controls', onclick: () => { const keep = state.markers.filter((m) => m.name.trim()); for (const name of Object.keys(inputs.current)) if (!keep.some((m) => m.name === name)) keep.push({ name, level: 'medium', dye: '' }); state.markers = keep; render(); } }, icon('upload'), 'This experiment\'s markers') : null));

  // Candidate dyes.
  const dyeRows = inputs.candidates.map((c) => {
    const table = dyeInfo(c.name)?.brightness ?? null;
    const off = state.exclude.has(c.name);
    return h('tr',
      h('td', h('label.check', h('input', { type: 'checkbox', checked: !off, onchange: (e) => { if (e.target.checked) state.exclude.delete(c.name); else state.exclude.add(c.name); render(); } }), c.name)),
      h('td.muted', c.source === 'library' ? 'library' : 'control'),
      h('td', h('input.input.small', { type: 'number', min: 0, step: 0.05, value: state.brightness[c.name] ?? '', placeholder: table ?? 'unknown', 'aria-label': `Relative brightness of ${c.name}`, style: { width: '84px' }, onchange: (e) => { const v = Number(e.target.value); if (v > 0) state.brightness[c.name] = v; else delete state.brightness[c.name]; } })));
  });
  pane.append(h('details', { style: { marginTop: '10px' } }, h('summary', `Dyes (${inputs.candidates.length}): which to use, and their brightness`),
    h('p.muted.small-print', 'Relative brightness per bound antibody, as vendors\' brightness charts rank dyes (PE 0.5, FITC 0.12); a blank uses the built-in value, or the median of the others when the dye is unknown. Library spectra must come from this instrument at these settings.'),
    h('div', { style: { overflow: 'auto', maxHeight: '260px' } }, h('table.data', h('thead', h('tr', h('th', 'Dye'), h('th', 'Spectrum'), h('th', 'Brightness'))), h('tbody', dyeRows)))));

  // Noise and run.
  const sources = inputs.sources;
  const chosen = sources.find((s) => s.id === state.source) ?? sources[0];
  if (!sources.length) pane.append(h('div.callout.warn', { style: { marginTop: '10px' } }, icon('info'), h('span', 'No noise model yet: compute the spreading matrix from the controls (Spectral → Panel quality, or Compensate from the single-stain controls), keep one for the instrument, or characterize it with multi-level beads (QC → Instrument).')));
  else {
    pane.append(h('div.field', { style: { marginTop: '10px' } }, h('span', 'Noise of the instrument'),
      h('div.segmented', { role: 'group', 'aria-label': 'Noise source' }, sources.map((s) => h(`button${s === chosen ? '.active' : ''}`, { type: 'button', 'aria-pressed': String(s === chosen), onclick: () => { state.source = s.id; render(); } }, s.label))),
      h('span.muted', { style: { fontWeight: 400 } }, `${chosen.note} Background: ${inputs.unstained ? `the unstained control (${inputs.unstained.name})` : inputs.background ? 'kept for the instrument' : 'assumed (no unstained control)'}.`)));
  }
  if (state.error) pane.append(h('div.callout.danger', { style: { marginTop: '8px' } }, icon('warning'), h('span', state.error)));
  const run = async () => {
    let spec;
    try {
      spec = specOf(state);
    } catch (error) {
      state.error = error.message;
      render();
      return;
    }
    state.error = null;
    state.busy = true;
    render();
    try {
      state.run = await runDesign(app, inputs, spec, { onProgress: (f, message) => { if (state.progressEl) state.progressEl.textContent = message; } });
    } catch (error) {
      state.error = error.message;
    } finally {
      state.busy = false;
      render();
    }
  };
  state.progressEl = state.busy ? h('span.muted', { role: 'status' }, 'Starting…') : null;
  pane.append(h('div.btn-row', { style: { marginTop: '6px' } },
    h('button.btn.primary', { type: 'button', disabled: state.busy || !sources.length, onclick: run }, icon('sparkles'), state.busy ? 'Optimizing…' : 'Optimize'),
    state.progressEl));
  return pane;
}

const si = (v) => (Number.isFinite(v) ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) : '∞');
const pct = (fraction) => {
  const v = 100 * Math.max(fraction, 0);
  return v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v >= 0.001 ? v.toPrecision(2) : '0';
};

function resultView(ctx, run) {
  const { result } = run;
  const compared = result.compared.find((c) => c.rows);
  const searched = result.method === 'exhaustive' ? `best of ${formatCount(result.assignmentsTried)} assignments` : result.evaluations === 1 ? `local search, swapping ${result.assignments.length} dyes` : `local search, ${formatCount(result.evaluations)} dye sets tried`;
  const pane = h('div.pane', h('h3', 'Design', h('span.spacer'),
    ctx.onUse ? h('button.btn.small', { type: 'button', title: 'Show these dyes in the predicted spreading matrix', onclick: () => ctx.onUse(run) }, icon('layers'), 'Show in the design view') : null,
    ctx.onKeep ? h('button.btn.small', { type: 'button', title: 'Keep the design in the instrument\'s library, to check it against the run of the panel', onclick: () => ctx.onKeep(run) }, icon('library'), 'Keep') : null,
    h('button.btn.small', { type: 'button', title: 'Download the design as CSV', onclick: () => downloadDesign(run) }, icon('download'), 'CSV')),
  h('p.muted', { style: { margin: '-4px 0 0' } }, `${searched[0].toUpperCase()}${searched.slice(1)} · noise: ${run.noise} · background: ${run.background === 'unstained' ? 'the unstained control' : run.background === 'kept' ? 'kept for the instrument' : 'assumed'}`));
  const tiles = [h('div.stat-tile', h('div.k', 'Dimmest resolution'), h('div.v', (() => {
    const worst = [...result.assignments].sort((a, b) => a.stainIndex - b.stainIndex)[0];
    return [si(worst.stainIndex), h('span.muted', { style: { fontSize: '11px', fontWeight: 500 } }, ` ${worst.marker} on ${worst.dye}`)];
  })()))];
  if (compared) tiles.push(h('div.stat-tile', h('div.k', 'Noise vs this experiment\'s panel'), h('div.v', `${(100 * (result.cost / compared.cost)).toFixed(0)}%`, h('span.muted', { style: { fontSize: '11px', fontWeight: 500 } }, ' of its Σ σ²/ΔF²'))));
  if (result.rule) tiles.push(h('div.stat-tile', h('div.k', 'Vs dimmest-on-brightest'), h('div.v', `${(100 * (result.cost / result.rule.cost)).toFixed(0)}%`, h('span.muted', { style: { fontSize: '11px', fontWeight: 500 } }, ' of its noise'))));
  pane.append(h('div.stat-grid', tiles));
  const currentOf = (marker) => compared?.rows.find((r) => r.marker === marker);
  pane.append(h('div', { style: { overflow: 'auto', maxHeight: '460px', marginTop: '8px' } }, h('table.data',
    h('thead', h('tr', h('th', 'Marker'), h('th', 'Expression'), h('th', 'Dye'), h('th.r', { title: 'Predicted stain index: ΔF / (2 SD of the negative) on the cells of its worst group' }, 'Stain index'), h('th', 'Limited by'), compared ? h('th', 'This experiment') : null, h('th', 'Next best'))),
    h('tbody', [...result.assignments].sort((a, b) => a.stainIndex - b.stainIndex).map((a) => {
      const top = a.from[0];
      const limited = a.background >= 0.5 || !top ? `background ${Math.round(100 * a.background)}%` : `${top.marker} (${top.dye}) ${Math.round(100 * top.share)}%`;
      const now = currentOf(a.marker);
      return h('tr',
        h('td', a.marker),
        h('td.muted', levelLabel(a.level)),
        h('td', { style: { whiteSpace: 'nowrap' } }, h('b', a.dye), a.fixed ? h('span.badge', { style: { marginLeft: '6px' } }, 'fixed') : null),
        h('td.r', si(a.stainIndex)),
        h('td.muted', { title: a.group ? `In ${a.group}` : 'In no group' }, limited),
        compared ? h('td.muted', now ? `${now.dye} · ${si(now.stainIndex)}` : '—') : null,
        h('td.muted', { style: { minWidth: '160px' }, title: a.alternatives.map((x) => `${x.dye}${x.swapWith ? ` (swap with ${x.swapWith})` : ''}: stain index ${si(x.stainIndex)}, the panel's noise +${pct(x.increase)}%`).join('\n') }, a.alternatives[0] ? `${a.alternatives[0].dye}${a.alternatives[0].swapWith ? ` ⇄ ${a.alternatives[0].swapWith}` : ''}: ${si(a.alternatives[0].stainIndex)}, +${pct(a.alternatives[0].increase)}%` : '—'));
    })))));
  if (result.energyTransfer.length) {
    const markerOf = new Map(result.assignments.map((a) => [a.dye, a.marker]));
    const tandems = new Map();
    for (const e of result.energyTransfer.filter((x) => x.kind === 'tandem')) {
      if (!tandems.has(e.donor)) tandems.set(e.donor, new Set());
      tandems.get(e.donor).add(e.acceptor);
    }
    const transfers = result.energyTransfer.filter((x) => x.kind === 'transfer');
    const items = [
      ...[...tandems].map(([donor, list]) => h('li', `${donor} (${markerOf.get(donor)}) is on the same cells as its tandem${list.size > 1 ? 's' : ''} ${[...list].map((d) => `${d} (${markerOf.get(d)})`).join(', ')}: where a tandem breaks down (light, fixation, time) it emits as ${donor}, into ${markerOf.get(donor)}'s channel.`)),
      ...transfers.slice(0, 6).map((e) => h('li', `${markerOf.get(e.donor)} and ${markerOf.get(e.acceptor)}: ${e.note}`)),
      transfers.length > 6 ? h('li', `and ${transfers.length - 6} more pairs whose emission and absorption overlap.`) : null,
    ];
    pane.append(h('div.callout.warn', { style: { marginTop: '8px' } }, icon('warning'), h('div',
      h('b', 'Dyes on the same cells that can pass light between them'),
      h('ul.spectral-caveats', items),
      h('span.muted', 'Energy transfer needs the dyes within about 10 nm of each other, so it matters for markers on the same molecule or complex (CD3 and the TCR, for instance).'))));
  }
  for (const w of result.warnings) pane.append(h('div.callout', { style: { marginTop: '6px' } }, icon('info'), h('span', w)));
  pane.append(h('p.muted.small-print', `Predicted from the spread model: photon noise and laser fluctuations of every co-expressed marker at its brightness (expression × the dye's relative brightness × ${result.settings.signalScale} per molecule), plus the background, carried through the ${result.settings.square ? 'compensation' : 'unmixing'} of these dyes. Not predicted: degraded tandems, spillover errors of a wrong control, steric effects of antibodies on the same molecule, and expression that differs from the levels given.`));
  return pane;
}

function downloadDesign(run) {
  const rows = [['marker', 'expression', 'dye', 'fixed', 'predicted stain index', 'group', 'background share', 'largest spread from', 'share', 'next best', 'its stain index', 'cost increase']];
  for (const a of run.result.assignments) rows.push([a.marker, a.level, a.dye, a.fixed ? 'yes' : '', a.stainIndex.toPrecision(4), a.group ?? '', a.background.toFixed(3), a.from[0] ? `${a.from[0].marker} (${a.from[0].dye})` : '', a.from[0] ? a.from[0].share.toFixed(3) : '', a.alternatives[0] ? `${a.alternatives[0].dye}${a.alternatives[0].swapWith ? ` (swap with ${a.alternatives[0].swapWith})` : ''}` : '', a.alternatives[0] ? a.alternatives[0].stainIndex.toPrecision(4) : '', a.alternatives[0] ? a.alternatives[0].increase.toPrecision(3) : '']);
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
  downloadBlob(new Blob([`${csv}\n`], { type: 'text/csv' }), 'panel-design.csv');
  toast('Saved panel-design.csv.', { kind: 'ok' });
}

// Kept designs against this run's spreading matrix (the Spectral view's Panel design tab).
export function keptDesignsPane(designs, spreading, onRemove) {
  const checked = designsAgainstRun(designs, spreading);
  if (!(designs ?? []).length) return null;
  const pane = h('div.pane', h('h3', 'Kept designs', h('span.muted', { style: { fontWeight: 500 } }, 'their predicted spread against this run\'s controls')));
  if (!spreading?.observations?.length) pane.append(h('p.muted', 'Compute the spreading matrix (Panel quality) to check a kept design\'s predicted spread against this run\'s controls.'));
  pane.append(h('table.data', h('thead', h('tr', h('th', 'Design'), h('th', 'Kept'), h('th.r', 'Dyes in this run'), h('th.r', 'Entries'), h('th.r', 'Within 2×'), h('th.r', 'Median factor'), h('th', 'Most underpredicted'), h('th', ''))),
    h('tbody', designs.map((design) => {
      const c = checked.find((x) => x.design === design)?.check;
      const worst = c?.rows.length ? [...c.rows].sort((a, b) => b.observed / b.predicted - a.observed / a.predicted)[0] : null;
      return h('tr',
        h('td', design.name),
        h('td.muted', design.created.slice(0, 10)),
        h('td.r', c ? `${c.shared} of ${design.spread.names.length}` : '—'),
        h('td.r', c ? c.measurable : '—'),
        h('td.r', c?.measurable ? `${Math.round(100 * c.within2x)}%` : '—'),
        h('td.r', c?.measurable ? `×${c.medianRatio.toFixed(2)}` : '—'),
        h('td.muted', worst ? `${worst.from} → ${worst.to}: ${worst.observed.toFixed(1)} vs ${worst.predicted.toFixed(1)}` : '—'),
        h('td', onRemove ? h('button.icon-button.small', { type: 'button', title: 'Remove from the library', 'aria-label': `Remove ${design.name}`, onclick: () => onRemove(design) }, icon('close')) : null));
    }))),
  h('p.muted.small-print', 'SS of each clearly measured pair (4 SE) of this run\'s single-stain controls against the design\'s prediction at the control\'s brightness. A dye far above its prediction is heterogeneous (a degraded tandem), off scale, or not the dye the design assumed; on a real 5-laser instrument, about 70% of pairs fall within 2× (validation, suite "panel").'));
  return pane;
}
