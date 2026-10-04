// Export dialogs: the workspace as a FlowJo workspace (with a fidelity report and, optionally, its
// FCS files), and de-identified FCS files (a ZIP, or an ACS archive with the workspace).

import { h, icon, downloadBlob, formatCount } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { countOf, population } from '../lib/engine.js';
import { serializeWorkspace } from '../lib/workspace.js';

const STATUS = { exact: ['ok', 'Exact'], approximated: ['accent', 'Traced'], omitted: ['warn', 'Not exported'] };
const safeName = (name, fallback) => (name ?? '').replace(/[^\w.+-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;

function statTile(label, value, badge) {
  return h('div.stat-tile', h('div.k', label), h('div.v', badge ? h(`span.badge.${badge}`, value) : value));
}

export function installExportDialogs(app) {
  const { store, data, library } = app;

  async function fileBytes(sample) {
    if (!sample.sha256) return null;
    const stored = data.session.get(sample.sha256) ?? await library.getFile(sample.sha256);
    if (!stored) return null;
    return stored instanceof Uint8Array ? stored : new Uint8Array(await stored.arrayBuffer());
  }

  // Unique file names for the samples' de-identified copies: the sample name.
  function pseudonyms(samples) {
    const used = new Set();
    return new Map(samples.map((s) => {
      const base = safeName(s.name, 'sample');
      let name = `${base}.fcs`;
      for (let k = 2; used.has(name.toLowerCase()); k += 1) name = `${base}_${k}.fcs`;
      used.add(name.toLowerCase());
      return [s.id, name];
    }));
  }

  // --- FlowJo ---------------------------------------------------------------------------------

  app.exportFlowJo = async () => {
    const ws = store.ws;
    if (!ws.samples.length) {
      toast('Add samples first.');
      return;
    }
    const { exportFlowJo } = await import('../lib/flowjo-export.js');
    const { report } = exportFlowJo(ws, {});
    // One row per population path, with the samples it applies to.
    const byPath = new Map();
    for (const p of report.populations) {
      const key = `${p.status}|${p.path}|${p.detail}`;
      if (!byPath.has(key)) byPath.set(key, { ...p, samples: 0 });
      byPath.get(key).samples += 1;
    }
    const notExact = [...byPath.values()].filter((p) => p.status !== 'exact');
    const options = { counts: true, files: false, deidentify: false };
    const content = [
      h('p', 'FlowJo 10 and 11 open FlowJo workspaces (.wsp). Each sample gets its own gating tree: the gates that apply to it, with its own adjustments. Keep the FCS files in the same folder as the workspace, or include them below. FlowJo 11 (File → Import FlowJo v10 Workspace) asks to reconnect the files the first time: choose that folder.'),
      h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(3, 1fr)' } },
        statTile('Exact', formatCount(report.summary.exact), 'ok'),
        statTile('Traced on another scale', formatCount(report.summary.approximated), report.summary.approximated ? 'accent' : null),
        statTile('Not exported', formatCount(report.summary.omitted), report.summary.omitted ? 'warn' : null)),
      h('p.muted', { style: { fontSize: '12px' } }, 'Counts are per population and sample. "Traced" gates were drawn on a different scale than FlowJo will show (logicle and arcsinh scales are written as FlowJo\'s biexponential, the only one FlowJo 11 reads correctly): their outlines are written with enough vertices to follow the original. Gates FlowJo cannot evaluate (on channels CytoWeave computed, such as QC pass, clusters or unmixed channels, and gates of three or more dimensions) are left out with their children.'),
      notExact.length
        ? h('div', { style: { maxHeight: '220px', overflow: 'auto', margin: '6px 0 12px' } }, h('table.data',
          h('thead', h('tr', h('th', 'Population'), h('th', 'Status'), h('th.r', 'Samples'), h('th', 'Why'))),
          h('tbody', notExact.slice(0, 200).map((p) => h('tr',
            h('td', p.path),
            h('td', h(`span.badge.${STATUS[p.status][0]}`, STATUS[p.status][1])),
            h('td.r', String(p.samples)),
            h('td.muted', { style: { fontSize: '11.5px' } }, p.detail))))))
        : h('p', icon('check'), ' Every population is written exactly.'),
      ...report.warnings.slice(0, 5).map((w) => h('div.callout.warn', icon('warning'), h('span', w))),
      h('div.section-title', { style: { marginTop: '12px' } }, 'Options'),
      h('label.check', h('input', { type: 'checkbox', checked: true, onchange: (e) => { options.counts = e.target.checked; } }), 'Include the population counts (loads every sample), so the counts in FlowJo can be checked against CytoWeave\'s'),
      h('label.check', { style: { marginTop: '6px' } }, h('input', { type: 'checkbox', onchange: (e) => { options.files = e.target.checked; } }), 'Include the FCS files: a .zip with the workspace and its files'),
      h('label.check', { style: { marginTop: '6px' } }, h('input', { type: 'checkbox', onchange: (e) => { options.deidentify = e.target.checked; } }), 'Remove identifying keywords (operator, specimen, patient and free-text fields, dates, serial numbers) from the workspace and the files, which are named after their samples'),
    ];
    showDialog({
      title: 'Export as a FlowJo workspace',
      width: 'wide',
      content,
      buttons: [
        { label: 'Cancel', ghost: true },
        { label: 'Export', primary: true, onClick: () => { runFlowJoExport(options); } },
      ],
    });
  };

  // The FlowJo workspace (options: counts, files, deidentify, samples (ids; default all)) as
  // { bytes, name (a file name), kind ('wsp' or 'zip'), report, missing (files not in the library) }.
  app.buildFlowJoExport = async (options, onProgress = () => {}) => {
    const all = store.ws;
    const ids = options.samples ? new Set(options.samples) : null;
    const ws = ids ? { ...all, samples: all.samples.filter((s) => ids.has(s.id)), groups: all.groups.map((g) => ({ ...g, sampleIds: g.sampleIds.filter((id) => ids.has(id)) })) } : all;
    const { exportFlowJo } = await import('../lib/flowjo-export.js');
    const { deidentifyKeywords, deidentifyFCS } = await import('../lib/deidentify.js');
    const counts = new Map();
    if (options.counts) {
      let done = 0;
      for (const sample of ws.samples) {
        try {
          const view = await data.ensure(sample.id);
          const out = new Map();
          for (const gate of ws.gates) {
            const members = population(view, ws, gate.id);
            if (members !== undefined) out.set(gate.id, countOf(members, view));
          }
          counts.set(sample.id, out);
        } catch {
          // A sample whose file is not available gets no counts.
        }
        done += 1;
        onProgress(done / ws.samples.length);
      }
    }
    const names = options.deidentify ? pseudonyms(ws.samples) : null;
    const { xml, report } = exportFlowJo(ws, {
      counts: (sample) => counts.get(sample.id) ?? null,
      keywords: options.deidentify ? (sample) => deidentifyKeywords(sample.keywords ?? {}).keywords : undefined,
      fileName: names ? (sample) => names.get(sample.id) : undefined,
      version: app.version,
    });
    const base = safeName(all.name, 'workspace');
    if (!options.files) return { bytes: new TextEncoder().encode(xml), name: `${base}.wsp`, kind: 'wsp', report, missing: 0 };
    onProgress(0, 'Packing the FCS files…');
    const { createZip } = await import('../lib/zip.js');
    const files = [{ name: `${base}.wsp`, data: xml }];
    const seen = new Set();
    let missing = 0;
    for (const [i, sample] of ws.samples.entries()) {
      const name = names ? names.get(sample.id) : sample.fileName;
      if (seen.has(name)) continue;
      seen.add(name);
      const bytes = await fileBytes(sample);
      if (!bytes) {
        missing += 1;
        continue;
      }
      files.push({ name, data: options.deidentify ? deidentifyFCS(bytes, { fileName: name }).bytes : bytes, compress: false });
      onProgress((i + 1) / ws.samples.length);
    }
    return { bytes: await createZip(files), name: `${base}_FlowJo.zip`, kind: 'zip', report, missing };
  };

  async function runFlowJoExport(options) {
    const progress = progressToast(options.counts ? 'Counting every population for FlowJo…' : 'Writing the FlowJo workspace…');
    try {
      const out = await app.buildFlowJoExport(options, (f, message) => progress.update(f, message));
      downloadBlob(new Blob([out.bytes], { type: out.kind === 'zip' ? 'application/zip' : 'application/xml' }), out.name);
      if (out.missing) toast(`${out.missing} FCS file(s) were not in the library and are not in the archive.`, { kind: 'error' });
      const { exact, approximated, omitted } = out.report.summary;
      progress.done(`Exported the FlowJo workspace: ${formatCount(exact)} populations exact${approximated ? `, ${formatCount(approximated)} traced` : ''}${omitted ? `, ${formatCount(omitted)} not exported` : ''}.`);
    } catch (error) {
      progress.fail(`FlowJo export failed: ${error.message}`);
    }
  }

  // --- De-identified files --------------------------------------------------------------------

  app.exportDeidentified = async () => {
    const ws = store.ws;
    if (!ws.samples.length) {
      toast('Add samples first.');
      return;
    }
    const { deidentifyKeywords } = await import('../lib/deidentify.js');
    const options = { keepDates: false, format: 'zip' };
    const sample = ws.samples.find((s) => s.id === store.ui.sampleId) ?? ws.samples[0];
    const preview = h('div');
    const renderPreview = () => {
      const { removed } = deidentifyKeywords(sample.keywords ?? {}, { keepDates: options.keepDates });
      preview.replaceChildren(
        h('div.section-title', `Removed from ${sample.name}`),
        removed.length
          ? h('div', { style: { maxHeight: '180px', overflow: 'auto' } }, h('table.data', h('tbody', removed.slice(0, 80).map((r) => h('tr', h('td.mono', r.key), h('td.muted', { style: { fontSize: '11.5px' } }, r.value.length > 80 ? `${r.value.slice(0, 80)}…` : r.value))))))
          : h('p.muted', 'This file has no keywords to remove.'));
    };
    renderPreview();
    const format = (value, label) => h('label.check', h('input', { type: 'radio', name: 'deid-format', checked: options.format === value, onchange: () => { options.format = value; } }), label);
    showDialog({
      title: 'Export de-identified FCS files',
      width: 'wide',
      content: [
        h('p', 'Each file keeps the keywords needed to read and analyze it: parameters, markers, ranges, voltages, compensation, the instrument model, the time step, index-sort wells. Everything else is removed, including operator, specimen and patient fields, free-text comments, file names, serial numbers and vendor keywords. The events are copied byte for byte.'),
        h('div.callout', icon('info'), h('span', 'Files are named after their samples, and sample names are kept: rename any sample whose name identifies a person before exporting.')),
        preview,
        h('div.section-title', { style: { marginTop: '12px' } }, 'Options'),
        h('label.check', h('input', { type: 'checkbox', onchange: (e) => { options.keepDates = e.target.checked; renderPreview(); } }), 'Keep acquisition dates and times'),
        h('div', { style: { marginTop: '8px' } }, format('zip', 'FCS files (.zip)')),
        h('div', { style: { marginTop: '4px' } }, format('acs', 'Workspace with the FCS files (ACS archive)')),
      ],
      buttons: [
        { label: 'Cancel', ghost: true },
        { label: 'Export', primary: true, onClick: () => { runDeidentified(options); } },
      ],
    });
  };

  // De-identified FCS files (options: keepDates, format 'zip' or 'acs', samples (ids; default
  // all)) as { bytes, name, files (count), removed (kinds of keyword), missing }.
  app.buildDeidentified = async (options, onProgress = () => {}) => {
    const ws = store.ws;
    const ids = options.samples ? new Set(options.samples) : null;
    const samples = ws.samples.filter((s) => !ids || ids.has(s.id));
    const { deidentifyFCS, deidentifyWorkspace } = await import('../lib/deidentify.js');
    const { sha256 } = await import('../lib/sha256.js');
    const names = pseudonyms(samples);
    const files = [];
    const byHash = new Map();
    const removedKeys = new Set();
    let missing = 0;
    for (const [i, sample] of samples.entries()) {
      const bytes = await fileBytes(sample);
      if (!bytes) {
        missing += 1;
        continue;
      }
      const result = deidentifyFCS(bytes, { keepDates: options.keepDates, fileName: names.get(sample.id) });
      for (const r of result.removed) removedKeys.add(r.key);
      files.push({ name: names.get(sample.id), bytes: result.bytes });
      if (options.format === 'acs') byHash.set(sample.id, sha256(result.bytes));
      onProgress((i + 1) / samples.length);
    }
    const base = `${safeName(ws.name, 'workspace')}_deidentified`;
    if (options.format === 'acs') {
      const subset = ids ? { ...ws, samples } : ws;
      const scrubbed = deidentifyWorkspace(subset, { fileNames: names, hashes: byHash, keepDates: options.keepDates });
      const { createACS } = await import('../lib/acs.js');
      return { bytes: await createACS({ fcsFiles: files, workspaceJSON: serializeWorkspace(scrubbed) }), name: `${base}.acs`, files: files.length, removed: [...removedKeys], missing };
    }
    const { createZip } = await import('../lib/zip.js');
    return { bytes: await createZip(files.map((f) => ({ name: f.name, data: f.bytes, compress: false }))), name: `${base}.zip`, files: files.length, removed: [...removedKeys], missing };
  };

  async function runDeidentified(options) {
    const progress = progressToast('De-identifying the FCS files…');
    try {
      const out = await app.buildDeidentified(options, (f) => progress.update(f));
      downloadBlob(new Blob([out.bytes], { type: 'application/zip' }), out.name);
      if (out.missing) toast(`${out.missing} FCS file(s) were not in the library and are not in the archive.`, { kind: 'error' });
      progress.done(`De-identified ${out.files} file(s); removed ${out.removed.length} kinds of keyword.`);
    } catch (error) {
      progress.fail(`De-identified export failed: ${error.message}`);
    }
  }
}
