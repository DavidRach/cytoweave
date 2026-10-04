// QC → Titration: a reagent titration (samples that differ in the amount of one antibody) or a
// detector voltage walk (samples that differ in PMT voltage), analyzed on one channel within one
// population (lib/titration.js): stain and separation index per step, the recommended amount or
// voltage with the reason, and a figure for the panel's record. Results can be kept in the
// workspace, where the methods describe them.

import { h, icon, clear, downloadBlob } from './dom.js';
import { toast } from './overlays.js';
import { mountChart, chartColors, toSVG, paint, valueScale, leftAxis, bottomAxis, withAlpha, toCSV } from './charts.js';
import { ROOT, addDerived, gatePath, gateById } from '../lib/workspace.js';
import { REFERENCES, analyzeTitration, analyzeVoltageWalk, formatAmount, guessChannel, parseVoltage, stepsFrom, titrationRecord, titrationSeries, voltageSeries } from '../lib/titration.js';

const BINS = 120;
const sig = (v, n = 3) => (Number.isFinite(v) ? Number(v.toPrecision(n)).toLocaleString('en-US', { maximumSignificantDigits: n }) : '—');

// The voltage walk among samples, from the channels' voltages kept at import (or names): the
// channel whose voltage takes the most values, and the samples alone at their voltage (a walk has
// one file per voltage; a voltage many files share is the experiment's own setting).
export function detectWalk(samples) {
  const pick = (groups) => {
    const single = [...groups].filter(([, list]) => list.length === 1).map(([voltage, list]) => ({ sample: list[0], voltage }));
    const steps = single.length >= 3 ? single : [...groups].map(([voltage, list]) => ({ sample: list[0], voltage }));
    return steps.sort((a, b) => a.voltage - b.voltage);
  };
  const byChannel = new Map();
  for (const s of samples) {
    for (const c of s.channels ?? []) {
      if (c.type !== 'fluorescence' || !c.voltage) continue;
      if (!byChannel.has(c.name)) byChannel.set(c.name, new Map());
      const groups = byChannel.get(c.name);
      if (!groups.has(c.voltage)) groups.set(c.voltage, []);
      groups.get(c.voltage).push(s);
    }
  }
  let best = null;
  for (const [channel, groups] of byChannel) if (!best || groups.size > best.groups.size) best = { channel, groups };
  if (best && best.groups.size >= 3) return pick(best.groups);
  const named = new Map();
  for (const s of samples) {
    const voltage = parseVoltage(s.name);
    if (!voltage) continue;
    if (!named.has(voltage)) named.set(voltage, []);
    named.get(voltage).push(s);
  }
  return pick(named);
}

function histogram(scaled) {
  const counts = new Float64Array(BINS);
  for (const v of scaled) {
    const b = Math.floor(v * BINS);
    if (b >= 0 && b < BINS) counts[b] += 1;
  }
  // A light smoothing for display.
  const out = new Float64Array(BINS);
  for (let i = 0; i < BINS; i += 1) out[i] = (counts[i - 1] ?? counts[i]) * 0.25 + counts[i] * 0.5 + (counts[i + 1] ?? counts[i]) * 0.25;
  return Array.from(out);
}

// --- Charts (items for the screen and the exported figure) ---------------------------------------

// Tick labels far enough apart to read (a label every other step when they crowd).
function spaced(ticks, map, gap = 36) {
  let last = -Infinity;
  return ticks.map((t) => {
    const px = map(t.value);
    if (px - last < gap) return { ...t, label: '' };
    last = px;
    return t;
  });
}

function amountTicks(rows) {
  return rows.map((r) => ({ value: r.amount.value, label: r.amount.kind === 'mass' ? sig(r.amount.value, 3) : r.amount.label }));
}

