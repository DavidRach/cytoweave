// Moving from FlowJo: the import dialog (what the workspace holds, which FCS files match, how
// faithfully each population converts), the import itself as one undoable edit, and the
// migration report, which recomputes every imported population and compares its count with the
// count FlowJo saved. Also the dialog that exports populations as an ISAC CLR file.

import { h, icon, clear, downloadBlob, formatCount } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { countOf, population, populationSet } from '../lib/engine.js';
import { gateById, gatePath } from '../lib/workspace.js';
import { writeCLR } from '../lib/clr.js';
import {
  buildFlowJoMigration,
  consensusTransforms,
  explainCountRows,
  fidelityNote,
  matchFlowJoSamples,
  migrationCSV,
  migrationCountRows,
  planCompensations,
  sameSpillover,
  scaleChanges,
  summarizeCountRows,
  summarizeFidelity,
} from '../lib/flowjo-match.js';

const FIDELITY_BADGE = { imported: 'ok', approximated: 'warn', unsupported: 'danger' };
const COUNT_BADGE = { exact: ['ok', 'exact'], close: ['accent', 'within 1%'], differs: ['danger', 'differs'], missing: ['warn', 'not compared'] };
const REPORT_LIMIT = 400;

const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));
const plural = (n, word, many = `${word}s`) => `${formatCount(n)} ${n === 1 ? word : many}`;
const baseName = (fileName) => String(fileName ?? 'flowjo').replace(/\.[^.]+$/, '');

function statTile(label, value, badge) {
  return h('div.stat-tile', h('div.k', label), h('div.v', badge ? h(`span.badge.${badge}`, value) : value));
}

function distinctMatrices(samples) {
  const out = [];
  for (const s of samples) if (s.compensation && !out.some((c) => sameSpillover(c, s.compensation, 1e-9))) out.push(s.compensation);
  return out;
}

// --- Import dialog -------------------------------------------------------------------------------

