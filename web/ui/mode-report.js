// Report: the methods paragraph with references, the MIFlowCyt checklist, named checkpoints with
// a semantic comparison against the current analysis (and its effect on frequencies), and the
// record of every change.

import { h, icon, clear, downloadBlob, formatPercent, relativeTime } from './dom.js';
import { toast, promptDialog, confirmDialog } from './overlays.js';
import { writeMethods, miflowcytChecklist, toBibTeX } from '../lib/methods.js';
import { analysisSnapshot, diffAnalyses } from '../lib/diff.js';
import { countOf, population } from '../lib/engine.js';
import { newId } from '../lib/gates.js';
import { ROOT, gatePath, setNotes } from '../lib/workspace.js';

export function mountReportMode(app, container) {
  const { store, data } = app;
  let tab = 'methods';
  let compareWith = null;

  const tabs = h('div.segmented');
  const body = h('div');
  const root = h('div.view',
    h('div.workbench-head', h('h1', icon('report'), 'Report'), h('span.spacer'), tabs),
    h('div.view-body', h('div', { style: { maxWidth: '1100px', margin: '0 auto' } }, body)));
  container.append(root);

  const TABS = [['methods', 'Methods'], ['checklist', 'MIFlowCyt'], ['history', 'Checkpoints'], ['log', 'Change log']];
  function renderTabs() {
    clear(tabs);
    for (const [id, label] of TABS) tabs.append(h(`button${tab === id ? '.active' : ''}`, { type: 'button', onclick: () => { tab = id; render(); } }, label));
  }

  function methodsTab() {
    const { paragraphs, references } = writeMethods(store.ws, { version: app.version });
    const text = `${paragraphs.join('\n\n')}\n\nReferences\n${references.map((r, i) => `${i + 1}. ${r.text}${r.doi ? ` doi:${r.doi}` : ''}`).join('\n')}`;
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('Methods copied.', { kind: 'ok' });
      } catch {
        toast('The browser did not allow copying.', { kind: 'error' });
      }
    };
    return h('div',
      h('div.pane',
        h('h3', 'Methods', h('span.spacer'),
          h('button.btn.small', { type: 'button', onclick: copy }, icon('copy'), 'Copy'),
          h('button.btn.small', { type: 'button', onclick: () => downloadBlob(new Blob([text], { type: 'text/markdown' }), 'methods.md') }, icon('download'), 'Markdown'),
          h('button.btn.small', { type: 'button', onclick: () => downloadBlob(new Blob([toBibTeX(references)], { type: 'application/x-bibtex' }), 'references.bib') }, icon('download'), 'BibTeX')),
        h('p.muted', { style: { marginTop: 0 } }, 'Written from what this workspace contains: instruments from the files\' keywords, the compensation and scales applied, the gating hierarchy and every recorded analysis with its parameters and seeds. Edit it to taste before publishing.'),
        h('div', { style: { fontSize: '14px', lineHeight: 1.65, maxWidth: '78ch' } }, ...paragraphs.map((p) => h('p', { style: { margin: '0 0 12px' } }, p)))),
      h('div.pane',
        h('h3', 'References'),
        h('ol', { style: { margin: 0, paddingLeft: '22px', lineHeight: 1.55 } }, ...references.map((r) => h('li', { style: { marginBottom: '6px' } }, r.text, r.doi ? [' ', h('a', { href: `https://doi.org/${r.doi}`, target: '_blank', rel: 'noopener' }, `doi:${r.doi}`)] : null)))));
  }

  function checklistTab() {
    const items = miflowcytChecklist(store.ws);
    const done = items.filter((i) => i.ok).length;
    const notes = h('textarea.input', { rows: 8, placeholder: 'Purpose of the experiment, lab and contact, specimen details, reagent clones and lots, instrument settings not in the files…', value: store.ws.notes ?? '' });
    notes.addEventListener('change', () => store.commit(setNotes(store.ws, notes.value), 'Edit notes'));
    const sections = new Map();
    for (const item of items) {
      if (!sections.has(item.section)) sections.set(item.section, []);
      sections.get(item.section).push(item);
    }
    return h('div',
      h('div.pane',
        h('h3', 'MIFlowCyt checklist', h('span.spacer'), h(`span.badge.${done === items.length ? 'ok' : 'warn'}`, `${done} of ${items.length}`)),
        h('p.muted', { style: { marginTop: 0 } }, 'The Minimum Information about a Flow Cytometry Experiment (Lee et al. 2008). CytoWeave fills what the files and the analysis record; the rest belongs in the notes below.'),
        ...[...sections.entries()].map(([section, list]) => h('div', { style: { marginBottom: '10px' } }, h('div.section-title', section),
          ...list.map((item) => h('div.row', { style: { alignItems: 'flex-start', padding: '5px 0' } },
            h(`span.badge.${item.ok ? 'ok' : 'warn'}`, item.ok ? 'documented' : 'missing'),
            h('div', h('div', item.item), item.ok || !item.hint ? null : h('div.muted', { style: { fontSize: '12px' } }, item.hint))))))),
      h('div.pane', h('h3', 'Workspace notes'), notes));
  }

  // --- Checkpoints ---------------------------------------------------------------------------

  function checkpoints() {
    return store.ws.checkpoints ?? [];
  }

  async function createCheckpoint() {
    const name = await promptDialog({ title: 'Create a checkpoint', label: 'Name', value: `Checkpoint ${checkpoints().length + 1}`, hint: 'A checkpoint keeps the gates, compensation and scales as they are now, to compare with or return to later.' });
    if (!name) return;
    const checkpoint = { id: newId('k'), name, time: new Date().toISOString(), snapshot: analysisSnapshot(store.ws) };
    store.commit({ ...store.ws, checkpoints: [...checkpoints(), checkpoint] }, `Checkpoint ${name}`);
    compareWith = checkpoint.id;
  }

  // Frequencies of every gate in both analyses on the loaded samples.
  function impact(snapshot) {
    const ws = store.ws;
    const before = { ...ws, gates: snapshot.gates };
    const rows = [];
    for (const sample of ws.samples) {
      const view = data.view(sample.id);
      if (!view) continue;
      for (const gate of ws.gates) {
        const old = snapshot.gates.find((g) => g.id === gate.id);
        if (!old) continue;
        try {
          const a = population(view, before, gate.id);
          const pa = population(view, before, old.parentId ?? ROOT);
          const b = population(view, ws, gate.id);
          const pb = population(view, ws, gate.parentId ?? ROOT);
          if (a === undefined || b === undefined) continue;
          const fa = (100 * countOf(a, view)) / (countOf(pa, view) || 1);
          const fb = (100 * countOf(b, view)) / (countOf(pb, view) || 1);
          if (Math.abs(fa - fb) > 1e-9) rows.push({ sample: sample.name, gate: gatePath(ws, gate.id), before: fa, after: fb, delta: fb - fa });
        } catch { /* missing channels */ }
      }
    }
    return rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  }

  function historyTab() {
    const list = checkpoints();
    const selected = list.find((c) => c.id === compareWith) ?? list[list.length - 1] ?? null;
    const listPane = h('div.pane', h('h3', 'Checkpoints', h('span.spacer'), h('button.btn.small.primary', { type: 'button', onclick: createCheckpoint }, icon('branch'), 'Create checkpoint')));
    if (!list.length) listPane.append(h('p.muted', 'Create a checkpoint before changing an analysis — for example before adjusting gates for a revision — and CytoWeave will show exactly what changed and how each frequency moved.'));
    for (const checkpoint of [...list].reverse()) {
      listPane.append(h(`div.tree-row${checkpoint.id === selected?.id ? '.selected' : ''}`, { style: { gridTemplateColumns: '18px 1fr auto auto' }, onclick: () => { compareWith = checkpoint.id; render(); } },
        icon('branch'), h('span.label', checkpoint.name), h('span.count', relativeTime(checkpoint.time)),
        h('button.icon-button.small', { type: 'button', title: 'Delete checkpoint', onclick: (event) => { event.stopPropagation(); store.commit({ ...store.ws, checkpoints: list.filter((c) => c.id !== checkpoint.id) }, 'Delete checkpoint'); } }, icon('trash'))));
    }
    const out = h('div', listPane);
    if (!selected) return out;
    const { changes, summary } = diffAnalyses(selected.snapshot, analysisSnapshot(store.ws));
    const diffPane = h('div.pane', h('h3', `Changes since "${selected.name}"`, h('span.spacer'),
      h('button.btn.small', {
        type: 'button',
        onclick: async () => {
          if (!(await confirmDialog({ title: 'Restore checkpoint?', message: `Restore the gates, compensation and scales of "${selected.name}"? The current analysis stays available through undo.`, confirm: 'Restore' }))) return;
          const snap = selected.snapshot;
          store.commit({ ...store.ws, gates: snap.gates, compensations: snap.compensations, channelSettings: snap.channelSettings }, `Restore ${selected.name}`);
        },
      }, icon('history'), 'Restore')));
    diffPane.append(h('p', summary));
    if (changes.length) {
      diffPane.append(h('table.data', h('thead', h('tr', h('th', 'What'), h('th', 'Change'), h('th', 'Name'), h('th', 'Detail'))),
        h('tbody', ...changes.map((c) => h('tr', h('td', c.kind), h('td', h(`span.badge.${c.action === 'added' ? 'ok' : c.action === 'removed' ? 'danger' : 'warn'}`, c.action)), h('td', c.name), h('td.muted', c.detail))))));
    }
    out.append(diffPane);
    const rows = impact(selected.snapshot);
    const impactPane = h('div.pane', h('h3', 'Effect on frequencies (loaded samples)'));
    if (!rows.length) impactPane.append(h('p.muted', changes.some((c) => c.kind === 'gate') ? 'No frequency changed on the loaded samples. Load more samples (Tables → Compute all) to check them all.' : 'No gate changed.'));
    else {
      impactPane.append(h('p.muted', { style: { marginTop: 0 } }, 'Each population\'s % of parent under the checkpoint\'s gates and under the current gates, largest changes first. Compensation changes are not included here.'),
        h('div', { style: { maxHeight: '420px', overflow: 'auto' } }, h('table.data', h('thead', h('tr', h('th', 'Sample'), h('th', 'Population'), h('th.r', 'Before'), h('th.r', 'Now'), h('th.r', 'Change'))),
          h('tbody', ...rows.slice(0, 400).map((r) => h('tr', h('td', r.sample), h('td', r.gate), h('td.r', formatPercent(r.before)), h('td.r', formatPercent(r.after)),
            h('td.r', { style: { color: Math.abs(r.delta) > 2 ? 'var(--danger)' : Math.abs(r.delta) > 0.5 ? 'var(--warn)' : 'var(--text-2)', fontWeight: 650 } }, `${r.delta > 0 ? '+' : ''}${r.delta.toFixed(2)} pts`)))))));
    }
    out.append(impactPane);
    return out;
  }

  function logTab() {
    const entries = [...(store.ws.provenance ?? [])].reverse().slice(0, 500);
    return h('div.pane', h('h3', 'Change log', h('span.spacer'),
      h('button.btn.small', { type: 'button', onclick: () => downloadBlob(new Blob([JSON.stringify(store.ws.provenance, null, 2)], { type: 'application/json' }), 'provenance.json') }, icon('download'), 'JSON')),
    h('p.muted', { style: { marginTop: 0 } }, 'Every change to the analysis, newest first. The full record is saved with the workspace.'),
    h('table.data', h('thead', h('tr', h('th', 'When'), h('th', 'Action'), h('th', 'Detail'))),
      h('tbody', ...entries.map((e) => h('tr', h('td', { style: { whiteSpace: 'nowrap' } }, new Date(e.time).toLocaleString()), h('td', e.action), h('td.muted', String(e.detail ?? '').slice(0, 160)))))));
  }

  function render() {
    renderTabs();
    clear(body);
    if (tab === 'methods') body.append(methodsTab());
    else if (tab === 'checklist') body.append(checklistTab());
    else if (tab === 'history') body.append(historyTab());
    else body.append(logTab());
  }

  render();
  return {
    update(topics) {
      if (topics.has('ws') || (tab === 'history' && topics.has('data'))) {
        if (document.activeElement?.tagName === 'TEXTAREA') return;
        render();
      }
    },
    destroy() {
      root.remove();
    },
  };
}
