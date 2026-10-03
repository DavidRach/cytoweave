// Compensation: spillover matrices from files, controls or by hand; their quality (condition
// number, spreading); checks for leaning populations; and an N×N view of compensated pairs.

import { h, icon, clear, formatCount } from './dom.js';
import { shownColor } from '../lib/colormaps.js';
import { showMenu, toast, progressToast, promptDialog, confirmDialog } from './overlays.js';
import { conditionNumber, compensate, controlResiduals, leanCheck, identityMatrix } from '../lib/compensation.js';
import { spilloverFromControls } from './controls.js';
import { readSpillover } from '../lib/fcs.js';
import { buildPlotScene, drawScene } from '../lib/plot.js';
import { channelTransform, population } from '../lib/engine.js';
import { createTransform } from '../lib/transforms.js';
import { ROOT, addCompensation, channelLabel, gatePath, setSampleCompensation, updateCompensation } from '../lib/workspace.js';

function rasterImage(raster) {
  const canvas = new OffscreenCanvas(raster.width, raster.height);
  canvas.getContext('2d').putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  return canvas;
}

function cellColor(value, dark) {
  const v = Math.min(1, Math.abs(value) / 0.5);
  if (value < 0) return `rgba(76, 120, 224, ${0.12 + 0.6 * v})`;
  if (value === 0) return 'transparent';
  return `rgba(240, 128, 60, ${(dark ? 0.15 : 0.08) + 0.7 * v})`;
}

