// User actions shared by the views: importing and exporting, menus and dialogs about gates and
// samples, plot export and the cohort review of a gate.

import { prefs } from './storage.js';
import { WorkspaceChangedError, presentSamples } from './store.js';
import { h, icon, clear, downloadBlob, formatCount, formatPercent } from './dom.js';
import { showMenu, showDialog, promptDialog, confirmDialog, toast, progressToast } from './overlays.js';
import { drawScene, sceneToSVG } from '../lib/plot.js';
import { exportScene } from '../lib/scene.js';
import { newId } from '../lib/gates.js';
import { channelTransform, countOf, gateRobustness, population, populationSet } from '../lib/engine.js';
import { createTransform, describeTransform, estimateLogicleW, applyTransform } from '../lib/transforms.js';
import { writeFCS, readSpillover } from '../lib/fcs.js';
import { histogram } from '../lib/density.js';
import {
  ROOT,
  META_FIELDS,
  addGroup,
  channelLabel,
  clearOverride,
  copyGateSubtree,
  gateById,
  gatePath,
  removeGate,
  setCollection,
  setChannelTransform,
  setSampleMeta,
  suggestFieldsFromNames,
  updateGate,
  updateSample,
} from '../lib/workspace.js';
import { CATEGORICAL, CATEGORICAL_CVD, colorVisionFriendly, shownColor } from '../lib/colormaps.js';

function rasterImage(raster) {
  const canvas = new OffscreenCanvas(raster.width, raster.height);
  canvas.getContext('2d').putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  return canvas;
}

async function rasterDataURL(raster) {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  canvas.getContext('2d').putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  return canvas.toDataURL('image/png');
}

