// Events in and out (wave 6, slice 4): the PBMC example's donor tubes (with their files' spillover,
// the suggested gates, CD4/CD8 and memory quadrants and Tregs; template-cases.mjs), annotated with
// subject and condition from their names, with a FlowSOM-like cluster channel and a UMAP (half the
// events embedded) recorded as derived results; and CSV files to import: CytoWeave's own export,
// FlowJo's format, a European one (semicolons, decimal commas), one already transformed, mass
// cytometry counts, and a damaged one with known faults.

import { createHash } from 'node:crypto';
import { pbmcFiles, sourceAnalysis } from './template-cases.mjs';

export const EVENTS_DATE = new Date('2026-10-04T12:00:00Z');
// ZIP entries store local wall-clock time (DOS dates), so the archive's date is built from local
// fields: noon on 4 October 2026 wherever the suite runs, and the same bytes in every time zone.
export const ZIP_DATE = new Date(2026, 9, 4, 12, 0, 0);

export function eventExperiment(scale = 0.04) {
  const files = pbmcFiles(scale);
  const source = sourceAnalysis(files);
  let { ws } = source;
  const { views } = source;
  // The files' checksums (which also seed each sample's downsampling), and annotations.
  const sha = new Map(files.files.map((f) => [f.name.replace(/\.fcs$/i, ''), createHash('sha256').update(f.bytes).digest('hex')]));
  ws = { ...ws, samples: ws.samples.map((s) => {
    const [subject, condition] = s.name.replace(/\.fcs$/i, '').split('_');
    return { ...s, sha256: sha.get(s.name), meta: { subject, condition } };
  }) };
  // A clustering and a map, as Explore records them.
  const names = ['Naive T', 'Memory T', 'B cells', 'NK cells', 'Monocytes'];
  ws = { ...ws, derived: [...(ws.derived ?? []), { id: 'd-som', kind: 'flowsom', outputs: ['FlowSOM cluster'], summary: { clusters: { k: 5, names } } }, { id: 'd-umap', kind: 'umap', outputs: ['UMAP 1', 'UMAP 2', 'Embedded'] }] };
  for (const view of views.values()) {
    const n = view.eventCount;
    const cluster = new Float32Array(n);
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const embedded = new Float32Array(n);
    for (let e = 0; e < n; e += 1) {
      cluster[e] = e % 7 === 6 ? -1 : e % 5;
      embedded[e] = e % 2;
      x[e] = embedded[e] ? Math.sin(e) * 10 : 0;
      y[e] = embedded[e] ? Math.cos(e) * 10 : 0;
    }
    view.setDerived('FlowSOM cluster', cluster);
    view.setDerived('UMAP 1', x);
    view.setDerived('UMAP 2', y);
    view.setDerived('Embedded', embedded);
    view.record = ws.samples.find((s) => s.id === view.id);
  }
  return { ws, views, viewOf: (id) => views.get(id) ?? null };
}

