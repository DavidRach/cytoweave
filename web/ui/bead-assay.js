// Bead immunoassays (LEGENDplex, CBA and the like) on a plate: the capture beads of each bead group
// (a scatter population) told apart by their classification dye, each analyte's reporter MFI, a
// standard curve per analyte from the standard wells, and every other well's concentration with its
// quantifiable range (lib/beadassay.js). Saved as a ws.derived record of kind 'bead-assay'.

import { h, icon, clear } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { mountChart, leftAxis, bottomAxis, valueScale, withAlpha, downloadCSV, formatValue } from './charts.js';
import { ROOT, channelCatalog, channelLabel, gateById, gatePath } from '../lib/workspace.js';
import { CATEGORICAL } from '../lib/colormaps.js';
import { MFI_STATISTICS, beadAssay, findBeadLevels, standardMode } from '../lib/beadassay.js';
import { curvePoints } from '../lib/curves.js';
import { platesOf } from '../lib/plates.js';
import { annotationFields, beadAssayInput, guessBeadChannels, guessFields } from './plate-analysis.js';
import { fieldRow, saveRecord, selectEl, tile } from './platforms.js';

const MODES = [
  { value: 'auto', label: 'Guess from the labels' },
  { value: 'levels-top-high', label: 'Levels, highest number on top (C7 … C1, C0 blank)' },
  { value: 'levels-top-low', label: 'Levels, 1 on top (S1, S2, …)' },
  { value: 'concentration', label: 'Concentrations (10000, 2500 pg/mL, …)' },
];

const FLAG_CLASS = { ok: '', '< LLOQ': '.flag-off', '> ULOQ': '.flag-off', '< LOD': '.flag-off', 'below curve': '.flag-off', 'above curve': '.flag-off' };

