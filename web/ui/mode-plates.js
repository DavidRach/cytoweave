// Plates: samples acquired from the wells of a plate, placed by their keywords or names (lib/
// plates.js). The plate's layout is the samples' annotations: wells are selected (click, shift for
// a block, row and column headings, the corner for all) and annotated, a dilution series filled in,
// or a layout imported from CSV. Any statistic of a population is shown across the plate as a heat
// map, with Z′ from the control wells; dose-response curves and bead immunoassays open from here.

import { h, icon, clear, downloadBlob, formatCount } from './dom.js';
import { toast, progressToast } from './overlays.js';
import { formatStatistic } from '../lib/stats.js';
import { computeStatistic, countOf, populationSet } from '../lib/engine.js';
import { colormapColor, categoricalColor } from '../lib/colormaps.js';
import { ROOT, annotateSamples, channelCatalog, channelLabel, gatePath } from '../lib/workspace.js';
import { REFERENCES, layoutCSV, layoutChanges, paddedWellName, parseLayout, parseQuantity, platesOf, wellName } from '../lib/plates.js';
import { PLATE_STATISTICS, annotationFields, basePopulation, controlWells, guessFields, plateZPrime, statisticLabel } from './plate-analysis.js';
import { fieldRow, selectEl, tile } from './platforms.js';

// The heat map's statistic and options, kept while the session lasts.
// While specAuto, the statistic follows the gating (the deepest population's % of parent).
const shown = { mode: 'layout', field: null, spec: null, specAuto: true, minEvents: 100, log: false, labels: true, controlField: null, robust: false };

// Reads a layout CSV and annotates the plate's samples (a CSV dropped on the app, or imported here).
export function applyLayoutText(app, text, fileName, plateName = null) {
  const { store } = app;
  const layout = parseLayout(text);
  const plates = platesOf(store.ws.samples);
  if (!plates.length) throw new Error('No sample has a well: wells come from the files\' $WELLID or WELL ID keywords, their names (Plate1_A01.fcs) or a "well" annotation.');
  const targets = layout.entries.some((e) => e.plate) ? plates : [plates.find((p) => p.name === plateName) ?? plates[0]];
  const byId = new Map(store.ws.samples.map((s) => [s.id, s]));
  let changes = {};
  let matched = 0;
  const unmatched = new Set();
  for (const plate of targets) {
    const result = layoutChanges(layout, plate, byId);
    changes = { ...changes, ...result.changes };
    matched += result.matched;
    for (const w of result.unmatched) unmatched.add(w);
  }
  if (!matched) throw new Error(`None of the layout's ${layout.entries.length} wells has a sample.`);
  store.commit(annotateSamples(store.ws, changes, `layout ${fileName}`), `Plate layout from ${fileName}`);
  toast(`Annotated ${matched} wells with ${layout.fields.join(', ')} from ${fileName}${unmatched.size ? `; ${unmatched.size} of its wells have no sample` : ''}.`, { kind: 'ok' });
  return { matched, fields: layout.fields, unmatched: [...unmatched], warnings: layout.warnings };
}