// CSV texts with what they hold. Each: { name, text, expect }.
export function csvCases(view) {
  const n = 2000;
  const params = view.parameters;
  const columns = params.map((p) => view.column(p.name));
  const own = [params.map((p) => JSON.stringify(p.name)).join(',')];
  for (let e = 0; e < n; e += 1) own.push(columns.map((c) => c[e]).join(','));
  const flowjo = [['Event #', ...params.map((p) => (p.type === 'fluorescence' ? `Comp-${p.name} :: ${p.marker || p.name}` : p.name))].join(',')];
  for (let e = 0; e < n; e += 1) flowjo.push([e + 1, ...columns.map((c) => c[e])].join(','));
  // Two decimals at most, written with commas, semicolon-separated.
  const pick = params.filter((p) => p.type !== 'time').slice(0, 6);
  const euro = [pick.map((p) => p.name).join(';')];
  const euroValues = pick.map(() => new Float64Array(n));
  for (let e = 0; e < n; e += 1) {
    euro.push(pick.map((p, j) => {
      const v = Math.round(view.column(p.name)[e] * 100) / 100;
      euroValues[j][e] = v;
      return String(v).replace('.', ',');
    }).join(';'));
  }
  // Already transformed: arcsinh(x / 150) of the fluorescence channels.
  const fluor = params.filter((p) => p.type === 'fluorescence').slice(0, 4);
  const asinh = [fluor.map((p) => p.marker || p.name).join(',')];
  for (let e = 0; e < n; e += 1) asinh.push(fluor.map((p) => Math.asinh(view.column(p.name)[e] / 150).toFixed(4)).join(','));
  // Mass cytometry: integer counts with many zeros.
  const mass = ['Time,Event_length,Yb176Di,Nd142Di'];
  for (let e = 0; e < n; e += 1) mass.push([e * 13, 10 + (e % 30), e % 3 === 0 ? 0 : (e * 7919) % 900, e % 4 === 0 ? 0 : (e * 104729) % 5000].join(','));
  // Damaged: 3 rows with a word, 2 with an empty cell, 1 short row, an event number, a label column.
  const broken = ['Event,FSC-A,FITC-A,Cluster'];
  for (let e = 0; e < 600; e += 1) {
    let fitc = String(100 + e);
    if (e === 10 || e === 20 || e === 30) fitc = 'overflow';
    if (e === 40 || e === 50) fitc = '';
    const row = [e + 1, 50000 + e, fitc, e % 3];
    broken.push(e === 60 ? row.slice(0, 2).join(',') : row.join(','));
  }
  return [
    { name: 'cytoweave_export.csv', text: own.join('\n'), expect: { rows: n, columns: params.map((p) => p.name), values: columns } },
    { name: 'flowjo_export.csv', text: flowjo.join('\n'), expect: { rows: n, eventNumber: 'Event #', names: params.map((p) => (p.type === 'fluorescence' ? `Comp-${p.name}` : p.name)), markers: params.map((p) => (p.type === 'fluorescence' ? p.marker || p.name : '')), values: columns } },
    { name: 'european.csv', text: euro.join('\n'), expect: { rows: n, delimiter: ';', decimalComma: true, values: euroValues } },
    { name: 'arcsinh.csv', text: asinh.join('\n'), expect: { rows: n, scale: 'transformed' } },
    { name: 'mass.csv', text: mass.join('\n'), expect: { rows: n, scales: { Time: 'linear', Yb176Di: 'arcsinh', Nd142Di: 'arcsinh' } } },
    { name: 'damaged.csv', text: broken.join('\n'), expect: { rows: 600, bad: 3, missing: 3, ragged: 1, dropped: 6, labels: 'Cluster', eventNumber: 'Event' } },
  ];
}

// The files the validation writes and the formats' readers read back (fixed date and seeds, so
// the same inputs give the same files). Returns { experiment, files: { name: bytes }, specs }.
export const EVENT_EXPORTS = [
  { file: 'concatenated.fcs', format: 'fcs', population: null, downsample: { mode: 'none' }, values: 'raw' },
  { file: 'downsampled.fcs', format: 'fcs', population: 'T cells', downsample: { mode: 'count', value: 1000, seed: 5 }, values: 'compensated' },
  { file: 'tregs.zip', format: 'zip', population: 'Tregs', downsample: { mode: 'fraction', value: 0.5, seed: 2 } },
  { file: 'lymphocytes.h5ad', format: 'h5ad', population: 'Lymphocytes', downsample: { mode: 'count', value: 2000, seed: 9 }, xValues: 'arcsinh', cofactor: 150 },
  { file: 'tcells.h5ad', format: 'h5ad', population: 'T cells', downsample: { mode: 'count', value: 300, seed: 4 }, xValues: 'compensated' },
];

export async function buildEventDocuments() {
  const { selectEvents, concatenatedFCS, sampleFCS } = await import('../web/lib/events.js');
  const { writeAnnData } = await import('../web/lib/anndata.js');
  const { createZip } = await import('../web/lib/zip.js');
  const experiment = eventExperiment();
  const { ws, viewOf } = experiment;
  const files = {};
  const selections = {};
  for (const spec of EVENT_EXPORTS) {
    const populationId = spec.population ? ws.gates.find((g) => g.name === spec.population).id : 'root';
    const { items } = selectEvents(ws, viewOf, { populationId, downsample: spec.downsample });
    selections[spec.file] = { items, populationId };
    if (spec.format === 'fcs') files[spec.file] = concatenatedFCS(ws, items, { populationId, downsample: spec.downsample, values: spec.values, version: 'validation' }).bytes;
    else if (spec.format === 'zip') files[spec.file] = await createZip(items.map((item) => ({ name: `${item.sample.name.replace(/\.fcs$/i, '')}.fcs`, data: sampleFCS(item, { downsample: spec.downsample }) })), { date: ZIP_DATE, compress: false });
    else files[spec.file] = writeAnnData(ws, items, { populationId, downsample: spec.downsample, values: spec.xValues, cofactor: spec.cofactor, version: 'validation', date: EVENTS_DATE }).bytes;
  }
  return { experiment, files, selections };
}
