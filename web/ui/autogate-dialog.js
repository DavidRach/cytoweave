// Autogating: a shared gate adapted to each sample (lib/autogating.js), shown as a review queue.
// Confident adjustments are ticked for applying; uncertain samples are listed first, to be checked
// by hand ("Show") or confirmed ("Looks right", which makes the sample an exemplar); probabilities
// export as CLR. Nothing changes until the user applies it, and applying is one undoable step.
// "Keep one gate per" a metadata field (a donor, a subject) adapts each group's samples together,
// as an assay whose stimulated and unstimulated wells are gated alike needs.

import { h, formatPercent, downloadBlob } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { gateById, gateAncestors, setGateGeometry, updateGate, addDerived } from '../lib/workspace.js';

const STATUS = { adjust: ['accent', 'Adjust'], keep: ['ok', 'Fits'], review: ['warn', 'Review'] };
const KIND = { adjusted: 'adjusted by you', confirmed: 'confirmed by you', drawn: 'drawn on', chosen: 'its boundary sits deepest in density valleys' };

export function installAutogating(app) {
  const { store, data } = app;

  async function loadViews(gate) {
    const samples = store.ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference' || gate.overrides?.[s.id] || gate.meta?.drawnOn === s.id);
    const views = new Map();
    const progress = progressToast(`Loading ${samples.length} samples…`);
    for (const [i, sample] of samples.entries()) {
      const view = await data.ensure(sample.id).catch(() => null);
      if (view) views.set(sample.id, view);
      progress.update((i + 1) / samples.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    progress.done();
    return views;
  }

  // The last "one gate per" choice, per workspace.
  const groupChoice = new Map();
  const metadataFields = () => [...new Set(store.ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference').flatMap((s) => Object.keys(s.meta ?? {}).filter((k) => s.meta[k] !== '' && s.meta[k] != null)))].sort();

  app.adaptGate = async (gateId, options = {}) => {
    const { adaptAcrossSamples, cannotAdapt } = await import('../lib/autogating.js');
    let gate = gateById(store.ws, gateId);
    // Quadrants and splits move as a family: adapt their first member.
    if (gate?.linkId) gate = store.ws.gates.find((g) => g.linkId === gate.linkId) ?? gate;
    const reason = cannotAdapt(gate);
    if (reason) {
      toast(`${gate?.name ?? 'This population'}: ${reason}.`, { kind: 'error' });
      return;
    }
    const groupBy = options.groupBy !== undefined ? options.groupBy : groupChoice.get(store.ws.id) ?? '';
    groupChoice.set(store.ws.id, groupBy);
    const views = await loadViews(gate);
    const progress = progressToast(`Adapting ${gate.name} to each sample…`);
    let run;
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = adaptAcrossSamples(store.ws, gate.id, views, { groupBy: groupBy || undefined });
      progress.done();
    } catch (error) {
      progress.fail(`${gate.name}: ${error.message}`);
      return;
    }
    show(gate, run, views, groupBy);
  };

  function show(gate, run, views, groupBy) {
    const ws = store.ws;
    const name = (id) => ws.samples.find((s) => s.id === id)?.name ?? id;
    const chosen = new Set(run.results.filter((r) => r.status === 'adjust').map((r) => r.sampleId));
    const order = { review: 0, adjust: 1, keep: 2 };
    const rows = run.results.slice().sort((a, b) => order[a.status] - order[b.status] || a.confidence - b.confidence);
    const counts = { adjust: 0, keep: 0, review: 0 };
    for (const r of run.results) counts[r.status] += 1;
    const applyButton = h('button.btn.primary', { type: 'button' });
    const updateApply = () => {
      applyButton.textContent = chosen.size ? `Apply ${chosen.size} adjustment${chosen.size === 1 ? '' : 's'}` : 'Close';
    };
    const below = gate.parentId ? gateAncestors(ws, gate.id).map((g) => g.name).join(' / ') : '';
    const body = h('tbody', rows.map((r) => {
      const [badge, label] = STATUS[r.status];
      const box = h('input', { type: 'checkbox', checked: chosen.has(r.sampleId), disabled: r.status === 'keep', title: r.status === 'review' ? 'Uncertain: check it by hand, or apply the adaptation anyway' : 'Apply this adjustment', onchange: (event) => { if (event.target.checked) chosen.add(r.sampleId); else chosen.delete(r.sampleId); updateApply(); } });
      const bar = h('span', { style: { display: 'inline-block', width: '54px', height: '6px', borderRadius: '3px', background: 'var(--line)', verticalAlign: 'middle', marginRight: '6px', position: 'relative', overflow: 'hidden' } },
        h('span', { style: { position: 'absolute', inset: '0 auto 0 0', width: `${Math.round(100 * r.confidence)}%`, background: r.confidence >= 0.8 ? 'var(--ok)' : 'var(--warn)' } }));
      return h('tr',
        h('td', box),
        h('td', name(r.sampleId), r.group ? h('span.muted', ` · ${r.group}`) : null),
        h('td.r', r.status === 'keep' ? formatPercent(100 * r.frequencies.current) : `${formatPercent(100 * r.frequencies.current)} → ${formatPercent(100 * r.frequencies.adapted)}`),
        h('td', bar, r.confidence.toFixed(2)),
        h('td', h(`span.badge.${badge}`, label)),
        h('td.muted', { style: { fontSize: '11.5px', maxWidth: '260px' } }, r.reason),
        h('td', { style: { whiteSpace: 'nowrap' } },
          h('button.btn.small', { type: 'button', title: 'Show this sample, to adjust the gate for it by hand', onclick: () => showSample(gate, r.sampleId) }, 'Show'),
          r.status === 'review' ? h('button.btn.small.ghost', { type: 'button', title: 'The gate is right for this sample as it is: learn from it', onclick: (event) => { confirm(gate, r.sampleId); event.target.closest('tr').style.opacity = 0.45; event.target.disabled = true; } }, 'Looks right') : null));
    }));
    const learned = run.exemplars.map((e) => `${name(e.sampleId)} (${KIND[e.kind]})`).join(', ');
    const fields = metadataFields();
    const grouping = fields.length ? h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 10px' } }, 'Keep one gate per',
      h('select', { onchange: (event) => { dialog?.close(); app.adaptGate(gate.id, { groupBy: event.target.value }); } },
        h('option', { value: '', selected: !groupBy }, 'sample (adapt each alone)'),
        fields.map((f) => h('option', { value: f, selected: groupBy === f }, f))),
      h('span.muted', { style: { fontSize: '12px' } }, 'Choose the donor or subject when its samples differ by a stimulation you are measuring.')) : null;
    let dialog = null;
    applyButton.addEventListener('click', () => {
      if (chosen.size) apply(gate, run, [...chosen]);
      dialog?.close();
    });
    updateApply();
    dialog = showDialog({
      title: `Adapt ${gate.name} to each sample`,
      width: 'wide',
      content: [
        h('p', `The gate is carried from the samples it is known to be right on to every other sample, by registering the density landmarks of ${below ? `"${below}"` : 'all events'} along its axes. Each sample gets a confidence; confident adjustments are ticked, uncertain samples are listed first for you to check.`),
        grouping,
        h('p', h('strong', `${counts.adjust} to adjust, ${counts.keep} already fit, ${counts.review} to review.`), ` Learned from: ${learned}.`),
        run.skipped.length ? h('p.muted', `Not adapted: ${run.skipped.map((s) => `${name(s.sampleId)} (${s.reason})`).join('; ')}.`) : null,
        h('div', { style: { maxHeight: '52vh', overflow: 'auto' } }, h('table.data',
          h('thead', h('tr', h('th', ''), h('th', 'Sample'), h('th.r', '% of parent, now → adapted'), h('th', 'Confidence'), h('th', 'Status'), h('th', 'Why'), h('th', ''))),
          body)),
        h('p.muted', { style: { fontSize: '12px' } }, 'A gate is moved only where it cuts into a population and the adaptation finds sparser events; a gate that sits in a valley stays, since populations also move for biological reasons. Adjust the gate on a sample by hand, or mark it as right, and adapt again: CytoWeave learns from the samples you have checked, using the most similar ones for each sample. Gates below this one should be adapted after it.'),
      ],
      buttons: [
        { label: 'Probabilities (CLR)', ghost: true, onClick: () => { exportProbabilities(gate, views, groupBy); return false; } },
        { label: 'Cancel', ghost: true },
      ],
    });
    dialog.dialog.querySelector('.dialog-foot').append(applyButton);
  }

  function apply(gate, run, sampleIds) {
    import('../lib/autogating.js').then(({ autogatingRecord: record }) => {
      let next = store.ws;
      for (const r of run.results) if (sampleIds.includes(r.sampleId)) next = setGateGeometry(next, gate.id, r.geometry, { sampleId: r.sampleId });
      next = addDerived(next, record(next, gate, run, sampleIds, app.version)).ws;
      store.commit(next, `Adapt ${gate.name} to ${sampleIds.length} sample${sampleIds.length === 1 ? '' : 's'}`);
      toast(`Adapted ${gate.name} for ${sampleIds.length} sample${sampleIds.length === 1 ? '' : 's'}; undo restores the shared gate.`, { kind: 'ok' });
    });
  }

  function confirm(gate, sampleId) {
    const current = gateById(store.ws, gate.id);
    store.commit(updateGate(store.ws, gate.id, { meta: { ...(current.meta ?? {}), confirmed: { ...(current.meta?.confirmed ?? {}), [sampleId]: true } } }), `Confirm ${gate.name} for a sample`);
  }

  function showSample(gate, sampleId) {
    document.querySelector('.dialog .dialog-head button')?.click();
    app.selectSample(sampleId);
    app.selectGate(gate.id);
    store.setUI({ editScope: 'sample', mode: 'gate' }, ['scope', 'mode']);
    toast('Editing the gate for this sample only. Adapt again afterwards to learn from it.');
  }

  // Each event's probability of belonging to the adapted gate, per sample, as CLR files.
  async function exportProbabilities(gate, views, groupBy) {
    const progress = progressToast('Computing membership probabilities…');
    try {
      const { adaptAcrossSamples } = await import('../lib/autogating.js');
      const { writeCLR } = await import('../lib/clr.js');
      const { createZip } = await import('../lib/zip.js');
      const run = adaptAcrossSamples(store.ws, gate.id, views, { fullProbabilities: true, groupBy: groupBy || undefined });
      const files = [];
      for (const r of run.results) {
        const view = views.get(r.sampleId);
        const p = new Float32Array(view.eventCount);
        r.list.forEach((e, k) => { p[e] = r.probabilities[k]; });
        const sample = store.ws.samples.find((s) => s.id === r.sampleId);
        const text = writeCLR(view.eventCount, [{ name: gate.name, probabilities: p }]);
        files.push({ name: `${(sample?.name ?? r.sampleId).replace(/[^\w.+-]+/g, '_')}_${gate.name.replace(/[^\w.+-]+/g, '_')}.csv`, data: text });
      }
      downloadBlob(new Blob([await createZip(files)], { type: 'application/zip' }), `${gate.name.replace(/[^\w.+-]+/g, '_')}_probabilities.zip`);
      progress.done(`Exported probabilities for ${files.length} sample${files.length === 1 ? '' : 's'}.`);
    } catch (error) {
      progress.fail(`Probabilities: ${error.message}`);
    }
  }

}