export function mountCompensateMode(app, container) {
  const { store, data } = app;
  let selectedId = null; // compensation id, or 'file:<sampleId>'
  let pairView = 'compensated';
  let pairSample = null;
  let ssm = null;

  const listHost = h('div');
  const controlsHost = h('div');
  const editorHost = h('div');
  const diagnosticsHost = h('div');
  const pairsHost = h('div');
  const root = h('div.view',
    h('div.workbench-head', h('h1', icon('compensate'), 'Compensation'), h('span.spacer'),
      h('button.btn.small', { type: 'button', onclick: () => newManual() }, icon('plus'), 'New matrix')),
    h('div.view-body', h('div.split',
      h('div', h('div.pane', h('h3', 'Matrices'), listHost), h('div.pane', h('h3', 'Compute from controls'), controlsHost)),
      h('div', { style: { minWidth: 0 } },
        h('div.pane', editorHost),
        h('div.pane', diagnosticsHost),
        h('div.pane', pairsHost)))));
  container.append(root);

  const dark = () => document.documentElement.dataset.theme === 'dark';

  // Matrices: the workspace's, and each distinct one embedded in the samples' files.
  function matrices() {
    const ws = store.ws;
    const list = ws.compensations.map((c) => ({ id: c.id, name: c.name, channels: c.channels, matrix: c.matrix, source: c.source, record: c }));
    const seen = new Set();
    for (const sample of ws.samples) {
      if (!sample.hasFileSpillover) continue;
      const view = data.view(sample.id);
      const spill = view ? readSpillover(view.dataset.keywords, view.parameters) : readSpillover(sample.keywords ?? {}, sample.channels);
      if (!spill || spill.identity) continue;
      const key = `${spill.channels.join(',')}|${Array.from(spill.matrix).map((v) => v.toFixed(6)).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ id: `file:${sample.id}`, name: `From ${sample.name} (${spill.keyword})`, channels: spill.channels, matrix: Array.from(spill.matrix), source: 'file', sampleId: sample.id });
    }
    return list;
  }

  function selected() {
    const list = matrices();
    return list.find((m) => m.id === selectedId) ?? list[0] ?? null;
  }

  function usage(matrixId, item) {
    return store.ws.samples.filter((s) => (item.source === 'file' && !item.record ? s.compensationId === 'file' : s.compensationId === matrixId)).length;
  }

  function renderList() {
    clear(listHost);
    const list = matrices();
    const current = selected();
    if (!list.length) {
      listHost.append(h('p.muted', 'No compensation matrices yet. The files have no $SPILLOVER keyword; compute one from single-stain controls or create one by hand.'));
      return;
    }
    for (const item of list) {
      const n = item.channels.length;
      const kappa = conditionNumber(item.matrix, n);
      listHost.append(h(`div.tree-row${item.id === current?.id ? '.selected' : ''}`, { style: { gridTemplateColumns: '18px 1fr auto' }, onclick: () => { selectedId = item.id; ssm = null; renderAll(); } },
        icon(item.source === 'file' ? 'file' : item.source === 'computed' ? 'sparkles' : 'compensate'),
        h('span.label', { title: item.name }, item.name),
        h('span.count', `${n}×${n} · κ ${kappa.toFixed(1)} · ${usage(item.id, item)} used`)));
    }
  }

  // --- Controls ---------------------------------------------------------------------------------

  function renderControls() {
    clear(controlsHost);
    const ws = store.ws;
    const controls = ws.samples.filter((s) => s.role === 'single-stain');
    const unstained = ws.samples.filter((s) => s.role === 'unstained');
    if (!controls.length) {
      controlsHost.append(h('p.muted', 'Mark single-stain controls with the role "Single stain" (sample menu → Set role). CytoWeave guesses the role and stained channel from names such as "FITC-A Stained Control".'));
      return;
    }
    const channels = [...new Set(ws.samples.flatMap((s) => s.channels.filter((c) => c.type === 'fluorescence').map((c) => c.name)))];
    const rows = h('tbody');
    for (const control of controls) {
      const select = h('select.input.small', { 'aria-label': `Stained channel of ${control.name}`, onchange: (event) => store.commit({ ...ws, samples: ws.samples.map((s) => (s.id === control.id ? { ...s, stain: event.target.value || null } : s)) }, 'Set stained channel') },
        h('option', { value: '' }, '— channel —'), ...channels.map((c) => h('option', { value: c, selected: c === control.stain }, channelLabel(ws, c))));
      rows.append(h('tr', h('td', { style: { maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: control.name }, control.name), h('td', select)));
    }
    const popSelect = h('select.input.small', h('option', { value: ROOT }, 'All events'), ...ws.gates.filter((g) => g.dims.every((d) => /^(FSC|SSC|FS|SS)/i.test(d.channel))).map((g) => h('option', { value: g.id }, gatePath(ws, g.id))));
    const method = h('select.input.small', h('option', { value: 'median' }, 'Median difference (FACSDiva, FlowJo)'), h('option', { value: 'regression' }, 'Robust regression (AutoSpill-style)'));
    const unstainedSelect = h('select.input.small', h('option', { value: '' }, 'Dim events of each control'), ...unstained.map((s) => h('option', { value: s.id }, s.name)));
    controlsHost.append(
      h('div', { style: { maxHeight: '220px', overflow: 'auto' } }, h('table.data', h('thead', h('tr', h('th', 'Control'), h('th', 'Stained channel'))), rows)),
      h('label.field', { style: { marginTop: '10px' } }, h('span', 'Events used (a scatter gate excludes debris)'), popSelect),
      h('label.field', h('span', 'Negative reference'), unstainedSelect),
      h('label.field', h('span', 'Method'), method),
      h('button.btn.primary.block', { type: 'button', onclick: () => computeFromControls(controls, popSelect.value, unstainedSelect.value, method.value) }, icon('sparkles'), 'Compute spillover'));
  }

  async function computeFromControls(controls, gateId, unstainedId, method) {
    const usable = controls.filter((c) => c.stain);
    if (usable.length < 2) {
      toast('Assign a stained channel to at least two controls.', { kind: 'error' });
      return;
    }
    const progress = progressToast('Computing spillover from controls…');
    try {
      const { detectors, matrix, report, spreading } = await spilloverFromControls(data, store.ws, { gateId, unstainedId, method, onProgress: (f, m) => progress.update(f, m) });
      const added = addCompensation(store.ws, { name: `Computed ${new Date().toLocaleDateString()} (${method})`, channels: detectors, matrix, source: 'computed', method, report });
      store.commit(added.ws, 'Compute compensation');
      selectedId = added.compensation.id;
      ssm = { channels: detectors, matrix: spreading.matrix };
      progress.done(`Computed a ${detectors.length}×${detectors.length} matrix from ${usable.length} controls.`);
      const warnings = report.flatMap((r) => r.warnings.map((w) => `${r.control}: ${w}`));
      for (const warning of warnings.slice(0, 4)) toast(warning);
      renderAll();
    } catch (error) {
      progress.fail(error.message);
    }
  }

  // --- Editor -------------------------------------------------------------------------------------

  function renderEditor() {
    clear(editorHost);
    const item = selected();
    const ws = store.ws;
    if (!item) {
      editorHost.append(h('div.empty', icon('compensate'), h('h3', 'Spillover matrix'), h('p', 'Rows are fluorochromes, columns are detectors: each cell is the fraction of a fluorochrome\'s signal that its detector sees. Compensation inverts the matrix.')));
      return;
    }
    const n = item.channels.length;
    const editable = Boolean(item.record);
    const kappa = conditionNumber(item.matrix, n);
    const table = h('table.matrix');
    table.append(h('thead', h('tr', h('th'), ...item.channels.map((c) => h('th', { title: c }, channelLabel(ws, c, { short: true }))))));
    const body = h('tbody');
    item.channels.forEach((rowChannel, i) => {
      const row = h('tr', h('th.rowhead', { title: rowChannel }, channelLabel(ws, rowChannel, { short: true })));
      item.channels.forEach((colChannel, j) => {
        const value = item.matrix[i * n + j];
        const input = h('input', { value: i === j ? '100' : (value * 100).toFixed(2), disabled: i === j || !editable, title: `${rowChannel} → ${colChannel}: ${(value * 100).toFixed(3)}%` });
        input.addEventListener('change', () => {
          const parsed = Number.parseFloat(input.value);
          if (!Number.isFinite(parsed)) return;
          const matrix = item.matrix.slice();
          matrix[i * n + j] = parsed / 100;
          store.commit(updateCompensation(store.ws, item.id, { matrix }), `Edit spillover ${rowChannel} → ${colChannel}`);
        });
        input.addEventListener('wheel', (event) => {
          if (!editable || i === j || document.activeElement !== input) return;
          event.preventDefault();
          const step = event.shiftKey ? 1 : 0.1;
          const parsed = Number.parseFloat(input.value) + (event.deltaY < 0 ? step : -step);
          input.value = parsed.toFixed(2);
          const matrix = item.matrix.slice();
          matrix[i * n + j] = parsed / 100;
          store.commit(updateCompensation(store.ws, item.id, { matrix }), `Edit spillover ${rowChannel} → ${colChannel}`);
        });
        row.append(h(`td${i === j ? '.diag' : ''}`, { style: { background: i === j ? 'var(--panel-2)' : cellColor(value, dark()) } }, input));
      });
      body.append(row);
    });
    table.append(body);
    const users = store.ws.samples.filter((s) => (item.record ? s.compensationId === item.id : s.compensationId === 'file'));
    editorHost.append(
      h('h3', item.name, h('span.spacer'),
        h(`span.badge.${kappa < 5 ? 'ok' : kappa < 20 ? 'warn' : 'danger'}`, { title: 'Condition number (2-norm): how much compensation can amplify noise' }, `κ = ${kappa.toFixed(2)}`),
        editable ? h('button.icon-button.small', { type: 'button', title: 'Rename', onclick: async () => { const name = await promptDialog({ title: 'Rename matrix', label: 'Name', value: item.name }); if (name) store.commit(updateCompensation(store.ws, item.id, { name }), 'Rename matrix'); } }, icon('edit')) : null,
        h('button.btn.small', { type: 'button', onclick: () => duplicate(item) }, icon('copy'), editable ? 'Duplicate' : 'Edit a copy'),
        h('button.btn.small.primary', { type: 'button', onclick: (event) => applyMenu(event.currentTarget, item) }, icon('check'), 'Apply to…')),
      h('p.muted', { style: { margin: '0 0 8px' } }, `Values are percent spillover (row fluorochrome into column detector). ${editable ? 'Edit a cell, or focus it and use the mouse wheel (⇧ for 1% steps); every edit can be undone.' : 'This matrix comes from a file; edit a copy to change it.'} Used by ${users.length} sample(s).`),
      h('div.matrix-wrap', { tabIndex: 0, role: 'region', 'aria-label': 'Spillover matrix' }, table));
    if (item.record?.report?.length) {
      const warnings = item.record.report.filter((r) => r.warnings?.length);
      editorHost.append(h('div', { style: { marginTop: '10px' } }, ...warnings.map((r) => h('div.callout.warn', { style: { marginTop: '6px' } }, icon('warning'), h('span', `${r.control ?? r.channel}: ${r.warnings.join(' ')}`)))));
    }
  }

  // A file's matrix is read-only: correct one entry in a copy, and move the samples that used the
  // file's matrix onto the copy, in one undoable step.
  function fixInCopy(item, i, j, value, suggestion) {
    const matrix = Array.from(item.matrix);
    matrix[i * item.channels.length + j] = value;
    const added = addCompensation(store.ws, { name: `${item.name.replace(/^From /, '')} (corrected)`, channels: item.channels, matrix, source: 'manual' });
    const users = store.ws.samples.filter((sample) => sample.compensationId === 'file').map((sample) => sample.id);
    const next = users.length ? setSampleCompensation(added.ws, users, added.compensation.id) : added.ws;
    store.commit(next, `Correct ${suggestion.from} → ${suggestion.to} in a copy of ${item.name}`);
    selectedId = added.compensation.id;
    leanResult = null;
    toast(`Made "${added.compensation.name}" with ${channelLabel(store.ws, suggestion.from, { short: true })} → ${channelLabel(store.ws, suggestion.to, { short: true })} at ${(100 * value).toFixed(2)}%${users.length ? `, now used by ${users.length} sample(s)` : ''}. Undo restores the file's matrix.`, { kind: 'ok', timeout: 6000 });
  }

  async function duplicate(item) {
    const added = addCompensation(store.ws, { name: `${item.name} (edited)`, channels: item.channels, matrix: item.matrix, source: 'manual' });
    store.commit(added.ws, 'Copy compensation');
    selectedId = added.compensation.id;
  }

  function newManual() {
    const ws = store.ws;
    const sample = ws.samples.find((s) => s.id === store.ui.sampleId) ?? ws.samples[0];
    if (!sample) {
      toast('Add samples first.');
      return;
    }
    const channels = sample.channels.filter((c) => c.type === 'fluorescence').map((c) => c.name);
    const added = addCompensation(ws, { name: 'New matrix', channels, matrix: identityMatrix(channels.length), source: 'manual' });
    store.commit(added.ws, 'New compensation');
    selectedId = added.compensation.id;
  }

  function applyMenu(anchor, item) {
    const ws = store.ws;
    const ensureRecord = () => {
      if (item.record) return item.id;
      return null;
    };
    const apply = (ids, label) => {
      const id = ensureRecord();
      store.commit(setSampleCompensation(store.ws, ids, id ?? 'file'), `Apply ${item.name} to ${label}`);
      toast(`Applied to ${ids.length} sample(s).`, { kind: 'ok' });
    };
    showMenu(anchor, [
      { label: 'All samples', onSelect: () => apply(ws.samples.map((s) => s.id), 'all samples') },
      { label: 'The current sample', disabled: !store.ui.sampleId, onSelect: () => apply([store.ui.sampleId], 'the current sample') },
      { label: 'Selected samples', disabled: !store.ui.selectedSamples.size, onSelect: () => apply([...store.ui.selectedSamples], 'the selection') },
      ...ws.groups.map((g) => ({ label: `Group: ${g.name}`, swatch: shownColor(ws, g, 'groups'), onSelect: () => apply(g.sampleIds, g.name) })),
    ]);
  }

  // --- Diagnostics -------------------------------------------------------------------------------

  function renderDiagnostics() {
    clear(diagnosticsHost);
    const item = selected();
    const ws = store.ws;
    diagnosticsHost.append(h('h3', 'Diagnostics', h('span.spacer'),
      h('button.btn.small.primary', { type: 'button', onclick: () => runControlCheck(item), title: 'Compensate each single-stain control with this matrix and measure what is left in the other detectors: the definitive check.' }, icon('check'), 'Check against the controls'),
      h('button.btn.small', { type: 'button', onclick: () => runLeanCheck(item), title: 'A hint only: compares bright and dim events of each channel in the current sample, where biology also differs.' }, icon('target'), 'Hint from the current sample')));
    if (ssm) diagnosticsHost.append(spreadingHeatmap(ssm));
    else diagnosticsHost.append(h('p.muted', 'The spillover spreading matrix appears after computing from controls: it shows how much each fluorochrome spreads the negative population in other detectors (Nguyen et al. 2013), the price paid for compensation.'));
    if (item?.lean) diagnosticsHost.append(leanList(item));
  }

  function spreadingHeatmap({ channels, matrix }) {
    const ws = store.ws;
    const n = channels.length;
    const table = h('table.matrix');
    table.append(h('thead', h('tr', h('th'), ...channels.map((c) => h('th', channelLabel(ws, c, { short: true }))))));
    const body = h('tbody');
    let max = 0;
    for (const v of matrix) if (Number.isFinite(v)) max = Math.max(max, v);
    channels.forEach((row, i) => {
      const tr = h('tr', h('th.rowhead', channelLabel(ws, row, { short: true })));
      channels.forEach((_, j) => {
        const v = matrix[i * n + j];
        const t = max ? v / max : 0;
        tr.append(h('td', { style: { background: i === j ? 'var(--panel-2)' : `rgba(214, 59, 74, ${0.05 + 0.75 * t})`, textAlign: 'right', padding: '4px 6px', minWidth: '52px' } }, i === j || !Number.isFinite(v) ? '' : v.toFixed(2)));
      });
      body.append(tr);
    });
    table.append(body);
    return h('div', h('div.section-title', 'Spillover spreading matrix'), h('div.matrix-wrap', { tabIndex: 0, role: 'region', 'aria-label': 'Spillover spreading matrix' }, table), h('p.muted', { style: { marginTop: '6px' } }, 'Large values in a column mean that detector will have wide negative populations when those fluorochromes are bright: pair dim markers with detectors that receive little spreading.'));
  }

  let leanResult = null;

  // The definitive check: each single-stain control compensated with the matrix should leave
  // nothing of its fluorochrome in the other detectors.
  async function runControlCheck(item) {
    if (!item) return;
    const ws = store.ws;
    const controls = ws.samples.filter((s) => s.role === 'single-stain' && s.stain && item.channels.includes(s.stain));
    if (!controls.length) {
      toast('Mark single-stain controls and their stained channels (left) to check the matrix against them.', { kind: 'error' });
      return;
    }
    const progress = progressToast(`Checking against ${controls.length} controls…`);
    try {
      const inputs = [];
      for (const [k, control] of controls.entries()) {
        const view = await data.ensure(control.id);
        const columns = Object.fromEntries(item.channels.filter((c) => view.raw.has(c)).map((c) => [c, view.raw.get(c)]));
        inputs.push({ channel: control.stain, columns });
        progress.update((k + 1) / controls.length, `Reading ${control.name}`);
      }
      const rows = controlResiduals(inputs, { channels: item.channels, matrix: item.matrix }, { threshold: 0.005 });
      leanResult = { item, suggestions: rows.slice(0, 15), sample: `${controls.length} single-stain controls`, source: 'controls' };
      progress.done();
      renderLean();
    } catch (error) {
      progress.fail(error.message);
    }
  }

  async function runLeanCheck(item) {
    const sampleId = store.ui.sampleId;
    if (!sampleId || !item) return;
    const view = await data.ensure(sampleId);
    const ws = store.ws;
    const indices = population(view, ws, store.ui.gateId ?? ROOT);
    const channels = item.channels.filter((c) => view.raw.has(c));
    const pick = (column) => {
      if (!indices) return column;
      const out = new Float32Array(indices.length);
      for (let i = 0; i < indices.length; i += 1) out[i] = column[indices[i]];
      return out;
    };
    const raw = Object.fromEntries(channels.map((c) => [c, pick(view.raw.get(c))]));
    const n = item.channels.length;
    const keep = item.channels.map((c, i) => [c, i]).filter(([c]) => view.raw.has(c));
    const matrix = [];
    for (const [, i] of keep) for (const [, j] of keep) matrix.push(item.matrix[i * n + j]);
    const compensated = compensate(raw, { channels, matrix });
    leanResult = { item, suggestions: leanCheck(compensated, channels, { threshold: 0.01 }).slice(0, 12), sample: view.record.name, source: 'sample' };
    renderLean();
  }

  function renderLean() {
    diagnosticsHost.querySelector('.lean')?.remove();
    if (!leanResult) return;
    const { item, suggestions, sample, source } = leanResult;
    const ws = store.ws;
    const fromControls = source === 'controls';
    const box = h('div.lean', { style: { marginTop: '12px' } }, h('div.section-title', fromControls ? `Residual spillover in ${sample}` : `Possible leaning populations in ${sample} (hint)`));
    if (!suggestions.length) {
      box.append(h('div.callout.ok', icon('check'), h('span', fromControls ? 'Every control is clean after compensation: no residual above 0.5% in any other detector.' : 'No leaning populations: bright events of each channel have the same median as dim events in the other channels.')));
    } else {
      const body = h('tbody');
      for (const s of suggestions) {
        const i = item.channels.indexOf(s.from);
        const j = item.channels.indexOf(s.to);
        const n = item.channels.length;
        const currentValue = item.matrix[i * n + j];
        const proposed = currentValue + s.residual;
        const apply = item.record
          ? h('button.btn.small', { type: 'button', onclick: () => { const matrix = item.matrix.slice(); matrix[i * n + j] = proposed; store.commit(updateCompensation(store.ws, item.id, { matrix }), `Correct ${s.from} → ${s.to}`); leanResult = null; } }, 'Apply')
          : h('button.btn.small', { type: 'button', title: 'A matrix from a file cannot change: make a corrected copy and use it for the samples that used this one', onclick: () => fixInCopy(item, i, j, proposed, s) }, 'Fix in a copy');
        body.append(h('tr',
          h('td', `${channelLabel(ws, s.from, { short: true })} → ${channelLabel(ws, s.to, { short: true })}`, s.broad ? h('span.badge.warn', { style: { marginLeft: '6px' }, title: `The positive events of this control are brighter in ${s.broad} other detectors at once. That is the signature of positive cells more autofluorescent than the negatives (dead cells in a viability control, beads against cells), not of one wrong spillover value. Use a negative of the same kind as the positives rather than changing the matrix.` }, 'autofluorescence?') : null),
          h('td.r', `${(s.residual * 100).toFixed(2)}%`),
          h('td.r', `${(currentValue * 100).toFixed(2)}% → ${(proposed * 100).toFixed(2)}%`),
          h('td', s.broad ? h('span.muted', 'check the negative') : apply)));
      }
      const broad = fromControls ? [...new Set(suggestions.filter((s) => s.broad).map((s) => s.from))] : [];
      box.append(h('p.muted', fromControls
        ? 'After compensation, the positive events of each control still sit this much above (or below) its negative events in the other detector, relative to their separation in the stained detector: the spillover value is off by about that residual. Corrections are suggestions; check the pair plots before and after.'
        : 'A hint, not a measurement: bright events of the first channel sit higher or lower in the second than dim events, which a wrong spillover value causes, but so does biology (populations that express both markers). Confirm with the controls before changing the matrix.'),
        h('table.data', h('thead', h('tr', h('th', 'Pair'), h('th.r', 'Residual'), h('th.r', 'Suggested value'), h('th'))), body));
      if (broad.length) {
        box.append(h('div.callout.warn', { style: { marginTop: '8px' } }, icon('warning'), h('span',
          `${broad.map((c) => channelLabel(ws, c, { short: true })).join(', ')}: the positive events are brighter in several detectors at once. That is autofluorescence of the positive cells (dead cells in a viability control, beads against cells), not a wrong spillover value; compute this control against a negative of the same kind instead of correcting the matrix.`)));
      }
    }
    diagnosticsHost.append(box);
  }

  // --- N×N pair plots -----------------------------------------------------------------------------

  function renderPairs() {
    clear(pairsHost);
    const item = selected();
    const ws = store.ws;
    const sampleId = pairSample ?? store.ui.sampleId;
    const sampleSelect = h('select.input.small', { 'aria-label': 'Sample shown in the pair plots', style: { width: '220px' }, onchange: (event) => { pairSample = event.target.value; renderPairs(); } },
      ...ws.samples.map((s) => h('option', { value: s.id, selected: s.id === sampleId }, s.name)));
    const toggle = h('div.segmented',
      ...['uncompensated', 'compensated'].map((mode) => h(`button${pairView === mode ? '.active' : ''}`, { type: 'button', onclick: () => { pairView = mode; renderPairs(); } }, mode === 'compensated' ? 'Compensated' : 'Uncompensated')));
    pairsHost.append(h('h3', 'Pairs', h('span.spacer'), toggle, sampleSelect));
    if (!item || !sampleId) {
      pairsHost.append(h('p.muted', 'Select a matrix and a sample.'));
      return;
    }
    const view = data.view(sampleId);
    if (!view) {
      pairsHost.append(h('p.muted', 'Loading…'));
      data.ensure(sampleId).then(() => renderPairs(), () => {});
      return;
    }
    const channels = item.channels.filter((c) => view.raw.has(c)).slice(0, 16);
    const indices = population(view, ws, store.ui.gateId ?? ROOT) ?? null;
    let columns;
    if (pairView === 'compensated') {
      const n = item.channels.length;
      const keep = item.channels.map((c, i) => [c, i]).filter(([c]) => view.raw.has(c));
      const matrix = [];
      for (const [, i] of keep) for (const [, j] of keep) matrix.push(item.matrix[i * n + j]);
      columns = compensate(Object.fromEntries(keep.map(([c]) => [c, view.raw.get(c)])), { channels: keep.map(([c]) => c), matrix });
    } else {
      columns = Object.fromEntries(channels.map((c) => [c, view.raw.get(c)]));
    }
    const size = channels.length > 10 ? 110 : 140;
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${channels.length - 1}, ${size}px)`, gap: '4px', overflow: 'auto', maxHeight: '70vh' } });
    const scaled = new Map();
    const scaledOf = (c) => {
      if (!scaled.has(c)) {
        const transform = createTransform(channelTransform(ws, view, c));
        const column = columns[c];
        const out = new Float32Array(column.length);
        for (let e = 0; e < column.length; e += 1) out[e] = transform.forward(column[e]);
        scaled.set(c, out);
      }
      return scaled.get(c);
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        entry.target.draw();
      }
    }, { root: null, rootMargin: '200px' });
    for (let i = 1; i < channels.length; i += 1) {
      for (let j = 0; j < channels.length - 1; j += 1) {
        if (j >= i) {
          grid.append(h('div'));
          continue;
        }
        const canvas = h('canvas', { style: { width: `${size}px`, height: `${size}px`, borderRadius: '6px', border: '1px solid var(--line)' }, title: `${channels[j]} vs ${channels[i]}` });
        canvas.draw = () => {
          const dpr = window.devicePixelRatio || 1;
          canvas.width = size * dpr;
          canvas.height = size * dpr;
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          const scene = buildPlotScene({
            width: size,
            height: size,
            type: 'pseudocolor',
            x: { channel: channels[j], transform: channelTransform(ws, view, channels[j]), label: channelLabel(ws, channels[j], { short: true }) },
            y: { channel: channels[i], transform: channelTransform(ws, view, channels[i]), label: channelLabel(ws, channels[i], { short: true }) },
            xs: scaledOf(channels[j]),
            ys: scaledOf(channels[i]),
            indices,
            options: { theme: dark() ? 'dark' : 'light', compact: true, colormap: store.ui.colormap },
          });
          drawScene(ctx, scene, rasterImage);
        };
        observer.observe(canvas);
        grid.append(canvas);
      }
    }
    pairsHost.append(h('p.muted', { style: { margin: '0 0 8px' } }, `Every pair of ${channels.length} channels for ${gatePath(ws, store.ui.gateId) || 'all events'} of ${view.record.name}. Populations should sit square to the axes after compensation; diagonal "leaning" means a spillover value is off.`), grid);
  }

  function renderAll() {
    renderList();
    renderControls();
    renderEditor();
    renderDiagnostics();
    renderLean();
    renderPairs();
  }

  renderAll();
  return {
    update(topics) {
      if (topics.has('ws') || topics.has('data') || topics.has('theme') || topics.has('gate')) {
        if (topics.has('ws') && leanResult) leanResult.item = selected() ?? leanResult.item;
        renderAll();
      } else if (topics.has('sample')) {
        renderPairs();
      }
    },
    destroy() {
      root.remove();
    },
  };
}
