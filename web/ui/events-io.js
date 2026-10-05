// Events in and out: the Export events dialog (a population's events in chosen samples, optionally
// downsampled, as one concatenated FCS file, one FCS file per sample or an AnnData file), and the
// import of events from CSV files (checked, with each column's kind and scale guessed and
// adjustable).

import { h, icon, clear, downloadBlob, formatCount } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { ROOT, gatePath, setChannelTransform, updateSample } from '../lib/workspace.js';

const safeName = (name, fallback) => (name ?? '').replace(/[^\w.+-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;

export function installEventsIO(app) {
  const { store, data } = app;

  // --- Export ---------------------------------------------------------------------------------

  // Writes events: options { sampleIds, populationId, downsample, format ('fcs' | 'zip' | 'h5ad'),
  // values, channels, xValues, cofactor }. Returns { bytes, name, report, notes }.
  app.buildEventsExport = async (options, onProgress = () => {}) => {
    const lib = await import('../lib/events.js');
    let done = 0;
    for (const id of options.sampleIds) {
      await data.ensure(id).catch(() => {});
      done += 1;
      onProgress(done / options.sampleIds.length);
    }
    const ws = store.ws;
    const { items, notes } = lib.selectEvents(ws, (id) => data.view(id), options);
    if (!items.length) throw new Error(notes[0] ?? 'None of the samples could be loaded.');
    const base = safeName(`${ws.name}${options.populationId && options.populationId !== ROOT ? `_${ws.gates.find((g) => g.id === options.populationId)?.name}` : ''}`, 'events');
    if (options.format === 'h5ad') {
      const { writeAnnData } = await import('../lib/anndata.js');
      const out = writeAnnData(ws, items, { channels: options.channels, values: options.xValues, cofactor: options.cofactor, populationId: options.populationId, downsample: options.downsample, version: app.version });
      return { bytes: out.bytes, name: `${base}.h5ad`, report: out.report, notes };
    }
    if (options.format === 'zip') {
      const { createZip } = await import('../lib/zip.js');
      const used = new Set();
      const files = items.map((item) => {
        let name = `${safeName(item.sample.name, 'sample')}.fcs`;
        for (let k = 2; used.has(name.toLowerCase()); k += 1) name = `${safeName(item.sample.name, 'sample')}_${k}.fcs`;
        used.add(name.toLowerCase());
        return { name, data: lib.sampleFCS(item, options) };
      });
      return { bytes: await createZip(files), name: `${base}.zip`, report: { events: items.reduce((a, it) => a + it.indices.length, 0), samples: items.map((it) => ({ sample: it.sample.name, events: it.indices.length, of: it.total })) }, notes };
    }
    const out = lib.concatenatedFCS(ws, items, { ...options, version: app.version });
    return { bytes: out.bytes, name: `${base}_concatenated.fcs`, report: out.report, notes };
  };

  app.exportEventsDialog = (preset = {}) => {
    const ws = store.ws;
    if (!ws.samples.length) {
      toast('Add samples first.');
      return;
    }
    const groupFilter = store.ui.groupFilter && !store.ui.groupFilter.startsWith('role:') ? ws.groups.find((g) => g.id === store.ui.groupFilter) : null;
    const chosen = new Set(preset.sampleIds ?? ws.samples.filter((s) => (groupFilter ? groupFilter.sampleIds.includes(s.id) : s.role === 'sample')).map((s) => s.id));
    const list = h('div', { style: { maxHeight: '180px', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '4px 8px' } });
    const renderList = () => {
      clear(list);
      for (const s of ws.samples) list.append(h('label.check', h('input', { type: 'checkbox', checked: chosen.has(s.id), onchange: (e) => { if (e.target.checked) chosen.add(s.id); else chosen.delete(s.id); update(); } }), s.name, s.role && s.role !== 'sample' ? h('span.muted', ` (${s.role})`) : null));
    };
    const pick = (fn) => { chosen.clear(); for (const s of ws.samples) if (fn(s)) chosen.add(s.id); renderList(); update(); };
    const quick = h('div.btn-row', { style: { marginTop: '4px' } },
      h('button.btn.small.ghost', { type: 'button', onclick: () => pick(() => true) }, 'All'),
      h('button.btn.small.ghost', { type: 'button', onclick: () => pick((s) => s.role === 'sample') }, 'Samples'),
      ...ws.groups.slice(0, 6).map((g) => h('button.btn.small.ghost', { type: 'button', onclick: () => pick((s) => g.sampleIds.includes(s.id)) }, g.name)),
      h('button.btn.small.ghost', { type: 'button', onclick: () => pick(() => false) }, 'None'));
    const popSelect = h('select.input.small', h('option', { value: ROOT }, 'All events'), ...ws.gates.map((g) => h('option', { value: g.id, selected: g.id === (preset.populationId ?? store.ui.gateId) }, gatePath(ws, g.id))));
    const mode = h('select.input.small', h('option', { value: 'none' }, 'Every event'), h('option', { value: 'count' }, 'Up to a number per sample'), h('option', { value: 'fraction' }, 'A share of each sample'));
    const amount = h('input.input.small', { type: 'number', min: 0, step: 'any', value: 10000, style: { width: '110px' } });
    const seed = h('input.input.small', { type: 'number', min: 1, step: 1, value: 1, style: { width: '80px' } });
    const amountField = h('label.field', h('span', 'Events per sample'), amount);
    const seedField = h('label.field', h('span', 'Seed'), seed);
    const format = h('select.input.small', h('option', { value: 'fcs', selected: preset.format !== 'h5ad' }, 'One FCS file, the samples concatenated'), h('option', { value: 'zip' }, 'One FCS file per sample (ZIP)'), h('option', { value: 'h5ad', selected: preset.format === 'h5ad' }, 'AnnData (.h5ad) for scanpy and R'));
    const values = h('select.input.small', h('option', { value: 'raw' }, 'As acquired, with the spillover matrix'), h('option', { value: 'compensated' }, 'Compensated'));
    const valuesField = h('label.field', h('span', 'Values'), values);
    const xValues = h('select.input.small', h('option', { value: 'arcsinh' }, 'arcsinh(x / cofactor)'), h('option', { value: 'compensated' }, 'Compensated values'));
    const mass = ws.samples.some((s) => s.technology === 'mass');
    const cofactor = h('input.input.small', { type: 'number', min: 0.001, step: 'any', value: mass ? 5 : 150, style: { width: '90px' } });
    const channelBox = h('div', { style: { maxHeight: '150px', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '4px 8px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' } });
    const xChannels = new Set();
    const catalog = [...new Map(ws.samples.flatMap((s) => s.channels.map((c) => [c.name, c]))).values()];
    for (const c of catalog) if (c.type === 'fluorescence' || c.type === 'mass') xChannels.add(c.name);
    for (const c of catalog) channelBox.append(h('label.check', h('input', { type: 'checkbox', checked: xChannels.has(c.name), onchange: (e) => { if (e.target.checked) xChannels.add(c.name); else xChannels.delete(c.name); } }), c.marker ? `${c.marker} (${c.name})` : c.name));
    const h5adFields = h('div',
      h('div.row', { style: { gap: '12px', flexWrap: 'wrap' } }, h('label.field', h('span', 'X holds'), xValues), h('label.field', h('span', 'Cofactor'), cofactor)),
      h('div.section-title', 'Channels in X'), channelBox,
      h('p.muted', { style: { fontSize: '11.5px' } }, 'Scatter and time go into obs, with the sample, its annotations, each event\'s populations (a True/False column per gate under the population, and the deepest as a category) and clusters; maps (UMAP, t-SNE) into obsm; where the file came from into uns. Channels some samples lack are left out.'));
    const summary = h('p.muted', { style: { fontSize: '12px' } });
    const update = () => {
      amountField.hidden = mode.value === 'none';
      seedField.hidden = mode.value === 'none';
      amountField.querySelector('span').textContent = mode.value === 'fraction' ? 'Share (%)' : 'Events per sample';
      valuesField.hidden = format.value !== 'fcs';
      h5adFields.hidden = format.value !== 'h5ad';
      cofactor.disabled = xValues.value !== 'arcsinh';
      const picked = ws.samples.filter((s) => chosen.has(s.id));
      const total = picked.reduce((sum, s) => sum + (s.eventCount ?? 0), 0);
      summary.textContent = `${picked.length} sample${picked.length === 1 ? '' : 's'}, ${formatCount(total)} events before the population and downsampling.${format.value === 'fcs' ? ' The file adds SampleID (1, 2, … in this order; the names are in its keywords) and SourceEvent (each event\'s index in its own file).' : ''}`;
    };
    for (const el of [mode, format, xValues, popSelect]) el.addEventListener('change', update);
    renderList();
    update();
    showDialog({
      title: 'Export events',
      width: 'wide',
      content: [
        h('p.muted', { style: { marginTop: 0 } }, 'A population\'s events in the chosen samples, as one concatenated FCS file (for tools that cluster several samples together), one FCS file per sample, or an AnnData file for scanpy and R.'),
        h('div.split', { style: { gap: '16px' } },
          h('div', h('div.section-title', 'Samples'), list, quick),
          h('div',
            h('label.field', h('span', 'Population'), popSelect),
            h('div.row', { style: { gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' } }, h('label.field', h('span', 'Events'), mode), amountField, seedField),
            h('label.field', h('span', 'Format'), format),
            valuesField)),
        h5adFields,
        summary,
      ],
      buttons: [
        { label: 'Cancel', ghost: true },
        {
          label: 'Export',
          primary: true,
          onClick: () => {
            if (!chosen.size) {
              toast('Choose at least one sample.', { kind: 'error' });
              return false;
            }
            const downsample = mode.value === 'none' ? { mode: 'none' } : { mode: mode.value, value: mode.value === 'fraction' ? Number(amount.value) / 100 : Number(amount.value), seed: Number(seed.value) || 1 };
            if (downsample.mode !== 'none' && !(downsample.value > 0)) {
              toast('Give how many events to keep.', { kind: 'error' });
              return false;
            }
            runExport({ sampleIds: ws.samples.filter((s) => chosen.has(s.id)).map((s) => s.id), populationId: popSelect.value, downsample, format: format.value, values: values.value, channels: catalog.filter((c) => xChannels.has(c.name)).map((c) => c.name), xValues: xValues.value, cofactor: Number(cofactor.value) || 150 });
            return true;
          },
        },
      ],
    });
  };

  async function runExport(options) {
    const progress = progressToast(`Loading ${options.sampleIds.length} samples…`);
    try {
      const out = await app.buildEventsExport(options, (f) => progress.update(f * 0.8));
      const type = options.format === 'h5ad' ? 'application/x-hdf5' : options.format === 'zip' ? 'application/zip' : 'application/octet-stream';
      downloadBlob(new Blob([out.bytes], { type }), out.name);
      const dropped = out.report.dropped?.length ? ` Channels not in every sample were left out: ${out.report.dropped.slice(0, 6).join(', ')}.` : '';
      progress.done(`Wrote ${formatCount(out.report.events)} events of ${out.report.samples.length} samples.${dropped}`);
      for (const note of out.notes.slice(0, 3)) toast(note);
    } catch (error) {
      progress.fail(`The export failed: ${error.message}`);
    }
  }

  // --- CSV import -----------------------------------------------------------------------------

  // Imports CSV files of events. Interactive: a dialog per set of files with the same columns;
  // otherwise (agents) the guesses as they are. Returns [{ file, rows, columns, samples, dropped,
  // notes, problems }].
  app.importEventCSVs = async (items, { interactive = true } = {}) => {
    const lib = await import('../lib/csv-events.js');
    const analyses = [];
    for (const item of items) {
      try {
        const text = item.text ?? new TextDecoder().decode(item.bytes ?? new Uint8Array(await item.file.arrayBuffer()));
        analyses.push(lib.analyzeCSV(text, item.name));
      } catch (error) {
        toast(`${item.name}: ${error.message}`, { kind: 'error' });
      }
    }
    const groups = new Map();
    for (const a of analyses) {
      const key = a.columns.map((c) => c.name).join('\u0000');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const results = [];
    for (const group of groups.values()) {
      const choice = interactive ? await csvDialog(lib, group) : { columns: group[0].columns.map((c) => ({ include: c.include, kind: c.kind, scale: c.scale, marker: c.marker, name: c.name })), splitBy: undefined };
      if (!choice) continue;
      results.push(...await importAnalyses(lib, group, choice));
    }
    return results;
  };

  async function importAnalyses(lib, group, choice) {
    const { writeFCS } = await import('../lib/fcs.js');
    const out = [];
    for (const analysis of group) {
      analysis.columns.forEach((c, j) => Object.assign(c, choice.columns[j]));
      let datasets;
      try {
        datasets = lib.csvDatasets(analysis, { splitBy: choice.splitBy });
      } catch (error) {
        toast(`${analysis.fileName}: ${error.message}`, { kind: 'error' });
        continue;
      }
      const files = datasets.datasets.map((d, order) => ({ name: `${safeName(d.name, 'events')}.fcs`, bytes: writeFCS(d), order }));
      const before = { ...store.ws.channelSettings };
      const records = await app.importFCSItems(files, { noGroups: true });
      // Kinds and scales as chosen.
      let ws = store.ws;
      const included = analysis.columns.filter((c) => c.include && c.index !== choice.splitBy);
      for (const record of records) {
        const kinds = new Map(included.map((c) => [c.name, c.kind]));
        const sample = ws.samples.find((s) => s.id === record.id);
        if (sample) ws = updateSample(ws, record.id, { channels: sample.channels.map((ch) => (kinds.has(ch.name) ? { ...ch, type: kinds.get(ch.name) } : ch)) });
      }
      // The chosen scales, except for channels the workspace had before.
      const kept = [];
      for (const c of included) {
        if (before[c.name]?.transform) kept.push(c.name);
        else ws = setChannelTransform(ws, c.name, lib.scaleFor(c, records[0]?.technology));
      }
      store.commit(ws, `Scales of ${analysis.fileName}`, ['samples']);
      out.push({ file: analysis.fileName, rows: analysis.rows, format: analysis.format, columns: included.map((c) => ({ name: c.name, marker: c.marker, kind: c.kind, scale: c.scale, note: c.note })), samples: records.map((r) => r.name), dropped: datasets.dropped, notes: [...analysis.notes, ...(kept.length ? [`kept the workspace's scales of ${kept.join(', ')}`] : [])], problems: analysis.problems });
      if (datasets.dropped) toast(`${analysis.fileName}: ${datasets.dropped.toLocaleString('en-US')} rows with an empty or non-numeric value in an imported column were left out.`);
    }
    return out;
  }

  function csvDialog(lib, group) {
    const a = group[0];
    return new Promise((resolve) => {
      const choices = a.columns.map((c) => ({ include: c.include, kind: c.kind, scale: c.scale, marker: c.marker, name: c.name }));
      const rows = group.reduce((sum, x) => sum + x.rows, 0);
      const labelColumns = a.columns.filter((c) => c.labels);
      const split = h('select.input.small', h('option', { value: '' }, 'One sample per file'), ...labelColumns.map((c) => h('option', { value: c.index }, `One sample per value of ${c.name} (${c.distinct.size})`)));
      const kinds = [['fluorescence', 'Fluorescence or mass'], ['scatter', 'Scatter'], ['time', 'Time'], ['other', 'Other']];
      const scales = [['logicle', 'Logicle'], ['arcsinh', 'arcsinh (cofactor 5)'], ['linear', 'Linear'], ['transformed', 'Already transformed (linear)']];
      const body = h('tbody', ...a.columns.map((c, j) => h('tr',
        h('td', h('input', { type: 'checkbox', checked: choices[j].include, 'aria-label': `Import ${c.name}`, onchange: (e) => { choices[j].include = e.target.checked; } })),
        h('td', c.name),
        h('td', h('input.input.small', { value: choices[j].marker, 'aria-label': `Marker of ${c.name}`, style: { width: '100px' }, onchange: (e) => { choices[j].marker = e.target.value.trim(); } })),
        h('td', h('select.input.small', { 'aria-label': `Kind of ${c.name}`, onchange: (e) => { choices[j].kind = e.target.value; } }, ...kinds.map(([v, l]) => h('option', { value: v, selected: v === c.kind }, l)))),
        h('td', h('select.input.small', { 'aria-label': `Scale of ${c.name}`, onchange: (e) => { choices[j].scale = e.target.value; } }, ...scales.map(([v, l]) => h('option', { value: v, selected: v === c.scale }, l)))),
        h('td.r', { style: { whiteSpace: 'nowrap' } }, Number.isFinite(c.min) ? `${+c.min.toPrecision(4)} to ${+c.max.toPrecision(4)}` : '—'),
        h('td.muted', { style: { fontSize: '11.5px' } }, c.note))));
      const format = `${a.format.delimiter === '\t' ? 'tab' : a.format.delimiter === ';' ? 'semicolon' : 'comma'}-separated${a.format.decimalComma ? ', decimal commas' : ''}${a.format.header ? '' : ', no header (columns numbered)'}`;
      showDialog({
        title: group.length === 1 ? `Import events: ${a.fileName}` : `Import events: ${group.length} CSV files`,
        width: 'wide',
        content: [
          h('p', { style: { marginTop: 0 } }, `${formatCount(rows)} events in ${a.columns.length} columns (${format}).${group.length > 1 ? ` The same columns in ${group.map((g) => g.fileName).join(', ')}.` : ''} Each file becomes a sample, stored as an FCS file (values as 32-bit floats).`),
          ...[...a.problems, ...a.notes].map((p) => h('div.callout.warn', icon('warning'), h('span', p))),
          h('div', { style: { maxHeight: '340px', overflow: 'auto' } }, h('table.data', h('thead', h('tr', h('th', ''), h('th', 'Column'), h('th', 'Marker'), h('th', 'Kind'), h('th', 'Scale'), h('th.r', 'Values'), h('th', 'Check'))), body)),
          labelColumns.length ? h('label.field', { style: { marginTop: '8px' } }, h('span', 'Samples'), split) : null,
          h('p.muted', { style: { fontSize: '11.5px' } }, 'Rows with an empty or non-numeric value in an imported column are left out. Scales can be changed later in the Gate view; a channel the workspace already has keeps its scale.'),
        ],
        buttons: [
          { label: 'Cancel', ghost: true, onClick: () => { resolve(null); return true; } },
          { label: 'Import', primary: true, onClick: () => { resolve({ columns: choices, splitBy: split.value === '' ? undefined : Number(split.value) }); return true; } },
        ],
        onClose: () => resolve(null),
      });
    });
  }
}
