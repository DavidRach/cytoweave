// Dose-response curves of a plate: a statistic of every well against its dose, one curve per
// compound (or another annotation), as a four- or five-parameter log-logistic fit (lib/curves.js)
// with EC50/IC50 and its 95% CI, the Hill slope and the asymptotes; raw, as % of the plate's
// controls or as % inhibition. Saved as a ws.derived record of kind 'dose-response'.

import { h, icon, clear } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { mountChart, leftAxis, bottomAxis, valueScale, withAlpha, downloadCSV, formatValue } from './charts.js';
import { ROOT, channelCatalog, channelLabel, gatePath } from '../lib/workspace.js';
import { CATEGORICAL } from '../lib/colormaps.js';
import { FLAG_TEXT, curvePoints } from '../lib/curves.js';
import { platesOf } from '../lib/plates.js';
import { PLATE_STATISTICS, annotationFields, doseResponseData, fitGroups, guessFields, plateValues, plateZPrime, controlWells, statisticLabel } from './plate-analysis.js';
import { fieldRow, saveRecord, selectEl, tile } from './platforms.js';

const NORMALIZE = [
  { value: 'none', label: 'The statistic itself' },
  { value: 'controls', label: '% of controls (negative 0%, positive 100%)' },
  { value: 'inhibition', label: '% inhibition (100 − % of controls)' },
];

