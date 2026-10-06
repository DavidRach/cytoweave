// The Kinetics platform: a population's signal, or the ratio of two channels (Indo-1 violet/blue),
// against acquisition time, with the response measured (lib/kinetics.js): baseline, peak, time
// to peak, half-max time, area and the fraction of responding cells. Other samples can be
// overlaid, aligned at their stimulus; every sample can be run at once and the results saved
// (a ws.derived record of kind 'kinetics').

import { h, icon, clear, formatCount } from './dom.js';
import { showDialog, toast } from './overlays.js';
import { mountChart, leftAxis, bottomAxis, valueScale, withAlpha, downloadCSV, formatValue, formatTick } from './charts.js';
import { population } from '../lib/engine.js';
import { ROOT, channelLabel, gateById } from '../lib/workspace.js';
import { CATEGORICAL } from '../lib/colormaps.js';
import { quantileSorted } from '../lib/stats.js';
import { alignedCurves, analyzeKinetics, eventSeconds, kineticsMeasure } from '../lib/kinetics.js';
import { fieldRow, populationName, runAllSamples, sampleOptions, saveRecord, selectEl, tile } from './platforms.js';

const VIOLET = /(indo.*(viol|bound|ca)|\bviolet\b)/i;
const BLUE = /(indo.*(blue|free)|\bblue\b)/i;
const SINGLE = /(fluo|cal-?520|calbryte|rhod|oregon|fura|indo)/i;

// Fluorescence channels with their markers/labels.
function fluorescenceChannels(view) {
  return view.parameters.filter((p) => p.type !== 'time' && p.type !== 'scatter' && !/^(FSC|SSC|Time)/i.test(p.name))
    .map((p) => ({ name: p.name, text: `${p.marker ?? ''} ${p.label ?? ''} ${p.name}` }));
}

export function guessMeasure(view) {
  const channels = fluorescenceChannels(view);
  const violet = channels.find((c) => VIOLET.test(c.text));
  const blue = channels.find((c) => BLUE.test(c.text));
  if (violet && blue) return { mode: 'ratio', numerator: violet.name, denominator: blue.name, channel: violet.name };
  const single = channels.find((c) => SINGLE.test(c.text)) ?? channels[0];
  return { mode: 'channel', numerator: channels[0]?.name, denominator: channels[1]?.name, channel: single?.name };
}

function timeOf(view) {
  const time = view.parameters.find((p) => p.type === 'time') ?? view.parameters.find((p) => /^time$/i.test(p.name));
  if (!time) throw new Error('This sample has no time parameter.');
  const keyword = Number.parseFloat(view.dataset?.keywords?.$TIMESTEP ?? view.record?.keywords?.$TIMESTEP);
  const timestep = keyword > 0 ? keyword : 0.01;
  return { seconds: eventSeconds(view.raw.get(time.name), timestep), assumed: !(keyword > 0), timestep };
}

// One sample's kinetics: measure ({ numerator, denominator } or { channel }, with labels), the
// analysis options of lib/kinetics.js. Returns { result, time, measure }.
export function kineticsOfView(view, indices, measure, options = {}) {
  const time = timeOf(view);
  const names = measure.numerator ? [measure.numerator, measure.denominator] : [measure.channel];
  const columns = {};
  for (const name of names) {
    if (!name || !view.hasChannel(name)) throw new Error(`${view.record.name} has no channel ${name}.`);
    columns[name] = view.column(name);
  }
  const values = kineticsMeasure(columns, measure);
  const result = analyzeKinetics(time.seconds, values.values, { ...options, indices, allTimes: time.seconds });
  if (time.assumed) result.warnings.push('The file has no $TIMESTEP keyword: 0.01 s per time unit is assumed.');
  return { result, time, measure: values };
}

