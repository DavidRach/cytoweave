// AnnData files (.h5ad, the format of scanpy, muon and most single-cell tools in Python, and of R
// through zellkonverter) from selected events (events.js): X holds the chosen channels for every
// event (compensated values, or arcsinh(x / cofactor)); obs the sample, the samples' annotations,
// each event's index in its file, its populations (a column per gate, True or False, and the
// deepest of them as a category), clusters (as categories, named), QC results, and scatter and time
// channels; var the channels (detector, marker, type); obsm the maps (X_umap, X_tsne, X_pca); uns
// where it came from (CytoWeave's version, the workspace, the population, the values, the seed,
// the samples and their checksums). Written in AnnData's on-disk format (encodings "dataframe",
// "categorical", "string-array", "array", "dict"; anndata 0.8 and later read it) through hdf5.js.

import { hdf5Attribute, hdf5Dataset, hdf5Group, writeHDF5 } from './hdf5.js';
import { ROOT, gateAncestors, gateById, gatePath } from './workspace.js';
import { population } from './engine.js';
import { describeDownsampling } from './events.js';

const EMBEDDINGS = [['UMAP', 'X_umap'], ['t-SNE', 'X_tsne'], ['PC', 'X_pca']];

const encoding = (node, type, version) => {
  hdf5Attribute(node, 'encoding-type', { type: 'string', data: type });
  hdf5Attribute(node, 'encoding-version', { type: 'string', data: version });
  return node;
};
const array = (group, name, type, shape, data) => encoding(hdf5Dataset(group, name, { type, shape, data }), 'array', '0.2.0');
const strings = (group, name, values) => encoding(hdf5Dataset(group, name, { type: 'string', shape: [values.length], data: values }), 'string-array', '0.2.0');
const dict = (parent, name) => encoding(hdf5Group(parent, name), 'dict', '0.1.0');

// A categorical column: codes (the smallest signed integer that holds them; −1 for a missing
// value) and categories, in the order given (or first seen).
function categorical(group, name, values, categories = null) {
  const cats = categories ?? [...new Set(values.filter((v) => v !== null && v !== undefined && v !== ''))];
  const index = new Map(cats.map((c, i) => [c, i]));
  const n = values.length;
  const type = cats.length < 128 ? 'int8' : cats.length < 32768 ? 'int16' : 'int32';
  const codes = type === 'int8' ? new Int8Array(n) : type === 'int16' ? new Int16Array(n) : new Int32Array(n);
  for (let i = 0; i < n; i += 1) codes[i] = index.get(values[i]) ?? -1;
  const node = encoding(hdf5Group(group, name), 'categorical', '0.2.0');
  hdf5Attribute(node, 'ordered', { type: 'bool', data: false });
  array(node, 'codes', type, [n], codes);
  strings(node, 'categories', cats.map(String));
}

function dataframe(parent, name, columns) {
  const node = encoding(hdf5Group(parent, name), 'dataframe', '0.2.0');
  hdf5Attribute(node, '_index', { type: 'string', data: '_index' });
  hdf5Attribute(node, 'column-order', { type: 'string', shape: [columns.length], data: columns });
  return node;
}