// Stain index against amount: points, the fitted saturation curve over the steps it was fitted
// to, 90% of saturation and the recommended amount.
function titrationChart(result, rect, colors, items, hits) {
  const { analysis } = result;
  const rows = analysis.rows.filter((r) => Number.isFinite(r.stainIndex));
  const xs = analysis.rows.map((r) => r.amount.value);
  const x = valueScale(Math.min(...xs) / 1.4, Math.max(...xs) * 1.4, rect.x, rect.x + rect.w, { log: true });
  x.ticks = spaced(amountTicks(analysis.rows), x.map);
  const top = Math.max(...rows.map((r) => r.stainIndex), analysis.fit?.top ?? 0) * 1.1;
  const y = valueScale(0, top || 1, rect.y + rect.h, rect.y);
  leftAxis(items, y, rect, colors, 'Stain index');
  bottomAxis(items, x, rect, colors, analysis.rows[0]?.amount.kind === 'mass' ? 'Antibody per test (ng)' : 'Amount');
  if (analysis.fit) {
    const pts = [];
    const lo = Math.log(Math.min(...xs) / 1.4);
    const hi = Math.log(analysis.best.row.amount.value);
    for (let i = 0; i <= 80; i += 1) {
      const c = Math.exp(lo + ((hi - lo) * i) / 80);
      pts.push([x.map(c), y.map((analysis.fit.top * c) / (analysis.fit.k + c))]);
    }
    items.push({ t: 'path', points: pts, stroke: colors.text3, width: 1.2, dash: [4, 3] });
  }
  if (analysis.c90) {
    const cx = x.map(analysis.c90);
    if (cx >= rect.x && cx <= rect.x + rect.w) {
      items.push({ t: 'line', x1: cx, y1: rect.y, x2: cx, y2: rect.y + rect.h, stroke: colors.text3, width: 1, dash: [2, 3] });
      items.push({ t: 'text', x: cx + 3, y: rect.y + 10, text: `90% of saturation (${formatAmount(analysis.c90, analysis.rows[0].amount.kind)})`, fill: colors.text3, size: 10 });
    }
  }
  items.push({ t: 'path', points: rows.map((r) => [x.map(r.amount.value), y.map(r.stainIndex)]), stroke: colors.accent, width: 1.5 });
  for (const r of rows) {
    const recommended = analysis.recommended?.row === r;
    const px = x.map(r.amount.value);
    const py = y.map(r.stainIndex);
    items.push({ t: 'circle', x: px, y: py, r: recommended ? 6 : 3.5, fill: recommended ? colors.ok : r.resolved ? colors.accent : colors.bg, stroke: recommended ? colors.ok : colors.accent, width: 1.5 });
    hits.push({ x: px, y: py, r: 6, data: r });
  }
  if (analysis.recommended) {
    const r = analysis.recommended.row;
    items.push({ t: 'text', x: x.map(r.amount.value), y: y.map(r.stainIndex) - 11, text: `Recommended: ${r.amount.label}`, fill: colors.ok, size: 11, weight: 600, align: 'center' });
  }
}

// Negative cells' rSD against voltage, with the electronic noise, 2.5 times it, and the
// recommended range.
function walkChart(result, rect, colors, items, hits) {
  const { analysis } = result;
  const rows = analysis.rows.filter((r) => r.negative);
  const vs = analysis.rows.map((r) => r.voltage);
  const lo = Math.min(...vs) - 25;
  const hi = Math.max(...vs) + 25;
  const x = valueScale(lo, hi, rect.x, rect.x + rect.w, { nice: false });
  x.ticks = spaced(analysis.rows.map((r) => ({ value: r.voltage, label: String(r.voltage) })), x.map, 28);
  const rsds = rows.map((r) => r.negative.rsd).filter((v) => v > 0);
  const noise = analysis.noise?.rsdEN;
  const y = valueScale(Math.min(...rsds, noise ?? Infinity) / 1.5, Math.max(...rsds) * 1.5, rect.y + rect.h, rect.y, { log: true });
  leftAxis(items, y, rect, colors, "Negative cells' rSD");
  bottomAxis(items, x, rect, colors, 'PMT voltage (V)');
  if (analysis.minimum && analysis.maximum) {
    const a = Math.max(rect.x, x.map(analysis.minimum.voltage));
    const b = Math.min(rect.x + rect.w, x.map(analysis.maximum.voltage));
    if (b > a) items.push({ t: 'rect', x: a, y: rect.y, w: b - a, h: rect.h, fill: withAlpha(colors.ok, 0.1) });
  }
  if (noise) {
    for (const [k, label] of [[1, 'rSD_EN'], [2.5, '2.5 × rSD_EN']]) {
      const py = y.map(k * noise);
      items.push({ t: 'line', x1: rect.x, y1: py, x2: rect.x + rect.w, y2: py, stroke: k === 1 ? colors.text3 : colors.warn, width: 1, dash: [4, 3] });
      items.push({ t: 'text', x: rect.x + 4, y: py - 4, text: label, fill: k === 1 ? colors.text3 : colors.warn, size: 10 });
    }
  }
  // The minimum labeled to the left of its line, the maximum to the right.
  for (const [v, label, color, side] of [[analysis.minimum?.voltage, 'minimum', colors.ok, -1], [analysis.maximum?.voltage, 'maximum', colors.danger, 1]]) {
    if (!Number.isFinite(v)) continue;
    const px = x.map(v);
    if (px < rect.x || px > rect.x + rect.w) continue;
    items.push({ t: 'line', x1: px, y1: rect.y, x2: px, y2: rect.y + rect.h, stroke: color, width: 1.2 });
    items.push({ t: 'text', x: px + 3 * side, y: rect.y + 10, text: `${label} ${Math.round(v)} V`, fill: color, size: 10, weight: 600, align: side < 0 ? 'end' : 'start' });
  }
  items.push({ t: 'path', points: rows.map((r) => [x.map(r.voltage), y.map(r.negative.rsd)]), stroke: colors.accent, width: 1.5 });
  for (const r of rows) {
    const px = x.map(r.voltage);
    const py = y.map(r.negative.rsd);
    items.push({ t: 'circle', x: px, y: py, r: 3.5, fill: r.inRange === false ? colors.bg : colors.accent, stroke: colors.accent, width: 1.5 });
    hits.push({ x: px, y: py, r: 6, data: r });
  }
}