// Shows what a parsed FlowJo workspace (importFlowJo's result) holds and imports it on request.
// Resolves to the migration record, or null when cancelled.
export function applyFlowJoImport(app, result, fileName = 'FlowJo workspace') {
  const { store } = app;
  return new Promise((resolve) => {
    let matches = matchFlowJoSamples(result.samples, store.ws.samples);
    const fidelity = summarizeFidelity(result.fidelity ?? []);
    const paths = new Set(result.samples.flatMap((s) => Object.keys(s.populationCounts ?? {})));
    const matrices = distinctMatrices(result.samples);
    const consensus = consensusTransforms(result.samples);
    const groups = (result.groups ?? []).filter((g) => !g.builtIn && !/^all samples$/i.test(g.name));
    const options = { scales: store.ws.gates.length ? 'missing' : 'all', compensation: true, compare: true };
    let finished = false;

    const fileInput = h('input', { type: 'file', multiple: true, accept: '.fcs,.lmd', style: { display: 'none' }, onchange: () => addFiles([...fileInput.files]) });
    const folderInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, style: { display: 'none' }, onchange: () => addFiles([...folderInput.files].filter((f) => /\.(fcs|lmd)$/i.test(f.name))) });
    const body = h('div');

    async function addFiles(files) {
      if (!files.length) return;
      await app.importFCSItems(files.map((file, order) => ({ file, name: file.name, order, folder: null })), { select: false, noGroups: true });
      matches = matchFlowJoSamples(result.samples, store.ws.samples);
      render();
    }

    function samplesTable() {
      const rows = matches.map((m) => h('tr',
        h('td', m.flowJo.name, m.flowJo.fileName && m.flowJo.fileName !== m.flowJo.name ? h('div.muted', { style: { fontSize: '11px' } }, m.flowJo.fileName) : null),
        h('td.r', Number.isFinite(m.flowJo.eventCount) ? formatCount(m.flowJo.eventCount) : '—'),
        h('td', m.flowJo.groupNames.filter((g) => !/^all samples$/i.test(g)).join(', ') || h('span.muted', '—')),
        h('td', m.sample
          ? [h('span.badge.ok', `matched by ${m.how}`), m.sample.name !== m.flowJo.name.replace(/\.(fcs|lmd)$/i, '') ? h('span.muted', { style: { marginLeft: '6px' } }, m.sample.name) : null]
          : h('span.badge.warn', 'not in this workspace'),
        m.note ? h('div.muted', { style: { fontSize: '11px' } }, m.note) : null)));
      return h('div', { style: { maxHeight: '220px', overflow: 'auto' } },
        h('table.data', h('thead', h('tr', h('th', 'FlowJo sample'), h('th.r', 'Events'), h('th', 'Groups'), h('th', 'FCS file in CytoWeave'))), h('tbody', rows)));
    }

    function fidelityDetails() {
      const attention = fidelity.paths.filter((r) => r.status !== 'imported');
      if (!attention.length && !fidelity.transforms.length) return h('p.muted', 'Every population converts exactly.');
      const list = h('div', { style: { maxHeight: '240px', overflow: 'auto' } },
        h('table.data', h('tbody', [...attention, ...fidelity.transforms].map((row) => h('tr',
          h('td', h(`span.badge.${FIDELITY_BADGE[row.status]}`, row.status)),
          h('td', row.path.startsWith('transform:') ? `Scale of ${row.path.slice(10)}` : row.path),
          h('td.muted', { style: { fontSize: '11.5px' } }, fidelityNote(row, 4), row.entries.length > 1 ? ` (${new Set(row.entries.map((e) => e.sample)).size} samples)` : ''))))));
      return h('details', h('summary', { style: { cursor: 'pointer', margin: '6px 0' } }, `Populations that are approximated or not imported (${attention.length})`), list);
    }

    function render() {
      clear(body);
      const matched = matches.filter((m) => m.sample);
      const missing = matches.filter((m) => !m.sample);
      const scales = scaleChanges(store.ws, consensus);
      const compPlans = planCompensations(matches);
      body.append(
        h('p', `${fileName}${result.flowJoVersion ? ` · FlowJo ${result.flowJoVersion}` : ''}. CytoWeave rebuilds FlowJo's gating tree with FlowJo's axis scales and compensation, then checks every population count against the count FlowJo saved.`),
        h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(5, 1fr)' } },
          statTile('Samples matched', `${matched.length} / ${matches.length}`),
          statTile('Populations', formatCount(paths.size)),
          statTile('Groups', formatCount(groups.length)),
          statTile('Compensation matrices', formatCount(matrices.length)),
          statTile('Channel scales', formatCount(Object.keys(consensus).length))),
        h('div.section-title', { style: { marginTop: '14px' } }, 'How faithfully the gates convert'),
        h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(3, 1fr)' } },
          statTile('Exact', formatCount(fidelity.counts.imported), 'ok'),
          statTile('Approximated', formatCount(fidelity.counts.approximated), fidelity.counts.approximated ? 'warn' : null),
          statTile('Not imported', formatCount(fidelity.counts.unsupported), fidelity.counts.unsupported ? 'danger' : null)),
        h('p.muted', { style: { fontSize: '12px' } }, 'Exact populations select the same events as in FlowJo. Approximated ones may differ for events near the gate boundary (the reason is listed); the migration report shows by how much. Populations that are not imported must be redrawn.'),
        fidelityDetails(),
        h('div.section-title', { style: { marginTop: '14px' } }, 'Samples'),
        samplesTable());
      if (missing.length) {
        body.append(h('div.callout.warn', { style: { marginTop: '10px' } },
          h('p', { style: { margin: '0 0 8px' } }, `${plural(missing.length, 'FlowJo sample')} ${missing.length === 1 ? 'has' : 'have'} no FCS file in this workspace. Add the files to import their sample-specific gate adjustments and compare counts, or continue with the gates alone.`),
          h('div.btn-row',
            h('button.btn.small', { type: 'button', onclick: () => { fileInput.value = ''; fileInput.click(); } }, icon('file'), 'Add the FCS files…'),
            h('button.btn.small', { type: 'button', onclick: () => { folderInput.value = ''; folderInput.click(); } }, icon('folder'), 'Add a folder…'),
            h('span.muted', { style: { fontSize: '11px' } }, `FlowJo read them from ${commonFolder(missing.map((m) => m.flowJo.uri)) || 'another computer'}.`))));
      }
      if (result.warnings?.length) {
        body.append(h('details', h('summary', { style: { cursor: 'pointer', margin: '8px 0' } }, `Notes from reading the workspace (${result.warnings.length})`),
          h('ul', { style: { margin: '0', paddingLeft: '18px', fontSize: '12px' } }, result.warnings.slice(0, 50).map((w) => h('li', w)))));
      }
      const scaleSelect = h('select.input', { onchange: (event) => { options.scales = event.target.value; } },
        h('option', { value: 'all', selected: options.scales === 'all' }, `Use FlowJo's scales (${scales.differ.length + scales.unset.length} of ${Object.keys(consensus).length} channels change)`),
        h('option', { value: 'missing', selected: options.scales === 'missing' }, `Only for channels without a scale (${scales.unset.length})`),
        h('option', { value: 'none', selected: options.scales === 'none' }, 'Keep the current scales'));
      const fileKept = compPlans.find((p) => p.kind === 'file')?.sampleIds.length ?? 0;
      const newMatrices = compPlans.filter((p) => p.kind === 'matrix').length;
      const compCount = compPlans.reduce((n, p) => n + p.sampleIds.length, 0);
      body.append(
        h('div.section-title', { style: { marginTop: '14px' } }, 'Options'),
        h('label.field', h('span', 'Axis scales'), scaleSelect,
          h('span.muted', { style: { fontWeight: 400 } }, 'Each gate keeps the scale it was drawn on either way; this sets how plots draw the axes.')),
        h('label.check', h('input', { type: 'checkbox', checked: options.compensation && compCount > 0, disabled: !compCount, onchange: (event) => { options.compensation = event.target.checked; } }),
          compCount
            ? `Apply FlowJo's compensation to ${plural(compCount, 'matched sample')}${fileKept ? ` (${fileKept} keep${fileKept === 1 ? 's' : ''} the file's own matrix, which FlowJo used)` : ''}${newMatrices ? `; adds ${plural(newMatrices, 'matrix', 'matrices')}` : ''}`
            : 'No compensation to apply (no matched sample has a FlowJo matrix)'),
        h('label.check', { style: { marginTop: '6px' } }, h('input', { type: 'checkbox', checked: options.compare && matched.length > 0, disabled: !matched.length, onchange: (event) => { options.compare = event.target.checked; } }),
          matched.length ? `Then load the ${plural(matched.length, 'matched sample')} and compare every population count with FlowJo's` : 'Counts can be compared once FCS files are matched'),
        fileInput, folderInput);
      const primary = dialog?.dialog.querySelector('.dialog-foot .btn.primary');
      if (primary) primary.textContent = matched.length ? 'Import' : 'Import gates only';
    }

    const dialog = showDialog({
      title: 'Import FlowJo workspace',
      width: 'wide',
      content: body,
      buttons: [
        { label: 'Cancel', ghost: true },
        { label: 'Import', primary: true, onClick: () => { finished = true; runImport(); return true; } },
      ],
      onClose: () => { if (!finished) resolve(null); },
    });
    render();

    function runImport() {
      let plan;
      try {
        plan = buildFlowJoMigration(store.ws, result, matches, { fileName, scales: options.scales, compensation: options.compensation });
      } catch (error) {
        toast(`The FlowJo import failed: ${error.message}`, { kind: 'error' });
        resolve(null);
        return;
      }
      store.commit(plan.ws, `Import FlowJo workspace ${fileName}`, ['samples', 'groups', 'gates', 'compensation', 'scales', 'migration']);
      app.data.syncAll?.();
      const populations = Object.keys(plan.migration.gates).length;
      const approximated = plan.fidelity.counts.approximated;
      toast(`Imported ${plural(populations, 'population')} from ${fileName}${approximated ? `; ${approximated} approximated` : ''}.`, { kind: 'ok' });
      for (const warning of plan.warnings.slice(0, 3)) toast(warning);
      if (store.ui.mode === 'welcome') app.setMode('gate');
      const top = plan.gates.find((g) => !g.parentId && !g.meta.helper);
      if (top) app.selectGate(top.id, { keepMode: true });
      resolve(plan.migration);
      if (options.compare && plan.migration.samples.some((s) => s.sampleId)) {
        runMigrationComparison(app, plan.migration.id).then((ok) => { if (ok) showMigrationReport(app, plan.migration.id); });
      }
    }
  });
}

