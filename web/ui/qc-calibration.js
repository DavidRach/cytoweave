// QC → Calibration: fluorescence in calibrated units (MEF or ERF) from a multi-level bead sample
// (lib/calibration.js, as FlowCal computes them). The beads' levels are found, each level's
// median is matched to the value on the manufacturer's datasheet, a standard curve is fitted, and
// applied to the samples acquired with the same settings, where each calibrated channel appears as
// "<channel> <unit>" beside the original.

import { h, icon, clear } from './dom.js';
import { toast } from './overlays.js';
import { mountChart, valueScale, leftAxis, bottomAxis } from './charts.js';
import { ROOT, addDerived, gatePath, gateById } from '../lib/workspace.js';
import { newId } from '../lib/gates.js';
import { populationSet } from '../lib/engine.js';
import { EventSet } from '../lib/eventset.js';
import { UNITS, calibrateBeads, calibrationRecord, channelBounds, standardCurve } from '../lib/calibration.js';

const sig = (v, n = 4) => (Number.isFinite(v) ? Number(v.toPrecision(n)).toLocaleString('en-US', { maximumSignificantDigits: n }) : '—');

// "0, 792, 2079 …" (commas, spaces or tabs; "-", "blank" or "none" for a level without a value).
export function parseLevelValues(text) {
  return String(text ?? '').split(/[\s,;]+/).filter(Boolean).map((t) => (/^(-|–|blank|none|na|n\/a)$/i.test(t) ? null : Number(t.replace(/[^\d.eE+-]/g, ''))));
}

export function defaultUnit(channel, marker) {
  const text = `${channel} ${marker ?? ''}`.toUpperCase();
  if (/FITC|GFP|FL1\b|B530|488.*530|AF488|BB515/.test(text)) return 'MEFL';
  if (/\bPE-?CY7|PE.CY7/.test(text)) return 'MEPCY7';
  if (/\bPE-?CY5|PE.CY5|PERCP/.test(text)) return 'MECY';
  if (/TEXAS|PE-?CF594|ECD/.test(text)) return 'MEPTR';
  if (/\bPE\b|PE-A|PE-H|\bPE$/.test(text)) return 'MEPE';
  if (/\bAPC\b|APC-A|APC-H/.test(text)) return 'MEAPC';
  if (/BFP|PACIFIC BLUE|V450|BV421/.test(text)) return 'MEBFP';
  return 'ERF';
}

