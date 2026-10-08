// QC → Instrument: detector efficiency Q, optical background B and the intrinsic CV of
// multi-level beads or LED pulses (lib/qb.js, as flowQB computes them), and Levey–Jennings charts
// of an instrument across runs. Runs measured here are kept in the workspace (one derived record
// per instrument) and can be saved to the instrument's record in the library, which follows it
// across experiments.

import { h, icon, clear, downloadBlob } from './dom.js';
import { progressToast, toast } from './overlays.js';
import { addDerived } from '../lib/workspace.js';
import { WorkspaceChangedError } from './store.js';
import { BEAD_PRODUCTS, REJECT_RULES } from '../lib/qb.js';
import { INSTRUMENT_RECORDS, LJ_METRICS, beadRun, fluorescenceChannels, instrumentOf, ljSeries, mergeRuns, runFlags, seriesRun, withRun } from '../lib/instrument-record.js';

const CITE = 'Q and B: Parks DR, El Khettabi F, Chase E, et al. Evaluating flow cytometer performance with weighted quadratic least squares analysis of LED and multi-level bead data. Cytometry A 2017;91(3):232–249, doi:10.1002/cyto.a.23052; as implemented in flowQB (Spidlen et al.).';

const METRIC_NAMES = { Q: 'Q', B: 'B', level: 'bead level' };
const sig = (v, n = 3) => (Number.isFinite(v) ? Number(v.toPrecision(n)).toLocaleString('en-US', { maximumSignificantDigits: n }) : '—');
const dateLabel = (iso) => (iso ? iso.slice(0, 10) : 'undated');

const SUPERSCRIPT = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const power = (t) => `10${String(Math.round(Math.log10(t))).split('').map((ch) => SUPERSCRIPT[ch]).join('')}`;

function niceLogTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e += 1) out.push(10 ** e);
  return out.filter((t) => t >= lo / 1.001 && t <= hi * 1.001);
}