export function installActions(app) {
  const { store, data } = app;

  // Records a derived result (clusters, embeddings, QC masks, unmixed channels): attaches the
  // per-event columns to the samples, stores them in the library and adds a workspace record with
  // the method, parameters and seed, so the result is both reloadable and reproducible.
  //   result: { id?, kind, name, method, params, seed, outputs: [channel], perSample: Map(sampleId →
  //             { [channel]: Float32Array }), summary? }
  app.saveDerived = async (result, label) => {
    const { addDerived } = await import('../lib/workspace.js');
    const perSample = presentSamples(store.ws, result.perSample);
    const files = {};
    for (const [sampleId, columns] of perSample) {
      files[sampleId] = {};
      for (const [name, column] of Object.entries(columns)) {
        data.setDerived(sampleId, name, column);
        files[sampleId][name] = await data.persistColumn(column);
      }
    }
    // Replacing a result with the same outputs drops the old record's channels first.
    const replaced = store.ws.derived.filter((d) => d.id !== result.id && d.outputs?.some((o) => result.outputs.includes(o)));
    let next = store.ws;
    if (replaced.length) next = { ...next, derived: next.derived.filter((d) => !replaced.includes(d)) };
    const { perSample: _all, ...record } = result;
    const added = addDerived(next, { ...record, files });
    store.commit(added.ws, label ?? `${result.kind} result`, ['derived', 'data']);
    return added.derived;
  };

  // Adds more samples' columns to an existing derived record (more samples placed on a map).
  // perSample: Map(sampleId → { channel: Float32Array }); params merge into the record's.
  app.addDerivedSamples = async (recordId, perSample, params, label) => {
    const { extendDerived } = await import('../lib/workspace.js');
    if (!store.ws.derived.some((d) => d.id === recordId)) throw new WorkspaceChangedError();
    const files = {};
    for (const [sampleId, columns] of presentSamples(store.ws, perSample)) {
      files[sampleId] = {};
      for (const [name, column] of Object.entries(columns)) {
        data.setDerived(sampleId, name, column);
        files[sampleId][name] = await data.persistColumn(column);
      }
    }
    store.commit(extendDerived(store.ws, recordId, files, params, label), label, ['derived', 'data']);
  };

  // --- Plot export ------------------------------------------------------------------------------

  // Rebuilds a plot view's scene at export size with its gates, then writes SVG/PNG/clipboard.
  // Places a live copy of a plot on a figure: the newest one, or a new 16:9 page when there is
  // none. Plots fill a grid of 360 px cells from the top left.
  app.addToFigure = (spec, sampleId) => {
    const ws = store.ws;
    const place = (figure) => {
      const cell = 360;
      const gap = 24;
      const columns = Math.max(1, Math.floor((figure.width - 2 * gap + gap) / (cell + gap)));
      const plots = figure.items.filter((item) => item.kind === 'plot').length;
      const x = gap + (plots % columns) * (cell + gap);
      const y = gap + Math.floor(plots / columns) * (cell + gap);
      const population = spec.populationId ?? ROOT;
      const item = {
        id: newId('i'), kind: 'plot', x, y, w: cell, h: cell, sampleId: sampleId ?? store.ui.sampleId,
        spec: { populationId: population, x: spec.x, y: spec.y ?? null, type: spec.type ?? 'pseudocolor', options: { ...(spec.options ?? {}) } },
        title: population === ROOT ? 'All events' : gateById(ws, population)?.name ?? '',
      };
      const next = { ...figure, items: [...figure.items, item] };
      if (y + cell > figure.height) next.height = y + cell + gap;
      return next;
    };
    const existing = ws.figures.at(-1);
    const figure = place(existing ?? { id: newId('f'), name: `Figure ${ws.figures.length + 1}`, width: 1600, height: 900, background: '#ffffff', items: [] });
    const figures = existing ? ws.figures.map((f) => (f.id === figure.id ? figure : f)) : [...ws.figures, figure];
    store.commit(setCollection(ws, 'figures', figures, 'edit-figure'), `Add a plot to ${figure.name}`, ['figures']);
    toast(`Added to ${figure.name}.`, { kind: 'ok', action: { label: 'Open Figures', onClick: () => app.setMode('figures') } });
  };

  app.exportPlot = async (plotView, format, options = {}) => {
    const view = data.view(plotView.sampleId);
    if (!view) return;
    const spec = plotView.spec;
    const ws = store.ws;
    const scene = buildExportScene(ws, view, spec, { width: options.width ?? 480, height: options.height ?? 440, theme: options.theme ?? 'light', title: options.title });
    const sample = ws.samples.find((s) => s.id === plotView.sampleId);
    const base = `${sample?.name ?? 'plot'}-${gateById(ws, spec.populationId)?.name ?? 'all'}`.replace(/[^\w.-]+/g, '_');
    // The plot's analysis, embedded as in figure exports (a one-plot figure).
    const provenance = async () => {
      if (prefs.get('figureProvenance', true) === false) return null;
      const { buildProvenance } = await import('../lib/figure-provenance.js');
      const figure = { id: null, name: base, width: scene.width, height: scene.height, items: [{ id: 'plot', kind: 'plot', x: 0, y: 0, w: scene.width, h: scene.height, sampleId: plotView.sampleId, spec: { populationId: spec.populationId, x: spec.x, y: spec.y, type: spec.type, options: spec.options ?? {} } }] };
      return buildProvenance(ws, figure, { views: new Map([[plotView.sampleId, view]]), version: app.version });
    };
    if (format === 'svg') {
      const href = scene.raster ? await rasterDataURL(scene.raster) : null;
      let svg = sceneToSVG(scene, { rasterHref: href });
      const record = await provenance();
      if (record) svg = (await import('../lib/figure-provenance.js')).embedSVG(svg, record);
      downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
      return;
    }
    const scale = options.scale ?? 3;
    const canvas = document.createElement('canvas');
    canvas.width = scene.width * scale;
    canvas.height = scene.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    drawScene(ctx, scene, rasterImage);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (format === 'clipboard') {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('Plot copied to the clipboard.', { kind: 'ok' });
      } catch {
        toast('The browser did not allow copying images; the plot was downloaded instead.');
        downloadBlob(blob, `${base}.png`);
      }
      return;
    }
    const record = await provenance();
    downloadBlob(record ? new Blob([(await import('../lib/figure-provenance.js')).embedPNG(new Uint8Array(await blob.arrayBuffer()), record)], { type: 'image/png' }) : blob, `${base}.png`);
  };

  // A complete scene (events, gates with labels) for export or figures, in the chosen colormap.
  function buildExportScene(ws, view, spec, options) {
    return exportScene(ws, view, spec, { ...options, colormap: store.ui.colormap });
  }
  app.buildExportScene = buildExportScene;

  // --- Gate menu --------------------------------------------------------------------------------

  app.gateMenu = (gateId, anchor, sampleId) => {
    const ws = store.ws;
    const gate = gateId ? gateById(ws, gateId) : null;
    const items = [];
    if (gate) {
      items.push(
        { label: 'Rename…', icon: 'edit', hint: 'F2', onSelect: () => app.renameGateInline(gate.id) },
        { label: 'Color', icon: 'tag', disabled: colorVisionFriendly(), hint: colorVisionFriendly() ? 'color-vision palette on' : undefined, onSelect: () => showMenu(anchor, CATEGORICAL.map((color) => ({ label: color, swatch: color, onSelect: () => store.commit(updateGate(store.ws, gate.id, { color }), 'Recolor gate') }))) },
        { label: store.ui.backgate ? 'Stop backgating' : 'Backgate on ancestors', icon: 'backgate', hint: 'B', onSelect: () => { app.selectGate(gate.id); store.setUI({ backgate: !store.ui.backgate }, ['backgate']); } },
        '-',
        gate.type === 'boolean' ? { label: 'Edit Boolean population…', icon: 'edit', onSelect: () => import('./boolean-gate.js').then((m) => m.openBooleanGate(app, { gateId: gate.id })) } : null,
        { label: 'Review across samples…', icon: 'target', onSelect: () => app.reviewGate(gate.id) },
        ['range', 'split', 'rectangle', 'polygon', 'ellipse', 'quadrant'].includes(gate.type) && gate.dims.length <= 2 ? { label: 'Adapt to each sample…', icon: 'sparkles', onSelect: () => app.adaptGate(gate.id) } : null,
        { label: 'Copy to another population…', icon: 'copy', onSelect: () => copyGateMenu(anchor, gate) },
        { label: 'Applies to', icon: 'layers', onSelect: () => scopeMenu(anchor, gate) },
        gate.overrides?.[sampleId] ? { label: 'Use the shared gate for this sample', icon: 'undo', onSelect: () => store.commit(clearOverride(store.ws, gate.id, sampleId), 'Reset gate for sample') } : null,
        '-',
      );
    }
    items.push(
      { label: 'New Boolean population…', icon: 'layers', disabled: !ws.gates.length, onSelect: () => import('./boolean-gate.js').then((m) => m.openBooleanGate(app, { operands: gate ? [gate.id] : [] })) },
      { label: 'Export events as FCS…', icon: 'download', disabled: !sampleId, onSelect: () => exportPopulation(gateId, sampleId, 'fcs') },
      { label: 'Export events as de-identified FCS…', icon: 'download', disabled: !sampleId, onSelect: () => exportPopulation(gateId, sampleId, 'fcs', { deidentify: true }) },
      { label: 'Export events as CSV…', icon: 'download', disabled: !sampleId, onSelect: () => exportPopulation(gateId, sampleId, 'csv') },
      { label: 'Export events of several samples…', icon: 'download', onSelect: () => app.exportEventsDialog({ populationId: gateId ?? ROOT }) },
      { label: 'Add statistics to a table', icon: 'table', onSelect: () => { app.setMode('tables'); setTimeout(() => app.addPopulationToTable?.(gateId), 50); } },
      '-',
      { section: 'Model this population' },
      { label: 'Cell cycle (DNA content)…', icon: 'dna', disabled: !sampleId, onSelect: () => import('./platforms.js').then((m) => m.openCellCycle(app, gateId, sampleId)) },
      { label: 'Proliferation (dye dilution)…', icon: 'cell', disabled: !sampleId, onSelect: () => import('./platforms.js').then((m) => m.openProliferation(app, gateId, sampleId)) },
      { label: 'Kinetics (signal over time, calcium flux)…', icon: 'wave', disabled: !sampleId, onSelect: () => import('./kinetics.js').then((m) => m.openKinetics(app, gateId, sampleId)) },
      { label: 'Bead immunoassay (LEGENDplex, CBA)…', icon: 'flask', onSelect: () => import('./bead-assay.js').then((m) => m.openBeadAssay(app, { gateId: gateId && gateId !== 'root' ? gateId : undefined })) },
    );
    if (gate) {
      items.push('-', { label: 'Delete gate', icon: 'trash', danger: true, hint: '⌫', onSelect: () => app.deleteGate(gate.id) });
    }
    showMenu(anchor, items.filter(Boolean));
  };

  app.deleteGate = async (gateId) => {
    const ws = store.ws;
    const gate = gateById(ws, gateId);
    if (!gate) return;
    const descendants = ws.gates.filter((g) => g.parentId === gate.id).length;
    if (descendants) {
      const ok = await confirmDialog({ title: `Delete ${gate.name}?`, message: `${gate.name} has subpopulations; they will be deleted too. You can undo this.`, confirm: 'Delete', danger: true });
      if (!ok) return;
    }
    store.commit(removeGate(ws, gate.id), `Delete ${gate.name}`);
    app.selectGate(gate.parentId ?? null);
  };

  function copyGateMenu(anchor, gate) {
    const ws = store.ws;
    const targets = [{ id: null, name: 'All events' }, ...ws.gates.filter((g) => g.id !== gate.id)];
    showMenu(anchor, targets.map((target) => ({
      label: target.id ? gatePath(ws, target.id) : 'All events',
      onSelect: () => {
        const result = copyGateSubtree(store.ws, gate.id, target.id ?? ROOT);
        store.commit(result.ws, `Copy ${gate.name}`);
        toast(`Copied ${gate.name} under ${target.name}.`, { kind: 'ok' });
      },
    })), { search: true });
  }

  function scopeMenu(anchor, gate) {
    const ws = store.ws;
    showMenu(anchor, [
      { label: 'All samples', checked: !gate.scope, onSelect: () => store.commit(updateGate(store.ws, gate.id, { scope: null }), 'Gate applies to all samples') },
      ...ws.groups.map((group) => ({ label: `Group: ${group.name}`, swatch: shownColor(ws, group, 'groups'), checked: gate.scope?.groupId === group.id, onSelect: () => store.commit(updateGate(store.ws, gate.id, { scope: { groupId: group.id } }), `Gate applies to ${group.name}`) })),
    ]);
  }

  async function exportPopulation(gateId, sampleId, format, { deidentify = false } = {}) {
    const view = await data.ensure(sampleId);
    const ws = store.ws;
    const indices = population(view, ws, gateId ?? ROOT);
    if (indices === undefined) {
      toast('This population does not apply to the sample.');
      return;
    }
    const sample = ws.samples.find((s) => s.id === sampleId);
    const gate = gateId ? gateById(ws, gateId) : null;
    const base = `${sample.name}${gate ? `_${gate.name}` : ''}`.replace(/[^\w.+-]+/g, '_');
    const n = countOf(indices, view);
    const pick = (column) => {
      if (!indices) return Float32Array.from(column);
      const out = new Float32Array(indices.length);
      for (let i = 0; i < indices.length; i += 1) out[i] = column[indices[i]];
      return out;
    };
    if (format === 'csv') {
      const names = view.parameters.map((p) => p.name);
      const columns = names.map((name) => pick(view.column(name)));
      const lines = [names.map((name) => JSON.stringify(name)).join(',')];
      for (let e = 0; e < n; e += 1) lines.push(columns.map((c) => c[e]).join(','));
      downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), `${base}.csv`);
      toast(`Exported ${formatCount(n)} events (compensated values).`, { kind: 'ok' });
      return;
    }
    // FCS: raw (uncompensated) values with the original keywords and the applied spillover, so
    // any program can reproduce the compensation.
    const keywords = { ...view.dataset.keywords };
    for (const key of Object.keys(keywords)) if (/^\$P\d+/.test(key) || /^\$(BEGIN|END)/.test(key)) delete keywords[key];
    if (view.compensation) keywords.$SPILLOVER = [view.compensation.channels.length, ...view.compensation.channels, ...view.compensation.matrix].join(',');
    keywords.$FIL = `${base}.fcs`;
    keywords.$ORIGINALITY = 'DataModified';
    keywords['CYTOWEAVE POPULATION'] = gate ? gatePath(ws, gate.id) : 'All events';
    let written = keywords;
    if (deidentify) {
      const { deidentifyKeywords } = await import('../lib/deidentify.js');
      written = deidentifyKeywords(keywords, { fileName: `${base}.fcs` }).keywords;
    }
    const bytes = writeFCS({ parameters: view.parameters.map((p) => ({ name: p.name, label: p.label, range: p.range })), data: view.parameters.map((p) => pick(view.raw.get(p.name))), keywords: written });
    downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `${base}.fcs`);
    toast(`Exported ${formatCount(n)} events${deidentify ? ' without identifying keywords' : ''}.`, { kind: 'ok' });
  }

  // --- Cohort review of a gate ---------------------------------------------------------------
  //
  // The gate's frequency on every sample it applies to, with a robust z-score against the cohort
  // and the boundary robustness on each sample. Samples are ranked for review: outliers and
  // sensitive boundaries first. Adjusting a sample from here creates a sample-specific override.

  app.reviewGate = async (gateId) => {
    const ws = store.ws;
    const gate = gateById(ws, gateId);
    if (!gate) return;
    const samples = ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference');
    const rows = [];
    const progress = progressToast(`Reviewing ${gate.name} on ${samples.length} samples…`);
    let i = 0;
    for (const sample of samples) {
      i += 1;
      progress.update(i / samples.length, `Reviewing ${gate.name}: ${sample.name}`);
      try {
        const view = await data.ensure(sample.id);
        const indices = populationSet(view, store.ws, gate.id);
        if (indices === undefined) continue;
        const parent = populationSet(view, store.ws, gate.parentId ?? ROOT);
        const parentCount = countOf(parent, view);
        const robustness = gateRobustness(view, store.ws, gate.id);
        rows.push({ sample, count: countOf(indices, view), freq: (100 * countOf(indices, view)) / (parentCount || 1), parentCount, robustness, adjusted: Boolean(gate.overrides?.[sample.id]) });
      } catch (error) {
        rows.push({ sample, error: error.message });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    progress.done();
    const freqs = rows.filter((r) => Number.isFinite(r.freq)).map((r) => r.freq).sort((a, b) => a - b);
    const median = freqs.length ? freqs[Math.floor(freqs.length / 2)] : 0;
    const mad = freqs.length ? [...freqs].map((f) => Math.abs(f - median)).sort((a, b) => a - b)[Math.floor(freqs.length / 2)] * 1.4826 || 1e-9 : 1;
    for (const row of rows) {
      row.z = Number.isFinite(row.freq) ? (row.freq - median) / mad : 0;
      row.priority = Math.abs(row.z) + (row.robustness?.rating === 'sensitive' ? 2 : row.robustness?.rating === 'moderate' ? 0.8 : 0) + (row.count < 100 ? 1 : 0);
    }
    rows.sort((a, b) => b.priority - a.priority);
    const body = h('tbody');
    for (const row of rows) {
      const flag = Math.abs(row.z) > 3 ? h('span.badge.danger', 'outlier') : Math.abs(row.z) > 2 ? h('span.badge.warn', 'unusual') : h('span.badge.ok', 'typical');
      const robust = row.robustness ? h(`span.badge.${row.robustness.rating === 'robust' ? 'ok' : row.robustness.rating === 'moderate' ? 'warn' : 'danger'}`, row.robustness.rating) : h('span.muted', '—');
      body.append(h('tr', {
        style: { cursor: 'pointer' },
        onclick: () => {
          dialog.close();
          app.selectSample(row.sample.id);
          app.selectGate(gate.id);
          store.setUI({ editScope: 'sample', mode: 'gate' }, ['scope', 'mode']);
          toast(`Editing ${gate.name} for ${row.sample.name} only. Switch to "All samples" to edit the shared gate.`);
        },
      },
      h('td', row.sample.name, row.adjusted ? h('span.badge.accent', { style: { marginLeft: '6px' } }, 'adjusted') : null),
      h('td.r', row.error ? '—' : formatPercent(row.freq)),
      h('td.r', row.error ? '—' : formatCount(row.count)),
      h('td.r', row.error ? '—' : row.z.toFixed(1)),
      h('td', row.error ? h('span.muted', row.error) : flag),
      h('td', robust)));
    }
    const adaptable = ['range', 'split', 'rectangle', 'polygon', 'ellipse', 'quadrant'].includes(gate.type) && gate.dims.length <= 2;
    const dialog = showDialog({
      title: `Review ${gate.name} across samples`,
      width: 'wide',
      buttons: [
        ...(adaptable ? [{ label: 'Adapt to each sample…', onClick: () => { app.adaptGate(gate.id); } }] : []),
        { label: 'Close', primary: true },
      ],
      content: [
        h('p', `Median ${formatPercent(median)} of parent across ${freqs.length} samples. Samples are ranked for review: frequency outliers (robust z-score against the cohort), boundaries that cut through dense events, and low counts come first. Click a sample to adjust the gate for it alone.`),
        h('div', { style: { maxHeight: '58vh', overflow: 'auto' } }, h('table.data', h('thead', h('tr', h('th', 'Sample'), h('th.r', '% of parent'), h('th.r', 'Events'), h('th.r', 'z'), h('th', 'Frequency'), h('th', 'Boundary'))), body)),
      ],
    });
  };

  // --- Scales ---------------------------------------------------------------------------------

  app.editScales = (spec, sampleId) => {
    const view = data.view(sampleId);
    if (!view) return;
    const channels = [spec.x, spec.y].filter(Boolean);
    const content = h('div');
    for (const channel of channels) content.append(scaleEditor(channel, view, spec));
    showDialog({ title: 'Axis scales', width: 'wide', content, buttons: [{ label: 'Done', primary: true }] });
  };

  function scaleEditor(channel, view, spec) {
    const ws = store.ws;
    let current = { ...channelTransform(ws, view, channel) };
    const info = view.channelInfo(channel);
    const range = info?.range > 0 ? info.range : 262144;
    const canvas = h('canvas', { width: 560, height: 120, style: { width: '100%', height: '120px', border: '1px solid var(--line)', borderRadius: '8px', background: 'var(--plot-bg)' } });
    const fields = h('div.row', { style: { flexWrap: 'wrap', alignItems: 'flex-end' } });
    const typeSelect = h('select.input.small', { style: { width: '150px' } },
      ...['linear', 'log', 'logicle', 'biex', 'arcsinh'].map((type) => h('option', { value: type, selected: current.type === type }, { linear: 'Linear', log: 'Logarithmic', logicle: 'Logicle', biex: 'Biexponential (FlowJo)', arcsinh: 'Arcsinh' }[type])));
    const describe = h('div.muted', { style: { fontSize: '11.5px', marginTop: '4px' } });
    const indices = populationSet(view, ws, spec.populationId ?? ROOT);

    const defaultsFor = (type) => {
      const column = view.column(channel);
      switch (type) {
        case 'linear': return { type, min: info?.type === 'fluorescence' ? -0.02 * range : 0, max: range };
        case 'log': return { type, min: 10, max: range };
        case 'logicle': return { type, T: range, W: +estimateLogicleW(column, range, 4.5).toFixed(3), M: 4.5, A: 0 };
        case 'biex': return { type, maxValue: range, widthBasis: -10, positiveDecades: 4.5, extraNegativeDecades: 0 };
        case 'arcsinh': return { type, cofactor: view.record.technology === 'mass' ? 5 : 150, max: range, min: -(view.record.technology === 'mass' ? 5 : 150) };
        default: return current;
      }
    };
    const numberField = (label, key, step) => {
      const input = h('input.input.small.num', { type: 'number', step, value: current[key], style: { width: '110px' } });
      input.addEventListener('input', () => {
        const value = Number.parseFloat(input.value);
        if (Number.isFinite(value)) {
          current = { ...current, [key]: value };
          preview();
        }
      });
      return h('label.field', { style: { marginBottom: 0 } }, h('span', label), input);
    };
    const buildFields = () => {
      clear(fields);
      fields.append(h('label.field', { style: { marginBottom: 0 } }, h('span', 'Scale'), typeSelect));
      const spec2 = { linear: [['Min', 'min', 100], ['Max', 'max', 1000]], log: [['Min', 'min', 1], ['Max', 'max', 1000]], logicle: [['Top (T)', 'T', 1000], ['Width (W)', 'W', 0.05], ['Decades (M)', 'M', 0.1], ['Extra negative (A)', 'A', 0.1]], biex: [['Max', 'maxValue', 1000], ['Width basis', 'widthBasis', 1], ['Positive decades', 'positiveDecades', 0.1], ['Extra negative decades', 'extraNegativeDecades', 0.1]], arcsinh: [['Cofactor', 'cofactor', 1], ['Max', 'max', 1000], ['Min', 'min', 1]] }[current.type] ?? [];
      for (const [label, key, step] of spec2) fields.append(numberField(label, key, step));
      fields.append(h('button.btn.small', { type: 'button', onclick: () => { current = defaultsFor(current.type); buildFields(); preview(); } }, icon('sparkles'), 'Estimate from data'));
    };
    typeSelect.addEventListener('change', () => {
      current = defaultsFor(typeSelect.value);
      buildFields();
      preview();
    });
    const preview = () => {
      let transform;
      try {
        transform = createTransform(current);
      } catch (error) {
        describe.textContent = error.message;
        return;
      }
      describe.textContent = `${describeTransform(current)} — the preview shows the plotted population on this scale.`;
      const scaled = applyTransform(view.column(channel), transform);
      const hist = histogram(scaled, indices ?? null, { bins: 280 });
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(91,76,230,0.25)';
      ctx.strokeStyle = '#5b4ce6';
      ctx.beginPath();
      ctx.moveTo(0, canvas.height);
      for (let i = 0; i < hist.bins; i += 1) ctx.lineTo((i / hist.bins) * canvas.width, canvas.height - 6 - (hist.smoothed[i] / (hist.max || 1)) * (canvas.height - 16));
      ctx.lineTo(canvas.width, canvas.height);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#7b8496';
      ctx.font = '11px system-ui';
      for (const tick of transform.ticks()) {
        if (!tick.label) continue;
        ctx.fillText(tick.label, tick.position * canvas.width + 2, 12);
        ctx.fillRect(tick.position * canvas.width, 0, 1, 5);
      }
    };
    buildFields();
    setTimeout(preview, 0);
    return h('div.pane', { style: { marginBottom: '12px' } },
      h('h3', channelLabel(ws, channel), h('span.spacer'),
        h('button.btn.small.primary', { type: 'button', onclick: () => { store.commit(setChannelTransform(store.ws, channel, current), `Scale ${channel}`, ['theme']); toast(`${channel}: ${describeTransform(current)} for every plot. Existing gates keep their own scales.`, { kind: 'ok' }); } }, 'Apply to all plots')),
      fields, describe, h('div', { style: { marginTop: '8px' } }, canvas));
  }

  // --- Samples -------------------------------------------------------------------------------

  app.showKeywords = (sampleId) => {
    const sample = store.ws.samples.find((s) => s.id === sampleId);
    if (!sample) return;
    const view = data.view(sampleId);
    const keywords = view?.dataset.keywords ?? sample.keywords;
    const filter = h('input.input', { placeholder: 'Filter keywords…', type: 'search' });
    const body = h('tbody');
    const render = () => {
      clear(body);
      const q = filter.value.toLowerCase();
      for (const [key, value] of Object.entries(keywords)) {
        if (q && !`${key} ${value}`.toLowerCase().includes(q)) continue;
        body.append(h('tr', h('td.mono', key), h('td.mono', { style: { wordBreak: 'break-all' } }, String(value).slice(0, 600))));
      }
    };
    filter.addEventListener('input', render);
    render();
    showDialog({ title: `Keywords of ${sample.name}`, width: 'wide', content: [filter, h('div', { style: { maxHeight: '60vh', overflow: 'auto', marginTop: '10px' } }, h('table.data', h('thead', h('tr', h('th', 'Keyword'), h('th', 'Value'))), body))] });
  };

  // Sample annotation: metadata fields for many samples at once, with values taken from
  // keywords or file-name tokens.
  app.annotateSamples = (ids) => {
    const ws = store.ws;
    const samples = ws.samples.filter((s) => ids.includes(s.id));
    const fields = [...new Set([...META_FIELDS.slice(0, 5), ...samples.flatMap((s) => Object.keys(s.meta ?? {}))])];
    const edits = new Map(samples.map((s) => [s.id, { ...(s.meta ?? {}) }]));
    const table = h('table.data');
    const render = () => {
      clear(table);
      table.append(h('thead', h('tr', h('th', 'Sample'), ...fields.map((f) => h('th', f)))));
      const tbody = h('tbody');
      for (const sample of samples) {
        const meta = edits.get(sample.id);
        tbody.append(h('tr', h('td', { style: { whiteSpace: 'nowrap' } }, sample.name), ...fields.map((field) => {
          const input = h('input.input.small', { value: meta[field] ?? '', style: { minWidth: '90px' } });
          input.addEventListener('input', () => { meta[field] = input.value; });
          return h('td', input);
        })));
      }
      table.append(tbody);
    };
    render();
    const fromNames = () => {
      // Each part of the names that differs between samples becomes the field its values look like.
      const suggested = suggestFieldsFromNames(samples.map((s) => s.name));
      for (const { field, values } of suggested) {
        samples.forEach((sample, j) => { edits.get(sample.id)[field] = values[j]; });
        if (!fields.includes(field)) fields.push(field);
      }
      render();
      toast(suggested.length ? `Filled ${suggested.map((s) => s.field).join(', ')} from the parts of the names that differ; check and correct them.` : 'The names do not have parts that differ consistently.');
    };
    const addField = async () => {
      const name = await promptDialog({ title: 'Add a field', label: 'Field name', placeholder: 'e.g. donor, dose, tissue' });
      if (name && !fields.includes(name)) {
        fields.push(name);
        render();
      }
    };
    showDialog({
      title: `Annotate ${samples.length} sample(s)`,
      width: 'wide',
      content: [
        h('p', 'Metadata describe the experimental design (condition, subject, batch…). Comparisons, statistics and batch normalization use them.'),
        h('div.btn-row', { style: { marginBottom: '10px' } },
          h('button.btn.small', { type: 'button', onclick: fromNames }, icon('sparkles'), 'Suggest from file names'),
          h('button.btn.small', { type: 'button', onclick: addField }, icon('plus'), 'Add field')),
        h('div', { style: { maxHeight: '55vh', overflow: 'auto' } }, table),
      ],
      buttons: [
        { label: 'Cancel', ghost: true },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            let next = store.ws;
            for (const sample of samples) next = updateSample(next, sample.id, { meta: Object.fromEntries(Object.entries(edits.get(sample.id)).filter(([, v]) => String(v).trim() !== '')) });
            store.commit(next, 'Annotate samples');
          },
        },
      ],
    });
  };

  app.chooseOverlays = (plotView) => {
    const ws = store.ws;
    const current = new Set((plotView.spec.overlays ?? []).map((o) => o.sampleId));
    showMenu(plotView.el.querySelector('.plot-card-actions') ?? plotView.el, ws.samples.filter((s) => s.id !== plotView.sampleId).map((sample, i) => ({
      label: sample.name,
      checked: current.has(sample.id),
      onSelect: () => {
        const overlays = (plotView.spec.overlays ?? []).filter((o) => o.sampleId !== sample.id);
        if (!current.has(sample.id)) overlays.push({ sampleId: sample.id, color: (colorVisionFriendly() ? CATEGORICAL_CVD : CATEGORICAL)[(overlays.length + 1) % CATEGORICAL.length], label: sample.name });
        plotView.setSpec({ overlays });
      },
    })), { search: true });
  };
}
