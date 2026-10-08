// Reproducibility certificates (R8): each example opened as the app opens it (samples with their
// checksums and annotations, the suggested gates), with a table of every population's % of parent,
// k-means clusters stored as a channel in the first samples (as Explore stores them) and a table
// column computed from it, and, where the example has conditions, a saved comparison.
import { computeNumbers } from '../web/lib/certificate.js';
import { EXAMPLES, generateExample } from '../web/lib/examples.js';
import { parseFCS } from '../web/lib/fcs.js';
import { kmeans } from '../web/lib/kmeans.js';
import { sha256 } from '../web/lib/sha256.js';
import { ROOT, addDerived, addGates, annotateSamples, createWorkspace, sampleFromDataset, setCollection } from '../web/lib/workspace.js';

export const CERTIFICATE_EXAMPLES = EXAMPLES.map((e) => e.id);

// k-means labels (k = 4, seed 7) on the first two scatter or, failing those, the first two
// channels: a Float32 column, as Explore stores clusters.
function clusterColumn(dataset) {
  const params = dataset.parameters;
  const scatter = params.filter((p) => /^(FSC|SSC)/i.test(p.name));
  const chosen = (scatter.length >= 2 ? scatter : params.filter((p) => !/time/i.test(p.name))).slice(0, 2);
  const columns = chosen.map((p) => dataset.data[params.indexOf(p)]);
  const n = Math.min(dataset.eventCount, 4000);
  const data = new Float64Array(n * 2);
  for (let i = 0; i < n; i += 1) for (let d = 0; d < 2; d += 1) data[i * 2 + d] = columns[d][i];
  const { centers } = kmeans(data, n, 2, 4, { seed: 7 });
  const labels = new Float32Array(dataset.eventCount);
  for (let i = 0; i < dataset.eventCount; i += 1) {
    let best = 0;
    let bestDistance = Infinity;
    for (let c = 0; c < 4; c += 1) {
      const distance = (columns[0][i] - centers[c * 2]) ** 2 + (columns[1][i] - centers[c * 2 + 1]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = c;
      }
    }
    labels[i] = best + 1;
  }
  return labels;
}

// An example as a certifiable workspace: { ws, source, files (sha256 → bytes), derived (sha256 →
// bytes) }.
export async function certifiableExample(id, options = {}) {
  const result = generateExample(id, { scale: options.scale ?? 0.05 });
  const files = new Map();
  const datasets = new Map();
  const samples = result.files.map((file) => {
    const digest = sha256(file.bytes);
    files.set(digest, file.bytes);
    const dataset = parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(dataset, { name: file.name, size: file.bytes.length, sha256: digest });
    datasets.set(record.id, dataset);
    return record;
  });
  let ws = { ...createWorkspace(id), samples };
  const changes = {};
  for (const s of samples) changes[s.id] = Object.fromEntries(Object.entries(result.workspaceHints.sampleMeta?.[s.fileName] ?? {}).filter(([k, v]) => !['role', 'stain'].includes(k) && typeof v !== 'object'));
  ws = annotateSamples(ws, changes, 'example');
  ws = { ...ws, channelSettings: { ...ws.channelSettings, ...(result.workspaceHints.channelSettings ?? {}) } };
  ws = addGates(ws, (result.workspaceHints.suggestedGates ?? []).map((g) => ({ ...g, overrides: {} }))).ws;
  // Clusters stored for the first three samples.
  const derived = new Map();
  const stored = {};
  for (const s of samples.slice(0, 3)) {
    const column = clusterColumn(datasets.get(s.id));
    const bytes = new Uint8Array(column.buffer);
    const digest = sha256(bytes);
    derived.set(digest, bytes);
    stored[s.id] = { Cluster: { sha256: digest, length: column.length } };
  }
  ws = addDerived(ws, { kind: 'kmeans', name: 'Clusters', method: 'k-means', seed: 7, params: { k: 4 }, files: stored }).ws;
  ws = setCollection(ws, 'tables', [{
    id: 'table-1',
    name: 'Populations',
    includeControls: true,
    columns: [
      ...ws.gates.slice(0, 12).map((g, i) => ({ id: `c${i}`, gateId: g.id, stat: 'freqParent' })),
      { id: 'cluster', gateId: ROOT, stat: 'positive', channel: 'Cluster', value: 2.5 },
    ],
  }], 'add-table');
  const source = { fcs: (s) => files.get(s.sha256) ?? null, derived: (sha) => derived.get(sha) ?? null };
  // A saved comparison of the last population between the first two conditions, as Compare saves
  // one (its values computed as the window computes them).
  const donors = ws.samples.filter((s) => s.role === 'sample' && s.meta?.condition);
  const levels = [...new Set(donors.map((s) => s.meta.condition))].slice(0, 2);
  const gate = ws.gates.at(-1);
  if (gate && levels.length === 2) {
    const chosen = donors.filter((s) => levels.includes(s.meta.condition));
    const paired = chosen.every((s) => s.meta.subject);
    const record = (values, p) => ({ id: 'comparison-1', name: `${gate.name} by condition`, kind: 'single', measure: { stat: 'freqParent', gateId: gate.id }, grouping: { by: 'meta:condition', levels, reference: levels[0] }, pairing: paired ? 'subject' : null, test: { id: paired ? 'pairedt' : 'welch', p }, results: { values } });
    const draft = setCollection(ws, 'comparisons', [record(chosen.map((s) => ({ sampleId: s.id, sample: s.name, group: s.meta.condition, pair: s.meta.subject ?? null, value: 0 })), null)], 'save-comparison');
    const { numbers } = await computeNumbers(draft, source);
    const c = numbers.comparisons[0];
    const value = (id) => {
      const v = c.values.find((x) => x.sampleId === id).value;
      return typeof v === 'number' ? v : Number(v);
    };
    ws = setCollection(ws, 'comparisons', [record(chosen.map((s) => ({ sampleId: s.id, sample: s.name, group: s.meta.condition, pair: s.meta.subject ?? null, value: value(s.id) })), c.results.test?.p ?? null)], 'save-comparison');
  }
  return { ws, source, files, derived };
}
