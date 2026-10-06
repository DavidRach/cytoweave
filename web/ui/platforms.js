// Modeling platforms: DNA-content (cell-cycle) and dye-dilution (proliferation) models of a
// population, in large dialogs with the fitted histogram, component curves, residuals,
// explained results, a per-sample batch run and saved results (ws.derived records).

import { h, icon, clear, formatCount } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { mountChart, leftAxis, bottomAxis, valueScale, withAlpha, downloadCSV, formatValue, formatTick } from './charts.js';
import { channelTransform, countOf, population } from '../lib/engine.js';
import { ROOT, addDerived, addGates, channelCatalog, channelLabel, gateApplies, gateById, gatePath, uniqueGateName } from '../lib/workspace.js';
import { dnaHistogram, doubletDiscrimination, fitDeanJettFox, fitWatsonPragmatic } from '../lib/cellcycle.js';
import { fitProliferation } from '../lib/proliferation.js';
import { CATEGORICAL } from '../lib/colormaps.js';
import { axisTicks, createTransform, powerLabel } from '../lib/transforms.js';

const DNA_DYES = /\b(PI|propidium|DAPI|7-?AAD|hoechst|fxcycle|fx ?cycle|draq ?5|draq ?7|dyecycle|vybrant|sytox|DNA|nuclear ?id)\b/i;
const PROLIFERATION_DYES = /(CTV|cell ?trace|CFSE|CFDA|prolif|PKH|\bCPD\b|tag-?it|e[Ff]luor ?(450|670) ?prolif)/i;
const COMPONENT_COLORS = { g1: '#4c78e0', s: '#3fb27f', g2: '#f0803c', debris: '#8a93a6', aggregates: '#9a6fd8' };

// Channels ranked for a dye pattern: marker/label matches first, area parameters preferred.
function rankChannels(ws, view, pattern) {
  const channels = (view?.parameters ?? channelCatalog(ws)).filter((p) => p.type === 'fluorescence' || p.type === undefined);
  const score = (p) => {
    let s = 0;
    if (pattern.test(`${p.marker ?? ''} ${p.label ?? ''}`)) s += 4;
    if (pattern.test(p.name)) s += 2;
    if (/-A$/i.test(p.name)) s += 1;
    if (/-W$/i.test(p.name)) s -= 2;
    return s;
  };
  return channels.map((p) => ({ name: p.name, marker: p.marker, score: score(p) })).sort((a, b) => b.score - a.score);
}

export function sampleOptions(ws, gateId) {
  const gate = gateId && gateId !== ROOT ? gateById(ws, gateId) : null;
  return ws.samples.filter((s) => !gate || gateApplies(ws, gate, s.id));
}

export function populationName(ws, gateId) {
  return gateId && gateId !== ROOT ? gatePath(ws, gateId) : 'All events';
}

export function fieldRow(label, control, hint) {
  return h('label.field', h('span', label), control, hint ? h('span.muted.fine-print', { style: { fontWeight: 400 } }, hint) : null);
}