export async function openKinetics(app, gateId, sampleId) {
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
  const state = {
    sampleId,
    ...guessMeasure(view),
    statistic: 'median',
    binWidth: null,
    smoothing: 3,
    stimulusMode: 'auto',
    stimulus: null,
    responseEnd: null,
    thresholdMode: 'auto',
    threshold: null,
    overlay: new Set(),
  };
  let result = null;
  let density = null;
  let error = null;
  let batch = null;
  const overlays = new Map(); // sample id → { name, result }

  const controls = h('div.platform-controls');
  const results = h('div');
  const batchHost = h('div');
  const chart = mountChart({
    height: 440,
    build: (width, height, colors) => buildChart(width, height, colors),
    tooltip: (d) => [h('b', `${d.time.toFixed(1)} s${d.after !== null ? ` (${d.after >= 0 ? '+' : ''}${d.after.toFixed(1)} s)` : ''}`), h('div', `${formatCount(d.count)} events · ${state.statistic} ${formatValue(d.value)} · smoothed ${formatValue(d.smooth)}`), Number.isFinite(d.percent) ? h('div.muted', `${d.percent.toFixed(1)}% above the threshold`) : null].filter(Boolean),
    name: () => `kinetics-${store.ws.samples.find((s) => s.id === state.sampleId)?.name ?? 'sample'}`,
  });

  const content = h('div.platform',
    h('p.platform-intro', 'The signal of ', h('b', populationName(ws0, gateId)), ' against acquisition time, as in a calcium flux: events are binned by time, each bin gives the population\'s median (or mean), and the response is measured from the smoothed curve against the baseline before the stimulus. For Indo-1, use the ratio of its violet (calcium-bound) and blue (free) channels; it does not depend on how much dye a cell took up.'),
    h('div.platform-grid', controls, h('div', { style: { minWidth: 0 } },
      h('div.pane', h('h3', icon('wave'), 'Kinetics', h('span.spacer'),
        h('button.btn.small', { type: 'button', onclick: () => chart.exportSVG() }, icon('download'), 'SVG'),
        h('button.btn.small', { type: 'button', onclick: () => chart.exportPNG() }, icon('download'), 'PNG')), chart.el),
      results)),
    batchHost,
    h('p.muted.fine-print', 'The stimulus is where acquisition paused (the tube taken out to add it), or the time you enter; without either, the response\'s onset (a step in the curve) is used and times are counted from it. Responding: the share of events above the threshold (by default the 99th percentile of the baseline events) at its smoothed maximum after the stimulus, net of the baseline\'s own share above it. Each cell is measured once, so this is the share responding at that moment.'));

  showDialog({
    title: `Kinetics — ${gateId !== ROOT ? gateById(ws0, gateId)?.name ?? 'population' : 'all events'}`,
    width: 'xwide',
    content,
    buttons: [
      { label: 'Close', ghost: true },
      { label: 'Save this sample', primary: true, onClick: () => { saveCurrent(); return false; } },
    ],
    onClose: () => chart.destroy(),
  });

  function measureSpec(v) {
    const label = (name) => channelLabel(store.ws, name, { short: true });
    return state.mode === 'ratio'
      ? { numerator: state.numerator, denominator: state.denominator, numeratorLabel: label(state.numerator), denominatorLabel: label(state.denominator) }
      : { channel: state.channel, label: label(state.channel) };
  }

  function options() {
    return {
      statistic: state.statistic,
      binWidth: state.binWidth > 0 ? state.binWidth : undefined,
      smoothing: state.smoothing,
      stimulus: state.stimulusMode === 'given' && Number.isFinite(state.stimulus) ? state.stimulus : undefined,
      responseEnd: Number.isFinite(state.responseEnd) ? state.responseEnd : undefined,
      threshold: state.thresholdMode === 'given' && Number.isFinite(state.threshold) ? state.threshold : undefined,
    };
  }

  function analyze(v, indices) {
    return kineticsOfView(v, indices, measureSpec(v), options());
  }

  function numberInput(value, onChange, placeholder, disabled = false) {
    const input = h('input.input.small', { type: 'number', step: 'any', value: value ?? '', placeholder, disabled, style: { width: '110px' } });
    input.addEventListener('change', () => { const v = Number.parseFloat(input.value); onChange(Number.isFinite(v) ? v : null); });
    return input;
  }

  function renderControls() {
    clear(controls);
    const ws = store.ws;
    const samples = sampleOptions(ws, gateId);
    const channels = fluorescenceChannels(view).map((c) => ({ value: c.name, label: channelLabel(ws, c.name) }));
    controls.append(
      fieldRow('Sample', selectEl(samples.map((s) => ({ value: s.id, label: s.name })), state.sampleId, async (v) => {
        state.sampleId = v;
        view = await data.ensure(v).catch((e) => { toast(e.message, { kind: 'error' }); return view; });
        state.overlay.delete(v);
        recompute();
      })),
      h('div.segmented', { style: { margin: '4px 0 8px' } },
        h(`button${state.mode === 'ratio' ? '.active' : ''}`, { type: 'button', onclick: () => { state.mode = 'ratio'; recompute(); } }, 'Ratio of two channels'),
        h(`button${state.mode === 'channel' ? '.active' : ''}`, { type: 'button', onclick: () => { state.mode = 'channel'; recompute(); } }, 'One channel')),
      ...(state.mode === 'ratio'
        ? [fieldRow('Numerator', selectEl(channels, state.numerator, (v) => { state.numerator = v; recompute(); }), 'Indo-1: violet (calcium-bound).'),
          fieldRow('Denominator', selectEl(channels, state.denominator, (v) => { state.denominator = v; recompute(); }), 'Indo-1: blue (free). Events where either is not positive are left out.')]
        : [fieldRow('Channel', selectEl(channels, state.channel, (v) => { state.channel = v; recompute(); }), 'A single-wavelength dye such as Fluo-4, or any parameter.')]),
      fieldRow('Statistic per time bin', selectEl([{ value: 'median', label: 'Median' }, { value: 'mean', label: 'Mean' }], state.statistic, (v) => { state.statistic = v; recompute(); })),
      fieldRow('Bin width (s)', numberInput(state.binWidth, (v) => { state.binWidth = v; recompute(); }, result ? `auto: ${result.binWidth}` : 'auto'), 'About 150 bins of at least 50 events by default.'),
      fieldRow('Smoothing', selectEl([1, 3, 5, 7, 9, 15].map((k) => ({ value: k, label: k === 1 ? 'None' : `${k} bins` })), state.smoothing, (v) => { state.smoothing = Number(v); recompute(); })),
      h('div.field-label', { style: { margin: '6px 0' } }, 'Stimulus'),
      h('div.segmented', { style: { marginBottom: '6px' } },
        h(`button${state.stimulusMode === 'auto' ? '.active' : ''}`, { type: 'button', onclick: () => { state.stimulusMode = 'auto'; recompute(); } }, 'Pause or onset'),
        h(`button${state.stimulusMode === 'given' ? '.active' : ''}`, { type: 'button', onclick: () => { state.stimulusMode = 'given'; state.stimulus ??= result?.stimulus?.time ?? null; recompute(); } }, 'At a time')),
      h('div.row', { style: { marginBottom: '8px', gap: '6px', alignItems: 'center' } }, numberInput(state.stimulusMode === 'given' ? state.stimulus : result?.stimulus?.time?.toFixed(1), (v) => { state.stimulus = v; state.stimulusMode = 'given'; recompute(); }, 'seconds', state.stimulusMode !== 'given'), h('span.muted.fine-print', 's')),
      fieldRow('End of the response window (s)', numberInput(state.responseEnd, (v) => { state.responseEnd = v; recompute(); }, 'end of acquisition')),
      h('div.field-label', { style: { margin: '6px 0' } }, 'Threshold for responding cells'),
      h('div.segmented', { style: { marginBottom: '6px' } },
        h(`button${state.thresholdMode === 'auto' ? '.active' : ''}`, { type: 'button', onclick: () => { state.thresholdMode = 'auto'; recompute(); } }, '99th pct of baseline'),
        h(`button${state.thresholdMode === 'given' ? '.active' : ''}`, { type: 'button', onclick: () => { state.thresholdMode = 'given'; state.threshold ??= result?.threshold ?? null; recompute(); } }, 'Fixed')),
      h('div.row', { style: { marginBottom: '8px' } }, numberInput(state.thresholdMode === 'given' ? state.threshold : result ? +result.threshold.toPrecision(4) : null, (v) => { state.threshold = v; state.thresholdMode = 'given'; recompute(); }, 'value', state.thresholdMode !== 'given')),
      h('div.section-title', { style: { marginTop: '12px' } }, 'Overlay'),
      h('p.muted.fine-print', 'Other samples\' smoothed curves, each aligned at its own stimulus.'),
      h('div.kinetics-overlay', samples.filter((s) => s.id !== state.sampleId).map((s) => h('label.check', h('input', { type: 'checkbox', checked: state.overlay.has(s.id), onchange: (e) => { if (e.target.checked) state.overlay.add(s.id); else state.overlay.delete(s.id); refreshOverlays(); } }), s.name))),
      h('div.section-title', { style: { marginTop: '12px' } }, 'All samples'),
      h('p.muted.fine-print', 'Measure every sample with these settings.'),
      h('button.btn.small', { type: 'button', onclick: () => runBatch() }, icon('play'), 'Run on all samples'));
  }

  // The events' density in time × value, for the background (60 value bins).
  function densityOf(time, values, indices, r, lo, hi) {
    const tb = r.curve.centers.length;
    const vb = 60;
    const counts = new Float64Array(tb * vb);
    const start = r.curve.centers[0] - r.binWidth / 2;
    let max = 0;
    for (const i of indices ?? values.keys()) {
      const v = values[i];
      if (!Number.isFinite(v) || v < lo || v >= hi) continue;
      const a = Math.floor((time[i] - start) / r.binWidth);
      const b = Math.floor(((v - lo) / (hi - lo)) * vb);
      if (a < 0 || a >= tb || b < 0 || b >= vb) continue;
      counts[a * vb + b] += 1;
      if (counts[a * vb + b] > max) max = counts[a * vb + b];
    }
    return { counts, tb, vb, lo, hi, max, start };
  }

  function recompute() {
    error = null;
    result = null;
    density = null;
    try {
      const indices = population(view, store.ws, gateId);
      if (indices === undefined) throw new Error('This population does not apply to the sample.');
      const run = analyze(view, indices);
      result = run.result;
      const sample = [];
      for (const i of indices ?? run.measure.values.keys()) if (Number.isFinite(run.measure.values[i])) sample.push(run.measure.values[i]);
      const sorted = Float64Array.from(sample).sort();
      const lo = Math.min(quantileSorted(sorted, 0.005), result.baseline);
      const hi = Math.max(quantileSorted(sorted, 0.995), result.peak ?? -Infinity, result.threshold);
      density = densityOf(run.time.seconds, run.measure.values, indices, result, lo, hi + (hi - lo) * 0.02);
      result.label = run.measure.label;
    } catch (e) {
      error = e.message;
    }
    renderControls();
    renderResults();
    refreshOverlays();
  }

  async function refreshOverlays() {
    for (const id of [...overlays.keys()]) if (!state.overlay.has(id)) overlays.delete(id);
    for (const id of state.overlay) {
      try {
        const v = await data.ensure(id);
        const indices = population(v, store.ws, gateId);
        if (indices === undefined) throw new Error('the population does not apply');
        overlays.set(id, { name: v.record.name, result: analyze(v, indices).result });
      } catch (e) {
        overlays.set(id, { name: store.ws.samples.find((s) => s.id === id)?.name ?? id, error: e.message });
      }
    }
    chart.redraw();
  }

  function buildChart(width, height, colors) {
    const items = [];
    const hits = [];
    if (!result) {
      items.push({ t: 'text', x: width / 2, y: height / 2, text: error ?? 'No curve yet', fill: colors.text3, size: 12, align: 'center' });
      return { items, hits };
    }
    const overlaid = [...overlays.values()].filter((o) => o.result);
    const aligned = overlaid.length > 0 && result.stimulus;
    const rect = { x: 64, y: 22, w: width - 64 - 16, h: height - 22 - 48 - 92 };
    const strip = { x: rect.x, y: rect.y + rect.h + 14, w: rect.w, h: 64 };
    const shift = aligned ? result.stimulus.time : 0;
    const curves = aligned ? alignedCurves([{ name: store.ws.samples.find((s) => s.id === state.sampleId)?.name, result }, ...overlaid]) : [];
    let tlo = result.curve.centers[0] - result.binWidth / 2 - shift;
    let thi = result.curve.centers.at(-1) + result.binWidth / 2 - shift;
    for (const c of curves) {
      tlo = Math.min(tlo, c.centers[0]);
      thi = Math.max(thi, c.centers.at(-1));
    }
    let vlo = density.lo;
    let vhi = density.hi;
    for (const o of overlaid) for (const v of o.result.curve.smooth) if (Number.isFinite(v)) { vlo = Math.min(vlo, v); vhi = Math.max(vhi, v); }
    const x = valueScale(tlo, thi, rect.x, rect.x + rect.w, { target: 8 });
    const y = valueScale(vlo, vhi, rect.y + rect.h, rect.y, { target: 6 });
    leftAxis(items, y, rect, colors, result.label);
    // The pause and the stimulus.
    if (result.pause) {
      const a = x.map(result.pause.start - shift);
      const b = x.map(result.pause.end - shift);
      items.push({ t: 'rect', x: a, y: rect.y, w: Math.max(1, b - a), h: rect.h, fill: withAlpha(colors.text3, 0.1) });
    }
    if (!aligned) {
      // Event density behind the curve.
      const cw = rect.w / ((thi - tlo) / result.binWidth);
      for (let a = 0; a < density.tb; a += 1) {
        for (let b = 0; b < density.vb; b += 1) {
          const c = density.counts[a * density.vb + b];
          if (!c) continue;
          const t0 = density.start + a * result.binWidth;
          const v0 = density.lo + (b / density.vb) * (density.hi - density.lo);
          const v1 = density.lo + ((b + 1) / density.vb) * (density.hi - density.lo);
          items.push({ t: 'rect', x: x.map(t0), y: y.map(v1), w: Math.max(1, cw), h: Math.max(1, y.map(v0) - y.map(v1)), fill: withAlpha(colors.text3, 0.05 + 0.5 * Math.sqrt(c / density.max)) });
        }
      }
    }
    if (result.stimulus) {
      const sx = x.map(result.stimulus.time - shift);
      items.push({ t: 'line', x1: sx, y1: rect.y, x2: sx, y2: strip.y + strip.h, stroke: colors.text2, width: 1.2, dash: [4, 3] });
      items.push({ t: 'text', x: sx + 4, y: rect.y + 10, text: result.stimulus.source === 'onset' ? 'onset' : 'stimulus', fill: colors.text2, size: 10.5 });
    }
    // Baseline and threshold.
    const by = y.map(result.baseline);
    items.push({ t: 'line', x1: rect.x, y1: by, x2: rect.x + rect.w, y2: by, stroke: colors.text3, width: 1, dash: [2, 3] });
    items.push({ t: 'text', x: rect.x + rect.w - 4, y: by - 4, text: `baseline ${formatValue(result.baseline)}`, fill: colors.text3, size: 10, align: 'end' });
    if (!aligned) {
      const ty = y.map(result.threshold);
      items.push({ t: 'line', x1: rect.x, y1: ty, x2: rect.x + rect.w, y2: ty, stroke: withAlpha(colors.warn, 0.8), width: 1, dash: [1, 3] });
      items.push({ t: 'text', x: rect.x + 4, y: ty - 4, text: 'threshold', fill: colors.warn, size: 10 });
    }
    const curvePath = (centers, values, offset = 0, scale = y) => {
      const paths = [];
      let current = [];
      for (let b = 0; b < centers.length; b += 1) {
        if (Number.isFinite(values[b])) current.push([x.map(centers[b] - offset), scale.map(values[b])]);
        else if (current.length) {
          paths.push(current);
          current = [];
        }
      }
      if (current.length) paths.push(current);
      return paths;
    };
    if (aligned) {
      curves.forEach((c, k) => {
        for (const points of curvePath(c.centers, c.smooth)) items.push({ t: 'path', points, stroke: CATEGORICAL[k % CATEGORICAL.length], width: k === 0 ? 2.4 : 1.6 });
        items.push({ t: 'text', x: rect.x + rect.w - 8, y: rect.y + 12 + 15 * k, text: c.name, fill: CATEGORICAL[k % CATEGORICAL.length], size: 11, weight: k === 0 ? 700 : 500, align: 'end' });
      });
    } else {
      for (let b = 0; b < result.curve.centers.length; b += 1) {
        const v = result.curve.values[b];
        if (Number.isFinite(v)) items.push({ t: 'circle', x: x.map(result.curve.centers[b]), y: y.map(v), r: 1.6, fill: withAlpha(colors.accent, 0.45) });
      }
      for (const points of curvePath(result.curve.centers, result.curve.smooth)) items.push({ t: 'path', points, stroke: colors.accent, width: 2.2 });
      if (Number.isFinite(result.peak)) {
        const px = x.map(result.peakTime);
        const py = y.map(result.peak);
        items.push({ t: 'circle', x: px, y: py, r: 4, fill: colors.bg, stroke: colors.danger, width: 2 });
        items.push({ t: 'text', x: px + 6, y: py - 6, text: `peak ${formatValue(result.peak)} at +${result.timeToPeak.toFixed(1)} s`, fill: colors.danger, size: 10.5, weight: 600 });
      }
    }
    // Strip: the percentage of events above the threshold.
    const pmax = Math.max(5, ...[...result.percentCurve.smooth].filter(Number.isFinite));
    const py = valueScale(0, Math.min(100, pmax * 1.1), strip.y + strip.h, strip.y, { target: 2 });
    leftAxis(items, py, strip, colors, '% above');
    for (const points of curvePath(result.curve.centers, result.percentCurve.smooth, shift, py)) items.push({ t: 'path', points, stroke: aligned ? CATEGORICAL[0] : colors.warn, width: 1.6 });
    bottomAxis(items, x, strip, colors, aligned ? 'Seconds after the stimulus' : 'Time (s)');
    for (let b = 0; b < result.curve.centers.length; b += 1) {
      const c = result.curve.centers[b];
      hits.push({ x: x.map(c - shift), y: rect.y + rect.h / 2, r: 10000, data: { time: c, after: result.stimulus ? c - result.stimulus.time : null, count: result.curve.counts[b], value: result.curve.values[b], smooth: result.curve.smooth[b], percent: result.percentCurve.smooth[b] } });
    }
    return { items, hits };
  }

  function seconds(v) {
    return Number.isFinite(v) ? `${v.toFixed(1)} s` : '—';
  }

  function renderResults() {
    clear(results);
    const pane = h('div.pane', h('h3', icon('flask'), 'Response'));
    results.append(pane);
    if (error || !result) {
      pane.append(h('div.callout.danger', error ?? 'No curve.'));
      return;
    }
    const r = result;
    if (r.stimulus) {
      pane.append(h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(5, 1fr)' } },
        tile('Baseline', formatValue(r.baseline), `${r.statistic} before the stimulus`),
        tile('Peak', formatValue(r.peak), `${formatValue(r.fold)}× the baseline`),
        tile('Time to peak', seconds(r.timeToPeak), 'after the stimulus'),
        tile('Half-max time', seconds(r.halfMaxTime), 'baseline + half the amplitude'),
        tile('Responding', `${r.respondingNet.toFixed(1)}%`, `of events, at +${(r.respondingTime - r.stimulus.time).toFixed(0)} s`)),
      h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(5, 1fr)', marginTop: '8px' } },
        tile('Amplitude', formatValue(r.amplitude), 'peak − baseline'),
        tile('Area', formatValue(r.area), 'above the baseline, value × s'),
        tile('End level', formatValue(r.endLevel), 'last tenth of the window'),
        tile('Threshold', formatValue(r.threshold), `${r.baselineAbove.toFixed(1)}% of baseline events above`),
        tile('Events', formatCount(r.events), r.excluded ? `${formatCount(r.excluded)} left out` : 'all with a value')));
      if (!r.responded) pane.append(h('div.callout', { style: { marginTop: '8px' } }, icon('info'), h('span', 'No response: the peak is within the baseline\'s bin-to-bin variation.')));
    }
    pane.append(h('dl.kv', { style: { marginTop: '10px' } },
      h('dt', 'Stimulus'), h('dd', r.stimulus ? `${r.stimulus.time.toFixed(1)} s (${r.stimulus.source === 'pause' ? `acquisition paused until ${r.stimulus.resume.toFixed(1)} s` : r.stimulus.source === 'onset' ? 'the response\'s onset' : 'entered'})` : 'none found'),
      h('dt', 'Baseline'), h('dd', `${r.baselineWindow[0].toFixed(1)}–${r.baselineWindow[1].toFixed(1)} s, ${formatCount(r.baselineEvents)} events`),
      h('dt', 'Bins'), h('dd', `${r.binWidth} s, smoothed over ${r.smoothing} bin${r.smoothing > 1 ? 's' : ''}`)));
    for (const warning of r.warnings) pane.append(h('div.callout.warn', { style: { marginTop: '8px', fontSize: '12px' } }, warning));
  }

  function rowOf(sample, r) {
    return {
      sampleId: sample.id,
      sample: sample.name,
      events: r.events,
      stimulus: r.stimulus?.time ?? null,
      stimulusSource: r.stimulus?.source ?? null,
      baseline: r.baseline,
      peak: r.peak ?? null,
      timeToPeak: r.timeToPeak ?? null,
      halfMaxTime: r.halfMaxTime ?? null,
      amplitude: r.amplitude ?? null,
      fold: r.fold ?? null,
      area: r.area ?? null,
      endLevel: r.endLevel ?? null,
      responding: r.respondingNet ?? null,
      responded: r.responded ?? false,
      threshold: r.threshold,
      warnings: r.warnings,
    };
  }

  function record(rows) {
    const ws = store.ws;
    const measure = state.mode === 'ratio' ? `${channelLabel(ws, state.numerator, { short: true })} / ${channelLabel(ws, state.denominator, { short: true })}` : channelLabel(ws, state.channel, { short: true });
    return {
      id: `kinetics:${gateId}:${state.mode === 'ratio' ? `${state.numerator}/${state.denominator}` : state.channel}`,
      kind: 'kinetics',
      name: `Kinetics · ${gateId !== ROOT ? gateById(ws, gateId)?.name : 'All events'} · ${measure}`,
      method: `${state.statistic === 'mean' ? 'Mean' : 'Median'} per time bin, centered moving average; response against the baseline before the stimulus`,
      params: { gateId, mode: state.mode, numerator: state.numerator, denominator: state.denominator, channel: state.channel, ...options() },
      seed: null,
      outputs: [],
      version: app.version ?? null,
      summary: { rows },
    };
  }

  function saveCurrent() {
    if (!result) {
      toast('Nothing to save: there is no curve.', { kind: 'error' });
      return;
    }
    const sample = store.ws.samples.find((s) => s.id === state.sampleId);
    saveRecord(app, record([rowOf(sample, result)]), 'Kinetics');
    toast(`Saved the kinetics of ${sample.name}.`, { kind: 'ok' });
  }

  async function runBatch() {
    batch = await runAllSamples(app, gateId, (v, indices) => analyze(v, indices), 'Kinetics');
    renderBatch();
  }

  function renderBatch() {
    clear(batchHost);
    if (!batch) return;
    const ok = batch.filter((r) => r.result);
    const cell = (v, digits) => (Number.isFinite(v) ? (digits === undefined ? formatValue(v) : v.toFixed(digits)) : '—');
    const table = h('table.data', h('thead', h('tr', h('th', 'Sample'), h('th.r', 'Events'), h('th.r', 'Stimulus (s)'), h('th.r', 'Baseline'), h('th.r', 'Peak'), h('th.r', 'Time to peak (s)'), h('th.r', 'Half-max (s)'), h('th.r', 'Area'), h('th.r', 'Responding %'), h('th', 'Notes'))),
      h('tbody', ...batch.map((b) => (b.result
        ? h('tr', { style: { cursor: 'pointer' }, title: 'Show this sample', onclick: async () => { state.sampleId = b.sample.id; view = await data.ensure(b.sample.id); recompute(); } },
          h('td', b.sample.name), h('td.r', formatCount(b.result.events)), h('td.r', cell(b.result.stimulus?.time, 1)), h('td.r', cell(b.result.baseline)), h('td.r', cell(b.result.peak)),
          h('td.r', cell(b.result.timeToPeak, 1)), h('td.r', cell(b.result.halfMaxTime, 1)), h('td.r', cell(b.result.area)), h('td.r', cell(b.result.respondingNet, 1)),
          h('td', !b.result.responded ? h('span.badge', 'no response') : b.result.warnings.length ? h('span.badge.warn', { title: b.result.warnings.join('\n') }, `${b.result.warnings.length} note${b.result.warnings.length > 1 ? 's' : ''}`) : h('span.badge.ok', 'ok')))
        : h('tr', h('td', b.sample.name), h('td.muted', { colSpan: 9 }, b.error))))));
    const csv = () => downloadCSV([
      ['Sample', 'Events', 'Stimulus (s)', 'Stimulus source', 'Baseline', 'Peak', 'Time to peak (s)', 'Half-max time (s)', 'Amplitude', 'Fold', 'Area', 'End level', 'Responding (%)', 'Threshold'],
      ...ok.map((b) => { const r = rowOf(b.sample, b.result); return [r.sample, r.events, r.stimulus, r.stimulusSource, r.baseline, r.peak, r.timeToPeak, r.halfMaxTime, r.amplitude, r.fold, r.area, r.endLevel, r.responding, r.threshold]; }),
    ], 'kinetics.csv');
    batchHost.append(h('div.pane', h('h3', icon('table'), `All samples (${ok.length} of ${batch.length})`, h('span.spacer'),
      h('button.btn.small', { type: 'button', onclick: csv }, icon('download'), 'CSV'),
      h('button.btn.small', { type: 'button', onclick: () => { saveRecord(app, record(ok.map((b) => rowOf(b.sample, b.result))), 'Kinetics, all samples'); toast(`Saved the kinetics of ${ok.length} samples.`, { kind: 'ok' }); } }, icon('save'), 'Save all')),
      h('div', { style: { overflow: 'auto' } }, table)));
  }

  recompute();
}