export async function openDoseResponse(app, options = {}) {
  const { store, data } = app;
  const plate = platesOf(store.ws.samples).find((p) => p.name === options.plateName) ?? platesOf(store.ws.samples)[0];
  if (!plate) {
    toast('No sample has a well.', { kind: 'error' });
    return;
  }
  const byId = new Map(store.ws.samples.map((s) => [s.id, s]));
  const samples = plate.placed.map((p) => byId.get(p.sampleId)).filter(Boolean);
  const guessed = guessFields(samples);
  const fields = annotationFields(samples);
  const state = {
    // By default the deepest population's % of parent (as the Plates view's heat map).
    spec: options.spec ?? (() => {
      const deepest = store.ws.gates.filter((g) => g.type !== 'category').at(-1);
      return deepest ? { gateId: deepest.id, stat: 'freqParent' } : { gateId: ROOT, stat: 'count' };
    })(),
    doseField: guessed.dose ?? fields[0] ?? null,
    groupField: guessed.group,
    controlField: options.controlField ?? guessed.control,
    normalize: 'none',
    model: 'LL.4',
    weighting: 'none',
    fixBottom: false,
    fixTop: false,
    hidden: new Set(),
  };
  let values = new Map();
  let result = null;
  let error = null;
  const controls = h('div.platform-controls');
  const results = h('div');
  const chart = mountChart({
    height: 420,
    build: (width, height, colors) => buildChart(width, height, colors),
    tooltip: (d) => [h('b', d.group), h('div', `${formatValue(d.x)} ${result?.data.unit ?? ''} → ${formatValue(d.y)}`), d.well ? h('div.muted', d.well) : null].filter(Boolean),
    name: () => `dose-response-${plate.name}`,
  });
  const content = h('div.platform',
    h('p.platform-intro', 'A statistic of every well against its dose, one curve per compound: a log-logistic fit (four parameters, or five for an asymmetric curve) gives each the EC50 (IC50 for a falling curve) with its 95% confidence interval, the Hill slope, and the bottom and top. Doses come from an annotation such as "10 nM" (units are converted to the most common one); control wells, by the control annotation, can set 0% and 100%.'),
    h('div.platform-grid', controls, h('div', { style: { minWidth: 0 } },
      h('div.pane', h('h3', icon('wave'), `Dose-response · ${plate.name}`, h('span.spacer'),
        h('button.btn.small', { type: 'button', onclick: () => chart.exportSVG() }, icon('download'), 'SVG'),
        h('button.btn.small', { type: 'button', onclick: () => chart.exportPNG() }, icon('download'), 'PNG')), chart.el),
      results)),
    h('p.muted.fine-print', 'Models as R\'s drc package parameterizes them (LL.4 and LL.5): the EC50 is the dose halfway between the zero-dose response and the other asymptote; its interval is symmetric on the log scale (delta method). A curve no better than a flat line (F test, p ≥ 0.05) is flagged as no dose-response, and an EC50 outside the tested doses or with an interval wider than 100-fold as poorly determined.'));
  showDialog({
    title: `Dose-response — ${plate.name}`,
    width: 'xwide',
    content,
    buttons: [{ label: 'Close', ghost: true }, { label: 'Save', primary: true, onClick: () => { save(); return false; } }],
    onClose: () => chart.destroy(),
  });

  function renderControls() {
    clear(controls);
    const ws = store.ws;
    const stat = PLATE_STATISTICS.find((s) => s.id === state.spec.stat);
    const channels = channelCatalog(ws).filter((c) => c.type !== 'time');
    const fieldOptions = [{ value: '', label: '(none)' }, ...fields.map((f) => ({ value: f, label: f }))];
    const respec = (patch) => {
      state.spec = { ...state.spec, ...patch };
      const def = PLATE_STATISTICS.find((s) => s.id === state.spec.stat);
      if (def?.needsChannel && !state.spec.channel) state.spec.channel = channels.find((c) => c.type === 'fluorescence')?.name;
      if (!def?.needsChannel) delete state.spec.channel;
      if (def?.needsValue && state.spec.value === undefined) state.spec.value = def.id === 'percentile' ? 50 : 1000;
      load();
    };
    controls.append(
      h('div.section-title', 'Response'),
      fieldRow('Population', selectEl([{ value: ROOT, label: 'All events' }, ...ws.gates.filter((g) => g.type !== 'category').map((g) => ({ value: g.id, label: gatePath(ws, g.id) }))], state.spec.gateId ?? ROOT, (v) => respec({ gateId: v }))),
      fieldRow('Statistic', selectEl(PLATE_STATISTICS.filter((s) => !s.needsAncestor && !s.needsDilution).map((s) => ({ value: s.id, label: s.label })), state.spec.stat, (v) => respec({ stat: v }))),
      stat?.needsChannel ? fieldRow('Channel', selectEl(channels.map((c) => ({ value: c.name, label: channelLabel(ws, c.name) })), state.spec.channel, (v) => respec({ channel: v }))) : null,
      fieldRow('As', selectEl(NORMALIZE, state.normalize, (v) => { state.normalize = v; if (v !== 'none') { state.fixBottom = true; state.fixTop = true; } refit(); })),
      h('div.section-title', { style: { marginTop: '10px' } }, 'Layout'),
      fieldRow('Dose', selectEl(fieldOptions.slice(1), state.doseField ?? '', (v) => { state.doseField = v; refit(); }), 'An annotation holding each well\'s dose.'),
      fieldRow('One curve per', selectEl(fieldOptions, state.groupField ?? '', (v) => { state.groupField = v || null; refit(); })),
      fieldRow('Controls', selectEl(fieldOptions, state.controlField ?? '', (v) => { state.controlField = v || null; refit(); }), 'Wells reading positive and negative: left out of the curves; they set 0% and 100%.'),
      h('div.section-title', { style: { marginTop: '10px' } }, 'Model'),
      h('div.segmented', { style: { marginBottom: '6px' } },
        ...['LL.4', 'LL.5'].map((m) => h(`button${state.model === m ? '.active' : ''}`, { type: 'button', onclick: () => { state.model = m; refit(); } }, m === 'LL.4' ? 'Four parameters' : 'Five (asymmetric)'))),
      fieldRow('Weighting', selectEl([{ value: 'none', label: 'None' }, { value: '1/y', label: '1/Y' }, { value: '1/y2', label: '1/Y² (relative errors)' }], state.weighting, (v) => { state.weighting = v; refit(); })),
      state.normalize !== 'none' ? h('div', h('label.check', h('input', { type: 'checkbox', checked: state.fixBottom, onchange: (e) => { state.fixBottom = e.target.checked; refit(); } }), 'Bottom fixed at 0%'),
        h('label.check', h('input', { type: 'checkbox', checked: state.fixTop, onchange: (e) => { state.fixTop = e.target.checked; refit(); } }), 'Top fixed at 100%')) : null);
  }

  async function load() {
    const missing = plate.placed.filter((p) => !data.view(p.sampleId));
    const progress = missing.length ? progressToast(`Computing ${plate.placed.length} wells…`) : null;
    try {
      values = await plateValues(store.ws, plate, state.spec, (id) => data.ensure(id), (f) => progress?.update(f));
    } finally {
      progress?.done();
    }
    refit();
  }

  function refit() {
    error = null;
    result = null;
    try {
      if (!state.doseField) throw new Error('Choose the annotation that holds each well\'s dose.');
      const set = doseResponseData(samples, values, { doseField: state.doseField, groupField: state.groupField, controlField: state.controlField, normalize: state.normalize });
      if (!set.groups.length) throw new Error(`No well has both a dose ("${state.doseField}") and a value.`);
      const fixed = {};
      if (state.normalize !== 'none') {
        // In drc's terms, with b > 0 the zero-dose asymptote is d and the other c: a falling curve's
        // bottom is c, a rising curve's is d (the fit then keeps b > 0).
        const falling = set.groups.every((g) => meanAt(g, 'low') >= meanAt(g, 'high'));
        if (state.fixBottom) fixed[falling ? 'c' : 'd'] = 0;
        if (state.fixTop) fixed[falling ? 'd' : 'c'] = 100;
      }
      const fits = fitGroups(set, { model: state.model, weighting: state.weighting, fixed });
      const controlIds = controlWells(samples, state.controlField);
      const z = state.controlField ? plateZPrime(values, controlIds) : null;
      result = { data: set, fits, z, fixed };
    } catch (e) {
      error = e.message;
    }
    renderControls();
    renderResults();
    chart.redraw();
  }

  function meanAt(group, end) {
    const doses = [...new Set(group.x)].sort((a, b) => a - b);
    const dose = end === 'low' ? doses[0] : doses.at(-1);
    const ys = group.y.filter((_, i) => group.x[i] === dose);
    return ys.reduce((s, v) => s + v, 0) / ys.length;
  }

  function buildChart(width, height, colors) {
    const items = [];
    const hits = [];
    if (!result) {
      items.push({ t: 'text', x: width / 2, y: height / 2, text: error ?? 'Computing…', fill: colors.text3, size: 12, align: 'center' });
      return { items, hits };
    }
    const shownFits = result.fits.filter((f) => !state.hidden.has(f.name));
    const positive = result.fits.flatMap((f) => f.x).filter((x) => x > 0);
    const xlo = Math.min(...positive);
    const xhi = Math.max(...positive);
    const hasZero = result.fits.some((f) => f.x.some((x) => x === 0));
    const rect = { x: 64, y: 18, w: width - 64 - 170, h: height - 18 - 48 };
    const zeroW = hasZero ? 34 : 0;
    const x = valueScale(xlo / 2, xhi * 2, rect.x + zeroW, rect.x + rect.w, { log: true });
    const ys = [...shownFits.flatMap((f) => f.y), ...result.data.controls.positive, ...result.data.controls.negative].filter(Number.isFinite);
    const ylo = Math.min(...ys);
    const yhi = Math.max(...ys);
    // Padded, but not below zero when every value is positive.
    const y = valueScale(ylo >= 0 ? Math.max(0, ylo - 0.05 * (yhi - ylo)) : ylo - 0.05 * (yhi - ylo), yhi + 0.05 * (yhi - ylo), rect.y + rect.h, rect.y, { target: 6 });
    leftAxis(items, y, rect, colors, state.normalize === 'none' ? statisticLabel(store.ws, state.spec, channelLabel) : state.normalize === 'inhibition' ? '% inhibition' : '% of controls');
    bottomAxis(items, x, { ...rect, x: rect.x + zeroW, w: rect.w - zeroW }, colors, `Dose${result.data.unit ? ` (${result.data.unit})` : ''}`);
    if (hasZero) {
      items.push({ t: 'text', x: rect.x + zeroW / 2, y: rect.y + rect.h + 16, text: '0', fill: colors.text3, size: 10.5, align: 'center' });
      items.push({ t: 'line', x1: rect.x + zeroW - 4, y1: rect.y + rect.h - 4, x2: rect.x + zeroW + 4, y2: rect.y + rect.h + 4, stroke: colors.line, width: 1 });
    }
    // Control bands: the mean ± SD of the positive and negative wells (named in the legend).
    let bands = 0;
    for (const list of [result.data.controls.positive, result.data.controls.negative]) {
      if (!list.length) continue;
      bands += 1;
      const m = list.reduce((s, v) => s + v, 0) / list.length;
      const sd = Math.sqrt(list.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, list.length - 1));
      items.push({ t: 'rect', x: rect.x, y: y.map(m + sd), w: rect.w, h: Math.max(1, y.map(m - sd) - y.map(m + sd)), fill: withAlpha(colors.text3, 0.12) });
    }
    const px = (v) => (v > 0 ? x.map(v) : rect.x + zeroW / 2);
    result.fits.forEach((f, k) => {
      if (state.hidden.has(f.name)) return;
      const color = CATEGORICAL[k % CATEGORICAL.length];
      f.x.forEach((xv, i) => {
        items.push({ t: 'circle', x: px(xv), y: y.map(f.y[i]), r: 3.2, fill: withAlpha(color, 0.8) });
        hits.push({ x: px(xv), y: y.map(f.y[i]), r: 6, data: { group: f.name, x: xv, y: f.y[i], well: samples.find((s) => s.id === f.sampleIds[i])?.name } });
      });
      if (f.fit && f.fit.flags.includes('no-effect')) {
        // No dose-response: the wells' mean, dashed.
        const m = f.y.reduce((sum, v) => sum + v, 0) / f.y.length;
        items.push({ t: 'line', x1: rect.x + zeroW, y1: y.map(m), x2: rect.x + rect.w, y2: y.map(m), stroke: color, width: 1.6, dash: [5, 4] });
      } else if (f.fit) {
        const poor = f.fit.flags.some((flag) => flag === 'wide-ci' || flag === 'extrapolated' || flag === 'not-converged');
        const points = curvePoints(f.fit, xlo / 2, xhi * 2).map(([a, b]) => [x.map(a), y.map(b)]).filter(([, b]) => b >= rect.y - 20 && b <= rect.y + rect.h + 20);
        items.push({ t: 'path', points, stroke: color, width: 2, ...(poor ? { dash: [5, 4] } : {}) });
        if (!poor && Number.isFinite(f.fit.ec50) && f.fit.ec50 >= xlo / 2 && f.fit.ec50 <= xhi * 2) {
          const ex = x.map(f.fit.ec50);
          const half = (f.fit.bottom + f.fit.top) / 2;
          items.push({ t: 'line', x1: ex, y1: y.map(half) - 6, x2: ex, y2: y.map(half) + 6, stroke: color, width: 2 });
        }
      }
      items.push({ t: 'rect', x: rect.x + rect.w + 14, y: rect.y + 4 + 17 * k, w: 10, h: 10, fill: color });
      items.push({ t: 'text', x: rect.x + rect.w + 30, y: rect.y + 13 + 17 * k, text: f.name, fill: colors.text2, size: 11 });
    });
    const below = rect.y + 4 + 17 * result.fits.length + 10;
    if (bands) {
      items.push({ t: 'rect', x: rect.x + rect.w + 14, y: below, w: 10, h: 10, fill: withAlpha(colors.text3, 0.3) });
      items.push({ t: 'text', x: rect.x + rect.w + 30, y: below + 9, text: 'controls (mean ± SD)', fill: colors.text3, size: 10.5 });
    }
    items.push({ t: 'line', x1: rect.x + rect.w + 14, y1: below + 26, x2: rect.x + rect.w + 24, y2: below + 26, stroke: colors.text3, width: 1.6, dash: [3, 2] });
    items.push({ t: 'text', x: rect.x + rect.w + 30, y: below + 30, text: 'flagged: see Notes', fill: colors.text3, size: 10.5 });
    return { items, hits };
  }

  function ec50Text(fit) {
    if (!fit || fit.flags.includes('no-effect')) return '—';
    const ci = fit.ec50CI;
    if (fit.flags.includes('wide-ci')) return `~${formatValue(fit.ec50)} (not determined)`;
    return `${fit.flags.includes('extrapolated') ? '~' : ''}${formatValue(fit.ec50)}${Number.isFinite(ci[0]) && Number.isFinite(ci[1]) ? ` (${formatValue(ci[0])}–${formatValue(ci[1])})` : ''}`;
  }

  // A fit's notes: no dose-response says it all; otherwise each flag.
  function notes(f) {
    if (f.error) return [h('span.badge.warn', { title: f.error }, 'no fit')];
    const flags = f.fit.flags.includes('no-effect') ? ['no-effect'] : f.fit.flags.filter((flag, i, all) => !(flag === 'extrapolated' && all.includes('wide-ci')));
    if (!flags.length) return [h('span.badge.ok', 'ok')];
    const label = { 'no-effect': 'no dose-response', 'wide-ci': 'EC50 not determined', extrapolated: 'EC50 beyond the doses', 'at-bound': 'at a limit', 'not-converged': 'not converged' };
    return flags.map((flag) => h(`span.badge${flag === 'no-effect' ? '' : '.warn'}`, { title: FLAG_TEXT[flag] }, label[flag]));
  }

  function renderResults() {
    clear(results);
    const pane = h('div.pane', h('h3', icon('table'), 'Curves', h('span.spacer'),
      result ? h('button.btn.small', { type: 'button', onclick: () => exportCSV() }, icon('download'), 'CSV') : null));
    results.append(pane);
    if (error || !result) {
      pane.append(h('div.callout.danger', error ?? 'No curves.'));
      return;
    }
    if (result.z) {
      pane.append(h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: '8px' } },
        tile('Z′ of the plate', Number.isFinite(result.z.z) ? result.z.z.toFixed(3) : '—', result.z.rating, result.z.z >= 0.5 ? 'ok' : result.z.z > 0 ? 'warn' : 'danger'),
        tile('Positive controls', formatValue(result.z.positive.mean), `SD ${formatValue(result.z.positive.sd)}, ${result.z.positive.n} wells`),
        tile('Negative controls', formatValue(result.z.negative.mean), `SD ${formatValue(result.z.negative.sd)}, ${result.z.negative.n} wells`)));
    }
    const unit = result.data.unit ? ` (${result.data.unit})` : '';
    const table = h('table.data.curve-results', h('thead', h('tr', h('th', ''), h('th', state.groupField ?? 'Group'), h('th.r', 'Wells'), h('th.r', `EC50${unit} (95% CI)`), h('th.r', 'Hill slope'), h('th.r', 'Bottom'), h('th.r', 'Top'), state.model === 'LL.5' ? h('th.r', 'Asymmetry') : null, h('th.r', 'R²'), h('th', 'Notes'))),
      h('tbody', ...result.fits.map((f, k) => h('tr',
        h('td', h('input', { type: 'checkbox', checked: !state.hidden.has(f.name), title: 'Show on the chart', onchange: (e) => { if (e.target.checked) state.hidden.delete(f.name); else state.hidden.add(f.name); chart.redraw(); } })),
        h('td', h('span.swatch', { style: { background: CATEGORICAL[k % CATEGORICAL.length], marginRight: '6px' } }), f.name),
        h('td.r', String(f.x.length)),
        h('td.r', ec50Text(f.fit)),
        ...(() => {
          const flat = !f.fit || f.fit.flags.includes('no-effect');
          return [
            h('td.r', flat ? '—' : formatValue(f.fit.hill)),
            h('td.r', flat ? '—' : formatValue(f.fit.bottom)),
            h('td.r', flat ? '—' : formatValue(f.fit.top)),
            state.model === 'LL.5' ? h('td.r', flat ? '—' : formatValue(f.fit.parameters.f)) : null,
          ];
        })(),
        h('td.r', f.fit ? f.fit.r2.toFixed(3) : '—'),
        h('td', ...notes(f))))));
    pane.append(h('div', { style: { overflow: 'auto' } }, table));
  }

  function rows() {
    return result.fits.map((f) => ({
      group: f.name,
      wells: f.x.length,
      ec50: f.fit && !f.fit.flags.includes('no-effect') ? f.fit.ec50 : null,
      ec50Low: f.fit?.ec50CI[0] ?? null,
      ec50High: f.fit?.ec50CI[1] ?? null,
      hill: f.fit?.hill ?? null,
      bottom: f.fit?.bottom ?? null,
      top: f.fit?.top ?? null,
      asymmetry: state.model === 'LL.5' ? f.fit?.parameters.f ?? null : null,
      r2: f.fit?.r2 ?? null,
      flags: f.fit?.flags ?? ['no fit'],
      parameters: f.fit?.parameters ?? null,
    }));
  }

  function exportCSV() {
    downloadCSV([
      [state.groupField ?? 'Group', 'Wells', `EC50${result.data.unit ? ` (${result.data.unit})` : ''}`, 'EC50 95% CI low', 'EC50 95% CI high', 'Hill slope', 'Bottom', 'Top', 'Asymmetry', 'R²', 'Flags'],
      ...rows().map((r) => [r.group, r.wells, r.ec50, r.ec50Low, r.ec50High, r.hill, r.bottom, r.top, r.asymmetry, r.r2, r.flags.join(' ')]),
    ], `dose-response-${plate.name}.csv`);
  }

  function save() {
    if (!result) {
      toast('Nothing to save.', { kind: 'error' });
      return;
    }
    const ws = store.ws;
    saveRecord(app, {
      id: `dose-response:${plate.name}:${JSON.stringify(state.spec)}`,
      kind: 'dose-response',
      name: `Dose-response · ${plate.name} · ${statisticLabel(ws, state.spec, channelLabel)}`,
      method: `${state.model === 'LL.5' ? 'Five' : 'Four'}-parameter log-logistic fits${state.weighting !== 'none' ? `, weighted ${state.weighting.replace('y2', 'Y²').replace('y', 'Y')}` : ''}${state.normalize !== 'none' ? `, response as ${state.normalize === 'inhibition' ? '% inhibition' : '% of controls'}` : ''}`,
      params: { plate: plate.name, spec: state.spec, doseField: state.doseField, groupField: state.groupField, controlField: state.controlField, normalize: state.normalize, model: state.model, weighting: state.weighting, fixed: result.fixed },
      seed: null,
      outputs: [],
      version: app.version ?? null,
      summary: { unit: result.data.unit, rows: rows(), zPrime: result.z?.z ?? null },
    }, 'Dose-response');
    toast(`Saved ${result.fits.length} dose-response curves.`, { kind: 'ok' });
  }

  renderControls();
  await load();
}
