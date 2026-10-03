// Opening an exported figure (SVG, PNG or PDF): the analysis it carries (figure-provenance.js),
// what changed since in the open workspace, and rebuilding it in a new workspace from the same
// files, or adding it back to this one.

import { h, formatCount } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { newId } from '../lib/gates.js';

const STATUS = { unchanged: ['ok', 'Unchanged'], changed: ['warn', 'Changed'], missing: ['danger', 'Not in this workspace'] };

export function installFigureProvenance(app) {
  const { store, data, library } = app;

  app.openFigureFile = async (item) => {
    const lib = await import('../lib/figure-provenance.js');
    const bytes = item.bytes ?? new Uint8Array(await item.file.arrayBuffer());
    const record = lib.readFigureProvenance(bytes);
    if (!record) {
      toast(`${item.name} carries no CytoWeave analysis: it was not exported by CytoWeave 0.3 or later, or the analysis was not embedded.`, { kind: 'error', timeout: 8000 });
      return;
    }
    // Load the matching samples, so scales, compensation and event counts can be checked too.
    const ws = store.ws;
    const shas = new Set(record.samples.map((s) => s.sha256).filter(Boolean));
    const matched = ws.samples.filter((s) => record.samples.some((r) => r.id === s.id) || (s.sha256 && shas.has(s.sha256)));
    const views = new Map();
    if (matched.length) {
      const progress = progressToast('Checking the figure against this workspace…');
      for (const [i, sample] of matched.entries()) {
        const view = await data.ensure(sample.id).catch(() => null);
        if (view) views.set(sample.id, view);
        progress.update((i + 1) / matched.length);
      }
      progress.done();
    }
    show(record, lib.compareProvenance(record, store.ws, { views }), lib);
  };

  function show(record, comparison, lib) {
    const counts = { unchanged: 0, changed: 0, missing: 0 };
    for (const p of comparison.plots) counts[p.status] += 1;
    const created = new Date(record.created);
    const headline = comparison.sameWorkspace
      ? 'It was exported from this workspace.'
      : `It was exported from the workspace "${record.workspace?.name ?? 'unknown'}"; plots are matched here by file checksum and population path.`;
    const summary = !comparison.plots.length
      ? 'The figure has no plots.'
      : counts.missing === comparison.plots.length
        ? 'None of its samples is in this workspace.'
        : counts.changed || counts.missing
          ? `${counts.unchanged} of ${comparison.plots.length} plots would look the same today; ${counts.changed ? `${counts.changed} changed` : ''}${counts.changed && counts.missing ? ', ' : ''}${counts.missing ? `${counts.missing} not in this workspace` : ''}.`
          : `All ${comparison.plots.length} plots would look the same today.`;
    const plotOf = (p) => record.plots.find((x) => x.item === p.item);
    const rows = comparison.plots.map((p) => {
      const plot = plotOf(p);
      const [badge, label] = STATUS[p.status];
      return h('tr',
        h('td', p.sample),
        h('td', p.path),
        h('td.muted', [plot.x, plot.y].filter(Boolean).join(' × ')),
        h('td.r', plot.events === null || plot.events === undefined ? '—' : formatCount(plot.events)),
        h('td', h(`span.badge.${badge}`, label)),
        h('td.muted', { style: { fontSize: '11.5px', maxWidth: '320px' } }, p.changes.join('; ')));
    });
    const canAdd = comparison.plots.length > 0 && comparison.plots.every((p) => p.sampleId && p.populationId);
    showDialog({
      title: `Figure: ${record.figure.name}`,
      width: 'wide',
      content: [
        h('p', `Exported by ${record.software} on ${created.toLocaleString()}. ${headline}`),
        h('p', h('strong', summary)),
        h('div', { style: { maxHeight: '320px', overflow: 'auto' } }, h('table.data',
          h('thead', h('tr', h('th', 'Sample'), h('th', 'Population'), h('th', 'Axes'), h('th.r', 'Events'), h('th', 'Today'), h('th', 'What changed'))),
          h('tbody', rows))),
        h('p.muted', { style: { fontSize: '12px' } }, `The figure carries ${record.gates.length} gate${record.gates.length === 1 ? '' : 's'}, ${record.compensations.length} compensation matri${record.compensations.length === 1 ? 'x' : 'ces'} beyond the files' own, the scales of its channels, and the checksums of ${record.samples.length} FCS file${record.samples.length === 1 ? '' : 's'}: enough to redraw it from the same files.`),
      ],
      buttons: [
        { label: 'Close', ghost: true },
        ...(canAdd ? [{ label: 'Add to this workspace', onClick: () => { addHere(record, comparison, lib); } }] : []),
        { label: 'Rebuild in a new workspace', primary: true, onClick: () => { rebuild(record, lib); } },
      ],
    });
  }

  function addHere(record, comparison, lib) {
    const figure = lib.figureForWorkspace(record, comparison, () => newId('f'));
    if (!figure) return;
    store.commit({ ...store.ws, figures: [...store.ws.figures, figure] }, `Add the figure "${figure.name}" from its file`, ['figures']);
    app.setMode('figures');
    toast(`Added the figure "${figure.name}".`, { kind: 'ok' });
  }

  async function missingFiles(record) {
    const missing = [];
    for (const sample of record.samples) {
      const present = sample.sha256 && (data.session.has?.(sample.sha256) || await library.hasFile(sample.sha256).catch(() => false));
      if (!present) missing.push(sample);
    }
    return missing;
  }

  async function rebuild(record, lib) {
    const missing = await missingFiles(record);
    if (missing.length) {
      askForFiles(record, lib, missing);
      return;
    }
    await app.saveNow?.();
    const ws = lib.rebuildWorkspace(record);
    await app.loadWorkspace(ws);
    app.setMode('figures');
    toast(`Rebuilt "${record.figure.name}" in a new workspace from ${record.samples.length} file${record.samples.length === 1 ? '' : 's'}.`, { kind: 'ok' });
  }

  function askForFiles(record, lib, missing) {
    const input = h('input', { type: 'file', multiple: true, accept: '.fcs,.lmd', style: { display: 'none' } });
    let close = null;
    input.addEventListener('change', async () => {
      const files = [...input.files].map((file, order) => ({ name: file.name, file, size: file.size, order }));
      if (!files.length) return;
      const progress = progressToast(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
      // Stored in the library by checksum; the rebuilt workspace finds them there.
      await data.importFCS(files, (done, total) => progress.update(done / total));
      progress.done();
      const still = await missingFiles(record);
      close?.();
      if (still.length) askForFiles(record, lib, still);
      else rebuild(record, lib);
    });
    const dialog = showDialog({
      title: 'Some files are not in the library',
      content: [
        h('p', `The figure was drawn from ${record.samples.length} FCS file${record.samples.length === 1 ? '' : 's'}; ${missing.length} ${missing.length === 1 ? 'is' : 'are'} not in your library. Add ${missing.length === 1 ? 'it' : 'them'}: CytoWeave recognizes the files by their checksums, whatever their names now.`),
        h('ul', missing.slice(0, 20).map((s) => h('li', h('strong', s.fileName ?? s.name), h('span.muted', ` · ${formatCount(s.eventCount)} events · SHA-256 ${String(s.sha256 ?? '').slice(0, 12)}…`)))),
        input,
      ],
      buttons: [
        { label: 'Cancel', ghost: true },
        { label: 'Add the FCS files…', primary: true, onClick: () => { input.click(); return false; } },
      ],
    });
    close = dialog?.close ?? null;
  }
}