function commonFolder(uris) {
  const folders = uris.filter(Boolean).map((uri) => {
    let path = String(uri).replace(/^file:(\/\/)?/, '');
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep as written
    }
    return path.replace(/[\\/][^\\/]*$/, '');
  });
  if (!folders.length) return '';
  return folders.every((f) => f === folders[0]) ? folders[0] : '';
}

// --- Count comparison ----------------------------------------------------------------------------

// Loads each matched sample, recomputes every imported population and stores the counts in the
// migration record (without an undo step: it is a measurement, not an edit). Resolves to true
// when at least one sample was compared.
export async function runMigrationComparison(app, migrationId) {
  const { store, data } = app;
  const find = () => (store.ws.migrations ?? []).find((m) => m.id === migrationId);
  const migration = find();
  if (!migration) return false;
  const targets = migration.samples.filter((s) => s.sampleId && store.ws.samples.some((w) => w.id === s.sampleId));
  if (!targets.length) return false;
  let cancelled = false;
  const progress = progressToast(`Comparing counts with FlowJo on ${plural(targets.length, 'sample')}…`, () => { cancelled = true; });
  const counts = {};
  const errors = {};
  for (const [i, target] of targets.entries()) {
    if (cancelled) break;
    const record = store.ws.samples.find((s) => s.id === target.sampleId);
    progress.update(i / targets.length, `Recomputing populations on ${record?.name ?? target.flowJoName} (${i + 1}/${targets.length})`);
    try {
      const view = await data.ensure(target.sampleId);
      const ws = store.ws;
      const out = {};
      for (const [path, gateId] of Object.entries(migration.gates)) {
        if (!gateById(ws, gateId)) continue;
        try {
          const indices = populationSet(view, ws, gateId);
          out[path] = indices === undefined ? null : countOf(indices, view);
        } catch {
          out[path] = null;
        }
      }
      counts[target.sampleId] = out;
    } catch (error) {
      errors[target.sampleId] = error.message;
    }
    await yieldToPage();
  }
  const compared = Object.keys(counts).length;
  if (!compared) {
    progress.fail(cancelled ? 'Comparison cancelled.' : `No sample could be loaded: ${Object.values(errors)[0] ?? 'unknown error'}`);
    return false;
  }
  progress.done(`Compared ${plural(compared, 'sample')} with FlowJo.`);
  const comparison = { time: new Date().toISOString(), counts, errors, partial: cancelled || compared < targets.length };
  const current = find();
  if (current) store.replace({ ...store.ws, migrations: store.ws.migrations.map((m) => (m.id === migrationId ? { ...m, comparison } : m)) }, ['migration']);
  return true;
}

