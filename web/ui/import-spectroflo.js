// The SpectroFlo experiment import dialog: the experiment's reference controls matched to the
// workspace's samples, applied as the Spectral view's controls (spectroflo.js).

import { h } from './dom.js';
import { showDialog, toast } from './overlays.js';
import { updateSample } from '../lib/workspace.js';
import { planSpectroFloControls } from '../lib/spectroflo.js';

export function applySpectroFloImport(app, result, fileName) {
  const { store } = app;
  const rows = planSpectroFloControls(result, store.ws.samples);
  const matched = rows.filter((r) => r.sample);
  const table = h('table.data',
    h('thead', h('tr', h('th', 'Control'), h('th', 'Marker'), h('th', 'Carrier'), h('th', 'SpectroFlo gated on'), h('th', 'File'), h('th', 'Sample in CytoWeave'))),
    h('tbody', rows.map((r) => h('tr',
      h('td', r.kind === 'unstained' ? 'Unstained' : r.reference.fluorochrome),
      h('td', r.reference.marker || h('span.muted', '—')),
      h('td', r.reference.carrier ?? h('span.muted', '—')),
      h('td', r.reference.gatedDetector ?? h('span.muted', '—')),
      h('td.muted', { style: { fontSize: '11.5px' } }, r.reference.controlFile ?? '—'),
      h('td', r.sample ? h('span.badge.ok', r.sample.name) : h('span.badge.warn', 'not in this workspace'))))));
  showDialog({
    title: 'Import SpectroFlo reference controls',
    width: 'wide',
    content: [
      h('p', `${fileName}${result.name && result.name !== fileName.replace(/\.expt$/i, '') ? ` · ${result.name}` : ''}: ${result.references.length} reference control${result.references.length === 1 ? '' : 's'}${result.unstained ? ' and an unstained control' : ''} on ${result.detectors.length} detectors. CytoWeave marks each matched file as SpectroFlo had it (fluorochrome, marker, beads or cells) and computes its spectrum from the file in the Spectral view.`),
      h('div', { style: { maxHeight: '50vh', overflow: 'auto' } }, table),
      matched.length < rows.length ? h('div.callout.warn', { style: { marginTop: '10px' } }, `${rows.length - matched.length} control file${rows.length - matched.length === 1 ? ' is' : 's are'} not in this workspace. Open the raw control files (from SpectroFlo's Raw folder) and import the experiment again to include them.`) : null,
      h('p.muted', { style: { fontSize: '12px' } }, 'SpectroFlo\'s stored spectra are not used: on public data they do not match the controls\' own events, so each spectrum is computed from its control file, with CytoWeave\'s quality checks.'),
      result.warnings.length ? h('ul', { style: { fontSize: '12px' } }, result.warnings.map((w) => h('li', w))) : null,
    ],
    buttons: [
      { label: 'Cancel', ghost: true },
      {
        label: matched.length ? `Mark ${matched.length} control${matched.length === 1 ? '' : 's'}` : 'Nothing to mark',
        primary: true,
        onClick: () => {
          if (!matched.length) return true;
          let next = store.ws;
          for (const r of matched) next = updateSample(next, r.sample.id, r.patch);
          store.commit(next, `Mark ${matched.length} control${matched.length === 1 ? '' : 's'} from SpectroFlo experiment ${fileName}`, ['samples']);
          toast(`Marked ${matched.length} control${matched.length === 1 ? '' : 's'} from ${fileName}.`, { kind: 'ok', action: { label: 'Open Spectral', onClick: () => app.setMode('spectral') } });
          return true;
        },
      },
    ],
  });
  return rows;
}