export function mountPlatesMode(app, container) {
  const { store, data } = app;
  let plateName = null;
  let selected = new Set();
  let anchor = null;
  let hovered = null;
  let computing = false;

  const controls = h('div');
  const head = h('div.row', { style: { marginBottom: '10px', gap: '8px', alignItems: 'center' } });
  const gridHost = h('div');
  const info = h('div.plate-info', { style: { marginTop: '10px' } });
  const fileInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt', hidden: true });
  const root = h('div.view',
    h('div.workbench-head', h('h1', icon('plate'), 'Plates'), h('span.spacer'),
      h('button.btn.small', { type: 'button', title: 'Annotate wells from a CSV: a "well" column and one column per field, or plate maps (a block per field, rows A, B, … and columns 1, 2, …)', onclick: () => fileInput.click() }, icon('upload'), 'Import layout…'),
      h('button.btn.small', { type: 'button', onclick: () => exportLayout() }, icon('download'), 'Export layout'),
      h('button.btn.small', { type: 'button', onclick: () => openDoseResponse() }, icon('wave'), 'Dose-response…'),
      h('button.btn.small', { type: 'button', onclick: () => openBeads() }, icon('flask'), 'Bead assay…')),
    h('div.view-body', h('div.split',
      h('div', h('div.pane', controls)),
      h('div.pane', { style: { minWidth: 0 } }, head, gridHost, info))),
    fileInput);
  container.append(root);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      applyLayoutText(app, await file.text(), file.name, plateName);
    } catch (error) {
      toast(error.message, { kind: 'error' });
    }
  });

  function plates() {
    return platesOf(store.ws.samples);
  }

  function currentPlate() {
    const all = plates();
    return all.find((p) => p.name === plateName) ?? all[0] ?? null;
  }

  function samplesOf(plate) {
    const byId = new Map(store.ws.samples.map((s) => [s.id, s]));
    return plate.placed.map((p) => byId.get(p.sampleId)).filter(Boolean);
  }

  function defaultSpec() {
    const gates = store.ws.gates.filter((g) => g.type !== 'category');
    const deepest = gates.at(-1);
    return { gateId: deepest?.id ?? ROOT, stat: deepest ? 'freqParent' : 'count' };
  }

  // Values of the statistic for loaded samples (others wait for "Compute").
  function valuesOf(plate) {
    const out = new Map();
    const spec = shown.spec;
    for (const p of plate.placed) {
      const view = data.view(p.sampleId);
      if (!view) continue;
      try {
        const events = countOf(populationSet(view, store.ws, basePopulation(store.ws, spec)), view);
        out.set(p.sampleId, { value: computeStatistic(view, store.ws, spec), events: Number.isFinite(events) ? events : 0 });
      } catch {
        out.set(p.sampleId, { value: Number.NaN, events: 0 });
      }
    }
    return out;
  }

  async function computeAll(plate) {
    const missing = plate.placed.filter((p) => !data.view(p.sampleId));
    if (!missing.length || computing) return;
    computing = true;
    const progress = progressToast(`Computing ${missing.length} wells…`);
    let done = 0;
    for (const p of missing) {
      await data.ensure(p.sampleId).catch(() => {});
      done += 1;
      progress.update(done / missing.length);
    }
    progress.done();
    computing = false;
    render();
  }

  function exportLayout() {
    const plate = currentPlate();
    if (!plate) {
      toast('No sample has a well.', { kind: 'error' });
      return;
    }
    const samples = samplesOf(plate);
    const fields = annotationFields(samples);
    const csv = layoutCSV(plate, new Map(samples.map((s) => [s.id, s])), fields);
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `${plate.name.replace(/[^\w.-]+/g, '_')}_layout.csv`);
  }

  async function openDoseResponse() {
    const plate = currentPlate();
    if (!plate) {
      toast('No sample has a well.', { kind: 'error' });
      return;
    }
    const { openDoseResponse: open } = await import('./dose-response.js');
    open(app, { plateName: plate.name, spec: shown.spec ?? defaultSpec(), controlField: shown.controlField });
  }

  async function openBeads() {
    const { openBeadAssay } = await import('./bead-assay.js');
    openBeadAssay(app, { plateName: currentPlate()?.name ?? null });
  }

  // --- Selection --------------------------------------------------------------------------------

  function select(plate, indices, event) {
    if (event?.shiftKey && anchor !== null && indices.length === 1) {
      const a = { r: Math.floor(anchor / plate.columns), c: anchor % plate.columns };
      const b = { r: Math.floor(indices[0] / plate.columns), c: indices[0] % plate.columns };
      const block = [];
      for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r += 1) for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c += 1) block.push(r * plate.columns + c);
      selected = new Set(block);
    } else if (event?.metaKey || event?.ctrlKey) {
      for (const i of indices) {
        if (selected.has(i)) selected.delete(i);
        else selected.add(i);
      }
      anchor = indices[0];
    } else {
      selected = new Set(indices);
      anchor = indices[0];
    }
    render();
  }

  // --- Controls -----------------------------------------------------------------------------------

  function renderControls(plate, values) {
    clear(controls);
    const ws = store.ws;
    const samples = samplesOf(plate);
    const fields = annotationFields(samples);
    shown.field = shown.field && fields.includes(shown.field) ? shown.field : guessFields(samples).group ?? fields[0] ?? null;
    shown.controlField = shown.controlField && fields.includes(shown.controlField) ? shown.controlField : guessFields(samples).control;
    if (shown.specAuto || !shown.spec || (shown.spec.gateId !== ROOT && !store.ws.gates.some((g) => g.id === shown.spec.gateId))) {
      shown.spec = defaultSpec();
      shown.specAuto = true;
    }
    controls.append(h('div.segmented', { style: { marginBottom: '10px' } },
      h(`button${shown.mode === 'layout' ? '.active' : ''}`, { type: 'button', onclick: () => { shown.mode = 'layout'; render(); } }, 'Layout'),
      h(`button${shown.mode === 'statistic' ? '.active' : ''}`, { type: 'button', onclick: () => { shown.mode = 'statistic'; render(); } }, 'Heat map')));
    if (shown.mode === 'layout') renderLayoutControls(plate, samples, fields);
    else renderStatisticControls(plate, samples, fields, values);
  }

  function renderLayoutControls(plate, samples, fields) {
    const ws = store.ws;
    controls.append(fieldRow('Color wells by', selectEl([{ value: '', label: '(none)' }, ...fields.map((f) => ({ value: f, label: f }))], shown.field ?? '', (v) => { shown.field = v || null; render(); })));
    const ids = [...selected].flatMap((i) => plate.wells[i] ?? []);
    controls.append(h('div.section-title', { style: { marginTop: '12px' } }, `Selected wells (${selected.size}, ${ids.length} sample${ids.length === 1 ? '' : 's'})`),
      h('p.muted.fine-print', 'Click a well; shift-click for a block, ⌘/Ctrl-click to add; click a row letter or column number for the whole row or column, the corner for the plate. Double-click a well to open its sample.'));
    const suggestions = [...new Set([...fields, 'compound', 'dose', 'control', 'standard', 'specimen', 'dilution', 'condition'])];
    const list = h('datalist', { id: 'plate-fields' }, ...suggestions.map((f) => h('option', { value: f })));
    const fieldInput = h('input.input.small', { list: 'plate-fields', value: shown.field ?? 'compound', placeholder: 'field' });
    const valueInput = h('input.input.small', { placeholder: 'value (e.g. CW-101, 10 nM, positive)' });
    const apply = (value) => {
      const field = fieldInput.value.trim();
      if (!field || !ids.length) {
        toast(ids.length ? 'Name the field.' : 'Select wells with samples first.', { kind: 'error' });
        return;
      }
      const changes = Object.fromEntries(ids.map((id) => [id, { [field]: value, ...wellOf(plate, id) }]));
      store.commit(annotateSamples(ws, changes, `${field} = ${value || '(cleared)'}`), `Annotate ${ids.length} wells`);
      shown.field = field;
    };
    controls.append(list, fieldRow('Field', fieldInput), fieldRow('Value', valueInput),
      h('div.btn-row', h('button.btn.small.primary', { type: 'button', disabled: !ids.length, onclick: () => apply(valueInput.value.trim()) }, 'Set'),
        h('button.btn.small', { type: 'button', disabled: !ids.length, onclick: () => apply('') }, 'Clear')));
    // A dilution series across the selection.
    const top = h('input.input.small', { type: 'number', step: 'any', placeholder: 'e.g. 10000', style: { width: '100px' } });
    const factor = h('input.input.small', { type: 'number', step: 'any', value: 3, style: { width: '70px' } });
    const unit = h('input.input.small', { value: 'nM', style: { width: '70px' } });
    let along = 'rows';
    const series = () => {
      const t = Number.parseFloat(top.value);
      const f = Number.parseFloat(factor.value);
      const field = fieldInput.value.trim() || 'dose';
      if (!(t > 0) || !(f > 1) || !selected.size) {
        toast('Select wells, then give the top dose and a dilution factor above 1.', { kind: 'error' });
        return;
      }
      const cells = [...selected].map((i) => ({ i, r: Math.floor(i / plate.columns), c: i % plate.columns }));
      // Each row (or column) of the selection is one series, starting at its first well.
      const changes = {};
      for (const cell of cells) {
        const lines = cells.filter((x) => (along === 'rows' ? x.r === cell.r : x.c === cell.c)).sort((a, b) => (along === 'rows' ? a.c - b.c : a.r - b.r));
        const step = lines.indexOf(cell);
        const dose = +(t / f ** step).toPrecision(4);
        for (const id of plate.wells[cell.i] ?? []) changes[id] = { [field]: `${dose}${unit.value.trim() ? ` ${unit.value.trim()}` : ''}`, ...wellOf(plate, id) };
      }
      if (!Object.keys(changes).length) return;
      store.commit(annotateSamples(store.ws, changes, `${field} series`), `Dilution series in ${Object.keys(changes).length} wells`);
      shown.field = field;
    };
    controls.append(h('div.section-title', { style: { marginTop: '12px' } }, 'Dilution series'),
      h('p.muted.fine-print', 'Each row (or column) of the selection gets the top dose in its first well, divided by the factor in each next one.'),
      h('div.row', { style: { gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, top, h('span.muted', '÷'), factor, unit),
      h('div.segmented', { style: { margin: '6px 0' } },
        h('button.active', { type: 'button', onclick: (e) => { along = 'rows'; e.currentTarget.classList.add('active'); e.currentTarget.nextSibling.classList.remove('active'); } }, 'Along rows'),
        h('button', { type: 'button', onclick: (e) => { along = 'columns'; e.currentTarget.classList.add('active'); e.currentTarget.previousSibling.classList.remove('active'); } }, 'Down columns')),
      h('button.btn.small', { type: 'button', disabled: !selected.size, onclick: series }, 'Fill the series'));
  }

  // The well (and plate) annotations that keep a sample in its place once annotated.
  function wellOf(plate, id) {
    const p = plate.placed.find((x) => x.sampleId === id);
    if (!p) return {};
    const sample = store.ws.samples.find((s) => s.id === id);
    return { ...(p.source === 'annotation' ? {} : { well: wellName(p.row, p.column) }), ...(plate.name !== 'Plate' && !sample?.meta?.plate ? { plate: plate.name } : {}) };
  }

  function renderStatisticControls(plate, samples, fields, values) {
    const ws = store.ws;
    const spec = shown.spec;
    const stat = PLATE_STATISTICS.find((s) => s.id === spec.stat) ?? PLATE_STATISTICS[1];
    const channels = channelCatalog(ws).filter((c) => c.type !== 'time');
    const update = (patch) => {
      shown.spec = { ...shown.spec, ...patch };
      shown.specAuto = false;
      const def = PLATE_STATISTICS.find((s) => s.id === shown.spec.stat);
      if (def?.needsChannel && !shown.spec.channel) shown.spec.channel = channels.find((c) => c.type === 'fluorescence')?.name;
      if (!def?.needsChannel) delete shown.spec.channel;
      if (def?.needsValue && shown.spec.value === undefined) shown.spec.value = def.id === 'percentile' ? 50 : 1000;
      if (!def?.needsValue) delete shown.spec.value;
      render();
    };
    controls.append(
      fieldRow('Population', selectEl([{ value: ROOT, label: 'All events' }, ...ws.gates.filter((g) => g.type !== 'category').map((g) => ({ value: g.id, label: gatePath(ws, g.id) }))], spec.gateId ?? ROOT, (v) => update({ gateId: v }))),
      fieldRow('Statistic', selectEl(PLATE_STATISTICS.filter((s) => !s.needsAncestor && !s.needsDilution).map((s) => ({ value: s.id, label: s.label })), spec.stat, (v) => update({ stat: v }))),
      stat.needsChannel ? fieldRow('Channel', selectEl(channels.map((c) => ({ value: c.name, label: channelLabel(ws, c.name) })), spec.channel, (v) => update({ channel: v }))) : null,
      stat.needsValue ? fieldRow(stat.id === 'percentile' ? 'Percentile' : 'Threshold', (() => { const input = h('input.input.small', { type: 'number', step: 'any', value: spec.value }); input.addEventListener('change', () => update({ value: Number.parseFloat(input.value) })); return input; })()) : null,
      fieldRow('Flag wells with fewer events than', (() => { const input = h('input.input.small', { type: 'number', min: 0, step: 1, value: shown.minEvents, style: { width: '90px' } }); input.addEventListener('change', () => { shown.minEvents = Math.max(0, Number.parseInt(input.value, 10) || 0); render(); }); return input; })(), 'In the population (for a percentage, in the population it is a percentage of).'),
      h('label.check', h('input', { type: 'checkbox', checked: shown.log, onchange: (e) => { shown.log = e.target.checked; render(); } }), 'Log color scale'),
      h('label.check', h('input', { type: 'checkbox', checked: shown.labels, onchange: (e) => { shown.labels = e.target.checked; render(); } }), 'Values in the wells'));
    // Z′ from the control wells.
    controls.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Z′ from the controls'),
      fieldRow('Control field', selectEl([{ value: '', label: '(none)' }, ...fields.map((f) => ({ value: f, label: f }))], shown.controlField ?? '', (v) => { shown.controlField = v || null; render(); }), 'Wells reading positive/pos/+/max and negative/neg/−/min.'),
      h('label.check', h('input', { type: 'checkbox', checked: shown.robust, onchange: (e) => { shown.robust = e.target.checked; render(); } }), 'Robust (median and MAD)'));
    const controlsOf = controlWells(samples, shown.controlField);
    const z = shown.controlField ? plateZPrime(values, controlsOf, shown.robust) : null;
    if (z) {
      controls.append(h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(2, 1fr)' } },
        tile('Z′', Number.isFinite(z.z) ? z.z.toFixed(3) : '—', z.rating, z.z >= 0.5 ? 'ok' : z.z > 0 ? 'warn' : 'danger'),
        tile('Window', formatStatistic(spec.stat, z.window), '|μ₊ − μ₋|'),
        tile('Positive', formatStatistic(spec.stat, z.positive.mean), `${z.robust ? 'robust SD' : 'SD'} ${formatStatistic(spec.stat, z.positive.sd)}, ${z.positive.n} wells`),
        tile('Negative', formatStatistic(spec.stat, z.negative.mean), `${z.robust ? 'robust SD' : 'SD'} ${formatStatistic(spec.stat, z.negative.sd)}, ${z.negative.n} wells`)),
      h('p.muted.fine-print', { title: REFERENCES.zPrime }, 'Z′ = 1 − 3 (σ₊ + σ₋) / |μ₊ − μ₋|; 0.5 or more is an excellent assay (Zhang et al. 1999).'));
    } else if (shown.controlField) {
      controls.append(h('p.muted.fine-print', controlsOf.positive.length && controlsOf.negative.length ? 'Compute the wells to see Z′.' : `No wells read as positive and negative controls in "${shown.controlField}".`));
    }
    controls.append(h('div.btn-row', { style: { marginTop: '12px' } },
      h('button.btn.small', { type: 'button', onclick: () => exportValues(plate, values) }, icon('download'), 'Values (CSV)'),
      h('button.btn.small', { type: 'button', onclick: () => copyMap(plate, values) }, icon('copy'), 'Copy as plate map')));
  }

  function exportValues(plate, values) {
    const ws = store.ws;
    const samples = samplesOf(plate);
    const fields = annotationFields(samples);
    const byId = new Map(samples.map((s) => [s.id, s]));
    const quote = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const lines = [['plate', 'well', 'sample', ...fields, statisticLabel(ws, shown.spec, channelLabel), 'events'].map(quote).join(',')];
    for (const p of plate.placed) {
      const s = byId.get(p.sampleId);
      const v = values.get(p.sampleId);
      lines.push([plate.name, paddedWellName(p.row, p.column), s?.name, ...fields.map((f) => s?.meta?.[f] ?? ''), Number.isFinite(v?.value) ? v.value : '', v?.events ?? ''].map(quote).join(','));
    }
    downloadBlob(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }), `${plate.name.replace(/[^\w.-]+/g, '_')}_values.csv`);
  }

  async function copyMap(plate, values) {
    const rows = [['', ...Array.from({ length: plate.columns }, (_, c) => c + 1)].join('\t')];
    for (let r = 0; r < plate.rows; r += 1) {
      rows.push([wellName(r, 0).replace(/\d+$/, ''), ...Array.from({ length: plate.columns }, (_, c) => {
        const id = plate.wells[r * plate.columns + c][0];
        const v = id ? values.get(id)?.value : undefined;
        return Number.isFinite(v) ? +v.toPrecision(6) : '';
      })].join('\t'));
    }
    try {
      await navigator.clipboard.writeText(rows.join('\n'));
      toast('Copied the plate map (rows A…, columns 1…) for a spreadsheet.', { kind: 'ok' });
    } catch {
      toast('The browser did not allow copying.', { kind: 'error' });
    }
  }

  // --- The plate ----------------------------------------------------------------------------------

  function colorsFor(plate, values) {
    const byId = new Map(store.ws.samples.map((s) => [s.id, s]));
    if (shown.mode === 'layout') {
      const field = shown.field;
      if (!field) return { colorOf: () => null, legend: [] };
      const raw = plate.placed.map((p) => byId.get(p.sampleId)?.meta?.[field]).filter((v) => v !== undefined && v !== null && v !== '');
      const quantities = raw.map((v) => parseQuantity(v));
      const numeric = raw.length && quantities.every(Boolean) && new Set(raw).size > 8;
      if (numeric) {
        const bases = quantities.map((q) => q.base).filter((v) => v > 0);
        const lo = Math.log(Math.min(...bases));
        const hi = Math.log(Math.max(...bases));
        return {
          colorOf: (id) => {
            const q = parseQuantity(byId.get(id)?.meta?.[field]);
            if (!q) return null;
            if (!(q.base > 0)) return 'var(--panel)';
            return colormapColor('viridis', hi > lo ? 0.1 + (0.85 * (Math.log(q.base) - lo)) / (hi - lo) : 0.5);
          },
          legend: [h('span.plate-scale', { style: { background: `linear-gradient(90deg, ${[0.1, 0.3, 0.5, 0.7, 0.95].map((t) => colormapColor('viridis', t)).join(', ')})` } }), h('span.muted', `${field}: ${raw[quantities.findIndex((q) => q.base === Math.min(...bases))]} → ${raw[quantities.findIndex((q) => q.base === Math.max(...bases))]} (log)`)],
        };
      }
      const categories = [...new Set(raw.map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const color = new Map(categories.map((c, k) => [c, categoricalColor(k + 1)]));
      return {
        colorOf: (id) => color.get(String(byId.get(id)?.meta?.[field] ?? '')) ?? null,
        legend: categories.slice(0, 40).map((c) => h('span.plate-legend-item', h('span.swatch', { style: { background: color.get(c) } }), c)),
      };
    }
    const finite = [...values.values()].map((v) => v.value).filter((v) => Number.isFinite(v) && (!shown.log || v > 0));
    if (!finite.length) return { colorOf: () => null, legend: [h('span.muted', 'No values yet.')] };
    const f = (v) => (shown.log ? Math.log10(v) : v);
    const lo = Math.min(...finite.map(f));
    const hi = Math.max(...finite.map(f));
    return {
      colorOf: (id) => {
        const v = values.get(id)?.value;
        if (!Number.isFinite(v) || (shown.log && !(v > 0))) return null;
        return colormapColor('viridis', hi > lo ? (f(v) - lo) / (hi - lo) : 0.5);
      },
      legend: [h('span.plate-scale', { style: { background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => colormapColor('viridis', t)).join(', ')})` } }),
        h('span.muted', `${statisticLabel(store.ws, shown.spec, channelLabel)}: ${formatStatistic(shown.spec.stat, shown.log ? 10 ** lo : lo)} → ${formatStatistic(shown.spec.stat, shown.log ? 10 ** hi : hi)}${shown.log ? ' (log)' : ''}`)],
    };
  }

  function renderPlate(plate, values) {
    clear(gridHost);
    clear(head);
    const all = plates();
    head.append(
      all.length > 1 ? selectEl(all.map((p) => ({ value: p.name, label: `${p.name} (${p.placed.length} wells)` })), plate.name, (v) => { plateName = v; selected = new Set(); render(); }, 'Plate') : h('b', plate.name),
      h('span.muted', `${plate.format}-well plate · ${plate.placed.length} wells with a sample · wells from ${[...new Set(plate.placed.map((p) => p.source))].map((s) => (s === 'keyword' ? 'the files\' keywords' : s === 'name' ? 'the file names' : 'annotations')).join(' and ')}`),
      h('span.grow'),
      shown.mode === 'statistic' && plate.placed.some((p) => !data.view(p.sampleId)) ? h('button.btn.small.primary', { type: 'button', disabled: computing, onclick: () => computeAll(plate) }, icon('play'), `Compute all ${plate.placed.length} wells`) : null);
    const { colorOf, legend } = colorsFor(plate, values);
    const byId = new Map(store.ws.samples.map((s) => [s.id, s]));
    const small = plate.columns > 12;
    const grid = h(`div.plates-grid${small ? '.small' : ''}`, { style: { gridTemplateColumns: `22px repeat(${plate.columns}, minmax(0, 1fr))` }, role: 'grid', 'aria-label': `${plate.name}, ${plate.format} wells` });
    const all96 = Array.from({ length: plate.rows * plate.columns }, (_, i) => i);
    grid.append(h('button.plates-corner', { type: 'button', title: 'Select every well', onclick: (e) => select(plate, all96, e) }),
      ...Array.from({ length: plate.columns }, (_, c) => h('button.plates-head', { type: 'button', title: `Column ${c + 1}`, onclick: (e) => select(plate, all96.filter((i) => i % plate.columns === c), e) }, String(c + 1))));
    for (let r = 0; r < plate.rows; r += 1) {
      const letter = wellName(r, 0).replace(/\d+$/, '');
      grid.append(h('button.plates-head', { type: 'button', title: `Row ${letter}`, onclick: (e) => select(plate, all96.filter((i) => Math.floor(i / plate.columns) === r), e) }, letter));
      for (let c = 0; c < plate.columns; c += 1) {
        const i = r * plate.columns + c;
        const ids = plate.wells[i];
        const id = ids[0];
        const sample = id ? byId.get(id) : null;
        const v = id ? values.get(id) : null;
        const color = id ? colorOf(id) : null;
        const few = shown.mode === 'statistic' && v && v.events < shown.minEvents;
        const label = shown.mode === 'statistic' && shown.labels && !small && v && Number.isFinite(v.value) ? compact(v.value) : '';
        const well = h(`button.plates-well${id ? '' : '.empty'}${selected.has(i) ? '.selected' : ''}${few ? '.few' : ''}${ids.length > 1 ? '.multiple' : ''}`, {
          type: 'button',
          title: `${wellName(r, c)}${sample ? `: ${sample.name}` : ': no sample'}`,
          style: color ? { background: color, color: textOn(color) } : {},
          onclick: (e) => select(plate, [i], e),
          ondblclick: () => { if (id) { app.selectSample(id); app.setMode('gate'); } },
          onmouseenter: () => { hovered = { i, id }; describe(plate, values); },
          onfocus: () => { hovered = { i, id }; describe(plate, values); },
        }, label);
        grid.append(well);
      }
    }
    gridHost.append(grid, h('div.plate-legend', ...legend));
    if (plate.duplicates.length) gridHost.append(h('div.callout.warn', { style: { marginTop: '8px' } }, icon('warning'), h('span', `More than one sample in ${plate.duplicates.slice(0, 8).join(', ')}${plate.duplicates.length > 8 ? '…' : ''}: the first is shown.`)));
    const few = [...values.values()].filter((x) => x.events < shown.minEvents).length;
    if (shown.mode === 'statistic' && few) gridHost.append(h('p.muted.fine-print', `${few} hatched well${few === 1 ? ' has' : 's have'} fewer than ${shown.minEvents} events in ${basePopulation(store.ws, shown.spec) === ROOT ? 'all' : gatePath(store.ws, basePopulation(store.ws, shown.spec))}.`));
    describe(plate, values);
  }

  function describe(plate, values) {
    clear(info);
    const target = hovered && hovered.i < plate.rows * plate.columns ? hovered : null;
    if (!target) {
      info.append(h('span.muted', 'Point at a well to see its sample and annotations.'));
      return;
    }
    const r = Math.floor(target.i / plate.columns);
    const c = target.i % plate.columns;
    const sample = target.id ? store.ws.samples.find((s) => s.id === target.id) : null;
    if (!sample) {
      info.append(h('div', h('strong', wellName(r, c)), ' · no sample'));
      return;
    }
    const v = values.get(sample.id);
    const meta = Object.entries(sample.meta ?? {}).filter(([k]) => k !== 'well' && k !== 'plate');
    info.append(h('div', h('strong', wellName(r, c)), ` · ${sample.name}`),
      meta.length ? h('div.plate-values', ...meta.map(([k, val]) => h('span.plate-value', h('span.muted', k), ` ${val}`))) : h('div.muted', 'No annotations.'),
      shown.mode === 'statistic' ? h('div', v ? `${statisticLabel(store.ws, shown.spec, channelLabel)}: ${formatStatistic(shown.spec.stat, v.value)} (${formatCount(v.events)} events)` : 'Not computed yet.') : null);
  }

  function render() {
    const plate = currentPlate();
    if (!plate) {
      clear(controls);
      clear(head);
      clear(gridHost);
      clear(info);
      gridHost.append(h('div.empty', icon('plate'), h('h3', 'No plate yet'),
        h('p', 'Samples acquired from a plate, one file per well, are placed here by their keywords ($WELLID, WELL ID) or names (Plate1_A01.fcs). Lay out the plate (compounds, doses, controls, standards), show any statistic as a heat map, check the screen\'s Z′ from its controls, and fit dose-response or bead-assay standard curves.'),
        h('div.btn-row', { style: { justifyContent: 'center' } },
          h('button.btn', { type: 'button', onclick: () => app.openExample?.('plate-screen') }, 'Open the drug-screen example'),
          h('button.btn', { type: 'button', onclick: () => app.openExample?.('bead-immunoassay') }, 'Open the bead-assay example'))));
      return;
    }
    plateName = plate.name;
    if (shown.specAuto || !shown.spec) shown.spec = defaultSpec();
    const values = shown.mode === 'statistic' ? valuesOf(plate) : new Map();
    renderControls(plate, values);
    renderPlate(plate, values);
  }

  render();
  return {
    update(topics) {
      if (topics.has('ws') || topics.has('data') || topics.has('theme') || topics.has('sample')) render();
    },
    destroy() {
      root.remove();
    },
  };
}

function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e5) return `${(v / 1e3).toFixed(0)}k`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toPrecision(2);
}

// Black or white text on a well's color, whichever is more legible.
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#000000' : '#ffffff';
}