export function selectEl(options, value, onChange, label) {
  return h('select.input.small', { 'aria-label': label, onchange: (event) => onChange(event.target.value) },
    ...options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
}

export function tile(k, v, sub, kind = '') {
  return h('div.stat-tile', h('div.k', k), h(`div.v${kind ? `.${kind}` : ''}`, v), sub ? h('div.muted', { style: { fontSize: '10.5px' } }, sub) : null);
}

// Step outline of a histogram (counts per bin) in chart coordinates.
function stepPoints(counts, edgeOf, x, y) {
  const points = [[x(edgeOf(0)), y(0)]];
  for (let b = 0; b < counts.length; b += 1) {
    points.push([x(edgeOf(b)), y(counts[b])], [x(edgeOf(b + 1)), y(counts[b])]);
  }
  points.push([x(edgeOf(counts.length)), y(0)]);
  return points;
}

function curvePoints(values, centers, x, y, from = 0, to = values.length) {
  const points = [];
  for (let b = from; b < to; b += 1) points.push([x(centers[b]), y(values[b])]);
  return points;
}

function areaPoints(values, centers, x, y, from = 0, to = values.length) {
  const line = curvePoints(values, centers, x, y, from, to);
  if (!line.length) return line;
  return [[line[0][0], y(0)], ...line, [line[line.length - 1][0], y(0)]];
}

// Residual strip: (observed − model)/√max(observed, 1) per bin, ±2 guide lines.
function residualStrip(items, rect, colors, x, centers, counts, model, from, to) {
  let max = 3;
  const res = [];
  for (let b = from; b <= to; b += 1) {
    const r = (counts[b] - model[b]) / Math.sqrt(Math.max(counts[b], 1));
    res.push([b, r]);
    if (Number.isFinite(r)) max = Math.max(max, Math.abs(r));
  }
  const mid = rect.y + rect.h / 2;
  const scale = (rect.h / 2 - 2) / max;
  items.push({ t: 'rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: colors.grid });
  for (const v of [-2, 2]) items.push({ t: 'line', x1: rect.x, y1: mid - v * scale, x2: rect.x + rect.w, y2: mid - v * scale, stroke: colors.text3, width: 0.8, dash: [3, 3] });
  items.push({ t: 'line', x1: rect.x, y1: mid, x2: rect.x + rect.w, y2: mid, stroke: colors.line, width: 1 });
  const w = Math.max(1, (x(centers[1] ?? centers[0] + 1) - x(centers[0])) * 0.8);
  for (const [b, r] of res) {
    if (!Number.isFinite(r)) continue;
    const top = mid - Math.max(r, 0) * scale;
    const hgt = Math.abs(r) * scale;
    items.push({ t: 'rect', x: x(centers[b]) - w / 2, y: r >= 0 ? top : mid, w, h: Math.max(0.5, hgt), fill: withAlpha(Math.abs(r) > 2 ? colors.danger : colors.text3, Math.abs(r) > 2 ? 0.75 : 0.5) });
  }
  items.push({ t: 'text', x: rect.x - 8, y: mid, text: 'resid.', fill: colors.text3, size: 9.5, align: 'end', baseline: 'middle' });
}

function legend(items, entries, rect, colors) {
  let y = rect.y + 8;
  const x = rect.x + rect.w - 8;
  for (const entry of entries) {
    items.push({ t: 'text', x: x - 16, y: y + 4, text: entry.label, fill: colors.text2, size: 11, weight: entry.bold ? 650 : 500, align: 'end', baseline: 'middle' });
    if (entry.line) items.push({ t: 'line', x1: x - 12, y1: y + 4, x2: x, y2: y + 4, stroke: entry.color, width: 2 });
    else items.push({ t: 'rect', x: x - 11, y: y - 1, w: 10, h: 10, radius: 2, fill: withAlpha(entry.color, 0.35), stroke: entry.color, width: 1.2 });
    y += 17;
  }
}

// Runs a computation over every sample the population applies to, with progress and cancel.
export async function runAllSamples(app, gateId, compute, label) {
  const { store, data } = app;
  const samples = sampleOptions(store.ws, gateId).filter((s) => s.role === 'sample' || s.role === 'reference');
  let canceled = false;
  const progress = progressToast(`${label}: ${samples.length} samples…`, () => { canceled = true; });
  const rows = [];
  for (let i = 0; i < samples.length && !canceled; i += 1) {
    const sample = samples[i];
    progress.update(i / samples.length, `${label}: ${sample.name} (${i + 1}/${samples.length})`);
    try {
      const view = await data.ensure(sample.id);
      const indices = population(view, store.ws, gateId ?? ROOT);
      if (indices === undefined) throw new Error('the population does not apply');
      rows.push({ sample, ...compute(view, indices) });
    } catch (error) {
      rows.push({ sample, error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (canceled) progress.done(`Stopped after ${rows.length} samples.`, 'info');
  else progress.done(`${label}: ${rows.length} samples done.`);
  return rows;
}

export function saveRecord(app, record, label) {
  const { store } = app;
  const existing = store.ws.derived.find((d) => d.id === record.id);
  // Merge per-sample rows with an earlier record of the same model, newest first.
  const rows = new Map((existing?.summary?.rows ?? []).map((r) => [r.sampleId, r]));
  for (const row of record.summary.rows) rows.set(row.sampleId, row);
  const merged = { ...record, summary: { ...record.summary, rows: [...rows.values()] } };
  store.commit(addDerived(store.ws, merged).ws, label, ['derived']);
}

// =====================================================================================================
// Cell cycle
// =====================================================================================================

export async function openCellCycle(app, gateId, sampleId) {
  const { store, data } = app;
  const ws0 = store.ws;
  gateId = gateId ?? ROOT;
  sampleId = sampleId ?? store.ui.sampleId ?? sampleOptions(ws0, gateId)[0]?.id;
  if (!sampleId) {
    toast('Add a sample first.', { kind: 'error' });
    return;
  }
  let view = await data.ensure(sampleId).catch((error) => {
    toast(error.message, { kind: 'error' });
    return null;
  });
  if (!view) return;
  const ranked = rankChannels(ws0, view, DNA_DYES);
  const state = {
    sampleId,
    channel: ranked[0]?.name,
    model: 'djf',
    ratioFixed: false,
    ratio: 2,
    equalCV: true,
    debris: false,
    aggregates: false,
    bins: 256,
  };
  let fit = null;
  let hist = null;
  let error = null;
  let batch = null;

  const controls = h('div.platform-controls');
  const chartHost = h('div');
  const results = h('div');
  const doublets = h('div');
  const batchHost = h('div');
  const chart = mountChart({
    height: 380,
    build: (width, height, colors) => buildChart(width, height, colors),
    tooltip: (bin) => [h('b', `≈ ${formatTick(bin.x)}`), h('div', `Observed ${formatCount(bin.count)} · model ${formatValue(bin.model)}`), h('div.muted', `G1 ${formatValue(bin.g1)} · S ${formatValue(bin.s)} · G2 ${formatValue(bin.g2)}`)],
    name: () => `cell-cycle-${store.ws.samples.find((s) => s.id === state.sampleId)?.name ?? 'sample'}`,
  });
  chartHost.append(chart.el);

  const content = h('div.platform',
    h('p.platform-intro', 'Models the DNA-content histogram of ', h('b', populationName(ws0, gateId)), ' as G0/G1 and G2/M Gaussians with S phase in between, and reports the fraction of cells in each phase. Gate singlets first: doublets of G1 cells sit exactly where G2/M cells do.'),
    h('div.platform-grid', controls, h('div', { style: { minWidth: 0 } },
      h('div.pane', h('h3', icon('dna'), 'Fitted DNA histogram', h('span.spacer'),
        h('button.btn.small', { type: 'button', onclick: () => chart.exportSVG() }, icon('download'), 'SVG'),
        h('button.btn.small', { type: 'button', onclick: () => chart.exportPNG() }, icon('download'), 'PNG')), chartHost),
      results, doublets)),
    batchHost,
    h('p.muted.fine-print', 'Dean–Jett–Fox: Fox 1980, Cytometry 1:71–77 (doi:10.1002/cyto.990010103); S phase as a broadened second-order polynomial (Dean & Jett 1974). Watson pragmatic: Watson, Chambers & Smith 1987, Cytometry 8:1–8 (doi:10.1002/cyto.990080101); here the S-phase edge inside each flank is modeled (toggle in the code: flankCorrection). Fits minimize Poisson-weighted χ² by Levenberg–Marquardt; uncertainties are delta-method standard errors from the fit covariance. Doublet gate: robust line of pulse width on DNA area ± 3 robust SD.'));

  const dialog = showDialog({
    title: `Cell cycle — ${gateId !== ROOT ? gateById(ws0, gateId)?.name ?? 'population' : 'all events'}`,
    width: 'xwide',
    content,
    buttons: [
      { label: 'Close', ghost: true },
      { label: 'Save this sample', primary: true, onClick: () => { saveCurrent(); return false; } },
    ],
    onClose: () => chart.destroy(),
  });
  void dialog;

  function renderControls() {
    clear(controls);
    const ws = store.ws;
    const samples = sampleOptions(ws, gateId);
    const channels = rankChannels(ws, view, DNA_DYES);
    controls.append(
      fieldRow('Sample', selectEl(samples.map((s) => ({ value: s.id, label: s.name })), state.sampleId, async (v) => {
        state.sampleId = v;
        view = await data.ensure(v).catch((e) => { toast(e.message, { kind: 'error' }); return view; });
        refit();
      })),
      fieldRow('DNA channel', selectEl(channels.map((c) => ({ value: c.name, label: c.marker ? `${c.marker} (${c.name})` : c.name })), state.channel, (v) => { state.channel = v; refit(); }),
        'Use the linear area parameter of the DNA dye.'),
      h('div.field-label', { style: { margin: '6px 0' } }, 'Model'),
      h('div.segmented', { style: { marginBottom: '6px' } },
        h(`button${state.model === 'djf' ? '.active' : ''}`, { type: 'button', onclick: () => { state.model = 'djf'; refit(); } }, 'Dean–Jett–Fox'),
        h(`button${state.model === 'watson' ? '.active' : ''}`, { type: 'button', onclick: () => { state.model = 'watson'; refit(); } }, 'Watson')),
      h('p.muted.fine-print', state.model === 'djf'
        ? 'Fits the whole histogram: two Gaussians and a broadened quadratic S phase. The usual choice for clean, well-resolved histograms.'
        : 'Fits Gaussians to the outer flanks of G1 and G2 only; S phase is what remains between them. Robust when S phase has an unusual shape.'),
      h('label.check', h('input', { type: 'checkbox', checked: state.ratioFixed, onchange: (e) => { state.ratioFixed = e.target.checked; refit(); } }), 'Constrain G2/G1 ratio to'),
      (() => {
        const input = h('input.input.small', { type: 'number', step: 0.01, min: 1.5, max: 2.5, value: state.ratio, disabled: !state.ratioFixed, 'aria-label': 'G2/G1 ratio', style: { width: '90px', margin: '4px 0 8px 24px' } });
        input.addEventListener('change', () => { state.ratio = Number.parseFloat(input.value) || 2; refit(); });
        return input;
      })(),
      h('label.check', h('input', { type: 'checkbox', checked: state.equalCV, onchange: (e) => { state.equalCV = e.target.checked; refit(); } }), 'G2 CV = G1 CV'),
      state.model === 'djf' ? h('label.check', { style: { marginTop: '6px' } }, h('input', { type: 'checkbox', checked: state.debris, onchange: (e) => { state.debris = e.target.checked; refit(); } }), 'Model debris (exponential)') : null,
      state.model === 'djf' ? h('label.check', { style: { marginTop: '6px' } }, h('input', { type: 'checkbox', checked: state.aggregates, onchange: (e) => { state.aggregates = e.target.checked; refit(); } }), 'Model aggregates (G1+G2, G2+G2)') : null,
      fieldRow('Histogram bins', selectEl([128, 256, 512, 1024].map((b) => ({ value: b, label: String(b) })), state.bins, (v) => { state.bins = Number(v); refit(); })),
      h('div.section-title', { style: { marginTop: '12px' } }, 'All samples'),
      h('p.muted.fine-print', 'Fit the same model, with these settings, to this population in every sample.'),
      h('button.btn.small', { type: 'button', onclick: () => runBatch() }, icon('play'), 'Run on all samples'));
  }

  function refit() {
    error = null;
    fit = null;
    hist = null;
    try {
      if (!state.channel || !view.hasChannel(state.channel)) throw new Error('Choose a DNA channel present in this sample.');
      const indices = population(view, store.ws, gateId);
      if (indices === undefined) throw new Error('This population does not apply to the sample.');
      if (countOf(indices, view) < 200) throw new Error(`Only ${countOf(indices, view)} events in the population; a cell-cycle model needs several thousand.`);
      hist = dnaHistogram(view.column(state.channel), { indices, bins: state.bins });
      fit = modelFit(hist);
    } catch (e) {
      error = e.message;
    }
    renderControls();
    renderResults();
    renderDoublets();
    chart.redraw();
  }

  function modelOptions() {
    return {
      ratio: state.ratioFixed ? state.ratio : undefined,
      equalCV: state.equalCV,
      debris: state.model === 'djf' && state.debris,
      aggregates: state.model === 'djf' && state.aggregates,
    };
  }

  function modelFit(histogram) {
    return state.model === 'djf' ? fitDeanJettFox(histogram, modelOptions()) : fitWatsonPragmatic(histogram, modelOptions());
  }

  function buildChart(width, height, colors) {
    const items = [];
    const hits = [];
    if (!hist || !fit) {
      items.push({ t: 'text', x: width / 2, y: height / 2, text: error ?? 'No fit yet', fill: colors.text3, size: 12, align: 'center' });
      return { items, hits };
    }
    const rect = { x: 62, y: 12, w: width - 62 - 14, h: height - 12 - 44 - 66 };
    const strip = { x: rect.x, y: rect.y + rect.h + 12, w: rect.w, h: 52 };
    const edgeOf = (b) => hist.min + b * hist.binWidth;
    const x = valueScale(hist.min, hist.max, rect.x, rect.x + rect.w, { nice: false, target: 7 });
    let top = 0;
    for (let b = 0; b < hist.bins; b += 1) top = Math.max(top, hist.counts[b], fit.curves.total[b]);
    const y = valueScale(0, top * 1.08, rect.y + rect.h, rect.y, { target: 5 });
    leftAxis(items, y, rect, colors, 'Events per bin');
    items.push({ t: 'path', points: stepPoints(hist.counts, edgeOf, x.map, y.map), fill: withAlpha(colors.text3, 0.16), stroke: withAlpha(colors.text3, 0.6), width: 1, close: true });
    const comps = ['debris', 'aggregates', 'g1', 's', 'g2'].filter((k) => fit.curves[k]);
    for (const key of comps) {
      const color = COMPONENT_COLORS[key];
      items.push({ t: 'path', points: areaPoints(fit.curves[key], hist.centers, x.map, y.map), fill: withAlpha(color, key === 's' ? 0.28 : 0.22), stroke: color, width: 1.5, close: true, dash: key === 'debris' || key === 'aggregates' ? [4, 3] : null });
    }
    items.push({ t: 'path', points: curvePoints(fit.curves.total, hist.centers, x.map, y.map), stroke: colors.text, width: 1.8 });
    const [f0, f1] = fit.fitRange;
    for (const v of [f0, f1]) if (v > hist.min && v < hist.max) items.push({ t: 'line', x1: x.map(v), y1: rect.y, x2: x.map(v), y2: rect.y + rect.h, stroke: colors.text3, width: 1, dash: [2, 4] });
    residualStrip(items, strip, colors, x.map, hist.centers, hist.counts, fit.curves.total, fit.fitBins[0], fit.fitBins[1]);
    bottomAxis(items, x, { x: rect.x, y: strip.y, w: rect.w, h: strip.h }, colors, channelLabel(store.ws, state.channel));
    legend(items, [
      { label: `G0/G1 ${fit.percentG1.toFixed(1)}%`, color: COMPONENT_COLORS.g1 },
      { label: `S ${fit.percentS.toFixed(1)}%`, color: COMPONENT_COLORS.s },
      { label: `G2/M ${fit.percentG2.toFixed(1)}%`, color: COMPONENT_COLORS.g2 },
      ...(fit.curves.debris ? [{ label: 'Debris', color: COMPONENT_COLORS.debris }] : []),
      ...(fit.curves.aggregates ? [{ label: 'Aggregates', color: COMPONENT_COLORS.aggregates }] : []),
      { label: 'Model', color: colors.text, line: true },
    ], rect, colors);
    for (let b = 0; b < hist.bins; b += 1) {
      hits.push({ x: x.map(hist.centers[b]), y: rect.y + rect.h / 2, r: 10000, data: { x: hist.centers[b], count: hist.counts[b], model: fit.curves.total[b], g1: fit.curves.g1[b], s: fit.curves.s[b], g2: fit.curves.g2[b] } });
    }
    return { items, hits };
  }

  function renderResults() {
    clear(results);
    const pane = h('div.pane', h('h3', icon('flask'), 'Result'));
    results.append(pane);
    if (error || !fit) {
      pane.append(h('div.callout.danger', error ?? 'The model could not be fitted.'));
      return;
    }
    const se = fit.percentSE;
    const pm = (v) => (Number.isFinite(v) ? ` ± ${v.toFixed(1)}` : '');
    pane.append(h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(3, 1fr)' } },
      tile('G0/G1', `${fit.percentG1.toFixed(1)}%`, se ? `SE${pm(se.g1)}` : 'flank fit'),
      tile('S phase', `${fit.percentS.toFixed(1)}%`, se ? `SE${pm(se.s)}` : 'remainder'),
      tile('G2/M', `${fit.percentG2.toFixed(1)}%`, se ? `SE${pm(se.g2)}` : 'flank fit')));
    const kv = h('dl.kv', { style: { marginTop: '10px' } },
      h('dt', 'G1 mean · CV'), h('dd', `${formatValue(fit.g1.mean)} · ${(100 * fit.g1.cv).toFixed(2)}%`),
      h('dt', 'G2 mean · CV'), h('dd', `${formatValue(fit.g2.mean)} · ${(100 * fit.g2.cv).toFixed(2)}%`),
      h('dt', 'G2/G1 ratio'), h('dd', `${fit.g2g1Ratio.toFixed(3)}${state.ratioFixed ? ' (fixed)' : ''}`),
      h('dt', 'Reduced χ² · RMSD'), h('dd', `${formatValue(fit.reducedChiSquare)} · ${formatValue(fit.rmsd)} events`),
      h('dt', 'Events in the histogram'), h('dd', formatCount(hist.total)),
      fit.debris ? [h('dt', 'Debris'), h('dd', `${fit.debris.percent.toFixed(1)}% of fitted events`)] : null,
      fit.aggregates ? [h('dt', 'Aggregates'), h('dd', `${fit.aggregates.percent.toFixed(1)}% of fitted events`)] : null,
      h('dt', 'Fit'), h('dd', `${fit.converged ? 'converged' : 'not converged'}${fit.iterations !== undefined ? ` in ${fit.iterations} iterations` : ''}`));
    pane.append(kv);
    for (const warning of fit.warnings) pane.append(h('div.callout.warn', { style: { marginTop: '8px', fontSize: '12px' } }, warning));
    pane.append(h('p.muted', { style: { fontSize: '12px', margin: '10px 0 0' } },
      'How to read this: phase percentages are shares of the cycling cells (debris and aggregates excluded). A reduced χ² near 1 means the model explains the histogram within counting noise; values above about 3, or runs of residual bars beyond the dashed ±2 lines, indicate structure the model misses (debris, doublets, apoptotic sub-G1 cells or a second population). G1 CVs below about 5% give reliable S-phase estimates; above 8% they are unreliable.'));
  }

  // --- Doublet discrimination ---------------------------------------------------------------------

  function pulsePartner() {
    if (!state.channel) return null;
    const base = state.channel.replace(/-A$/i, '');
    if (base === state.channel) return null;
    for (const suffix of ['-W', '-H']) if (view.hasChannel(`${base}${suffix}`)) return `${base}${suffix}`;
    return null;
  }

  function renderDoublets() {
    clear(doublets);
    const partner = pulsePartner();
    const pane = h('div.pane', h('h3', icon('polygon'), 'Doublet discrimination'));
    doublets.append(pane);
    if (!partner) {
      pane.append(h('p.muted', { style: { margin: 0, fontSize: '12px' } }, 'No pulse width or height parameter of this DNA channel was found (e.g. PI-W). Gate singlets on a width or height vs area plot before modeling.'));
      return;
    }
    pane.append(h('p.muted', { style: { margin: '0 0 8px', fontSize: '12px' } },
      `Two G1 nuclei stuck together have the DNA area of one G2 nucleus but a ${/-W$/.test(partner) ? 'longer pulse (larger width)' : 'lower height for their area'}. CytoWeave can propose a singlet gate on ${state.channel} × ${partner}.`),
    h('button.btn.small', { type: 'button', onclick: () => proposeSinglets(partner) }, icon('sparkles'), 'Suggest a singlet gate'));
  }

  function proposeSinglets(partner) {
    const indices = population(view, store.ws, gateId);
    let suggestion;
    try {
      suggestion = doubletDiscrimination(view.column(state.channel), view.column(partner), { indices });
    } catch (e) {
      toast(e.message, { kind: 'error' });
      return;
    }
    const area = view.column(state.channel);
    const width = view.column(partner);
    const n = countOf(indices, view);
    const stride = Math.max(1, Math.floor(n / 6000));
    const pts = [];
    for (let i = 0; i < n; i += stride) {
      const e = indices ? indices[i] : i;
      pts.push([area[e], width[e]]);
    }
    const xs = pts.map((p) => p[0]).sort((a, b) => a - b);
    const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
    const inside = (a, w) => Math.abs(w - (suggestion.intercept + suggestion.slope * a)) <= suggestion.halfWidth && a <= suggestion.vertices[1][0];
    const preview = mountChart({
      height: 260,
      build: (W, H, colors) => {
        const items = [];
        const rect = { x: 62, y: 10, w: W - 62 - 12, h: H - 10 - 44 };
        const x = valueScale(0, q(xs, 0.998) * 1.05, rect.x, rect.x + rect.w, { target: 6 });
        const y = valueScale(Math.max(0, q(ys, 0.002) * 0.9), q(ys, 0.998) * 1.08, rect.y + rect.h, rect.y, { target: 5 });
        leftAxis(items, y, rect, colors, partner);
        bottomAxis(items, x, rect, colors, state.channel);
        for (const [a, w] of pts) {
          const px = x.map(a);
          const py = y.map(w);
          if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue;
          items.push({ t: 'circle', x: px, y: py, r: 1.3, fill: inside(a, w) ? withAlpha(colors.accent.startsWith('#') ? colors.accent : '#5b4ce6', 0.45) : withAlpha('#e45563', 0.5) });
        }
        items.push({ t: 'path', points: suggestion.vertices.map(([a, w]) => [x.map(a), y.map(w)]), stroke: colors.text, width: 1.6, close: true });
        return { items, hits: [] };
      },
    });
    const gateName = uniqueGateName(store.ws, gateId === ROOT ? null : gateId, `Singlets (${channelLabel(store.ws, state.channel, { short: true })})`);
    const box = h('div', { style: { marginTop: '10px' } }, preview.el,
      h('p', { style: { fontSize: '12px', margin: '8px 0' } }, `Keeps ${(100 * suggestion.singletFraction).toFixed(1)}% of the events: those within ±3 robust SD of the width-vs-area line (slope ${formatValue(suggestion.slope)}). Red events are likely doublets or clumps.`),
      h('div.btn-row',
        h('button.btn.small.primary', { type: 'button', onclick: () => addSingletGate(partner, suggestion, gateName) }, icon('plus'), `Add gate "${gateName}"`),
        h('button.btn.small.ghost', { type: 'button', onclick: () => { preview.destroy(); box.remove(); } }, 'Dismiss')));
    doublets.querySelector('.pane').append(box);
    requestAnimationFrame(() => preview.redraw());
  }

  function addSingletGate(partner, suggestion, name) {
    const ws = store.ws;
    const rangeOf = (channel) => {
      const info = view.channelInfo(channel);
      const column = view.column(channel);
      let hi = 0;
      for (let i = 0; i < column.length; i += 1) if (column[i] > hi) hi = column[i];
      return Math.max(info?.range ?? 0, hi, 1);
    };
    // Linear dimensions keep the straight band exact (a polygon on a logicle scale would bend).
    const dims = [state.channel, partner].map((channel) => ({ channel, transform: { type: 'linear', min: 0, max: rangeOf(channel) } }));
    const forward = dims.map((d) => createTransform(d.transform).forward);
    const vertices = suggestion.vertices.map(([a, w]) => [forward[0](a), forward[1](w)]);
    const result = addGates(ws, [{
      name,
      parentId: gateId === ROOT ? null : gateId,
      type: 'polygon',
      dims,
      geometry: { vertices },
      meta: { origin: 'auto', method: 'doublet discrimination: robust width-vs-area line ± 3 robust SD (CytoWeave)', note: `slope ${suggestion.slope}, intercept ${suggestion.intercept}` },
    }], 'add-gate');
    store.commit(result.ws, `Add ${name}`);
    const gate = result.gates[0];
    toast(`Added ${name}.`, { kind: 'ok', action: { label: 'Model the singlets', onClick: () => { dialog.close(); openCellCycle(app, gate.id, state.sampleId); } } });
  }

  // --- Batch ---------------------------------------------------------------------------------------

  function rowOf(sample, f, h0) {
    return {
      sampleId: sample.id,
      sample: sample.name,
      events: h0.total,
      percentG1: f.percentG1,
      percentS: f.percentS,
      percentG2: f.percentG2,
      cvG1: f.g1.cv,
      meanG1: f.g1.mean,
      ratio: f.g2g1Ratio,
      reducedChiSquare: f.reducedChiSquare,
      warnings: f.warnings,
    };
  }

  function record(rows) {
    const ws = store.ws;
    return {
      id: `cellcycle:${gateId}:${state.channel}`,
      kind: 'cellcycle',
      name: `Cell cycle · ${gateId !== ROOT ? gateById(ws, gateId)?.name : 'All events'} · ${channelLabel(ws, state.channel, { short: true })}`,
      method: state.model === 'djf' ? 'Dean–Jett–Fox (Fox 1980)' : 'Watson pragmatic (Watson et al. 1987)',
      params: { gateId, channel: state.channel, model: state.model, bins: state.bins, ...modelOptions() },
      seed: null,
      outputs: [],
      version: app.version ?? null,
      summary: { rows },
    };
  }

  function saveCurrent() {
    if (!fit) {
      toast('Nothing to save: the model did not fit.', { kind: 'error' });
      return;
    }
    const sample = store.ws.samples.find((s) => s.id === state.sampleId);
    saveRecord(app, record([rowOf(sample, fit, hist)]), 'Cell cycle model');
    toast(`Saved the cell-cycle result of ${sample.name}.`, { kind: 'ok' });
  }

  async function runBatch() {
    const options = { ...state };
    const rows = await runAllSamples(app, gateId, (v, indices) => {
      if (!v.hasChannel(options.channel)) throw new Error(`no channel ${options.channel}`);
      const histogram = dnaHistogram(v.column(options.channel), { indices, bins: options.bins });
      return { h: histogram, fit: modelFit(histogram) };
    }, 'Cell cycle');
    batch = rows;
    renderBatch();
  }

  function renderBatch() {
    clear(batchHost);
    if (!batch) return;
    const ok = batch.filter((r) => r.fit);
    const table = h('table.data', h('thead', h('tr', h('th', 'Sample'), h('th.r', 'Events'), h('th.r', '% G0/G1'), h('th.r', '% S'), h('th.r', '% G2/M'), h('th.r', 'G1 CV'), h('th.r', 'G2/G1'), h('th.r', 'Red. χ²'), h('th', 'Notes'))),
      h('tbody', ...batch.map((r) => (r.fit
        ? h('tr', { style: { cursor: 'pointer' }, title: 'Show this sample', onclick: async () => { state.sampleId = r.sample.id; view = await data.ensure(r.sample.id); refit(); } },
          h('td', r.sample.name), h('td.r', formatCount(r.h.total)), h('td.r', r.fit.percentG1.toFixed(1)), h('td.r', r.fit.percentS.toFixed(1)), h('td.r', r.fit.percentG2.toFixed(1)),
          h('td.r', `${(100 * r.fit.g1.cv).toFixed(1)}%`), h('td.r', r.fit.g2g1Ratio.toFixed(2)), h('td.r', formatValue(r.fit.reducedChiSquare)),
          h('td', r.fit.warnings.length ? h('span.badge.warn', { title: r.fit.warnings.join('\n') }, `${r.fit.warnings.length} warning${r.fit.warnings.length > 1 ? 's' : ''}`) : h('span.badge.ok', 'ok')))
        : h('tr', h('td', r.sample.name), h('td.muted', { colSpan: 8 }, r.error))))));
    const csv = () => downloadCSV([
      ['Sample', 'File', 'Events', '% G0/G1', '% S', '% G2/M', 'G1 mean', 'G1 CV', 'G2/G1', 'Reduced chi-square', 'Warnings'],
      ...batch.map((r) => (r.fit ? [r.sample.name, r.sample.fileName ?? '', r.h.total, r.fit.percentG1, r.fit.percentS, r.fit.percentG2, r.fit.g1.mean, r.fit.g1.cv, r.fit.g2g1Ratio, r.fit.reducedChiSquare, r.fit.warnings.join(' | ')] : [r.sample.name, r.sample.fileName ?? '', '', '', '', '', '', '', '', '', r.error])),
    ], `cell-cycle-${gateById(store.ws, gateId)?.name ?? 'all'}`);
    batchHost.append(h('div.pane', { style: { marginTop: '14px' } },
      h('h3', icon('table'), `All samples (${ok.length} fitted)`, h('span.spacer'),
        h('button.btn.small', { type: 'button', onclick: csv }, icon('download'), 'CSV'),
        h('button.btn.small.primary', { type: 'button', onclick: () => { saveRecord(app, record(ok.map((r) => rowOf(r.sample, r.fit, r.h))), 'Cell cycle (all samples)'); toast(`Saved ${ok.length} results to the workspace.`, { kind: 'ok' }); } }, icon('save'), 'Save results')),
      h('div', { style: { maxHeight: '300px', overflow: 'auto' } }, table)));
  }

  renderControls();
  refit();
  requestAnimationFrame(() => chart.redraw());
}

// =====================================================================================================
// Proliferation
// =====================================================================================================

export async function openProliferation(app, gateId, sampleId) {
  const { store, data } = app;
  const ws0 = store.ws;
  gateId = gateId ?? ROOT;
  sampleId = sampleId ?? store.ui.sampleId ?? sampleOptions(ws0, gateId)[0]?.id;
  if (!sampleId) {
    toast('Add a sample first.', { kind: 'error' });
    return;
  }
  let view = await data.ensure(sampleId).catch((error) => {
    toast(error.message, { kind: 'error' });
    return null;
  });
  if (!view) return;
  const ranked = rankChannels(ws0, view, PROLIFERATION_DYES);
  const state = {
    sampleId,
    channel: ranked[0]?.name,
    scale: 'log10',
    peakMode: 'auto',
    peak: null,
    generations: 'auto',
    fitSpacing: true,
    bins: 256,
  };
  let fit = null;
  let error = null;
  let batch = null;

  const controls = h('div.platform-controls');
  const results = h('div');
  const batchHost = h('div');
  const chart = mountChart({
    height: 380,
    build: (width, height, colors) => buildChart(width, height, colors),
    tooltip: (bin) => [h('b', `≈ ${formatTick(bin.linear)}`), h('div', `Observed ${formatCount(bin.count)} · model ${formatValue(bin.model)}`), bin.generation !== null ? h('div.muted', `Mostly generation ${bin.generation}`) : null].filter(Boolean),
    name: () => `proliferation-${store.ws.samples.find((s) => s.id === state.sampleId)?.name ?? 'sample'}`,
  });

  const content = h('div.platform',
    h('p.platform-intro', 'Each division halves a cell’s dye. The dye histogram of ', h('b', populationName(ws0, gateId)), ' is modeled as equally spaced generation peaks (on a log scale) with a shared width; the cells in each generation give the number of original cells (precursors) that divided, and the proliferation indices below.'),
    h('div.platform-grid', controls, h('div', { style: { minWidth: 0 } },
      h('div.pane', h('h3', icon('wave'), 'Fitted generations', h('span.spacer'),
        h('button.btn.small', { type: 'button', onclick: () => chart.exportSVG() }, icon('download'), 'SVG'),
        h('button.btn.small', { type: 'button', onclick: () => chart.exportPNG() }, icon('download'), 'PNG')), chart.el),
      results)),
    batchHost,
    h('p.muted.fine-print', 'Indices as defined by Roederer 2011, Cytometry A 79:95–101 (doi:10.1002/cyto.a.21010) and FlowJo’s proliferation platform, from precursor numbers N_g/2^g. Generations are a mixture of Gaussians on the log (or channel) scale with means log(peak₀) − g·r·log(2) and a shared width, fitted to the Poisson-weighted histogram by Levenberg–Marquardt; events are assigned to generations by posterior probability. Indices assume no cell death and that all divided cells are resolved.'));

  const dialog = showDialog({
    title: `Proliferation — ${gateId !== ROOT ? gateById(ws0, gateId)?.name ?? 'population' : 'all events'}`,
    width: 'xwide',
    content,
    buttons: [
      { label: 'Close', ghost: true },
      { label: 'Save this sample', primary: true, onClick: () => { saveCurrent(); return false; } },
    ],
    onClose: () => chart.destroy(),
  });
  void dialog;

  function transformOption(v) {
    if (state.scale === 'channel') {
      const spec = channelTransform(store.ws, v, state.channel);
      if (spec && spec.type !== 'linear') return spec;
    }
    return 'log10';
  }

  function options(v) {
    return {
      transform: transformOption(v),
      undividedPeak: state.peakMode === 'fixed' && state.peak > 0 ? state.peak : undefined,
      generations: state.generations === 'auto' ? undefined : Number(state.generations),
      fitSpacing: state.fitSpacing,
      bins: state.bins,
    };
  }

  function renderControls() {
    clear(controls);
    const ws = store.ws;
    const samples = sampleOptions(ws, gateId);
    const channels = rankChannels(ws, view, PROLIFERATION_DYES);
    const peakInput = h('input.input.small', { type: 'number', step: 'any', min: 0, value: state.peak ?? '', placeholder: 'e.g. 45000', disabled: state.peakMode !== 'fixed', style: { width: '120px' } });
    peakInput.addEventListener('change', () => { state.peak = Number.parseFloat(peakInput.value) || null; refit(); });
    controls.append(
      fieldRow('Sample', selectEl(samples.map((s) => ({ value: s.id, label: s.name })), state.sampleId, async (v) => {
        state.sampleId = v;
        view = await data.ensure(v).catch((e) => { toast(e.message, { kind: 'error' }); return view; });
        refit();
      })),
      fieldRow('Dye channel', selectEl(channels.map((c) => ({ value: c.name, label: c.marker ? `${c.marker} (${c.name})` : c.name })), state.channel, (v) => { state.channel = v; refit(); }), 'CellTrace Violet, CFSE or a similar dye (compensated, linear values).'),
      fieldRow('Scale', selectEl([{ value: 'log10', label: 'Log₁₀ (non-positive events left out)' }, { value: 'channel', label: 'The channel’s plot scale (logicle keeps all events)' }], state.scale, (v) => { state.scale = v; refit(); })),
      h('div.field-label', { style: { margin: '6px 0' } }, 'Undivided peak (generation 0)'),
      h('div.segmented', { style: { marginBottom: '6px' } },
        h(`button${state.peakMode === 'auto' ? '.active' : ''}`, { type: 'button', onclick: () => { state.peakMode = 'auto'; refit(); } }, 'Brightest peak'),
        h(`button${state.peakMode === 'fixed' ? '.active' : ''}`, { type: 'button', onclick: () => { state.peakMode = 'fixed'; state.peak ??= fit?.undividedPeak ?? null; refit(); } }, 'Fixed')),
      h('div.row', { style: { marginBottom: '8px' } }, peakInput,
        selectEl([{ value: '', label: 'Take from a control…' }, ...store.ws.samples.filter((s) => s.id !== state.sampleId).map((s) => ({ value: s.id, label: s.name }))], '', (v) => { if (v) peakFromControl(v); }, 'Take the undivided peak from a control')),
      h('p.muted.fine-print', 'An unstimulated control marks generation 0 exactly; otherwise the brightest substantial peak is used and refined.'),
      fieldRow('Generations', selectEl([{ value: 'auto', label: 'Automatic (up to 10)' }, ...Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))], state.generations, (v) => { state.generations = v; refit(); })),
      h('label.check', h('input', { type: 'checkbox', checked: state.fitSpacing, onchange: (e) => { state.fitSpacing = e.target.checked; refit(); } }), 'Fit the spacing (dye loss per division)'),
      h('p.muted.fine-print', 'Off: generations are exactly 2-fold apart.'),
      h('div.section-title', { style: { marginTop: '12px' } }, 'All samples'),
      h('p.muted.fine-print', 'Fit every sample with these settings (a fixed undivided peak is shared by all).'),
      h('button.btn.small', { type: 'button', onclick: () => runBatch() }, icon('play'), 'Run on all samples'));
  }

  async function peakFromControl(controlId) {
    try {
      const control = await data.ensure(controlId);
      const indices = population(control, store.ws, gateId);
      if (indices === undefined) throw new Error('The population does not apply to that sample.');
      const reference = fitProliferation(control.column(state.channel), { ...options(control), indices, undividedPeak: undefined, generations: 1 });
      state.peak = +reference.undividedPeak.toPrecision(5);
      state.peakMode = 'fixed';
      toast(`Undivided peak set to ${formatTick(state.peak)} from ${control.record.name}.`, { kind: 'ok' });
      refit();
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  function refit() {
    error = null;
    fit = null;
    try {
      if (!state.channel || !view.hasChannel(state.channel)) throw new Error('Choose a dye channel present in this sample.');
      const indices = population(view, store.ws, gateId);
      if (indices === undefined) throw new Error('This population does not apply to the sample.');
      fit = fitProliferation(view.column(state.channel), { ...options(view), indices });
    } catch (e) {
      error = e.message;
    }
    renderControls();
    renderResults();
    chart.redraw();
  }

  function scaleTicks(lo, hi) {
    if (fit.scale === 'log10') {
      const ticks = [];
      for (let e = Math.floor(lo); e <= Math.ceil(hi); e += 1) {
        for (let m = 1; m <= 9; m += 1) {
          const v = Math.log10(m * 10 ** e);
          if (v >= lo && v <= hi) ticks.push({ value: v, label: m === 1 ? powerLabel(e) : '', major: m === 1 });
        }
      }
      return ticks;
    }
    const spec = transformOption(view);
    return axisTicks(createTransform(spec)).map((t) => ({ value: t.position, label: t.label, major: t.major })).filter((t) => t.value >= lo && t.value <= hi);
  }

  function buildChart(width, height, colors) {
    const items = [];
    const hits = [];
    if (!fit) {
      items.push({ t: 'text', x: width / 2, y: height / 2, text: error ?? 'No fit yet', fill: colors.text3, size: 12, align: 'center' });
      return { items, hits };
    }
    const rect = { x: 62, y: 24, w: width - 62 - 14, h: height - 24 - 44 - 66 };
    const strip = { x: rect.x, y: rect.y + rect.h + 12, w: rect.w, h: 52 };
    const bw = fit.binWidth;
    const lo = fit.x[0] - bw / 2;
    const hi = fit.x[fit.x.length - 1] + bw / 2;
    const x = valueScale(lo, hi, rect.x, rect.x + rect.w, { nice: false });
    x.ticks = scaleTicks(lo, hi);
    let top = 0;
    for (let b = 0; b < fit.histogram.length; b += 1) top = Math.max(top, fit.histogram[b], fit.curves.total[b]);
    const y = valueScale(0, top * 1.1, rect.y + rect.h, rect.y, { target: 5 });
    leftAxis(items, y, rect, colors, 'Events per bin');
    items.push({ t: 'path', points: stepPoints(fit.histogram, (b) => lo + b * bw, x.map, y.map), fill: withAlpha(colors.text3, 0.16), stroke: withAlpha(colors.text3, 0.6), width: 1, close: true });
    fit.curves.components.forEach((component, g) => {
      const color = CATEGORICAL[g % CATEGORICAL.length];
      items.push({ t: 'path', points: areaPoints(component, fit.x, x.map, y.map), fill: withAlpha(color, 0.22), stroke: color, width: 1.4, close: true });
      const generation = fit.generations[g];
      const px = x.map(generation.position);
      let peak = 0;
      for (const v of component) peak = Math.max(peak, v);
      if (px >= rect.x && px <= rect.x + rect.w && generation.fraction > 0.002) {
        items.push({ t: 'text', x: px, y: Math.max(rect.y + 10, y.map(peak) - 6), text: String(g), fill: color, size: 11, weight: 700, align: 'center' });
      }
    });
    items.push({ t: 'path', points: curvePoints(fit.curves.total, fit.x, x.map, y.map), stroke: colors.text, width: 1.8 });
    const p0 = x.map(fit.generations[0].position);
    items.push({ t: 'line', x1: p0, y1: rect.y, x2: p0, y2: rect.y + rect.h, stroke: colors.text3, width: 1, dash: [3, 4] });
    items.push({ t: 'text', x: p0 - 4, y: rect.y - 8, text: 'undivided', fill: colors.text3, size: 10, align: 'end' });
    residualStrip(items, strip, colors, x.map, fit.x, fit.histogram, fit.curves.total, 0, fit.histogram.length - 1);
    bottomAxis(items, x, { x: rect.x, y: strip.y, w: rect.w, h: strip.h }, colors, channelLabel(store.ws, state.channel));
    for (let b = 0; b < fit.x.length; b += 1) {
      let best = null;
      let bestV = 0;
      fit.curves.components.forEach((c, g) => { if (c[b] > bestV) { bestV = c[b]; best = g; } });
      hits.push({ x: x.map(fit.x[b]), y: rect.y + rect.h / 2, r: 10000, data: { linear: fit.xLinear[b], count: fit.histogram[b], model: fit.curves.total[b], generation: bestV > 0.5 ? best : null } });
    }
    return { items, hits };
  }

  function renderResults() {
    clear(results);
    const pane = h('div.pane', h('h3', icon('flask'), 'Result'));
    results.append(pane);
    if (error || !fit) {
      pane.append(h('div.callout.danger', error ?? 'The model could not be fitted.'));
      return;
    }
    const idx = fit.indices;
    pane.append(h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(5, 1fr)' } },
      tile('% Divided', `${idx.percentDivided.toFixed(1)}%`, 'of original cells'),
      tile('Division index', formatValue(idx.divisionIndex), 'divisions per original cell'),
      tile('Proliferation index', formatValue(idx.proliferationIndex), 'divisions per responder'),
      tile('Expansion index', formatValue(idx.expansionIndex), 'fold expansion, all'),
      tile('Replication index', formatValue(idx.replicationIndex), 'fold expansion, responders')));
    const body = h('tbody', ...fit.generations.map((g) => h('tr',
      h('td', h('span.swatch', { style: { background: CATEGORICAL[g.generation % CATEGORICAL.length], marginRight: '6px' } }), g.generation === 0 ? '0 (undivided)' : String(g.generation)),
      h('td.r', formatTick(g.mean)), h('td.r', formatCount(g.count)), h('td.r', `${(100 * g.fraction).toFixed(1)}%`), h('td.r', `${(100 * g.precursorFraction).toFixed(1)}%`))));
    pane.append(h('div.section-title', { style: { marginTop: '12px' } }, 'Generations'),
      h('table.data', h('thead', h('tr', h('th', 'Generation'), h('th.r', 'Peak intensity'), h('th.r', 'Cells'), h('th.r', '% of cells'), h('th.r', '% of precursors'))), body),
      h('dl.kv', { style: { marginTop: '10px' } },
        h('dt', 'Dilution per division'), h('dd', `${fit.dilutionPerGeneration.toFixed(3)}×${state.fitSpacing ? ' (fitted)' : ' (fixed)'}`),
        h('dt', 'Peak CV'), h('dd', `${(100 * fit.cv).toFixed(1)}%`),
        h('dt', 'Reduced χ²'), h('dd', formatValue(fit.reducedChiSquare)),
        h('dt', 'Events modeled'), h('dd', `${formatCount(fit.eventCount)}${fit.excluded ? ` (${formatCount(fit.excluded)} left out)` : ''}`)));
    for (const warning of fit.warnings) pane.append(h('div.callout.warn', { style: { marginTop: '8px', fontSize: '12px' } }, warning));
    pane.append(h('div.callout', { style: { marginTop: '10px', fontSize: '12px' } },
      h('b', 'What the indices mean. '),
      '% Divided: share of the original cells that divided at least once. Division index: average number of divisions of all original cells, including those that never divided. Proliferation index: average number of divisions of the cells that did divide. Expansion index: how many times the culture grew. Replication index: how many times the responding cells grew. All are computed from precursor numbers (cells in generation g ÷ 2^g) and assume no cell death (Roederer 2011 explains why the division index is easily misread).'));
  }

  function rowOf(sample, f) {
    return { sampleId: sample.id, sample: sample.name, events: f.eventCount, generations: f.generations.length - 1, ...f.indices, dilution: f.dilutionPerGeneration, cv: f.cv, undividedPeak: f.undividedPeak, reducedChiSquare: f.reducedChiSquare, warnings: f.warnings };
  }

  function record(rows) {
    const ws = store.ws;
    return {
      id: `proliferation:${gateId}:${state.channel}`,
      kind: 'proliferation',
      name: `Proliferation · ${gateId !== ROOT ? gateById(ws, gateId)?.name : 'All events'} · ${channelLabel(ws, state.channel, { short: true })}`,
      method: 'Generation mixture model; indices per Roederer 2011',
      params: { gateId, channel: state.channel, scale: state.scale, undividedPeak: state.peakMode === 'fixed' ? state.peak : 'auto', generations: state.generations, fitSpacing: state.fitSpacing, bins: state.bins },
      seed: null,
      outputs: [],
      version: app.version ?? null,
      summary: { rows },
    };
  }

  function saveCurrent() {
    if (!fit) {
      toast('Nothing to save: the model did not fit.', { kind: 'error' });
      return;
    }
    const sample = store.ws.samples.find((s) => s.id === state.sampleId);
    saveRecord(app, record([rowOf(sample, fit)]), 'Proliferation model');
    toast(`Saved the proliferation result of ${sample.name}.`, { kind: 'ok' });
  }

  async function runBatch() {
    const rows = await runAllSamples(app, gateId, (v, indices) => {
      if (!v.hasChannel(state.channel)) throw new Error(`no channel ${state.channel}`);
      return { fit: fitProliferation(v.column(state.channel), { ...options(v), indices }) };
    }, 'Proliferation');
    batch = rows;
    renderBatch();
  }

  function renderBatch() {
    clear(batchHost);
    if (!batch) return;
    const ok = batch.filter((r) => r.fit);
    const table = h('table.data', h('thead', h('tr', h('th', 'Sample'), h('th.r', 'Events'), h('th.r', 'Gens'), h('th.r', '% Divided'), h('th.r', 'Division idx'), h('th.r', 'Prolif. idx'), h('th.r', 'Expansion idx'), h('th.r', 'Replication idx'), h('th', 'Notes'))),
      h('tbody', ...batch.map((r) => (r.fit
        ? h('tr', { style: { cursor: 'pointer' }, title: 'Show this sample', onclick: async () => { state.sampleId = r.sample.id; view = await data.ensure(r.sample.id); refit(); } },
          h('td', r.sample.name), h('td.r', formatCount(r.fit.eventCount)), h('td.r', r.fit.generations.length - 1), h('td.r', r.fit.indices.percentDivided.toFixed(1)),
          h('td.r', formatValue(r.fit.indices.divisionIndex)), h('td.r', formatValue(r.fit.indices.proliferationIndex)), h('td.r', formatValue(r.fit.indices.expansionIndex)), h('td.r', formatValue(r.fit.indices.replicationIndex)),
          h('td', r.fit.warnings.length ? h('span.badge.warn', { title: r.fit.warnings.join('\n') }, `${r.fit.warnings.length} warning${r.fit.warnings.length > 1 ? 's' : ''}`) : h('span.badge.ok', 'ok')))
        : h('tr', h('td', r.sample.name), h('td.muted', { colSpan: 8 }, r.error))))));
    const csv = () => downloadCSV([
      ['Sample', 'File', 'Events', 'Generations', '% Divided', 'Division index', 'Proliferation index', 'Expansion index', 'Replication index', 'Dilution per division', 'Peak CV', 'Undivided peak', 'Warnings'],
      ...batch.map((r) => (r.fit ? [r.sample.name, r.sample.fileName ?? '', r.fit.eventCount, r.fit.generations.length - 1, r.fit.indices.percentDivided, r.fit.indices.divisionIndex, r.fit.indices.proliferationIndex, r.fit.indices.expansionIndex, r.fit.indices.replicationIndex, r.fit.dilutionPerGeneration, r.fit.cv, r.fit.undividedPeak, r.fit.warnings.join(' | ')] : [r.sample.name, r.sample.fileName ?? '', '', '', '', '', '', '', '', '', '', '', r.error])),
    ], `proliferation-${gateById(store.ws, gateId)?.name ?? 'all'}`);
    batchHost.append(h('div.pane', { style: { marginTop: '14px' } },
      h('h3', icon('table'), `All samples (${ok.length} fitted)`, h('span.spacer'),
        h('button.btn.small', { type: 'button', onclick: csv }, icon('download'), 'CSV'),
        h('button.btn.small.primary', { type: 'button', onclick: () => { saveRecord(app, record(ok.map((r) => rowOf(r.sample, r.fit))), 'Proliferation (all samples)'); toast(`Saved ${ok.length} results to the workspace.`, { kind: 'ok' }); } }, icon('save'), 'Save results')),
      h('div', { style: { maxHeight: '300px', overflow: 'auto' } }, table)));
  }

  renderControls();
  refit();
  requestAnimationFrame(() => chart.redraw());
}