// Mounts nothing permanent: render(host) draws the section into host. ctx: { app, chart (height,
// draw) → canvas, colors () → palette, alpha, rerender }.
export function createInstrumentSection(ctx) {
  const { app } = ctx;
  const { store, data, library } = app;
  const S = (app.qcState.instrument ??= {
    mode: 'beads',
    product: 'spherotech-8',
    peaks: 8,
    sampleIds: null,
    heights: false,
    runId: null,
    channel: null,
    ljChannel: null,
    ljMetric: 'Q',
    baseline: 20,
    library: new Map(), // instrument id → record (or null when none), loaded once
    busy: false,
  });

  const records = () => store.ws.derived.filter((d) => d.kind === 'instrument-qc');
  const beadSamples = () => store.ws.samples.filter((s) => s.role === 'bead');
  const chosenSamples = () => {
    const pool = S.sampleIds ? store.ws.samples.filter((s) => S.sampleIds.includes(s.id)) : beadSamples();
    return pool.filter((s) => s.channels.some((c) => c.type === 'fluorescence'));
  };

  async function libraryRecord(instrument) {
    if (S.library.has(instrument.id)) return S.library.get(instrument.id);
    S.library.set(instrument.id, null);
    try {
      const record = await library.getRecord?.(INSTRUMENT_RECORDS, instrument.id);
      S.library.set(instrument.id, record ?? null);
      if (record) ctx.rerender();
    } catch {
      S.library.set(instrument.id, null);
    }
    return S.library.get(instrument.id);
  }

  // --- Measuring ---------------------------------------------------------------------------------

  async function measure() {
    const samples = chosenSamples();
    if (!samples.length || S.busy) return;
    S.busy = true;
    let canceled = false;
    const progress = progressToast(`Measuring Q and B on ${samples.length} file${samples.length === 1 ? '' : 's'}…`, () => { canceled = true; });
    const sameWorkspace = store.sameWorkspace();
    const byInstrument = new Map();
    try {
      const add = (instrument, run) => {
        const list = byInstrument.get(instrument.id) ?? { instrument, runs: [] };
        list.runs.push(run);
        byInstrument.set(instrument.id, list);
      };
      if (S.mode === 'series') {
        const items = [];
        for (const [i, sample] of samples.entries()) {
          if (canceled) throw new Error('Canceled.');
          items.push({ sample, view: await data.ensure(sample.id) });
          progress.update((i + 1) / (samples.length + 1), `Reading ${sample.name}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        add(instrumentOf(samples[0].keywords), seriesRun(items, { channels: fluorescenceChannels(samples[0], { heights: S.heights }) }));
      } else {
        for (const [i, sample] of samples.entries()) {
          if (canceled) throw new Error('Canceled.');
          progress.update(i / samples.length, `Fitting ${sample.name}`);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const view = await data.ensure(sample.id);
          const product = BEAD_PRODUCTS.find((p) => p.id === S.product);
          add(instrumentOf(sample.keywords), beadRun(view, sample, { peaks: S.peaks, product: product?.label ?? null, channels: fluorescenceChannels(sample, { heights: S.heights }) }));
        }
      }
      if (!sameWorkspace()) throw new WorkspaceChangedError();
      let ws = store.ws;
      for (const { instrument, runs } of byInstrument.values()) {
        const id = `instrument-qc-${instrument.id}`;
        let record = ws.derived.find((d) => d.id === id) ?? { id, kind: 'instrument-qc', name: `Q and B of ${instrument.name}`, instrument, method: 'Parks 2017 weighted quadratic fit (flowQB)', runs: [] };
        for (const run of runs) record = withRun(record, run);
        ws = addDerived(ws, record).ws;
      }
      const total = [...byInstrument.values()].reduce((n, x) => n + x.runs.length, 0);
      store.commit(ws, `Measure Q and B (${total} run${total === 1 ? '' : 's'})`, ['derived']);
      S.runId = [...byInstrument.values()].at(-1).runs.at(-1).id;
      progress.done(`Measured ${total} run${total === 1 ? '' : 's'}.`);
    } catch (error) {
      progress.fail(error.message);
    } finally {
      S.busy = false;
      ctx.rerender();
    }
  }

  async function saveToLibrary(record) {
    if (!library.putRecord) return;
    try {
      let doc = (await library.getRecord(INSTRUMENT_RECORDS, record.instrument.id)) ?? { name: record.instrument.name, instrument: record.instrument, runs: [] };
      for (const run of record.runs) doc = withRun(doc, { ...run, workspace: store.ws.name });
      await library.putRecord(INSTRUMENT_RECORDS, record.instrument.id, doc);
      S.library.set(record.instrument.id, doc);
      toast(`Saved ${record.runs.length} run${record.runs.length === 1 ? '' : 's'} to the record of ${record.instrument.name} (${doc.runs.length} in all).`, { kind: 'ok' });
      ctx.rerender();
    } catch (error) {
      toast(`The record could not be saved: ${error.message}`, { kind: 'error' });
    }
  }

  function exportCSV(runs) {
    const channels = [...new Set(runs.flatMap((r) => Object.keys(r.channels)))];
    const rows = [['date', 'file', 'source', 'detector', 'Q', 'Q_SE', 'B', 'B_SE', 'CV0', 'peaks_used', 'bright_median', 'bright_rCV'].join(',')];
    for (const r of runs) for (const ch of channels) {
      const c = r.channels[ch];
      if (!c) continue;
      rows.push([dateLabel(r.date), JSON.stringify(r.file), r.source ?? '', JSON.stringify(ch), c.Q ?? '', c.se?.Q ?? '', c.B ?? '', c.se?.B ?? '', c.CV0 ?? '', c.used, c.bright?.median ?? '', c.bright?.rcv ?? ''].join(','));
    }
    downloadBlob(new Blob([`${rows.join('\n')}\n`], { type: 'text/csv' }), 'instrument-qb.csv');
  }

  // --- Charts ------------------------------------------------------------------------------------

  // Peak variance against peak mean, log–log, with the fitted model and its three terms.
  function varianceChart(channel) {
    return ctx.chart(240, (g, w, hgt, c) => {
      const pts = channel.peaks.filter((p) => p.mean > 0 && p.sd > 0);
      if (!pts.length) return;
      const pad = { l: 44, r: 12, t: 10, b: 30 };
      const xs = pts.map((p) => p.mean);
      const ys = pts.map((p) => p.sd * p.sd);
      const [x0, x1] = [Math.min(...xs) / 1.5, Math.max(...xs) * 1.5];
      const [y0, y1] = [Math.min(...ys, channel.c?.[0] ?? Infinity) / 2, Math.max(...ys) * 2];
      const X = (v) => pad.l + ((Math.log10(v) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0))) * (w - pad.l - pad.r);
      const Y = (v) => hgt - pad.b - ((Math.log10(v) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0))) * (hgt - pad.t - pad.b);
      g.font = '11px system-ui, sans-serif';
      g.strokeStyle = c.line;
      g.fillStyle = c.text3;
      g.lineWidth = 1;
      for (const t of niceLogTicks(x0, x1)) {
        g.beginPath(); g.moveTo(X(t), pad.t); g.lineTo(X(t), hgt - pad.b); g.stroke();
        g.textAlign = 'center'; g.fillText(power(t), X(t), hgt - pad.b + 14);
      }
      for (const t of niceLogTicks(y0, y1)) {
        g.beginPath(); g.moveTo(pad.l, Y(t)); g.lineTo(w - pad.r, Y(t)); g.stroke();
        g.textAlign = 'right'; g.fillText(power(t), pad.l - 4, Y(t) + 4);
      }
      g.textAlign = 'center';
      g.fillText('Peak mean', (pad.l + w - pad.r) / 2, hgt - 4);
      g.save(); g.translate(12, (pad.t + hgt - pad.b) / 2); g.rotate(-Math.PI / 2); g.fillText('Peak variance', 0, 0); g.restore();
      if (channel.c) {
        const [c0, c1, c2] = channel.c;
        const curve = (f, color, dash) => {
          g.strokeStyle = color; g.setLineDash(dash); g.lineWidth = dash.length ? 1 : 2;
          g.beginPath();
          let started = false;
          for (let i = 0; i <= 120; i += 1) {
            const m = x0 * (x1 / x0) ** (i / 120);
            const v = f(m);
            if (!(v > 0)) { started = false; continue; }
            const y = Math.max(pad.t, Math.min(hgt - pad.b, Y(v)));
            if (started) g.lineTo(X(m), y); else { g.moveTo(X(m), y); started = true; }
          }
          g.stroke(); g.setLineDash([]);
        };
        curve(() => c0, ctx.alpha(c.text3, 0.8), [3, 3]);
        curve((m) => c1 * m, ctx.alpha(c.accent, 0.6), [3, 3]);
        if (c2 > 0) curve((m) => c2 * m * m, ctx.alpha(c.warn, 0.7), [3, 3]);
        curve((m) => c0 + c1 * m + c2 * m * m, c.accent, []);
      }
      for (const p of channel.peaks) {
        if (!(p.mean > 0 && p.sd > 0)) continue;
        g.beginPath(); g.arc(X(p.mean), Y(p.sd * p.sd), 4, 0, 2 * Math.PI);
        if (p.omit) { g.strokeStyle = c.text3; g.lineWidth = 1.5; g.stroke(); } else { g.fillStyle = c.text; g.fill(); }
      }
    });
  }

  function ljChart(runs, series, metric) {
    return ctx.chart(220, (g, w, hgt, c) => {
      const pad = { l: 60, r: 14, t: 10, b: 34 };
      const vals = series.values.filter((v) => v !== null);
      if (!vals.length) return;
      const sd = series.sd > 0 ? series.sd : Math.abs(series.mean) * 0.05 || 1;
      const lo = Math.min(...vals, series.mean - 3.5 * sd);
      const hi = Math.max(...vals, series.mean + 3.5 * sd);
      const n = runs.length;
      const X = (i) => pad.l + (n === 1 ? 0.5 : i / (n - 1)) * (w - pad.l - pad.r);
      const Y = (v) => hgt - pad.b - ((v - lo) / (hi - lo || 1)) * (hgt - pad.t - pad.b);
      g.font = '11px system-ui, sans-serif';
      // Baseline runs, shaded.
      if (series.n > 0 && n > 1) {
        const baseEnd = runs.findIndex((_, i) => series.values.slice(0, i + 1).filter((v) => v !== null).length >= series.n);
        g.fillStyle = ctx.alpha(c.accent, 0.06);
        g.fillRect(pad.l, pad.t, X(Math.max(0, baseEnd)) - pad.l + 4, hgt - pad.t - pad.b);
      }
      // When the runs span many SDs, label only the mean and ±3 SD.
      const crowded = Math.abs(Y(series.mean + sd) - Y(series.mean)) < 12;
      for (const k of [-3, -2, -1, 0, 1, 2, 3]) {
        const y = Y(series.mean + k * sd);
        g.strokeStyle = k === 0 ? c.text2 : Math.abs(k) === 3 ? ctx.alpha(c.danger, 0.7) : Math.abs(k) === 2 ? ctx.alpha(c.warn, 0.7) : c.line;
        g.setLineDash(k === 0 ? [] : [4, 3]);
        g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
        g.setLineDash([]);
        g.fillStyle = c.text3; g.textAlign = 'right';
        if (!crowded || k === 0 || Math.abs(k) === 3) g.fillText(k === 0 ? sig(series.mean) : `${k > 0 ? '+' : '−'}${Math.abs(k)} SD`, pad.l - 4, y + 4);
      }
      g.strokeStyle = c.text2; g.lineWidth = 1;
      g.beginPath();
      let started = false;
      series.values.forEach((v, i) => {
        if (v === null) { started = false; return; }
        if (started) g.lineTo(X(i), Y(v)); else { g.moveTo(X(i), Y(v)); started = true; }
      });
      g.stroke();
      series.values.forEach((v, i) => {
        if (v === null) return;
        const rules = series.flags[i].rules;
        g.fillStyle = rules.some((r) => REJECT_RULES.has(r)) ? c.danger : rules.length ? c.warn : runs[i].source === 'library' ? c.text3 : c.accent;
        g.beginPath(); g.arc(X(i), Y(v), runs[i].id === S.runId ? 5 : 3.5, 0, 2 * Math.PI); g.fill();
      });
      g.fillStyle = c.text3; g.textAlign = 'center';
      const step = Math.max(1, Math.ceil(n / 8));
      for (let i = 0; i < n; i += step) g.fillText(dateLabel(runs[i].date).slice(5), X(i), hgt - pad.b + 14);
      g.fillText(metric.label, (pad.l + w - pad.r) / 2, hgt - 4);
      return { X, n };
    });
  }

  // --- Rendering ---------------------------------------------------------------------------------

  function controls() {
    const pane = h('div.pane');
    const beads = beadSamples();
    const chosen = chosenSamples();
    pane.append(h('h3', icon('gauge'), 'Instrument characterization'),
      h('p.qc-explain', 'How many photoelectrons a detector collects per unit of signal (', h('b', 'Q'), ') and how much background light and electronic noise it adds (', h('b', 'B'), ', in photoelectrons) decide how dim a population it can resolve. Both come from the spread of peaks of known uniformity: the variance of each peak grows with its mean as c0 + c1·mean + c2·mean², so Q = 1/c1, B = c0/c1² and the beads\' intrinsic CV is √c2. Use multi-level beads (one tube with several intensities, such as 8-peak rainbow beads) or a series of files with one level each (an LED pulser). The data are used raw, without compensation.'));
    const product = BEAD_PRODUCTS.find((p) => p.id === S.product) ?? BEAD_PRODUCTS[0];
    const mode = h('div.segmented',
      h(`button${S.mode === 'beads' ? '.active' : ''}`, { type: 'button', onclick: () => { S.mode = 'beads'; ctx.rerender(); } }, 'Multi-level beads'),
      h(`button${S.mode === 'series' ? '.active' : ''}`, { type: 'button', onclick: () => { S.mode = 'series'; ctx.rerender(); } }, 'One level per file'));
    pane.append(h('div.qc-toolbar',
      h('div.field', h('span', 'Data'), mode),
      S.mode === 'beads' ? h('label.field', h('span', 'Beads'), h('select.input.small', { onchange: (event) => { S.product = event.target.value; const p = BEAD_PRODUCTS.find((x) => x.id === S.product); if (p?.peaks) S.peaks = p.peaks; ctx.rerender(); } },
        BEAD_PRODUCTS.map((p) => h('option', { value: p.id, selected: p.id === product.id }, p.label)))) : null,
      S.mode === 'beads' ? h('label.field', { title: 'Number of intensity levels, including the blank' }, h('span', 'Levels'),
        h('input.input.small', { type: 'number', min: 3, max: 16, step: 1, value: S.peaks, style: { width: '64px' }, onchange: (event) => { const v = Math.round(Number(event.target.value)); if (v >= 3 && v <= 16) { S.peaks = v; S.product = BEAD_PRODUCTS.find((p) => p.peaks === v)?.id ?? 'other'; } ctx.rerender(); } })) : null,
      h('label.check', { title: 'Also characterize the height (-H) channels' }, h('input', { type: 'checkbox', checked: S.heights, onchange: (event) => { S.heights = event.target.checked; } }), h('span', 'Height channels too'))));
    const pool = S.mode === 'series' || !beads.length ? store.ws.samples : beads;
    const picked = new Set(chosen.map((s) => s.id));
    pane.append(h('div.field-label', { style: { marginTop: '8px' } }, S.mode === 'series' ? `Files of the series (${picked.size}), one level each` : `Bead files (${picked.size})${beads.length ? '' : ' — no sample has the role "bead"; tick the bead files'}`),
      h('div.qc-checks', pool.map((s) => h('label.check', { title: s.fileName ?? s.name },
        h('input', { type: 'checkbox', checked: picked.has(s.id), onchange: (event) => { const ids = new Set(chosen.map((x) => x.id)); if (event.target.checked) ids.add(s.id); else ids.delete(s.id); S.sampleIds = [...ids]; ctx.rerender(); } }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name)))));
    const label = S.mode === 'series' ? `Measure the series (${picked.size} files)` : `Measure ${picked.size} bead file${picked.size === 1 ? '' : 's'}`;
    pane.append(h('div.btn-row', { style: { marginTop: '10px' } },
      h('button.btn.primary', { type: 'button', disabled: S.busy || picked.size < (S.mode === 'series' ? 3 : 1), onclick: measure }, icon('play'), label)));
    return pane;
  }

  function runsPane(record, runs) {
    const pane = h('div.pane');
    const lib = S.library.get(record.instrument.id);
    const fromLibrary = runs.filter((r) => r.source === 'library').length;
    pane.append(h('h3', icon('gauge'), record.instrument.name),
      h('p.qc-explain', `${record.runs.length} run${record.runs.length === 1 ? '' : 's'} measured in this workspace`, lib ? `, and ${fromLibrary} more from the instrument's record in the library` : '', '. Flags follow the Westgard rules against the mean and SD of the first runs (the baseline): one value beyond 3 SD, two beyond 2 SD on one side, a swing of 4 SD, four beyond 1 SD or ten on one side reject a run; one beyond 2 SD warns.'));
    const flagged = runs.map((_, i) => runFlags(runs, i, { baseline: S.baseline }));
    const body = h('tbody', runs.map((run, i) => {
      // Warnings (one value beyond 2 SD) are expected by chance on most runs among dozens of
      // detectors and metrics: the run table counts rejections only.
      const reject = flagged[i].filter((f) => f.rules.some((r) => REJECT_RULES.has(r)));
      const fitted = Object.values(run.channels).filter((c) => c.Q).length;
      return h(`tr${run.id === S.runId ? '.selected' : ''}`, { style: { cursor: 'pointer' }, onclick: () => { S.runId = run.id; ctx.rerender(); } },
        h('td', dateLabel(run.date)),
        h('td', { style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, run.file),
        h('td.r', `${fitted} of ${Object.keys(run.channels).length}`),
        h('td', reject.length
          ? h('span.badge.danger', { title: reject.map((f) => `${f.channel} ${METRIC_NAMES[f.metric]}: ${f.rules.join(', ')}`).join('\n') }, `${reject.length} out of control`)
          : h('span.badge.ok', 'In control')),
        h('td.muted', run.source === 'library' ? `library${run.workspace ? ` · ${run.workspace}` : ''}` : 'this workspace'));
    }));
    pane.append(h('div.qc-table-scroll', { tabIndex: 0, style: { maxHeight: '280px' } }, h('table.data', h('thead', h('tr', h('th', 'Date'), h('th', 'File'), h('th.r', 'Detectors fitted'), h('th', 'Levey–Jennings'), h('th', 'Source'))), body)),
      h('div.btn-row', { style: { marginTop: '10px' } },
        library.putRecord ? h('button.btn', { type: 'button', onclick: () => saveToLibrary(record), title: 'Keep these runs in the library\'s record of this instrument, to follow it across experiments' }, icon('library'), 'Save to the instrument\'s record') : null,
        h('button.btn.ghost', { type: 'button', onclick: () => exportCSV(runs) }, icon('download'), 'Export CSV'),
        h('label.field', { style: { marginLeft: 'auto' }, title: 'How many leading runs set the mean and SD' }, h('span', 'Baseline runs'),
          h('input.input.small', { type: 'number', min: 2, max: 100, value: S.baseline, style: { width: '64px' }, onchange: (event) => { const v = Math.round(Number(event.target.value)); if (v >= 2) S.baseline = v; ctx.rerender(); } }))));
    return pane;
  }

  function runPane(run, runs) {
    const pane = h('div.pane');
    const index = runs.findIndex((r) => r.id === run.id);
    const flags = index >= 0 ? runFlags(runs, index, { baseline: S.baseline }) : [];
    const channels = Object.keys(run.channels);
    if (!S.channel || !run.channels[S.channel]) S.channel = channels.find((ch) => run.channels[ch].Q) ?? channels[0];
    const body = h('tbody', channels.map((ch) => {
      const c = run.channels[ch];
      const f = flags.filter((x) => x.channel === ch);
      return h(`tr${ch === S.channel ? '.selected' : ''}`, { style: { cursor: 'pointer' }, onclick: () => { S.channel = ch; S.ljChannel = ch; ctx.rerender(); } },
        h('td', ch),
        h('td.r', c.Q ? `${sig(c.Q)} ± ${sig(c.se?.Q, 2)}` : '—'),
        h('td.r', c.B !== null ? `${sig(c.B)} ± ${sig(c.se?.B, 2)}` : '—'),
        h('td.r', c.CV0 !== null ? `${(100 * c.CV0).toFixed(2)}%` : '—'),
        h('td.r', `${c.used} of ${c.peaks.length}`),
        h('td.r', c.bright ? sig(c.bright.median, 4) : '—'),
        h('td.r', c.bright ? `${(100 * c.bright.rcv).toFixed(2)}%` : '—'),
        h('td', f.map((x) => h(`span.badge.${x.rules.some((r) => REJECT_RULES.has(r)) ? 'danger' : 'warn'}`, { style: { marginRight: '4px' }, title: x.rules.join(', ') }, `${METRIC_NAMES[x.metric]} ${x.z > 0 ? '↑' : '↓'}`))));
    }));
    pane.append(h('h3', icon('table'), `${dateLabel(run.date)} · ${run.file}`),
      h('p.qc-explain', run.method === 'beads' ? `${run.peaks} levels found by k-means on the logicle-scaled detectors after a scatter gate (${run.gated?.toLocaleString('en-US')} of ${run.events?.toLocaleString('en-US')} events). ` : `${run.peaks} files, one level each. `,
        `Each peak's mean and SD are those of a normal fitted to its central 80%; peaks with a mean above ${sig(run.bounds?.maximum)} or below ${sig(run.bounds?.minimum)} are left out (the detector's linear range). Q in photoelectrons per unit of signal, B in photoelectrons, ± standard errors of the fit.`),
      h('div.qc-table-scroll', { tabIndex: 0, style: { maxHeight: '330px' } }, h('table.data', h('thead', h('tr', h('th', 'Detector'), h('th.r', 'Q'), h('th.r', 'B'), h('th.r', 'Bead CV'), h('th.r', 'Peaks used'), h('th.r', 'Brightest peak'), h('th.r', 'rCV'), h('th', 'Flags'))), body)));
    const c = run.channels[S.channel];
    if (c) {
      const omitted = c.peaks.filter((p) => p.omit);
      pane.append(h('div.field-label', { style: { marginTop: '10px' } }, `${S.channel}: peak variance against mean`),
        varianceChart(c),
        h('p.muted.qc-small', 'The solid line is the fitted c0 + c1·mean + c2·mean²; dashed lines are its terms: background (flat), photoelectron counting (rising with the mean) and the beads\' own variation (rising with its square). Open circles are peaks left out', omitted.length ? ` (${omitted.map((p) => p.why).filter(Boolean).join('; ')})` : '', '.'));
    }
    return pane;
  }

  function ljPane(runs) {
    const pane = h('div.pane');
    const channels = [...new Set(runs.flatMap((r) => Object.keys(r.channels)))];
    if (!S.ljChannel || !channels.includes(S.ljChannel)) S.ljChannel = S.channel && channels.includes(S.channel) ? S.channel : channels[0];
    const metric = LJ_METRICS.find((m) => m.id === S.ljMetric) ?? LJ_METRICS[0];
    const series = ljSeries(runs, S.ljChannel, metric.id, { baseline: S.baseline });
    pane.append(h('h3', icon('histogram'), 'Levey–Jennings'),
      h('div.qc-toolbar',
        h('label.field', h('span', 'Detector'), h('select.input.small', { onchange: (event) => { S.ljChannel = event.target.value; ctx.rerender(); } }, channels.map((ch) => h('option', { value: ch, selected: ch === S.ljChannel }, ch)))),
        h('label.field', h('span', 'Metric'), h('select.input.small', { onchange: (event) => { S.ljMetric = event.target.value; ctx.rerender(); } }, LJ_METRICS.map((m) => h('option', { value: m.id, selected: m.id === metric.id }, m.label))))),
      runs.length < 3 ? h('p.muted', 'Measure at least three runs to follow the instrument.') : ljChart(runs, series, metric),
      h('p.muted.qc-small', `Mean ${sig(series.mean)} and SD ${sig(series.sd, 2)} from the first ${series.n} run${series.n === 1 ? '' : 's'} (shaded)${metric.level && series.level !== null ? `; bead level ${series.level + 1}, the brightest within the linear range in every run` : ''}. Red points break a rejection rule, amber ones warn; gray points come from the library.`));
    return pane;
  }

  function render(host) {
    clear(host);
    host.append(controls());
    const recs = records();
    if (!recs.length) {
      host.append(h('div.pane', h('div.empty', icon('gauge'), h('h3', 'No runs yet'), h('p', 'Measure bead files to see each detector\'s Q and B, and follow the instrument run by run. Try the example "Daily bead QC".'))));
    }
    for (const record of recs) {
      void libraryRecord(record.instrument);
      const lib = S.library.get(record.instrument.id);
      const runs = mergeRuns({ runs: record.runs, source: 'workspace' }, { runs: lib?.runs ?? [], source: 'library' });
      if (!runs.some((r) => r.id === S.runId)) S.runId = record.runs.at(-1)?.id ?? null;
      host.append(runsPane(record, runs));
      const run = runs.find((r) => r.id === S.runId);
      if (run) host.append(runPane(run, runs));
      host.append(ljPane(runs));
    }
    host.append(h('div.pane', h('div.qc-cite', h('div', CITE))));
  }

  return { render };
}
