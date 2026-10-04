// The Boolean population dialog: combine populations as "all of", "any of" or "none of" them,
// under a parent, with the count on the current sample shown as the choice changes.

import { h, formatCount, formatPercent } from './dom.js';
import { shownColor } from '../lib/colormaps.js';
import { showDialog, toast } from './overlays.js';
import { countOf, populationSet } from '../lib/engine.js';
import { BOOLEAN_OPS, ROOT, booleanCandidates, booleanName, gateById, gatePath, setBooleanGate } from '../lib/workspace.js';

// options: { operands: [gate ids] to start with, gateId: a Boolean gate to edit }
export function openBooleanGate(app, options = {}) {
  const { store, data } = app;
  const ws = store.ws;
  const editing = options.gateId ? gateById(ws, options.gateId) : null;
  const candidates = booleanCandidates(ws, editing?.id ?? null).filter((g) => !g.meta?.helper);
  if (!candidates.length) {
    toast('Draw some gates first: a Boolean population combines existing populations.', { kind: 'error' });
    return;
  }
  const state = {
    op: editing?.geometry.op ?? 'and',
    operands: new Set(editing?.geometry.operands ?? (options.operands ?? []).filter((id) => candidates.some((g) => g.id === id))),
    parentId: editing ? editing.parentId ?? null : gateById(ws, options.operands?.[0])?.parentId ?? null,
    name: editing?.name ?? '',
  };

  const opButtons = Object.entries(BOOLEAN_OPS).map(([op, label]) => h('button', {
    type: 'button',
    onclick: () => { state.op = op; refresh(); },
  }, label[0].toUpperCase() + label.slice(1)));
  const search = h('input.input.small', { placeholder: 'Find a population', 'aria-label': 'Find a population' });
  const list = h('div.boolean-list');
  const parentSelect = h('select.input.small', { 'aria-label': 'Parent population' },
    h('option', { value: '' }, 'All events'),
    ...candidates.map((g) => h('option', { value: g.id, selected: g.id === state.parentId }, gatePath(ws, g.id))));
  parentSelect.addEventListener('change', () => { state.parentId = parentSelect.value || null; refresh(); });
  const nameInput = h('input.input.small', { value: state.name, 'aria-label': 'Name' });
  nameInput.addEventListener('input', () => { state.name = nameInput.value; });
  const preview = h('div.muted', { style: { fontSize: '12px', minHeight: '18px' } });
  const explain = h('div.muted', { style: { fontSize: '12px' } });

  function renderList() {
    const text = search.value.trim().toLowerCase();
    list.replaceChildren(...candidates.filter((g) => !text || gatePath(ws, g.id).toLowerCase().includes(text)).map((g) => {
      const box = h('input', { type: 'checkbox', checked: state.operands.has(g.id) });
      box.addEventListener('change', () => {
        if (box.checked) state.operands.add(g.id);
        else state.operands.delete(g.id);
        refresh();
      });
      return h('label.boolean-option', box, h('span.swatch', { style: { background: shownColor(ws, g) } }), h('span', { title: gatePath(ws, g.id) }, gatePath(ws, g.id)));
    }));
  }
  search.addEventListener('input', renderList);

  function refresh() {
    opButtons.forEach((b, i) => {
      const on = Object.keys(BOOLEAN_OPS)[i] === state.op;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const operands = [...state.operands];
    nameInput.placeholder = operands.length ? booleanName(ws, state.op, operands) : 'Name';
    const parentName = state.parentId ? gateById(ws, state.parentId)?.name : 'all events';
    explain.textContent = operands.length
      ? `Events of ${parentName} that are in ${state.op === 'and' ? 'every one' : state.op === 'or' ? 'at least one' : 'none'} of the ${operands.length} chosen population${operands.length === 1 ? '' : 's'}.`
      : 'Choose the populations to combine.';
    preview.textContent = '';
    const view = store.ui.sampleId ? data.view(store.ui.sampleId) : null;
    if (!view || !operands.length) return;
    try {
      const trial = setBooleanGate(store.ws, { id: editing?.id ?? null, op: state.op, operands, parentId: state.parentId });
      const members = populationSet(view, trial.ws, trial.gate.id);
      const parent = populationSet(view, trial.ws, state.parentId ?? ROOT);
      if (members === undefined || parent === undefined) {
        preview.textContent = 'Does not apply to the current sample.';
        return;
      }
      const count = countOf(members, view);
      preview.textContent = `${formatCount(count)} events, ${formatPercent((100 * count) / (countOf(parent, view) || 1))} of ${parentName}, in ${view.record.name}.`;
    } catch (error) {
      preview.textContent = error.message;
    }
  }

  const content = h('div.boolean-dialog',
    h('div.segmented', { role: 'group', 'aria-label': 'Combine as' }, ...opButtons),
    explain,
    h('div.field-label', { style: { marginTop: '10px' } }, 'Populations'),
    search,
    list,
    h('div.row', { style: { gap: '10px', marginTop: '10px', alignItems: 'flex-end', flexWrap: 'wrap' } },
      h('label.field', { style: { flex: '1 1 200px' } }, h('span', 'Within'), parentSelect),
      h('label.field', { style: { flex: '1 1 200px' } }, h('span', 'Name'), nameInput)),
    preview);
  renderList();
  refresh();
  showDialog({
    title: editing ? `Edit ${editing.name}` : 'New Boolean population',
    content,
    buttons: [
      { label: 'Cancel', ghost: true },
      {
        label: editing ? 'Save' : 'Create',
        primary: true,
        onClick: () => {
          try {
            const result = setBooleanGate(store.ws, { id: editing?.id ?? null, op: state.op, operands: [...state.operands], parentId: state.parentId, name: state.name });
            store.commit(result.ws, `${editing ? 'Edit' : 'Add'} ${result.gate.name}`);
            app.selectGate(result.gate.id);
            return true;
          } catch (error) {
            toast(error.message, { kind: 'error' });
            return false;
          }
        },
      },
    ],
  });
}