// --- Migration report ----------------------------------------------------------------------------

// "+0.42%", or the event difference when FlowJo's count is zero.
function differenceText(row) {
  if (row.cytoweave === null || row.difference === null) return '—';
  const sign = row.difference > 0 ? '+' : row.difference < 0 ? '−' : '';
  if (Number.isFinite(row.relative)) return `${sign}${Math.abs(100 * row.relative).toFixed(2)}%`;
  return `${sign}${formatCount(Math.abs(row.difference))} events`;
}

// The report of a FlowJo import (the latest when migrationId is omitted): FlowJo's counts beside
// CytoWeave's for every population and sample, worst first, with likely causes.
export async function showMigrationReport(app, migrationId) {
  const { store } = app;
  const all = store.ws.migrations ?? [];
  let migration = all.find((m) => m.id === migrationId) ?? all[all.length - 1];
  if (!migration) {
    toast('This workspace has no FlowJo import to report on.');
    return;
  }
  if (!migration.comparison && migration.samples.some((s) => s.sampleId)) {
    await runMigrationComparison(app, migration.id);
    migration = (store.ws.migrations ?? []).find((m) => m.id === migration.id) ?? migration;
  }
  const rows = explainCountRows(migrationCountRows(migration), migration);
  const summary = summarizeCountRows(rows);
  let filter = 'all';
  const tableHost = h('div', { style: { maxHeight: '52vh', overflow: 'auto' } });
  const filters = h('div.segmented');
  const FILTERS = [['all', 'All'], ['differs', 'Differs'], ['missing', 'Not compared'], ['close', 'Within 1%'], ['exact', 'Exact']];

  const show = (row) => {
    dialog.close();
    app.selectSample(row.sampleId);
    app.selectGate(row.gateId);
    app.setMode('gate');
  };

  function renderFilters() {
    clear(filters);
    for (const [id, label] of FILTERS) {
      const n = id === 'all' ? rows.length : summary[id];
      filters.append(h(`button${filter === id ? '.active' : ''}`, { type: 'button', onclick: () => { filter = id; renderFilters(); renderTable(); } }, `${label} (${formatCount(n)})`));
    }
  }

  function renderTable() {
    clear(tableHost);
    const visible = rows.filter((r) => filter === 'all' || r.status === filter);
    if (!visible.length) {
      tableHost.append(h('p.muted', 'No populations in this category.'));
      return;
    }
    const ws = store.ws;
    const body = h('tbody', visible.slice(0, REPORT_LIMIT).map((row) => {
      const [badge, label] = COUNT_BADGE[row.status];
      const gate = row.gateId ? gateById(ws, row.gateId) : null;
      return h('tr',
        h('td', row.path),
        h('td', row.sampleName),
        h('td.r', formatCount(row.flowjo)),
        h('td.r', row.cytoweave === null ? '—' : formatCount(row.cytoweave)),
        h('td.r', differenceText(row)),
        h('td', h(`span.badge.${badge}`, label)),
        h('td.muted', { style: { fontSize: '11.5px', maxWidth: '300px' } }, (row.causes ?? []).join('; ')),
        h('td', gate ? h('button.btn.small', { type: 'button', title: 'Show this population on this sample', onclick: () => show(row) }, icon('target'), 'Show') : null));
    }));
    tableHost.append(h('table.data',
      h('thead', h('tr', h('th', 'Population'), h('th', 'Sample'), h('th.r', 'FlowJo'), h('th.r', 'CytoWeave'), h('th.r', 'Difference'), h('th', 'Status'), h('th', 'Likely cause'), h('th', ''))),
      body));
    if (visible.length > REPORT_LIMIT) tableHost.append(h('p.muted', `Showing the first ${REPORT_LIMIT} of ${formatCount(visible.length)} rows; export the CSV for all of them.`));
  }

  const compared = rows.length - summary.missing;
  const headline = !rows.length
    ? (migration.samples.some((s) => s.sampleId) ? 'No counts were compared yet.' : 'No FCS file of this FlowJo workspace is in CytoWeave, so counts cannot be compared. Add the files and run the comparison.')
    : `${formatCount(summary.exact)} of ${formatCount(compared)} population counts agree exactly with FlowJo${summary.close ? `, ${formatCount(summary.close)} within 1%` : ''}${summary.differs ? `, and ${formatCount(summary.differs)} differ` : ''}.`;
  const errorCount = Object.keys(migration.comparison?.errors ?? {}).length;
  const content = [
    h('p', h('strong', headline), ` Imported from ${migration.source} on ${new Date(migration.imported).toLocaleString()}${migration.comparison ? `; counts computed ${new Date(migration.comparison.time).toLocaleString()}` : ''}.`),
    h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(4, 1fr)' } },
      statTile('Exact', formatCount(summary.exact), 'ok'),
      statTile('Within 1%', formatCount(summary.close), summary.close ? 'accent' : null),
      statTile('Differs', formatCount(summary.differs), summary.differs ? 'danger' : null),
      statTile('Not compared', formatCount(summary.missing), summary.missing ? 'warn' : null)),
    h('p.muted', { style: { fontSize: '12px' } }, 'CytoWeave recomputed each imported population from the FCS data. Small differences are expected: FlowJo evaluates gates at its display resolution, which moves events near gate boundaries (typically well under 1% of a large population, more for populations of a few dozen events), and gates marked approximated were converted to the closest CytoWeave gate. FlowJo\'s biexponential scale is reproduced exactly. Larger differences usually mean different compensation, a different FCS file, or a population whose parent already differs.'),
    migration.comparison?.partial || errorCount ? h('div.callout.warn', `Not every matched sample was compared${errorCount ? ` (${errorCount} could not be loaded: ${Object.values(migration.comparison.errors)[0]})` : ''}.`) : null,
    h('div.row', { style: { margin: '10px 0' } }, filters, h('span.grow')),
    tableHost,
  ];
  renderFilters();
  renderTable();
  const dialog = showDialog({
    title: 'FlowJo migration report',
    width: 'xwide',
    content,
    buttons: [
      { label: 'Export CSV', ghost: true, onClick: () => { downloadBlob(new Blob([migrationCSV(rows)], { type: 'text/csv' }), `${baseName(migration.source)}-flowjo-comparison.csv`); return false; } },
      { label: 'Recompute', ghost: true, onClick: async () => { if (await runMigrationComparison(app, migration.id)) setTimeout(() => showMigrationReport(app, migration.id), 0); return true; } },
      { label: 'Close', primary: true },
    ],
  });
}