// One histogram per step, stacked, with the cut points between negative and positive cells.
function ridgeline(result, rect, colors, items) {
  const { analysis, hist } = result;
  const rows = analysis.rows;
  const n = rows.length;
  const rowH = rect.h / (n + 0.6);
  const labelW = 64;
  const x0 = rect.x + labelW;
  const w = rect.w - labelW;
  const recommendedIndex = result.mode === 'voltage' ? -1 : rows.indexOf(analysis.recommended?.row);
  for (let i = n - 1; i >= 0; i -= 1) {
    const counts = hist[i];
    const max = Math.max(...counts, 1);
    const base = rect.y + (n - i + 0.4) * rowH;
    const pts = counts.map((c, b) => [x0 + ((b + 0.5) / BINS) * w, base - (c / max) * rowH * 1.5]);
    const highlight = i === recommendedIndex;
    items.push({ t: 'path', points: [[x0, base], ...pts, [x0 + w, base]], close: true, fill: withAlpha(highlight ? colors.ok : colors.accent, highlight ? 0.35 : 0.18), stroke: highlight ? colors.ok : colors.accent, width: 1 });
    items.push({ t: 'text', x: x0 - 6, y: base - 3, text: rows[i].label, fill: highlight ? colors.ok : colors.text2, size: 10, weight: highlight ? 600 : 400, align: 'end' });
    for (const cut of [rows[i].cuts?.lower, rows[i].cuts?.upper]) {
      if (!Number.isFinite(cut)) continue;
      items.push({ t: 'line', x1: x0 + cut * w, y1: base - rowH * 0.9, x2: x0 + cut * w, y2: base, stroke: colors.text3, width: 1, dash: rows[i].estimated ? [2, 2] : null });
    }
  }
  items.push({ t: 'line', x1: x0, y1: rect.y + rect.h, x2: x0 + w, y2: rect.y + rect.h, stroke: colors.line, width: 1 });
  items.push({ t: 'text', x: x0 + w / 2, y: rect.y + rect.h + 16, text: `${result.channelLabel} (display scale)`, fill: colors.text2, size: 11, weight: 600, align: 'center' });
}

function headline(result) {
  const a = result.analysis;
  if (result.mode === 'voltage') {
    if (a.recommended) return `${result.channelLabel}: ${Math.round(a.minimum.voltage)}–${Math.round(a.maximum.voltage)} V; recommended ${a.recommended.voltage} V`;
    return `${result.channelLabel}: voltage walk`;
  }
  return `${result.channelLabel} titration${a.recommended ? `: recommended ${a.recommended.row.amount.label} per test` : ''}`;
}