// Unique names an HDF5 group can hold ("/" becomes "_"): a repeat gets " (2)", " (3)", ….
function unique(names) {
  const seen = new Map();
  return names.map((raw) => {
    const name = String(raw).replace(/\//g, '_') || '_';
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

// The derived channels in the samples: clusters (outputs of a record with named clusters), maps
// (axis 1 and 2) and QC results.
function derivedChannels(ws, items) {
  const has = (name) => items.every((it) => { try { it.view.column(name); return true; } catch { return false; } });
  const clusters = [];
  const maps = [];
  const flags = [];
  for (const record of ws.derived ?? []) {
    for (const output of record.outputs ?? []) {
      if (!has(output)) continue;
      const axis = EMBEDDINGS.find(([prefix]) => output === `${prefix} 1`);
      if (axis && (record.outputs ?? []).includes(`${axis[0]} 2`) && has(`${axis[0]} 2`)) maps.push({ key: axis[1], x: output, y: `${axis[0]} 2` });
      else if (/ cluster$/.test(output) && record.summary?.clusters) clusters.push({ name: output, names: record.summary.clusters.names ?? [] });
      else if (record.kind === 'qc' || output === 'QC pass') flags.push(output);
    }
  }
  return { clusters, maps, flags: [...new Set(flags)] };
}

// options: { channels (X; default the fluorescence and mass channels all samples have), values
// ('arcsinh' | 'compensated'), cofactor, populations (gate ids; default every gate the samples'
// population has under it), obsChannels (scatter and time channels for obs; default all),
// populationId, downsample, version, date, workspace }. Returns { bytes, report }.
export function writeAnnData(ws, items, options = {}) {
  if (!items.length) throw new Error('No events to write: choose samples that are loaded.');
  const n = items.reduce((sum, it) => sum + it.indices.length, 0);
  // Channels every sample has, with their kinds and markers as the samples record them.
  const recorded = (name) => items[0].sample.channels?.find((c) => c.name === name) ?? items[0].view.parameters.find((p) => p.name === name);
  const common = items[0].view.parameters.filter((p) => items.every((it) => it.view.parameters.some((q) => q.name === p.name))).map((p) => ({ ...p, type: recorded(p.name)?.type ?? p.type, marker: recorded(p.name)?.marker ?? p.marker }));
  const channels = options.channels ?? common.filter((p) => p.type === 'fluorescence' || p.type === 'mass').map((p) => p.name);
  if (!channels.length) throw new Error('Choose at least one channel for X.');
  const obsChannels = options.obsChannels ?? common.filter((p) => (p.type === 'scatter' || p.type === 'time') && !channels.includes(p.name)).map((p) => p.name);
  const values = options.values ?? 'arcsinh';
  const cofactor = options.cofactor ?? (items[0].sample.technology === 'mass' ? 5 : 150);
  const root = encoding(hdf5Group(), 'anndata', '0.1.0');

  // X: events × channels, row by row.
  const X = new Float32Array(n * channels.length);
  let row = 0;
  for (const item of items) {
    const columns = channels.map((name) => item.view.column(name));
    for (const e of item.indices) {
      for (let c = 0; c < channels.length; c += 1) {
        const v = columns[c][e];
        X[row * channels.length + c] = values === 'arcsinh' ? Math.asinh(v / cofactor) : v;
      }
      row += 1;
    }
  }
  array(root, 'X', 'float32', [n, channels.length], X);

  // obs.
  const gather = (fn) => {
    const out = new Array(n);
    let i = 0;
    for (const item of items) for (const e of item.indices) out[i++] = fn(item, e);
    return out;
  };
  const obsColumns = [];
  const obsWriters = [];
  const add = (name, write) => {
    obsColumns.push(name);
    obsWriters.push(write);
  };
  const sampleNames = unique(items.map((it) => it.sample.name));
  const itemIndex = new Map(items.map((it, k) => [it, k]));
  add('sample', (g, name) => categorical(g, name, gather((it) => sampleNames[itemIndex.get(it)]), sampleNames));
  const fields = [...new Set(items.flatMap((it) => Object.entries(it.sample.meta ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k]) => k)))];
  for (const field of fields) add(field, (g, name) => categorical(g, name, gather((it) => (it.sample.meta?.[field] === undefined || it.sample.meta?.[field] === null ? null : String(it.sample.meta[field])))));
  add('event', (g, name) => array(g, name, 'int32', [n], Int32Array.from(gather((_, e) => e))));
  // Populations: the gates under the exported population, a column each, and the deepest one.
  const parent = options.populationId ?? ROOT;
  const under = (g) => parent === ROOT || gateAncestors(ws, g.id).some((a) => a.id === parent);
  const gates = (options.populations ?? ws.gates.filter((g) => g.id !== parent && under(g)).map((g) => g.id)).map((id) => gateById(ws, id)).filter(Boolean);
  const gateNames = unique(gates.map((g) => g.name));
  const membership = gates.map((gate) => {
    const sets = new Map();
    for (const item of items) {
      const members = population(item.view, ws, gate.id);
      const flags = new Uint8Array(item.view.eventCount);
      if (members === null) flags.fill(1);
      else if (members) for (const e of members) flags[e] = 1;
      sets.set(item, flags);
    }
    return sets;
  });
  if (gates.length) {
    // The deepest gate holding the event; the exported population when none does.
    const depth = gates.map((g) => gateAncestors(ws, g.id).length);
    const top = parent === ROOT ? 'All events' : gateById(ws, parent)?.name ?? 'All events';
    const categories = gateNames.includes(top) ? gateNames : [top, ...gateNames];
    add('population', (g, name) => categorical(g, name, gather((it, e) => {
      let best = -1;
      gates.forEach((_, j) => {
        if (membership[j].get(it)[e] && (best < 0 || depth[j] > depth[best])) best = j;
      });
      return best < 0 ? top : gateNames[best];
    }), categories));
  }
  gates.forEach((gate, j) => add(gateNames[j], (g, name) => encoding(hdf5Dataset(g, name, { type: 'bool', shape: [n], data: gather((it, e) => membership[j].get(it)[e] === 1) }), 'array', '0.2.0')));
  const derived = derivedChannels(ws, items);
  for (const cluster of derived.clusters) {
    const names = cluster.names.map((c, k) => c || `Cluster ${k + 1}`);
    add(cluster.name, (g, name) => categorical(g, name, gather((it, e) => {
      const v = it.view.column(cluster.name)[e];
      return v >= 0 && Number.isInteger(v) ? names[v] ?? `Cluster ${v + 1}` : null;
    }), names));
  }
  for (const flag of derived.flags) add(flag, (g, name) => encoding(hdf5Dataset(g, name, { type: 'bool', shape: [n], data: gather((it, e) => it.view.column(flag)[e] > 0.5) }), 'array', '0.2.0'));
  for (const channel of obsChannels) add(channel, (g, name) => array(g, name, 'float32', [n], Float32Array.from(gather((it, e) => it.view.column(channel)[e]))));
  const names = unique(obsColumns);
  const obs = dataframe(root, 'obs', names);
  strings(obs, '_index', gather((it, e) => `${sampleNames[itemIndex.get(it)]}:${e}`));
  obsWriters.forEach((write, i) => write(obs, names[i]));

  // var.
  const param = (name) => common.find((p) => p.name === name) ?? recorded(name);
  const markers = channels.map((c) => param(c)?.marker ?? '');
  const varNames = unique(channels.map((c, i) => markers[i] || c));
  const varFrame = dataframe(root, 'var', ['channel', 'marker', 'type']);
  strings(varFrame, '_index', varNames);
  strings(varFrame, 'channel', channels);
  strings(varFrame, 'marker', markers);
  categorical(varFrame, 'type', channels.map((c) => param(c)?.type ?? 'fluorescence'));

  // obsm: the maps (NaN where an event was not embedded).
  const obsm = dict(root, 'obsm');
  for (const map of derived.maps) {
    const out = new Float32Array(n * 2);
    let i = 0;
    for (const item of items) {
      const x = item.view.column(map.x);
      const y = item.view.column(map.y);
      let embedded = null;
      try { embedded = item.view.column('Embedded'); } catch { /* every event */ }
      for (const e of item.indices) {
        const inMap = !embedded || embedded[e] > 0.5;
        out[i * 2] = inMap ? x[e] : Number.NaN;
        out[i * 2 + 1] = inMap ? y[e] : Number.NaN;
        i += 1;
      }
    }
    array(obsm, map.key, 'float32', [n, 2], out);
  }
  for (const key of ['layers', 'obsp', 'varm', 'varp']) dict(root, key);

  // uns: where the file came from.
  const uns = dict(root, 'uns');
  const cw = dict(uns, 'cytoweave');
  const text = (name, value) => encoding(hdf5Dataset(cw, name, { type: 'string', data: String(value) }), 'string', '0.2.0');
  text('version', options.version ?? '');
  text('workspace', options.workspace ?? ws.name ?? '');
  text('exported', (options.date ?? new Date()).toISOString());
  text('population', parent === ROOT ? 'All events' : gatePath(ws, parent));
  text('values', values === 'arcsinh' ? `arcsinh(x / ${cofactor}) of compensated values` : 'compensated values');
  text('downsampling', describeDownsampling(options.downsample).replace(/^, /, '') || 'none');
  strings(cw, 'samples', items.map((it) => it.sample.name));
  strings(cw, 'sha256', items.map((it) => it.sample.sha256 ?? ''));
  strings(cw, 'files', items.map((it) => it.sample.fileName ?? ''));

  const bytes = writeHDF5(root);
  return {
    bytes,
    report: { events: n, samples: items.map((it) => ({ sample: it.sample.name, events: it.indices.length, of: it.total })), X: varNames, obs: names, obsm: derived.maps.map((m) => m.key), values, cofactor: values === 'arcsinh' ? cofactor : null },
  };
}