export function createCalibrationSection(ctx) {
  const { app } = ctx;
  const { store, data } = app;
  const S = (app.qcState.calibration ??= { sampleId: null, populationId: ROOT, levels: 8, values: {}, units: {}, clustering: null, result: null, applyIds: null, busy: false });
  let charts = [];

  const fluorescence = (sample) => (sample?.channels ?? []).filter((c) => c.type === 'fluorescence');

  function beadSample() {
    const ws = store.ws;
    const chosen = ws.samples.find((s) => s.id === S.sampleId);
    if (chosen) return chosen;
    const guess = ws.samples.find((s) => s.role === 'bead') ?? ws.samples.find((s) => /bead|rainbow|calib|spherotech|rcp|urcp/i.test(s.name)) ?? ws.samples.find((s) => s.id === store.ui.sampleId) ?? ws.samples[0];
    S.sampleId = guess?.id ?? null;
    return guess;
  }

  // The samples acquired with the same settings as the beads: the same cytometer and, on every
  // calibrated channel, the same voltage when the files record one.
  function sameSettings(beads, channels) {
    const cytometer = beads.acquisition?.cytometer ?? beads.keywords?.$CYT;
    const voltages = Object.fromEntries(channels.map((c) => [c, beads.channels.find((x) => x.name === c)?.voltage]));
    return store.ws.samples.filter((s) => {
      if (s.id === beads.id) return false;
      if (cytometer && (s.acquisition?.cytometer ?? s.keywords?.$CYT) && (s.acquisition?.cytometer ?? s.keywords?.$CYT) !== cytometer) return false;
      return channels.every((c) => {
        const own = s.channels.find((x) => x.name === c);
        return own && (!voltages[c] || !own.voltage || own.voltage === voltages[c]);
      });
    });
  }

  async function run() {
    const ws = store.ws;
    const beads = beadSample();
    const channels = Object.keys(S.values).filter((c) => String(S.values[c] ?? '').trim());
    if (!beads || !channels.length) {
      toast('Give the beads\' values for at least one channel.', { kind: 'warn' });
      return;
    }
    const values = Object.fromEntries(channels.map((c) => [c, parseLevelValues(S.values[c])]));
    const wrong = channels.find((c) => values[c].length !== S.levels || values[c].some((v) => v !== null && !Number.isFinite(v)));
    if (wrong) {
      toast(`${wrong}: give ${S.levels} values, dimmest level first ("-" for a level without one).`, { kind: 'warn' });
      return;
    }
    S.busy = true;
    ctx.rerender();
    try {
      const view = await data.ensure(beads.id);
      const clustering = (S.clustering?.length ? S.clustering : channels).filter((c) => view.hasChannel(c));
      const needed = [...new Set([...clustering, ...channels])];
      const columns = Object.fromEntries(needed.map((c) => [c, view.column(c)]));
      const scatter = ['FSC-A', 'FSC', 'FSC-H'].find((c) => view.hasChannel(c));
      const side = ['SSC-A', 'SSC', 'SSC-H'].find((c) => view.hasChannel(c));
      if (scatter) columns[scatter] = view.column(scatter);
      if (side) columns[side] = view.column(side);
      let events = null;
      if (S.populationId && S.populationId !== ROOT) {
        const set = populationSet(view, ws, S.populationId);
        if (set === undefined) throw new Error('The bead population does not apply to this sample.');
        events = set === null ? null : set instanceof EventSet ? set.toIndices() : set;
      }
      const bounds = Object.fromEntries(channels.map((c) => {
        const p = view.parameters.find((x) => x.name === c);
        return [c, channelBounds(view.dataset.keywords, p.index, p.range)];
      }));
      const units = Object.fromEntries(channels.map((c) => [c, S.units[c] ?? defaultUnit(c, beads.channels.find((x) => x.name === c)?.marker)]));
      const result = calibrateBeads(columns, { channels, values, clustering, events, scatter: scatter && side ? [scatter, side] : null, bounds, unit: units });
      S.result = { sampleId: beads.id, beads: beads.name, channels, units, populationId: S.populationId, result, at: Date.now() };
      S.applyIds = null;
    } catch (error) {
      toast(`The beads could not be calibrated: ${error.message}`, { kind: 'error' });
    } finally {
      S.busy = false;
      ctx.rerender();
    }
  }

  function apply() {
    const r = S.result;
    const beads = store.ws.samples.find((s) => s.id === r.sampleId);
    const targets = S.applyIds ?? [r.sampleId, ...sameSettings(beads, r.channels).map((s) => s.id)];
    let ws = store.ws;
    const made = [];
    for (const channel of r.channels) {
      const c = r.result.channels[channel];
      if (!c.fit) continue;
      const unit = r.units[channel];
      const output = `${channel} ${unit}`;
      // These samples leave any earlier calibration of the same channel.
      ws = { ...ws, derived: ws.derived.flatMap((d) => {
        if (d.kind !== 'calibration' || d.outputs[0] !== output) return [d];
        const rest = (d.samples ?? ws.samples.map((s) => s.id)).filter((id) => !targets.includes(id));
        return rest.length ? [{ ...d, samples: rest }] : [];
      }) };
      ws = addDerived(ws, calibrationRecord(channel, c, { unit, beads: r.beads, samples: targets, id: newId('d') })).ws;
      made.push(output);
    }
    if (!made.length) return;
    store.commit(ws, `Calibrate ${made.join(', ')}`);
    toast(`${made.join(', ')} added to ${targets.length} sample${targets.length === 1 ? '' : 's'}.`, { kind: 'ok' });
  }

  function controls() {
    const ws = store.ws;
    const beads = beadSample();
    const pane = h('div.pane');
    pane.append(h('h3', icon('gauge'), 'Calibrated units from beads'),
      h('p.qc-explain', 'Beads with several levels of known brightness, acquired with the same settings as the samples, turn a channel\'s arbitrary units into MEF (molecules of equivalent fluorochrome) or ERF, so results compare across instruments and days. Give each level\'s value from the beads\' datasheet for this lot, dimmest first; the levels are found in the bead sample, a standard curve is fitted as FlowCal does, and the calibrated channels are added to the samples acquired with the same settings.'));
    if (!beads) return pane;
    // A datasheet kept with the bead sample (an example's beads carry theirs) fills in its values once.
    const sheet = beads.beadDatasheet;
    if (sheet && S.sheetFor !== beads.id) {
      S.sheetFor = beads.id;
      S.levels = sheet.levels ?? S.levels;
      for (const [channel, values] of Object.entries(sheet.values ?? {})) {
        S.values[channel] = values.map((v) => (v === null ? '-' : String(v))).join(', ');
        if (sheet.units?.[channel]) S.units[channel] = sheet.units[channel];
      }
    }
    if (sheet) pane.append(h('div.callout.accent', icon('file'), h('span', `Values from the datasheet that came with these beads: ${sheet.product ?? 'beads'}${sheet.lot ? `, lot ${sheet.lot}` : ''}.`)));
    const channels = fluorescence(beads);
    if (!S.populationId || (S.populationId !== ROOT && !gateById(ws, S.populationId))) S.populationId = ROOT;
    pane.append(h('div.qc-toolbar',
      h('label.field', h('span', 'Bead sample'), h('select.input.small', { onchange: (event) => { S.sampleId = event.target.value; S.result = null; ctx.rerender(); } },
        ws.samples.map((s) => h('option', { value: s.id, selected: s.id === beads.id }, s.name)))),
      h('label.field', { title: 'The single beads. All events: the main population on forward and side scatter is found automatically.' }, h('span', 'Beads'), h('select.input.small', { onchange: (event) => { S.populationId = event.target.value; } },
        h('option', { value: ROOT, selected: S.populationId === ROOT }, 'Found on scatter'),
        ws.gates.filter((g) => g.type !== 'boolean').map((g) => h('option', { value: g.id, selected: g.id === S.populationId }, gatePath(ws, g.id))))),
      h('label.field', h('span', 'Levels'), h('input.input.small', { type: 'number', min: 3, max: 12, step: 1, value: S.levels, style: { width: '64px' }, onchange: (event) => { S.levels = Math.max(3, Math.min(12, Number.parseInt(event.target.value, 10) || 8)); ctx.rerender(); } }))));
    const table = h('table.data', h('thead', h('tr', h('th', 'Channel'), h('th', `Values of the ${S.levels} levels, dimmest first`), h('th', 'Unit'), h('th', { title: 'Channels the levels are found on together' }, 'Find levels'))),
      h('tbody', channels.map((c, row) => {
        const unit = S.units[c.name] ?? defaultUnit(c.name, c.marker);
        const clustering = S.clustering ?? [];
        return h('tr',
          h('td', { style: { whiteSpace: 'nowrap' } }, c.marker ? `${c.marker} · ${c.name}` : c.name),
          h('td', h('input.input.small', { type: 'text', value: S.values[c.name] ?? '', placeholder: row === 0 ? 'e.g. 0, 792, 2079, 6588, …' : '', style: { width: '100%', fontFamily: 'var(--mono)' }, 'aria-label': `Bead values for ${c.name}`, onchange: (event) => { S.values[c.name] = event.target.value; } })),
          h('td', h('select.input.small', { 'aria-label': `Unit for ${c.name}`, onchange: (event) => { S.units[c.name] = event.target.value; } }, UNITS.map((u) => h('option', { value: u.id, selected: u.id === unit }, u.id)))),
          h('td', h('input', { type: 'checkbox', 'aria-label': `Find the levels on ${c.name}`, checked: clustering.includes(c.name), onchange: (event) => { const set = new Set(S.clustering ?? []); if (event.target.checked) set.add(c.name); else set.delete(c.name); S.clustering = [...set]; } })));
      })));
    pane.append(h('div.qc-table-scroll', { tabIndex: 0, style: { maxHeight: '300px', marginTop: '8px' } }, table),
      h('p.muted.qc-small', 'Leave a row empty to leave that channel uncalibrated. Without "Find levels" ticks, the levels are found on the calibrated channels; ticking a bright channel or two helps separate the dim levels. Use the values for your lot: they differ between lots.'),
      h('div.btn-row', { style: { marginTop: '10px' } },
        h('button.btn.primary', { type: 'button', disabled: S.busy, onclick: run }, icon('play'), S.busy ? 'Calibrating…' : 'Calibrate')));
    return pane;
  }

  function channelChart(c, unit) {
    return mountChart({
      height: 240,
      tooltip: (row) => [`Level ${row.level}: median ${sig(row.median)}, ${row.value === null ? 'no value' : `${sig(row.value)} ${unit}`}`, row.used ? '' : ` (left out: ${row.why})`],
      build: (w, hgt, colors) => {
        const items = [];
        const hits = [];
        const rect = { x: 70, y: 12, w: w - 90, h: hgt - 56 };
        const rows = c.levels.map((l, i) => ({ ...l, level: i + 1 }));
        const xs = rows.map((r) => r.median).filter((v) => v > 0);
        const curve = c.fit ? standardCurve(c.fit) : null;
        const ys = [...rows.map((r) => r.value).filter((v) => v > 0), ...(curve ? xs.map(curve) : [])];
        const x = valueScale(Math.min(...xs) / 1.5, Math.max(...xs) * 1.5, rect.x, rect.x + rect.w, { log: true });
        const y = valueScale(Math.min(...ys) / 1.5, Math.max(...ys) * 1.5, rect.y + rect.h, rect.y, { log: true });
        leftAxis(items, y, rect, colors, unit);
        bottomAxis(items, x, rect, colors, 'Bead level median (channel units)');
        if (c.fit) {
          const pts = [];
          const model = [];
          for (let i = 0; i <= 60; i += 1) {
            const v = Math.exp(Math.log(x.lo) + ((Math.log(x.hi) - Math.log(x.lo)) * i) / 60);
            pts.push([x.map(v), y.map(curve(v))]);
            const m = curve(v) - c.fit.autofluorescence;
            if (m >= y.lo) model.push([x.map(v), y.map(m)]);
          }
          items.push({ t: 'path', points: pts, stroke: colors.accent, width: 1.5 });
          if (model.length > 1) items.push({ t: 'path', points: model, stroke: colors.text3, width: 1, dash: [4, 3] });
        }
        for (const r of rows) {
          if (!(r.value > 0) || !(r.median > 0)) continue;
          const px = x.map(r.median);
          const py = y.map(r.value);
          items.push({ t: 'circle', x: px, y: py, r: 4, fill: r.used ? colors.accent : colors.bg, stroke: colors.accent, width: 1.5 });
          hits.push({ x: px, y: py, r: 6, data: r });
        }
        return { items, hits };
      },
    });
  }

  function resultPane(r) {
    const pane = h('div.pane');
    const beads = store.ws.samples.find((s) => s.id === r.sampleId);
    pane.append(h('h3', icon('target'), `${r.beads}: ${r.result.levels} levels, ${r.result.events.length.toLocaleString('en-US')} bead events`));
    for (const channel of r.channels) {
      const c = r.result.channels[channel];
      const unit = r.units[channel];
      pane.append(h('div.section-title', { style: { marginTop: '12px' } }, `${channel} → ${unit}`));
      if (c.fit) {
        const resid = Math.sqrt(c.fit.rss / Math.max(1, c.fit.n - 3));
        pane.append(h('div.callout.accent', icon('sparkles'), h('span', `${unit} = ${sig(Math.exp(c.fit.b))} × value^${c.fit.m.toFixed(4)} (slope ${c.fit.m.toFixed(4)}), from ${c.fit.n} levels; the beads' own fluorescence ${sig(c.fit.autofluorescence)} ${unit} is in the fit but not in the conversion. Residual SD ${(100 * resid).toFixed(1)}% (in log units).`)));
        if (Math.abs(c.fit.m - 1) > 0.15) pane.append(h('div.callout.warn', { style: { marginTop: '6px' } }, icon('warning'), h('span', `The slope is ${c.fit.m.toFixed(2)}; a linear detector gives close to 1. Check the values' order and lot, and that the levels were found correctly.`)));
      } else pane.append(h('div.callout.warn', icon('warning'), h('span', c.error ?? 'No standard curve.')));
      const chart = channelChart(c, unit);
      charts.push(chart);
      pane.append(h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '12px', marginTop: '8px' } },
        chart.el,
        h('div.qc-table-scroll', { tabIndex: 0, style: { maxHeight: '260px' } }, h('table.data', h('thead', h('tr', h('th', 'Level'), h('th.r', 'Events'), h('th.r', 'Median'), h('th.r', unit), h('th', ''))),
          h('tbody', c.levels.map((l, i) => h('tr', h('td', String(i + 1)), h('td.r', l.n.toLocaleString('en-US')), h('td.r', sig(l.median)), h('td.r', l.value === null ? '—' : l.value.toLocaleString('en-US')),
            h('td', l.used ? h('span.badge.ok', 'used') : h('span.badge.warn', { title: l.why }, l.why.replace(/ \(.*\)/, ''))))))))));
    }
    pane.append(h('p.muted.qc-small', 'Solid: the standard curve, which converts any value. Dashed: the beads\' model, their datasheet values without their own fluorescence. Open circles: levels left out of the fit (near the ends of the range, or without a value); a blank level (value 0) is fitted but cannot be drawn on the log scale. Each level\'s median is matched to its datasheet value; the curve is fitted in log space (FlowCal, Castillo-Hair et al. 2016).'));
    const fitted = r.channels.filter((ch) => r.result.channels[ch].fit);
    if (fitted.length && beads) {
      const candidates = [beads, ...sameSettings(beads, fitted)];
      const chosen = new Set(S.applyIds ?? candidates.map((s) => s.id));
      const others = store.ws.samples.filter((s) => !candidates.includes(s));
      pane.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Apply to'),
        h('p.muted.qc-small', `Samples acquired with the same settings as the beads (${candidates.length - 1} found: the same cytometer${fitted.some((ch) => beads.channels.find((x) => x.name === ch)?.voltage) ? ' and voltages' : ''}). Each gets ${fitted.map((ch) => `"${ch} ${r.units[ch]}"`).join(', ')}.`),
        h('div.qc-checks', [...candidates, ...others].map((s) => h('label.check', { title: candidates.includes(s) ? '' : 'Acquired with other settings' },
          h('input', { type: 'checkbox', checked: chosen.has(s.id), onchange: (event) => { if (event.target.checked) chosen.add(s.id); else chosen.delete(s.id); S.applyIds = [...chosen]; } }),
          h('span', { style: candidates.includes(s) ? {} : { opacity: 0.6 } }, s.name)))),
        h('div.btn-row', { style: { marginTop: '10px' } }, h('button.btn.primary', { type: 'button', onclick: apply }, icon('check'), 'Add the calibrated channels')));
    }
    return pane;
  }

  function savedPane() {
    const saved = store.ws.derived.filter((d) => d.kind === 'calibration');
    if (!saved.length) return null;
    return h('div.pane', h('h3', icon('save'), 'Calibrated channels in this workspace'),
      h('ul', { style: { margin: '4px 0 0 18px', fontSize: '12.5px' } }, saved.map((d) => h('li', `${d.outputs[0]}: from ${d.params.beads ?? 'beads'}, slope ${d.params.m.toFixed(4)}, ${d.samples ? `${d.samples.length} sample${d.samples.length === 1 ? '' : 's'}` : 'every sample'}`))),
      h('div.btn-row', { style: { marginTop: '8px' } }, h('button.btn.small', { type: 'button', onclick: () => app.computedChannelsDialog() }, 'Computed channels…')));
  }

  function render(host) {
    for (const c of charts) c.destroy();
    charts = [];
    clear(host);
    host.append(controls());
    if (S.result && S.result.sampleId === S.sampleId) host.append(resultPane(S.result));
    const saved = savedPane();
    if (saved) host.append(saved);
    host.append(h('div.pane', h('div.qc-cite', h('div', 'Calibration: Castillo-Hair SM, Sexton JT, Landry BP, Olson EJ, Igoshin OA, Tabor JJ. FlowCal: a user-friendly, open source software tool for automatically converting flow cytometry data from arbitrary to calibrated units. ACS Synth Biol. 2016;5(7):774–780. doi:10.1021/acssynbio.5b00284'))));
  }

  return { render };
}