// The figure for the panel's record: a title, the curve and the histograms side by side.
export function buildFigure(result, width, height, colors) {
  const items = [];
  const hits = [];
  items.push({ t: 'text', x: 16, y: 22, text: headline(result), fill: colors.text, size: 14, weight: 700 });
  items.push({ t: 'text', x: 16, y: 40, text: `${result.populationName} · ${result.analysis.rows.length} steps · ${new Date(result.at).toISOString().slice(0, 10)}`, fill: colors.text3, size: 11 });
  const plotTop = 64;
  const plotH = height - plotTop - 64;
  const left = { x: 70, y: plotTop, w: width * 0.5 - 90, h: plotH };
  const right = { x: width * 0.5 + 10, y: plotTop, w: width * 0.5 - 26, h: plotH };
  if (result.mode === 'voltage') walkChart(result, left, colors, items, hits);
  else titrationChart(result, left, colors, items, hits);
  ridgeline(result, right, colors, items);
  const cite = result.mode === 'voltage' ? 'Minimum: negative cells\' rSD = 2.5 × rSD_EN (Meinelt et al., BD technical bulletin 2012); maximum: positive cells\' 99th percentile within the linear range.' : 'Stain index (Maecker et al. 2004); recommended: at least 2 × the amount giving 90% of saturating staining (Bonilla et al. 2024).';
  items.push({ t: 'text', x: 16, y: height - 10, text: cite, fill: colors.text3, size: 10 });
  return { items, hits };
}

// --- Section -------------------------------------------------------------------------------------