// --- CLR export ------------------------------------------------------------------------------------

function gatesInTreeOrder(ws) {
  const gates = ws.gates.filter((g) => !g.meta?.helper);
  const ids = new Set(gates.map((g) => g.id));
  const children = new Map();
  for (const g of gates) {
    const parent = g.parentId && ids.has(g.parentId) ? g.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(g);
  }
  const out = [];
  const visit = (parent, depth) => {
    for (const g of children.get(parent) ?? []) {
      out.push({ gate: g, depth, leaf: !(children.get(g.id)?.length) });
      visit(g.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

// Lets the user pick populations and a sample and downloads an ISAC Classification Results (CLR)
// file: one column per population, one row per event, 1 where the event belongs to it.
export function exportCLRDialog(app) {
  const { store, data } = app;
  const ws = store.ws;
  if (!ws.samples.length) {
    toast('Add FCS files first: a CLR file classifies the events of one sample.');
    return;
  }
  const tree = gatesInTreeOrder(ws);
  if (!tree.length) {
    toast('Draw or import gates first: a CLR file records which events belong to which populations.');
    return;
  }
  const sampleSelect = h('select.input', ...ws.samples.map((s) => h('option', { value: s.id, selected: s.id === store.ui.sampleId }, s.name)));
  const naming = h('select.input', h('option', { value: 'name' }, 'Population name (path when names repeat)'), h('option', { value: 'path' }, 'Full path'));
  const boxes = new Map();
  const list = h('div', { style: { maxHeight: '44vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '6px 8px' } },
    tree.map(({ gate, depth }) => {
      const box = h('input', { type: 'checkbox', checked: gate.id === store.ui.gateId });
      boxes.set(gate.id, box);
      return h('label.check', { style: { paddingLeft: `${depth * 16}px`, margin: '3px 0' } }, box, gate.name, h('span.muted', { style: { fontSize: '11px' } }, gate.type));
    }));
  const setAll = (predicate) => { for (const { gate, leaf } of tree) boxes.get(gate.id).checked = predicate({ gate, leaf }); };
  showDialog({
    title: 'Export classification results (CLR)',
    width: 'wide',
    content: [
      h('p', 'Writes an ISAC Classification Results file for one sample: a CSV table with a column per population and a row per event, in the order of the FCS file (1 = the event belongs to the population). Other tools can read it alongside the FCS file.'),
      h('label.field', h('span', 'Sample'), sampleSelect),
      h('div.row', { style: { marginBottom: '6px' } }, h('span.field-label', 'Populations'), h('span.grow'),
        h('button.btn.small', { type: 'button', onclick: () => setAll(({ leaf }) => leaf) }, 'Leaf populations'),
        h('button.btn.small', { type: 'button', onclick: () => setAll(() => true) }, 'All'),
        h('button.btn.small', { type: 'button', onclick: () => setAll(() => false) }, 'None')),
      list,
      h('label.field', { style: { marginTop: '10px' } }, h('span', 'Column names'), naming),
    ],
    buttons: [
      { label: 'Cancel', ghost: true },
      {
        label: 'Download CLR',
        primary: true,
        onClick: async () => {
          const chosen = tree.filter(({ gate }) => boxes.get(gate.id).checked).map(({ gate }) => gate);
          if (!chosen.length) {
            toast('Choose at least one population.', { kind: 'error' });
            return false;
          }
          const sample = store.ws.samples.find((s) => s.id === sampleSelect.value);
          const progress = progressToast(`Classifying the events of ${sample.name}…`);
          try {
            const view = await data.ensure(sample.id);
            const current = store.ws;
            const names = chosen.map((g) => g.name);
            const label = (g) => (naming.value === 'path' || names.filter((n) => n === g.name).length > 1 ? gatePath(current, g.id) : g.name);
            const classes = [];
            const skipped = [];
            for (const gate of chosen) {
              const indices = population(view, current, gate.id);
              if (indices === undefined) {
                skipped.push(gate.name);
                continue;
              }
              classes.push({ name: label(gate), members: indices ?? Uint32Array.from({ length: view.eventCount }, (_, i) => i) });
            }
            if (!classes.length) {
              progress.fail(`None of the chosen populations applies to ${sample.name}.`);
              return false;
            }
            const text = writeCLR(view.eventCount, classes);
            downloadBlob(new Blob([text], { type: 'text/csv' }), `${sample.name}_CLR.csv`);
            progress.done(`Saved ${plural(classes.length, 'population')} for ${formatCount(view.eventCount)} events${skipped.length ? `; skipped ${skipped.join(', ')} (not applied to this sample)` : ''}.`);
            return true;
          } catch (error) {
            progress.fail(error.message);
            return false;
          }
        },
      },
    ],
  });
}