export async function openBeadAssay(app, options = {}) {
  const { store, data } = app;
  const ws0 = store.ws;
  const plate = platesOf(ws0.samples).find((p) => p.name === options.plateName) ?? platesOf(ws0.samples)[0] ?? null;
  const byId = new Map(ws0.samples.map((s) => [s.id, s]));
  const samples = plate ? plate.placed.map((p) => byId.get(p.sampleId)).filter(Boolean) : ws0.samples.filter((s) => s.role === 'sample');
  if (!samples.length) {
    toast('Add the assay\'s samples first.', { kind: 'error' });
    return;
  }
  const guessed = guessFields(samples);
  const fields = annotationFields(samples);
  const beadGates = ws0.gates.filter((g) => /bead/i.test(g.name) && !ws0.gates.some((c) => c.parentId === g.id && /bead/i.test(c.name)));
  const firstView = await data.ensure(samples[0].id).catch(() => null);
  const channels = guessBeadChannels(firstView?.parameters ?? channelCatalog(ws0));
  const state = {
    groups: (options.gateId ? [gateById(ws0, options.gateId)] : beadGates.length ? beadGates : [null]).map((g) => ({ gateId: g?.id ?? ROOT, analytes: '' })),
    classification: channels.classification,
    reporter: channels.reporter,
    statistic: 'median',
    standardField: guessed.standard,
    standardMode: 'auto',
    top: 10000,
    tops: '',
    factor: 4,
    unit: 'pg/mL',
    sampleField: guessed.specimen,
    dilutionField: guessed.dilution,
    model: 'LL.5',
    weighting: '1/y2',
    minBeads: 50,
  };
  let wells = null;
  let result = null;
  let error = null;
  let byWell = false;
  const controls = h('div.platform-controls');
  const results = h('div');
  const curves = h('div.bead-curves');
  const levelsChart = mountChart({ height: 150, build: (w, hgt, colors) => buildLevels(w, hgt, colors), name: () => 'bead-levels' });
  const content = h('div.platform',
    h('p.platform-intro', 'Capture beads of each size (a scatter gate per bead group) are told apart by their classification dye; each analyte\'s reporter MFI on the standard wells gives a standard curve (five-parameter logistic by default), from which every other well\'s concentration is read and multiplied by its dilution. Name the analytes of each group from its dimmest bead to its brightest.'),
    h('div.platform-grid', controls, h('div', { style: { minWidth: 0 } },
      h('div.pane', h('h3', icon('histogram'), 'Bead levels'), levelsChart.el),
      h('div.pane', h('h3', icon('wave'), 'Standard curves'), curves),
      results)),
    h('p.muted.fine-print', 'The quantifiable range runs between the lowest and highest standards whose replicates back-calculate within 20% of their concentration with a CV of at most 20% (25% at the two ends; FDA bioanalytical method validation guidance, 2018); the limit of detection is the concentration at the blanks\' mean MFI + 3 SD. Bead levels are found once from all wells together.'));
  showDialog({
    title: `Bead immunoassay${plate ? ` — ${plate.name}` : ''}`,
    width: 'xwide',
    content,
    buttons: [{ label: 'Close', ghost: true }, { label: 'Save', primary: true, onClick: () => { save(); return false; } }],
    onClose: () => levelsChart.destroy(),
  });

  function populationOptions() {
    const ws = store.ws;
    return [{ value: ROOT, label: 'All events' }, ...ws.gates.filter((g) => g.type !== 'category').map((g) => ({ value: g.id, label: gatePath(ws, g.id) }))];
  }

  function names(group) {
    return group.analytes.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
  }

  function renderControls() {
    clear(controls);
    const ws = store.ws;
    const fluor = (firstView?.parameters ?? channelCatalog(ws)).filter((p) => p.type !== 'time' && p.type !== 'scatter' && !/^(FSC|SSC|Time)/i.test(p.name)).map((p) => ({ value: p.name, label: channelLabel(ws, p.name) }));
    const fieldOptions = [{ value: '', label: '(none)' }, ...fields.map((f) => ({ value: f, label: f }))];
    const number = (value, onChange, width = '100px') => {
      const input = h('input.input.small', { type: 'number', step: 'any', value: value ?? '', style: { width } });
      input.addEventListener('change', () => { const v = Number.parseFloat(input.value); onChange(Number.isFinite(v) ? v : null); });
      return input;
    };
    controls.append(h('div.section-title', 'Bead groups'),
      h('div.bead-groups', ...state.groups.map((group, k) => {
        const area = h('textarea.input', { placeholder: 'Analytes, dimmest bead first (one per line). Empty: as many as there are peaks.', value: group.analytes });
        area.addEventListener('change', () => { group.analytes = area.value; });
        return h('div.bead-group',
          h('div.row', { style: { gap: '6px', alignItems: 'center' } }, h('b', `Group ${k + 1}`), h('span.grow'),
            state.groups.length > 1 ? h('button.icon-button.small', { type: 'button', title: 'Remove this group', onclick: () => { state.groups.splice(k, 1); renderControls(); } }, icon('trash')) : null),
          selectEl(populationOptions(), group.gateId, (v) => { group.gateId = v; }, 'Bead group population'),
          area);
      })),
      h('button.btn.small', { type: 'button', style: { marginTop: '6px' }, onclick: () => { state.groups.push({ gateId: ROOT, analytes: '' }); renderControls(); } }, icon('plus'), 'Add a bead group'),
      h('div.section-title', { style: { marginTop: '10px' } }, 'Channels'),
      fieldRow('Classification (bead ID)', selectEl(fluor, state.classification, (v) => { state.classification = v; })),
      fieldRow('Reporter', selectEl(fluor, state.reporter, (v) => { state.reporter = v; })),
      fieldRow('MFI', selectEl(MFI_STATISTICS.map((m) => ({ value: m, label: m === 'geometric' ? 'Geometric mean' : m === 'mean' ? 'Mean' : 'Median' })), state.statistic, (v) => { state.statistic = v; })),
      h('div.section-title', { style: { marginTop: '10px' } }, 'Standards'),
      fieldRow('Standard wells', selectEl(fieldOptions, state.standardField ?? '', (v) => { state.standardField = v || null; renderControls(); }), 'The annotation naming each standard (C0 … C7, or its concentration).'),
      fieldRow('Labels read as', selectEl(MODES, state.standardMode, (v) => { state.standardMode = v; }), state.standardField ? `Guessed: ${MODES.find((m) => m.value === standardMode(samples.map((s) => s.meta?.[state.standardField]).filter(Boolean)))?.label}` : null),
      h('div.row', { style: { gap: '8px', flexWrap: 'wrap' } },
        fieldRow('Top standard', number(state.top, (v) => { state.top = v; })),
        fieldRow('Dilution step', number(state.factor, (v) => { state.factor = v; }, '70px')),
        fieldRow('Unit', (() => { const input = h('input.input.small', { value: state.unit, style: { width: '80px' } }); input.addEventListener('change', () => { state.unit = input.value.trim(); }); return input; })())),
      fieldRow('Top standard per analyte', (() => { const area = h('textarea.input', { placeholder: 'Optional, one per line: IL-6 = 5000', value: state.tops, style: { minHeight: '44px' } }); area.addEventListener('change', () => { state.tops = area.value; }); return area; })()),
      h('div.section-title', { style: { marginTop: '10px' } }, 'Samples'),
      fieldRow('Replicates of', selectEl(fieldOptions, state.sampleField ?? '', (v) => { state.sampleField = v || null; }), 'Wells with the same value are averaged.'),
      fieldRow('Dilution', selectEl(fieldOptions, state.dilutionField ?? '', (v) => { state.dilutionField = v || null; }), 'Concentrations are multiplied by it.'),
      h('div.section-title', { style: { marginTop: '10px' } }, 'Standard curve'),
      h('div.segmented', { style: { marginBottom: '6px' } }, ...['LL.5', 'LL.4'].map((m) => h(`button${state.model === m ? '.active' : ''}`, { type: 'button', onclick: () => { state.model = m; renderControls(); } }, m === 'LL.5' ? 'Five parameters' : 'Four parameters'))),
      fieldRow('Weighting', selectEl([{ value: '1/y2', label: '1/Y² (relative errors)' }, { value: '1/y', label: '1/Y' }, { value: 'none', label: 'None (as beadplexr)' }], state.weighting, (v) => { state.weighting = v; })),
      fieldRow('Fewer beads than this: no value', number(state.minBeads, (v) => { state.minBeads = v ?? 0; }, '70px')),
      h('button.btn.primary', { type: 'button', style: { marginTop: '8px' }, onclick: () => run() }, icon('play'), 'Analyze'));
  }

  function topOf() {
    const map = {};
    for (const line of state.tops.split('\n')) {
      const m = /^(.+?)\s*[=:]\s*([\d.eE+-]+)/.exec(line.trim());
      if (m) map[m[1].trim()] = Number(m[2]);
    }
    return Object.keys(map).length ? new Proxy(map, { get: (t, k) => (k in t ? t[k] : state.top) }) : state.top;
  }

  async function run() {
    error = null;
    result = null;
    try {
      if (!state.standardField) throw new Error('Choose the annotation that names the standard wells.');
      if (!state.classification || !state.reporter) throw new Error('Choose the classification and reporter channels.');
      const progress = progressToast(`Reading ${samples.length} wells…`);
      try {
        wells = await beadAssayInput(store.ws, samples, state.groups.map((g) => g.gateId), { classification: state.classification, reporter: state.reporter }, (id) => data.ensure(id), (f) => progress.update(f));
      } finally {
        progress.done();
      }
      // Unnamed analytes: as many as the group's peaks.
      const groups = state.groups.map((g, k) => {
        let list = names(g);
        if (!list.length) {
          const pooled = wells.flatMap((w) => [...w.groups[k].classification].slice(0, 2000));
          const found = findBeadLevels(pooled, null);
          const label = g.gateId !== ROOT ? gateById(store.ws, g.gateId)?.name ?? `Group ${k + 1}` : `Group ${k + 1}`;
          list = found.levels.map((_, j) => `${label} ${j + 1}`);
          g.analytes = list.join('\n');
        }
        return { name: g.gateId !== ROOT ? gateById(store.ws, g.gateId)?.name ?? `Group ${k + 1}` : `Group ${k + 1}`, analytes: list };
      });
      result = beadAssay(wells, { groups, statistic: state.statistic, standardField: state.standardField, standardMode: state.standardMode, top: topOf(), factor: state.factor, unit: state.unit, dilutionField: state.dilutionField, sampleField: state.sampleField, model: state.model, weighting: state.weighting, minBeads: state.minBeads });
    } catch (e) {
      error = e.message;
    }
    renderControls();
    levelsChart.redraw();
    renderCurves();
    renderResults();
  }

  function buildLevels(width, height, colors) {
    const items = [];
    if (!result) {
      items.push({ t: 'text', x: width / 2, y: height / 2, text: error ?? 'Choose the bead groups and analyze.', fill: colors.text3, size: 12, align: 'center' });
      return { items, hits: [] };
    }
    const n = result.groups.length;
    const gap = 16;
    const w = (width - 64 - gap * (n - 1)) / n;
    result.groups.forEach((g, k) => {
      const rect = { x: 40 + k * (w + gap), y: 14, w: w - 10, h: height - 14 - 34 };
      const { lo, hi, smooth } = g.histogram;
      const x = valueScale(lo, hi, rect.x, rect.x + rect.w, { target: 4 });
      const max = Math.max(...smooth);
      const y = (v) => rect.y + rect.h - (v / max) * rect.h;
      const step = (hi - lo) / smooth.length;
      g.levels.forEach((l, j) => items.push({ t: 'rect', x: x.map(l.lo), y: rect.y, w: Math.max(1, x.map(l.hi) - x.map(l.lo)), h: rect.h, fill: withAlpha(CATEGORICAL[j % CATEGORICAL.length], 0.16) }));
      items.push({ t: 'path', points: Array.from(smooth, (v, i) => [x.map(lo + (i + 0.5) * step), y(v)]), stroke: colors.text2, width: 1.4 });
      g.levels.forEach((l, j) => items.push({ t: 'text', x: x.map(l.median), y: rect.y + 10 + (j % 2) * 11, text: g.analytes[j], fill: CATEGORICAL[j % CATEGORICAL.length], size: 10, weight: 600, align: 'center' }));
      bottomAxis(items, x, rect, colors, `${g.name}: ${g.scale === 'linear' ? '' : 'log10 '}${channelLabel(store.ws, state.classification, { short: true })}`);
    });
    return { items, hits: [] };
  }

  function renderCurves() {
    clear(curves);
    if (!result) return;
    for (const [k, a] of result.analytes.entries()) {
      const chart = mountChart({
        height: 210,
        build: (w, hgt, colors) => buildCurve(a, k, w, hgt, colors),
        tooltip: (d) => [h('b', d.label), h('div', `${formatValue(d.mfi)} MFI → ${d.concentration === null ? '—' : `${formatValue(d.concentration)} ${state.unit}`}`), d.flag && d.flag !== 'ok' ? h('div.muted', d.flag) : null].filter(Boolean),
        name: () => `standard-curve-${a.name}`,
      });
      const c = a.curve;
      curves.append(h('div', h('div.row', { style: { alignItems: 'baseline', gap: '6px' } }, h('b', a.name), h('span.muted.fine-print', a.group)),
        h('div.muted.fine-print', c.fit ? `Range ${formatValue(c.lloq)}–${formatValue(c.uloq)} ${state.unit}${c.lod ? ` · LOD ${formatValue(c.lod)}` : ''}` : 'No curve'), chart.el));
    }
  }

  function buildCurve(a, k, width, height, colors) {
    const items = [];
    const hits = [];
    const c = a.curve;
    const rect = { x: 52, y: 10, w: width - 52 - 10, h: height - 10 - 40 };
    const standards = (c.standards ?? []).filter((s) => Number.isFinite(s.mfi));
    const positive = standards.filter((s) => s.concentration > 0);
    if (!positive.length) {
      items.push({ t: 'text', x: width / 2, y: height / 2, text: c.error ?? 'No standards', fill: colors.text3, size: 11, align: 'center' });
      return { items, hits };
    }
    const sampleRows = result.wells.filter((w) => w.kind === 'sample').map((w) => ({ name: w.name, ...w.results[a.name] }));
    const conc = [...positive.map((s) => s.concentration), ...sampleRows.map((r) => r.concentration?.raw).filter((v) => v > 0)];
    const mfis = [...standards.map((s) => s.mfi), ...sampleRows.map((r) => r.mfi)].filter((v) => v > 0);
    const xlo = Math.min(...conc) / 2;
    const xhi = Math.max(...conc) * 2;
    // Small charts: label decades only.
    const decades = (scale) => ({ ...scale, ticks: scale.ticks.map((t) => (t.major ? t : { ...t, label: '' })) });
    const x = decades(valueScale(xlo, xhi, rect.x + 22, rect.x + rect.w, { log: true }));
    const y = decades(valueScale(Math.min(...mfis) / 1.5, Math.max(...mfis) * 1.5, rect.y + rect.h, rect.y, { log: true }));
    leftAxis(items, y, rect, colors, 'MFI');
    bottomAxis(items, x, { ...rect, x: rect.x + 22, w: rect.w - 22 }, colors, state.unit);
    if (c.lloq && c.uloq) items.push({ t: 'rect', x: x.map(c.lloq), y: rect.y, w: x.map(c.uloq) - x.map(c.lloq), h: rect.h, fill: withAlpha(colors.ok ?? '#138a52', 0.07) });
    if (c.fit) items.push({ t: 'path', points: curvePoints(c.fit, xlo, xhi).filter(([, v]) => v > 0).map(([u, v]) => [x.map(u), y.map(v)]), stroke: CATEGORICAL[k % CATEGORICAL.length], width: 1.8 });
    for (const s of standards) {
      const px = s.concentration > 0 ? x.map(s.concentration) : rect.x + 10;
      items.push({ t: 'circle', x: px, y: y.map(s.mfi), r: 3.2, fill: colors.bg, stroke: colors.text, width: 1.4 });
      hits.push({ x: px, y: y.map(s.mfi), r: 6, data: { label: `${s.well} (standard${s.concentration === 0 ? ', blank' : ''})`, mfi: s.mfi, concentration: s.concentration } });
    }
    for (const r of sampleRows) {
      if (!(r.mfi > 0)) continue;
      const raw = r.concentration?.raw;
      const px = raw > 0 ? x.map(raw) : rect.x + 10;
      const off = r.concentration?.flag && r.concentration.flag !== 'ok';
      items.push({ t: 'circle', x: px, y: y.map(r.mfi), r: 2.6, fill: off ? withAlpha(colors.warn, 0.85) : withAlpha(CATEGORICAL[k % CATEGORICAL.length], 0.85) });
      hits.push({ x: px, y: y.map(r.mfi), r: 5, data: { label: r.name, mfi: r.mfi, concentration: r.concentration?.value ?? null, flag: r.concentration?.flag } });
    }
    return { items, hits };
  }

  function cell(v, flags) {
    if (v === null || v === undefined || !Number.isFinite(v)) return h('td.r.muted', flags?.length ? flags.join(', ') : '—');
    const off = flags?.some((f) => f !== 'ok');
    return h(`td.r${off ? '.flag-off' : ''}`, { title: off ? flags.join(', ') : '' }, `${off && flags.some((f) => f.startsWith('<')) ? '≤ ' : ''}${formatValue(v)}`);
  }

  function renderResults() {
    clear(results);
    const pane = h('div.pane', h('h3', icon('table'), `Concentrations (${state.unit})`, h('span.spacer'),
      result ? h('div.segmented', h(`button${byWell ? '' : '.active'}`, { type: 'button', onclick: () => { byWell = false; renderResults(); } }, 'By sample'), h(`button${byWell ? '.active' : ''}`, { type: 'button', onclick: () => { byWell = true; renderResults(); } }, 'By well')) : null,
      result ? h('button.btn.small', { type: 'button', onclick: () => exportCSV() }, icon('download'), 'CSV') : null));
    results.append(pane);
    if (error || !result) {
      pane.append(error ? h('div.callout.danger', error) : h('p.muted', 'Not analyzed yet.'));
      return;
    }
    for (const note of result.notes) pane.append(h('div.callout.warn', { style: { marginBottom: '6px', fontSize: '12px' } }, note));
    const analytes = result.analytes.map((a) => a.name);
    const head = h('thead', h('tr', h('th', byWell ? 'Well' : (state.sampleField ?? 'Sample')), byWell ? h('th', 'Kind') : h('th.r', 'Wells'), ...analytes.map((n) => h('th.r', n))));
    const body = byWell
      ? result.wells.map((w) => h('tr', h('td', w.name), h('td.muted', w.kind === 'sample' ? '' : `${w.kind} ${w.standard ?? ''}`), ...analytes.map((n) => {
        const r = w.results[n];
        if (w.kind !== 'sample') return h('td.r.muted', { title: `MFI ${formatValue(r.mfi)}, ${r.beads} beads` }, formatValue(r.mfi));
        return cell(r.concentration?.value, [r.concentration?.flag].filter(Boolean));
      })))
      : result.samples.map((s) => h('tr', h('td', s.name), h('td.r', String(s.wells.length)), ...analytes.map((n) => {
        const r = s.results[n];
        const td = cell(r.mean, r.flags);
        if (r.cv !== null && Number.isFinite(r.cv)) td.title = `${td.title ? `${td.title}; ` : ''}CV ${r.cv.toFixed(1)}% of ${r.n} wells`;
        return td;
      })));
    pane.append(h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '8px' } },
      tile('Analytes', String(result.analytes.length), result.groups.map((g) => `${g.name} ${g.analytes.length}`).join(', ')),
      tile('Standards', String(result.wells.filter((w) => w.kind !== 'sample').length), 'wells, blanks included'),
      tile('Samples', String(result.samples.length), `${result.wells.filter((w) => w.kind === 'sample').length} wells`),
      tile('Curves', `${result.analytes.filter((a) => a.curve.fit).length} of ${result.analytes.length}`, state.model === 'LL.5' ? 'five-parameter' : 'four-parameter')),
      h('div', { style: { overflow: 'auto', maxHeight: '420px' } }, h('table.data', head, h('tbody', ...body))),
      h('p.muted.fine-print', 'Values in amber are outside the quantifiable range (≤: below it); hover for the flag and the replicates\' CV.'));
  }

  function exportCSV() {
    const analytes = result.analytes.map((a) => a.name);
    downloadCSV([
      ['Well', 'Kind', 'Standard', state.sampleField ?? 'Sample', 'Dilution', ...analytes.flatMap((n) => [`${n} MFI`, `${n} beads`, `${n} (${state.unit})`, `${n} flag`])],
      ...result.wells.map((w) => [w.name, w.kind, w.standard ?? '', w.sample, w.dilution, ...analytes.flatMap((n) => {
        const r = w.results[n];
        return [r.mfi, r.beads, r.concentration?.value ?? '', w.kind === 'sample' ? r.concentration?.flag ?? '' : 'nominal'];
      })]),
    ], `bead-assay${plate ? `-${plate.name}` : ''}.csv`);
  }

  function save() {
    if (!result) {
      toast('Analyze the assay first.', { kind: 'error' });
      return;
    }
    saveRecord(app, {
      id: `bead-assay:${plate?.name ?? 'samples'}:${state.reporter}`,
      kind: 'bead-assay',
      name: `Bead assay · ${plate?.name ?? 'samples'} · ${result.analytes.length} analytes`,
      method: `${state.model === 'LL.5' ? 'Five' : 'Four'}-parameter log-logistic standard curves${state.weighting !== 'none' ? ` weighted ${state.weighting.replace('y2', 'Y²').replace('y', 'Y')}` : ''} of the reporter's ${state.statistic === 'geometric' ? 'geometric mean' : state.statistic} per analyte`,
      params: { plate: plate?.name ?? null, groups: state.groups, classification: state.classification, reporter: state.reporter, statistic: state.statistic, standardField: state.standardField, standardMode: state.standardMode, top: state.top, tops: state.tops, factor: state.factor, unit: state.unit, sampleField: state.sampleField, dilutionField: state.dilutionField, model: state.model, weighting: state.weighting, minBeads: state.minBeads },
      seed: null,
      outputs: [],
      version: app.version ?? null,
      summary: {
        unit: state.unit,
        analytes: result.analytes.map((a) => ({ name: a.name, group: a.group, lloq: a.curve.lloq, uloq: a.curve.uloq, lod: a.curve.lod, parameters: a.curve.fit?.parameters ?? null })),
        samples: result.samples.map((s) => ({ name: s.name, results: s.results })),
      },
    }, 'Bead assay');
    toast(`Saved the bead assay (${result.analytes.length} analytes, ${result.samples.length} samples).`, { kind: 'ok' });
  }

  renderControls();
  renderResults();
  if (state.standardField && state.groups.every((g) => g.gateId !== ROOT)) run();
}