// ctx: { app, rerender }. render(host) draws the section.
export function createTitrationSection(ctx) {
  const { app } = ctx;
  const { store, data } = app;
  const S = (app.qcState.titration ??= { mode: null, sampleIds: null, channel: null, populationId: null, rsdEN: '', linearMax: '', result: null, busy: false });
  let charts = [];

  const series = () => {
    const samples = store.ws.samples;
    return { titration: titrationSeries(samples), walk: detectWalk(samples) };
  };

  function defaultPopulation() {
    const lymph = store.ws.gates.find((g) => /lymph/i.test(g.name));
    return lymph?.id ?? ROOT;
  }

  async function run() {
    const ws = store.ws;
    const { titration, walk } = series();
    const mode = S.mode;
    const pool = mode === 'voltage' ? walk : titration.steps;
    const chosen = pool.filter((x) => !S.sampleIds || S.sampleIds.includes(x.sample.id));
    if (chosen.length < 3) {
      toast('Choose at least three samples of the series.', { kind: 'warn' });
      return;
    }
    S.busy = true;
    ctx.rerender();
    try {
      const views = new Map();
      for (const x of chosen) views.set(x.sample.id, await data.ensure(x.sample.id));
      const channel = S.channel ?? guessChannel(ws, chosen.map((x) => x.sample), views, mode);
      if (!channel) throw new Error('The samples have no fluorescence channel.');
      S.channel = channel;
      const populationId = S.populationId ?? defaultPopulation();
      let items;
      if (mode === 'voltage') {
        // The channel's own $PnV in each file decides the voltage.
        items = voltageSeries(chosen.map((x) => x.sample), views, channel).map(({ sample, voltage }) => ({ sample, view: views.get(sample.id), label: `${voltage} V`, voltage }));
      } else items = chosen.map(({ sample, amount }) => ({ sample, view: views.get(sample.id), label: amount.label, amount }));
      const steps = stepsFrom(ws, items, { channel, populationId });
      if (steps.some((s) => !s.linear.length)) throw new Error('The population has no events in some of the samples.');
      const options = { rsdEN: Number(S.rsdEN) > 0 ? Number(S.rsdEN) : undefined, linearMax: Number(S.linearMax) > 0 ? Number(S.linearMax) : undefined };
      const analysis = mode === 'voltage' ? analyzeVoltageWalk(steps, options) : analyzeTitration(steps);
      const info = ws.samples[0]?.channels.find((c) => c.name === channel);
      S.result = {
        mode,
        channel,
        marker: info?.marker || null,
        channelLabel: info?.marker ? `${info.marker} (${channel})` : channel,
        populationId,
        populationName: populationId === ROOT ? 'All events' : gatePath(ws, populationId),
        sampleIds: items.map((x) => x.sample.id),
        options,
        analysis,
        hist: steps.map((s) => histogram(s.scaled)),
        at: Date.now(),
      };
    } catch (error) {
      toast(`The ${mode === 'voltage' ? 'voltage walk' : 'titration'} could not be analyzed: ${error.message}`, { kind: 'error' });
    } finally {
      S.busy = false;
      ctx.rerender();
    }
  }

  function save() {
    const r = S.result;
    const record = titrationRecord(r.analysis, { mode: r.mode, channel: r.channel, marker: r.marker, population: r.populationName, sampleIds: r.sampleIds, params: r.options });
    store.commit(addDerived(store.ws, record).ws, `Save the ${r.mode === 'voltage' ? 'voltage walk' : 'titration'} of ${r.channelLabel}`, ['derived']);
    toast('Saved in the workspace; the methods describe it.', { kind: 'ok' });
  }

  function exportFigure(kind) {
    const r = S.result;
    const colors = chartColors({ export: true });
    const width = 980;
    const height = 460;
    const { items } = buildFigure(r, width, height, colors);
    const base = `${r.mode === 'voltage' ? 'voltage-walk' : 'titration'}_${(r.marker ?? r.channel).replace(/[^\w.+-]+/g, '_')}`;
    if (kind === 'svg') {
      downloadBlob(new Blob([toSVG(items, width, height, colors)], { type: 'image/svg+xml' }), `${base}.svg`);
      return;
    }
    const scale = 3;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const g = canvas.getContext('2d');
    g.scale(scale, scale);
    g.fillStyle = colors.bg;
    g.fillRect(0, 0, width, height);
    paint(g, items, colors);
    canvas.toBlob((blob) => downloadBlob(blob, `${base}.png`), 'image/png');
  }

  function exportCSV() {
    const r = S.result;
    const voltage = r.mode === 'voltage';
    const rows = [[voltage ? 'Voltage (V)' : 'Amount', 'Positive median', 'Positive rSD', 'Positive P99', 'Negative median', 'Negative rSD', 'Negative P84', 'Stain index', 'Separation index', '% positive', 'Resolved']];
    for (const x of r.analysis.rows) rows.push([voltage ? x.voltage : x.amount.label, x.positive?.median, x.positive?.rsd, x.positive?.p99, x.negative?.median, x.negative?.rsd, x.negative?.p84, x.stainIndex, x.separationIndex, Number.isFinite(x.fraction) ? 100 * x.fraction : null, x.resolved ? 'yes' : x.estimated ? 'estimated' : 'no']);
    downloadBlob(new Blob([toCSV(rows)], { type: 'text/csv' }), `${voltage ? 'voltage-walk' : 'titration'}_${(r.marker ?? r.channel).replace(/[^\w.+-]+/g, '_')}.csv`);
  }

  function controls(found) {
    const pane = h('div.pane');
    const ws = store.ws;
    if (!S.mode) S.mode = found.titration.steps.length >= 3 || found.walk.length < 3 ? 'titration' : 'voltage';
    const voltage = S.mode === 'voltage';
    pane.append(h('h3', icon('flask'), 'Titration and voltage walk'),
      h('p.qc-explain', voltage
        ? 'The same cells acquired at a series of PMT voltages. At low voltages the negative cells\' spread is the detector\'s electronic noise; the minimum voltage is where it reaches 2.5 times that noise, and the maximum keeps the brightest cells within the detector\'s linear range. The voltage of each file is read from its $PnV keyword.'
        : 'The same cells stained with a series of amounts of one antibody. At each step the stain index compares the positive cells with the negative ones; it rises until the antigen is saturated, then levels off or falls as unbound antibody raises the background. Amounts are read from the file names ("125 ng", "1:200", "2.5 uL") or an "amount" annotation.'));
    const mode = h('div.segmented',
      h(`button${!voltage ? '.active' : ''}`, { type: 'button', onclick: () => { S.mode = 'titration'; S.sampleIds = null; S.result = null; ctx.rerender(); } }, 'Titration'),
      h(`button${voltage ? '.active' : ''}`, { type: 'button', onclick: () => { S.mode = 'voltage'; S.sampleIds = null; S.result = null; ctx.rerender(); } }, 'Voltage walk'));
    const fluorescence = (ws.samples[0]?.channels ?? []).filter((c) => c.type === 'fluorescence');
    if (!S.populationId || (S.populationId !== ROOT && !gateById(ws, S.populationId))) S.populationId = defaultPopulation();
    pane.append(h('div.qc-toolbar',
      h('div.field', h('span', 'Series'), mode),
      h('label.field', h('span', 'Channel'), h('select.input.small', { onchange: (event) => { S.channel = event.target.value || null; } },
        h('option', { value: '' }, 'Detect from the data'),
        fluorescence.map((c) => h('option', { value: c.name, selected: c.name === S.channel }, c.marker ? `${c.marker} · ${c.name}` : c.name)))),
      h('label.field', { title: 'Positive and negative cells are found within this population: gate the cells that carry the antigen and those that do not (for example lymphocytes), without debris and doublets' }, h('span', 'Within'), h('select.input.small', { onchange: (event) => { S.populationId = event.target.value; } },
        h('option', { value: ROOT, selected: S.populationId === ROOT }, 'All events'),
        ws.gates.filter((g) => g.type !== 'boolean').map((g) => h('option', { value: g.id, selected: g.id === S.populationId }, gatePath(ws, g.id))))),
      voltage ? h('label.field', { title: 'The detector\'s electronic noise rSD, from the cytometer\'s baseline report (BD CS&T: rSD_EN). Leave empty to estimate it from the walk.' }, h('span', 'rSD_EN'),
        h('input.input.small', { type: 'number', min: 0, step: 'any', value: S.rsdEN, placeholder: 'estimate', style: { width: '84px' }, onchange: (event) => { S.rsdEN = event.target.value; } })) : null,
      voltage ? h('label.field', { title: 'The top of the detector\'s linear range (BD CS&T: linearity maximum). Leave empty for 90% of the channel\'s range.' }, h('span', 'Linear max'),
        h('input.input.small', { type: 'number', min: 0, step: 'any', value: S.linearMax, placeholder: '90% of range', style: { width: '104px' }, onchange: (event) => { S.linearMax = event.target.value; } })) : null));
    const pool = voltage ? found.walk.map((x) => ({ sample: x.sample, value: `${x.voltage} V` })) : found.titration.steps.map((x) => ({ sample: x.sample, value: x.amount.label }));
    const picked = new Set(pool.filter((x) => !S.sampleIds || S.sampleIds.includes(x.sample.id)).map((x) => x.sample.id));
    pane.append(h('div.field-label', { style: { marginTop: '8px' } }, pool.length
      ? `${voltage ? 'Voltages' : 'Amounts'} found (${picked.size} of ${pool.length} chosen)`
      : voltage ? 'No voltage walk found: the files need different PMT voltages ($PnV) for a channel, or a voltage in their names ("450 V").' : 'No titration found: name the files with the amount ("CD4-PE 125 ng", "CD8 1-200") or annotate an "amount" field.'),
    h('div.qc-checks', pool.map((x) => h('label.check', { title: x.sample.fileName ?? x.sample.name },
      h('input', { type: 'checkbox', checked: picked.has(x.sample.id), onchange: (event) => { const ids = new Set(picked); if (event.target.checked) ids.add(x.sample.id); else ids.delete(x.sample.id); S.sampleIds = [...ids]; ctx.rerender(); } }),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, h('b', x.value), ` · ${x.sample.name}`)))));
    if (!voltage && found.titration.unstained.length) pane.append(h('p.muted.qc-small', `Unstained: ${found.titration.unstained.map((s) => s.name).join(', ')} (not a step; the negative cells of each step are its own).`));
    pane.append(h('div.btn-row', { style: { marginTop: '10px' } },
      h('button.btn.primary', { type: 'button', disabled: S.busy || picked.size < 3, onclick: run }, icon('play'), S.busy ? 'Analyzing…' : `Analyze ${picked.size} ${voltage ? 'voltages' : 'amounts'}`)));
    return pane;
  }

  function resultPane(r) {
    const pane = h('div.pane');
    const a = r.analysis;
    const voltage = r.mode === 'voltage';
    pane.append(h('h3', icon('target'), headline(r)));
    let reason;
    if (voltage) {
      reason = a.recommended
        ? `From ${Math.round(a.minimum.voltage)} V, where the negative cells' rSD reaches 2.5 times the electronic noise (rSD_EN ${sig(a.noise.rsdEN)}${a.noise.source === 'estimated' ? ', estimated from the walk' : ''}), to ${Math.round(a.maximum.voltage)} V, where the positive cells' 99th percentile reaches the top of the linear range. The signal grows as the voltage to the power ${a.exponent.toFixed(2)}. ${a.recommended.voltage} V, the lowest voltage in that range, keeps the most room for brighter cells; any voltage in it resolves the negative cells as well.`
        : null;
    } else if (a.recommended) {
      reason = `A saturation curve fitted to the stain index reaches 90% of its plateau at ${formatAmount(a.c90, a.rows[0].amount.kind)}; ${a.recommended.row.amount.label} is the first amount tested at or above twice that. The highest stain index is at ${a.best.row.amount.label} (${sig(a.best.row.stainIndex)}).`;
    }
    if (reason) pane.append(h('div.callout.accent', icon('sparkles'), h('span', reason)));
    for (const note of a.notes) pane.append(h('div.callout.warn', { style: { marginTop: '6px' } }, icon('warning'), h('span', note)));
    // Charts.
    const tooltip = (row) => [`${voltage ? `${row.voltage} V` : row.amount.label}: stain index ${sig(row.stainIndex)}, separation index ${sig(row.separationIndex)}`, h('br'), `positive median ${sig(row.positive?.median, 4)}, negative median ${sig(row.negative?.median, 4)}, rSD ${sig(row.negative?.rsd)}`];
    const curve = mountChart({ height: 280, tooltip, build: (w, hgt, colors) => { const items = []; const hits = []; const rect = { x: 64, y: 14, w: w - 84, h: hgt - 60 }; if (voltage) walkChart(r, rect, colors, items, hits); else titrationChart(r, rect, colors, items, hits); return { items, hits }; } });
    const ridges = mountChart({ height: Math.max(220, 26 * a.rows.length + 50), build: (w, hgt, colors) => { const items = []; ridgeline(r, { x: 8, y: 8, w: w - 24, h: hgt - 40 }, colors, items); return { items }; } });
    charts.push(curve, ridges);
    pane.append(h('div.qc-grid-2', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '12px', marginTop: '10px' } }, curve.el, ridges.el));
    if (voltage) {
      const si = mountChart({ height: 200, tooltip, build: (w, hgt, colors) => {
        const items = [];
        const hits = [];
        const rect = { x: 64, y: 12, w: w - 84, h: hgt - 56 };
        const rows = a.rows.filter((x) => Number.isFinite(x.stainIndex));
        const x = valueScale(Math.min(...a.rows.map((q) => q.voltage)) - 25, Math.max(...a.rows.map((q) => q.voltage)) + 25, rect.x, rect.x + rect.w, { nice: false });
        x.ticks = a.rows.map((q) => ({ value: q.voltage, label: String(q.voltage) }));
        const y = valueScale(0, Math.max(...rows.map((q) => q.stainIndex)) * 1.1 || 1, rect.y + rect.h, rect.y);
        leftAxis(items, y, rect, colors, 'Stain index');
        bottomAxis(items, x, rect, colors, 'PMT voltage (V)');
        items.push({ t: 'path', points: rows.map((q) => [x.map(q.voltage), y.map(q.stainIndex)]), stroke: colors.accent, width: 1.5 });
        for (const q of rows) {
          items.push({ t: 'circle', x: x.map(q.voltage), y: y.map(q.stainIndex), r: 3.5, fill: q.inRange === false ? colors.bg : colors.accent, stroke: colors.accent, width: 1.5 });
          hits.push({ x: x.map(q.voltage), y: y.map(q.stainIndex), r: 6, data: q });
        }
        return { items, hits };
      } });
      charts.push(si);
      pane.append(h('div.field-label', { style: { marginTop: '8px' } }, 'Stain index (open circles: positive cells beyond the linear range)'), si.el);
    }
    pane.append(h('p.muted.qc-small', voltage
      ? 'Shaded: the voltage range. Each histogram is one voltage on the channel\'s display scale; ticks mark where the negative and positive cells were divided.'
      : 'Dashed: the saturation curve fitted to the steps up to the highest stain index. Open circles: steps whose positive and negative cells overlap, divided by the shares the other steps have. Each histogram is one amount; ticks mark the division.'));
    // Table.
    const head = h('tr', h('th', voltage ? 'Voltage' : 'Amount'), h('th.r', 'Positive median'), h('th.r', voltage ? 'Positive P99' : '% positive'), h('th.r', 'Negative median'), h('th.r', 'Negative rSD'), h('th.r', 'Stain index'), h('th.r', 'Separation index'), h('th', ''));
    const body = h('tbody', a.rows.map((x) => {
      const recommended = voltage ? false : a.recommended?.row === x;
      return h(`tr${recommended ? '.selected' : ''}`,
        h('td', { style: { whiteSpace: 'nowrap' } }, voltage ? `${x.voltage} V` : x.amount.label),
        h('td.r', sig(x.positive?.median, 4)),
        h('td.r', voltage ? sig(x.positive?.p99, 4) : Number.isFinite(x.fraction) ? `${(100 * x.fraction).toFixed(1)}%` : '—'),
        h('td.r', sig(x.negative?.median, 4)),
        h('td.r', sig(x.negative?.rsd)),
        h('td.r', sig(x.stainIndex)),
        h('td.r', sig(x.separationIndex)),
        h('td', x.estimated ? h('span.badge.warn', { title: 'Positive and negative cells overlap at this step' }, 'overlap') : voltage && x.inRange === false ? h('span.badge.danger', 'beyond linear range') : recommended ? h('span.badge.ok', 'recommended') : null));
    }));
    pane.append(h('div.qc-table-scroll', { tabIndex: 0, style: { maxHeight: '320px', marginTop: '10px' } }, h('table.data', h('thead', head), body)),
      h('p.muted.qc-small', `Within ${r.populationName}, on linear values. Stain index = (median⁺ − median⁻) / (2 × rSD⁻); separation index = (median⁺ − median⁻) / ((P84⁻ − median⁻) / 0.995); rSD = (P84.13 − P15.87) / 2, FACSDiva's robust SD (FlowJo's Robust SD is 1.4826 × the median absolute deviation, which differs for skewed populations).`),
      h('div.btn-row', { style: { marginTop: '10px' } },
        h('button.btn', { type: 'button', onclick: save, title: 'Keep the result in the workspace; the methods describe it' }, icon('save'), 'Save in the workspace'),
        h('button.btn.ghost', { type: 'button', onclick: () => exportFigure('svg') }, icon('download'), 'Figure (SVG)'),
        h('button.btn.ghost', { type: 'button', onclick: () => exportFigure('png') }, icon('download'), 'Figure (PNG)'),
        h('button.btn.ghost', { type: 'button', onclick: exportCSV }, icon('download'), 'CSV')));
    return pane;
  }

  function savedPane() {
    const saved = store.ws.derived.filter((d) => d.kind === 'titration');
    if (!saved.length) return null;
    return h('div.pane', h('h3', icon('save'), 'Saved in this workspace'),
      h('ul', { style: { margin: '4px 0 0 18px', fontSize: '12.5px' } }, saved.map((d) => h('li', `${d.name}: `, d.mode === 'voltage'
        ? (Number.isFinite(d.summary?.recommended) ? `${Math.round(d.summary.minimum)}–${Math.round(d.summary.maximum)} V, ${d.summary.recommended} V chosen` : 'no voltage range')
        : (d.summary?.recommended ? `${d.summary.recommended} recommended (90% of saturation at ${d.summary.c90})` : 'no recommendation'), d.population ? ` · within ${d.population}` : ''))));
  }

  function render(host) {
    for (const c of charts) c.destroy();
    charts = [];
    clear(host);
    const found = series();
    host.append(controls(found));
    if (S.result && S.result.mode === S.mode) host.append(resultPane(S.result));
    const saved = savedPane();
    if (saved) host.append(saved);
    host.append(h('div.pane', h('div.qc-cite', h('div', `Stain index: ${REFERENCES.stainIndex}`), h('div', `Separation index: ${REFERENCES.separationIndex}`), h('div', `Titration: ${REFERENCES.titration}`), h('div', `Voltage: ${REFERENCES.voltage}`))));
  }

  return { render };
}
