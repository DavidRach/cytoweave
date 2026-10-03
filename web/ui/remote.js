// Remote control: actions sent by programs on this computer (AI agents through "cytoweave mcp",
// or scripts through /api/remote/action) are performed here, in the open window, where the user
// sees them and can undo them. Each action returns { ok, message, data }.

import { channelTransform, computeStatistic, countOf, describePopulation, gateRobustness, population, populationSet } from '../lib/engine.js';
import { createTransform } from '../lib/transforms.js';
import { drawScene } from '../lib/plot.js';
import { newId, quadrantGates, quadrantNames, splitGates } from '../lib/gates.js';
import { densityGateAt, suggestSinglets, valleyThreshold } from '../lib/autogate.js';
import { ROOT, addGates, gateById, gatePath, removeGate, uniqueGateName, updateGate } from '../lib/workspace.js';
import { describe } from '../lib/stats.js';
import { toast } from './overlays.js';

export class ActionError extends Error {}

function rasterImage(raster) {
  const canvas = new OffscreenCanvas(raster.width, raster.height);
  canvas.getContext('2d').putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  return canvas;
}

const round = (v, digits = 4) => (Number.isFinite(v) ? +v.toPrecision(digits) : null);

export function installRemote(app) {
  const { store, data } = app;
  const ws = () => store.ws;

  // --- Resolution of names ------------------------------------------------------------------------

  function resolveSample(ref) {
    const samples = ws().samples;
    if (!ref) {
      const current = samples.find((s) => s.id === store.ui.sampleId) ?? samples[0];
      if (!current) throw new ActionError('The workspace has no samples; open FCS files first.');
      return current;
    }
    const lower = String(ref).toLowerCase();
    const found = samples.find((s) => s.id === ref) ?? samples.find((s) => s.name.toLowerCase() === lower || s.fileName?.toLowerCase() === lower)
      ?? samples.find((s) => s.name.toLowerCase().includes(lower));
    if (!found) throw new ActionError(`No sample "${ref}". Samples: ${samples.slice(0, 20).map((s) => s.name).join(', ')}${samples.length > 20 ? '…' : ''}`);
    return found;
  }

  function resolvePopulation(ref) {
    if (!ref || /^(all events|all|root|ungated)$/i.test(String(ref).trim())) return ROOT;
    const gates = ws().gates;
    const direct = gates.find((g) => g.id === ref);
    if (direct) return direct.id;
    const text = String(ref).trim();
    if (text.includes('/')) {
      const parts = text.split('/').map((p) => p.trim().toLowerCase()).filter(Boolean);
      if (parts[0] === 'all events') parts.shift();
      let parentId = null;
      let gate = null;
      for (const part of parts) {
        gate = gates.find((g) => (g.parentId ?? null) === parentId && g.name.toLowerCase() === part);
        if (!gate) break;
        parentId = gate.id;
      }
      if (gate) return gate.id;
      // A path may skip levels: match by its last part and check the ancestry contains the rest.
      const last = parts[parts.length - 1];
      const candidates = gates.filter((g) => g.name.toLowerCase() === last && parts.every((p) => gatePath(ws(), g.id).toLowerCase().includes(p)));
      if (candidates.length === 1) return candidates[0].id;
    }
    const byName = gates.filter((g) => g.name.toLowerCase() === text.toLowerCase());
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1) throw new ActionError(`"${ref}" names ${byName.length} populations; use a path: ${byName.map((g) => gatePath(ws(), g.id)).join(' | ')}`);
    throw new ActionError(`No population "${ref}". Populations: ${gates.slice(0, 30).map((g) => gatePath(ws(), g.id)).join(' | ') || 'none yet'}`);
  }

  function resolveChannel(view, ref) {
    if (!ref) throw new ActionError('A channel is required.');
    const text = String(ref).trim();
    const lower = text.toLowerCase();
    const params = view.parameters;
    const found = params.find((p) => p.name === text) ?? params.find((p) => p.name.toLowerCase() === lower)
      ?? params.find((p) => p.marker && p.marker.toLowerCase() === lower) ?? params.find((p) => p.label && p.label.toLowerCase() === lower)
      ?? params.find((p) => p.marker && p.marker.toLowerCase().startsWith(lower));
    if (found) return found.name;
    for (const name of view.derived.keys()) if (name.toLowerCase() === lower) return name;
    throw new ActionError(`No channel "${ref}" in ${view.record.name}. Channels: ${params.map((p) => (p.marker ? `${p.name} (${p.marker})` : p.name)).join(', ')}`);
  }

  async function loadedView(sample) {
    return data.ensure(sample.id);
  }

  function populationRows(view) {
    const rows = [];
    const walk = (parentId, depth) => {
      for (const gate of ws().gates.filter((g) => (g.parentId ?? null) === parentId)) {
        const indices = populationSet(view, ws(), gate.id);
        const parent = populationSet(view, ws(), gate.parentId ?? ROOT);
        const count = indices === undefined ? null : countOf(indices, view);
        rows.push({
          path: gatePath(ws(), gate.id),
          id: gate.id,
          type: gate.type,
          channels: gate.dims.map((d) => d.channel),
          count,
          percentOfParent: count === null ? null : round((100 * count) / (countOf(parent, view) || 1)),
          percentOfTotal: count === null ? null : round((100 * count) / view.eventCount),
          adjustedForThisSample: Boolean(gate.overrides?.[view.id]),
          origin: gate.meta?.origin ?? 'manual',
        });
        walk(gate.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }

  // --- Actions ------------------------------------------------------------------------------------

  const actions = {
    async workspace_summary() {
      const w = ws();
      const current = w.samples.find((s) => s.id === store.ui.sampleId);
      let tree = null;
      if (current) tree = populationRows(await loadedView(current));
      return {
        message: `${w.name}: ${w.samples.length} samples, ${w.gates.length} gates.`,
        data: {
          workspace: w.name,
          samples: w.samples.map((s) => ({ name: s.name, events: s.eventCount, role: s.role, meta: s.meta, technology: s.technology, compensation: s.compensationId, cytometer: s.acquisition?.cytometer || undefined })),
          channels: current ? current.channels.map((c) => ({ name: c.name, marker: c.marker || undefined, type: c.type })) : [],
          groups: w.groups.map((g) => ({ name: g.name, samples: g.sampleIds.length })),
          populationsOfCurrentSample: tree,
          compensations: w.compensations.map((c) => ({ name: c.name, source: c.source, channels: c.channels.length })),
          derivedResults: w.derived.map((d) => ({ name: d.name, kind: d.kind, method: d.method, outputs: d.outputs })),
          window: { view: store.ui.mode, sample: current?.name ?? null, population: store.ui.gateId ? gatePath(w, store.ui.gateId) : 'All events' },
        },
      };
    },

    async open_files(args, event) {
      const files = event.files ?? [];
      const items = [];
      for (const file of files) {
        const response = await fetch(file.url);
        if (!response.ok) continue;
        items.push(Object.assign(new File([await response.arrayBuffer()], file.name), { folder: file.folder ?? null }));
      }
      const before = ws().samples.length;
      await app.importFiles(items);
      const added = ws().samples.slice(before);
      return { message: `Opened ${items.length} file(s); ${added.length} new sample(s).`, data: { samples: added.map((s) => ({ name: s.name, events: s.eventCount, role: s.role })) } };
    },

    async open_example(args) {
      await app.openExample(args.id);
      return { message: `Opened the example ${args.id}.`, data: { samples: ws().samples.map((s) => ({ name: s.name, role: s.role, events: s.eventCount, meta: s.meta })) } };
    },

    async select(args) {
      if (args.view) await app.setMode(args.view);
      if (args.sample) app.selectSample(resolveSample(args.sample).id);
      if (args.population !== undefined) {
        const id = resolvePopulation(args.population);
        app.selectGate(id === ROOT ? null : id, { keepMode: Boolean(args.view) });
      }
      return { message: `Showing ${store.ui.mode}${store.ui.sampleId ? `, ${resolveSample().name}` : ''}${store.ui.gateId ? `, ${gatePath(ws(), store.ui.gateId)}` : ''}.` };
    },

    async list_populations(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      return { message: `${ws().gates.length} populations in ${sample.name} (${view.eventCount} events).`, data: { sample: sample.name, events: view.eventCount, populations: populationRows(view) } };
    },

    async population_statistics(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const gateId = resolvePopulation(args.population);
      const indices = populationSet(view, ws(), gateId);
      if (indices === undefined) throw new ActionError('That population does not apply to this sample.');
      const channels = args.channels?.length ? args.channels.map((c) => resolveChannel(view, c)) : view.parameters.filter((p) => p.type === 'fluorescence').map((p) => p.name);
      const stats = describePopulation(view, ws(), gateId, channels);
      const gate = gateById(ws(), gateId);
      const parent = populationSet(view, ws(), gate?.parentId ?? ROOT);
      const count = countOf(indices, view);
      return {
        message: `${gate ? gatePath(ws(), gateId) : 'All events'} in ${sample.name}: ${count} events.`,
        data: {
          sample: sample.name,
          population: gate ? gatePath(ws(), gateId) : 'All events',
          count,
          percentOfParent: round((100 * count) / (countOf(parent, view) || 1)),
          percentOfTotal: round((100 * count) / view.eventCount),
          compensated: Boolean(view.compensation),
          channels: Object.fromEntries(Object.entries(stats ?? {}).map(([channel, d]) => [channel, { marker: view.channelInfo(channel)?.marker || undefined, median: round(d.median), mean: round(d.mean), geomean: round(d.geomean), sd: round(d.sd), robustSD: round(d.rsd), cv: round(d.cv), robustCV: round(d.rcv), p5: round(d.p5), p95: round(d.p95) }])),
        },
      };
    },

    async statistics_table(args) {
      const w = ws();
      const group = args.group ? w.groups.find((g) => g.name.toLowerCase() === String(args.group).toLowerCase()) : null;
      if (args.group && !group) throw new ActionError(`No group "${args.group}".`);
      const samples = w.samples.filter((s) => (group ? group.sampleIds.includes(s.id) : s.role === 'sample' || s.role === 'reference'));
      const gateIds = args.populations?.length ? args.populations.map(resolvePopulation) : w.gates.map((g) => g.id);
      const stat = args.statistic ?? 'freqParent';
      const rows = [];
      for (const sample of samples) {
        const view = await loadedView(sample);
        const channel = args.channel ? resolveChannel(view, args.channel) : undefined;
        const values = {};
        for (const id of gateIds) values[id === ROOT ? 'All events' : gatePath(w, id)] = round(computeStatistic(view, w, { stat, gateId: id, channel }), 6);
        rows.push({ sample: sample.name, meta: sample.meta, values });
      }
      return { message: `${stat}${args.channel ? ` of ${args.channel}` : ''} for ${gateIds.length} population(s) in ${samples.length} sample(s).`, data: { statistic: stat, channel: args.channel, rows } };
    },

    async render_plot(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const x = resolveChannel(view, args.x);
      const y = args.y ? resolveChannel(view, args.y) : null;
      const gateId = resolvePopulation(args.population);
      const width = Math.min(1600, Math.max(200, Number(args.width) || 520));
      const height = Math.min(1600, Math.max(200, Number(args.height) || 480));
      const spec = { populationId: gateId, x, y, type: y ? (args.type && args.type !== 'histogram' ? args.type : 'pseudocolor') : 'histogram', options: {} };
      const scene = app.buildExportScene(ws(), view, spec, { width, height, theme: 'light', title: `${sample.name} · ${gateId === ROOT ? 'All events' : gatePath(ws(), gateId)}` });
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      drawScene(ctx, scene, rasterImage);
      return { message: `${spec.type} of ${gateId === ROOT ? 'all events' : gatePath(ws(), gateId)} in ${sample.name}: ${y ? `${x} × ${y}` : x}.`, data: { image: canvas.toDataURL('image/png'), width: width * 2, height: height * 2, sample: sample.name } };
    },

    async create_gate(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const parentRef = resolvePopulation(args.parent);
      const parentId = parentRef === ROOT ? null : parentRef;
      const x = resolveChannel(view, args.x);
      const oneD = args.type === 'range' || args.type === 'split';
      const y = oneD ? null : resolveChannel(view, args.y);
      const tx = channelTransform(ws(), view, x);
      const ty = y ? channelTransform(ws(), view, y) : null;
      const fx = createTransform(tx).forward;
      const fy = ty ? createTransform(ty).forward : null;
      const dims = [{ channel: x, transform: { ...tx } }, ...(y ? [{ channel: y, transform: { ...ty } }] : [])];
      const c = args.coordinates ?? {};
      const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
      let gates;
      const marker = (channel) => view.channelInfo(channel)?.marker || channel.replace(/-[AHW]$/, '');
      switch (args.type) {
        case 'rectangle': {
          const [x0, x1, y0, y1] = [num(c.xMin), num(c.xMax), num(c.yMin), num(c.yMax)];
          gates = [{ type: 'rectangle', geometry: { min: [x0 === null ? null : fx(x0), y0 === null ? null : fy(y0)], max: [x1 === null ? null : fx(x1), y1 === null ? null : fy(y1)] } }];
          break;
        }
        case 'polygon': {
          if (!Array.isArray(c.vertices) || c.vertices.length < 3) throw new ActionError('A polygon needs at least three vertices: {"vertices": [[x, y], ...]}.');
          gates = [{ type: 'polygon', geometry: { vertices: c.vertices.map(([vx, vy]) => [fx(Number(vx)), fy(Number(vy))]) } }];
          break;
        }
        case 'ellipse': {
          const [cx, cy] = c.center ?? [];
          const [rx, ry] = c.semiAxes ?? [0.08, 0.08];
          gates = [{ type: 'ellipse', geometry: { center: [fx(Number(cx)), fy(Number(cy))], radii: [Number(rx), Number(ry)], angle: ((Number(c.angle) || 0) * Math.PI) / 180 } }];
          break;
        }
        case 'range':
          gates = [{ type: 'range', geometry: { min: num(c.min) === null ? null : fx(num(c.min)), max: num(c.max) === null ? null : fx(num(c.max)) } }];
          break;
        case 'quadrant': {
          const [qx, qy] = c.at ?? [];
          gates = quadrantGates({ parentId, dims, center: [fx(Number(qx)), fy(Number(qy))], names: quadrantNames(marker(x), marker(y)) });
          break;
        }
        case 'split':
          gates = splitGates({ parentId, dims, threshold: fx(Number(c.threshold)), xName: marker(x) });
          break;
        default:
          throw new ActionError('type must be rectangle, polygon, ellipse, range, quadrant or split.');
      }
      return commitGates(gates, { parentId, dims, name: args.name, view, origin: 'agent' });
    },

    async auto_gate(args) {
      const sample = resolveSample(args.sample);
      const view = await loadedView(sample);
      const parentRef = resolvePopulation(args.parent);
      const parentId = parentRef === ROOT ? null : parentRef;
      const parentIndices = population(view, ws(), parentRef);
      if (parentIndices === undefined) throw new ActionError('The parent population does not apply to this sample.');
      const x = resolveChannel(view, args.x);
      const tx = channelTransform(ws(), view, x);
      const xs = view.scaled(x, tx);
      if (args.method === 'valley') {
        const result = valleyThreshold(xs, parentIndices);
        const name = view.channelInfo(x)?.marker || x.replace(/-[AHW]$/, '');
        return commitGates(splitGates({ parentId, dims: [{ channel: x, transform: { ...tx } }], threshold: result.threshold, xName: name }), { parentId, view, origin: 'auto', method: 'valley', explanation: result.explanation });
      }
      const y = resolveChannel(view, args.y);
      const ty = channelTransform(ws(), view, y);
      const ys = view.scaled(y, ty);
      const dims = [{ channel: x, transform: { ...tx } }, { channel: y, transform: { ...ty } }];
      let proposal;
      if (args.method === 'singlets') {
        proposal = suggestSinglets(view.column(x), view.column(y), parentIndices, createTransform(tx), createTransform(ty));
        if (!proposal) throw new ActionError('Too few events to propose a singlet gate.');
        if (!args.name) args.name = 'Singlets';
      } else {
        const [ax, ay] = args.at ?? [];
        if (!Number.isFinite(Number(ax)) || !Number.isFinite(Number(ay))) throw new ActionError('density needs "at": [x, y] in data values, a point inside the population.');
        proposal = densityGateAt(xs, ys, parentIndices, createTransform(tx).forward(Number(ax)), createTransform(ty).forward(Number(ay)));
        if (!proposal) throw new ActionError('No population was found at that point.');
      }
      return commitGates([{ type: proposal.type, geometry: proposal.geometry }], { parentId, dims, name: args.name, view, origin: 'auto', method: args.method, explanation: proposal.explanation });
    },

    async edit_gate(args) {
      const id = resolvePopulation(args.population);
      if (id === ROOT) throw new ActionError('All events is not a gate.');
      const gate = gateById(ws(), id);
      if (args.delete) {
        store.commit(removeGate(ws(), id), `Delete ${gate.name} (agent)`);
        return { message: `Deleted ${gate.name} and its subpopulations. The user can undo this.` };
      }
      const patch = {};
      if (args.name) patch.name = String(args.name);
      if (args.color && /^#[0-9a-f]{6}$/i.test(args.color)) patch.color = args.color;
      if (!Object.keys(patch).length) throw new ActionError('Give a new name, a color or delete: true.');
      store.commit(updateGate(ws(), id, patch), `Edit ${gate.name} (agent)`);
      return { message: `Updated ${gatePath(ws(), id)}.` };
    },

    async review_gate(args) {
      const id = resolvePopulation(args.population);
      if (id === ROOT) throw new ActionError('Name a gated population.');
      const gate = gateById(ws(), id);
      const rows = [];
      for (const sample of ws().samples.filter((s) => s.role === 'sample' || s.role === 'reference')) {
        const view = await loadedView(sample);
        const indices = populationSet(view, ws(), id);
        if (indices === undefined) continue;
        const parent = populationSet(view, ws(), gate.parentId ?? ROOT);
        const robustness = gateRobustness(view, ws(), id);
        rows.push({ sample: sample.name, count: countOf(indices, view), percentOfParent: (100 * countOf(indices, view)) / (countOf(parent, view) || 1), boundary: robustness?.rating, sensitivity: round(robustness?.sensitivity), adjusted: Boolean(gate.overrides?.[sample.id]) });
      }
      const freqs = rows.map((r) => r.percentOfParent).sort((a, b) => a - b);
      const median = freqs[Math.floor(freqs.length / 2)] ?? 0;
      const mad = (freqs.map((f) => Math.abs(f - median)).sort((a, b) => a - b)[Math.floor(freqs.length / 2)] ?? 0) * 1.4826 || 1e-9;
      for (const row of rows) {
        row.z = round((row.percentOfParent - median) / mad, 3);
        row.percentOfParent = round(row.percentOfParent);
      }
      rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      const outliers = rows.filter((r) => Math.abs(r.z) > 3).map((r) => r.sample);
      return { message: `${gate.name}: median ${median.toFixed(2)}% of parent across ${rows.length} samples${outliers.length ? `; outliers: ${outliers.join(', ')}` : '; no outliers'}.`, data: { population: gatePath(ws(), id), median: round(median), rows } };
    },

    async compare(args) {
      const hypothesis = await import('../lib/hypothesis.js');
      const w = ws();
      const id = resolvePopulation(args.population);
      const stat = args.statistic ?? 'freqParent';
      const field = String(args.groupBy);
      const samples = w.samples.filter((s) => (s.role === 'sample' || s.role === 'reference') && s.meta?.[field] !== undefined && s.meta[field] !== '');
      if (!samples.length) throw new ActionError(`No sample has the metadata field "${field}". Annotate samples first (fields in use: ${[...new Set(w.samples.flatMap((s) => Object.keys(s.meta ?? {})))].join(', ') || 'none'}).`);
      const groups = new Map();
      for (const sample of samples) {
        const view = await loadedView(sample);
        const channel = args.channel ? resolveChannel(view, args.channel) : undefined;
        const value = computeStatistic(view, w, { stat, gateId: id, channel });
        if (!Number.isFinite(value)) continue;
        const key = String(sample.meta[field]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ sample: sample.name, value, pair: args.pairBy ? sample.meta?.[args.pairBy] : undefined });
      }
      const names = [...groups.keys()];
      const values = names.map((n) => groups.get(n).map((r) => r.value));
      const summary = names.map((n, i) => ({ group: n, n: values[i].length, median: round(describe(Float32Array.from(values[i])).median), mean: round(values[i].reduce((a, b) => a + b, 0) / values[i].length), samples: groups.get(n) }));
      const tests = [];
      if (names.length === 2) {
        const [a, b] = values;
        let paired = null;
        if (args.pairBy) {
          const map = new Map(groups.get(names[1]).map((r) => [String(r.pair), r.value]));
          const pa = []; const pb = [];
          for (const r of groups.get(names[0])) if (map.has(String(r.pair))) { pa.push(r.value); pb.push(map.get(String(r.pair))); }
          if (pa.length >= 2) paired = [pa, pb];
        }
        const attempt = (fn) => { try { tests.push(fn()); } catch (error) { tests.push({ method: 'not computed', note: error.message }); } };
        if (paired) {
          attempt(() => hypothesis.pairedTTest(paired[0], paired[1]));
          attempt(() => hypothesis.wilcoxonSignedRank(paired[0], paired[1]));
        } else {
          attempt(() => hypothesis.welchTTest(a, b));
          attempt(() => hypothesis.mannWhitneyU(a, b));
          attempt(() => ({ method: 'Hedges g', ...hypothesis.cohensD(a, b) }));
        }
      } else if (names.length > 2) {
        tests.push(hypothesis.welchAnova(values), hypothesis.kruskalWallis(values));
      }
      const label = `${stat}${args.channel ? ` of ${args.channel}` : ''} of ${id === ROOT ? 'all events' : gatePath(w, id)}`;
      const clean = JSON.parse(JSON.stringify(tests, (k, v) => (typeof v === 'number' ? round(v, 6) : v)));
      return { message: `${label} by ${field}: ${summary.map((s) => `${s.group} median ${s.median} (n=${s.n})`).join(' vs ')}${clean[0]?.p !== undefined ? `; ${clean[0].method} p = ${clean[0].p}` : ''}. Each sample is one observation.`, data: { measure: label, groupBy: field, pairBy: args.pairBy, groups: summary, tests: clean } };
    },

    async methods() {
      const { writeMethods } = await import('../lib/methods.js');
      const { paragraphs, references } = writeMethods(ws(), { version: app.version });
      return { message: `${paragraphs.join('\n\n')}\n\nReferences\n${references.map((r, i) => `${i + 1}. ${r.text}${r.doi ? ` doi:${r.doi}` : ''}`).join('\n')}` };
    },

    async export_gating_ml() {
      const { exportGatingML } = await import('../lib/gatingml.js');
      const result = exportGatingML(ws());
      const xml = typeof result === 'string' ? result : result.xml;
      return { message: xml, data: { warnings: result.warnings ?? [] } };
    },
  };

  function commitGates(gates, { parentId, dims, name, view, origin, method, explanation }) {
    const w = ws();
    const meta = { origin, method, note: explanation, created: new Date().toISOString() };
    const records = gates.map((g) => ({
      id: g.id ?? newId('g'),
      parentId,
      dims: g.dims ?? dims,
      linkId: g.linkId,
      type: g.type,
      geometry: g.geometry,
      name: uniqueGateName(w, parentId, g.name ?? name ?? defaultName(view, g.dims ?? dims, g)),
      meta,
    }));
    const result = addGates(w, records, 'add-gate-agent');
    store.commit(result.ws, `Add ${records.map((r) => r.name).join(', ')} (${origin === 'auto' ? 'proposed' : 'agent'})`);
    app.selectGate(records[records.length > 1 ? 1 : 0].id, { keepMode: true });
    toast(`${origin === 'auto' ? 'Proposed' : 'An agent added'} ${records.map((r) => r.name).join(', ')}. Undo with ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Z.`);
    const parent = populationSet(view, store.ws, parentId ?? ROOT);
    const created = records.map((r) => {
      const indices = populationSet(view, store.ws, r.id);
      return { population: gatePath(store.ws, r.id), count: indices === undefined ? null : countOf(indices, view), percentOfParent: indices === undefined ? null : round((100 * countOf(indices, view)) / (countOf(parent, view) || 1)) };
    });
    return { message: `${created.map((c) => `${c.population}: ${c.percentOfParent}% of parent (${c.count} events)`).join('; ')} in ${view.record.name}.${explanation ? ` ${explanation}` : ''}`, data: { created } };
  }

  function defaultName(view, dims, gate) {
    const label = (channel) => view.channelInfo(channel)?.marker || channel.replace(/-[AHW]$/, '');
    if (dims.length === 1) return `${label(dims[0].channel)}+`;
    return `${label(dims[0].channel)} × ${label(dims[1].channel)}`;
  }

  // --- Connection ---------------------------------------------------------------------------------

  async function perform(event) {
    let outcome;
    try {
      const handler = actions[event.action];
      if (!handler) throw new ActionError(`Unknown action "${event.action}". Actions: ${Object.keys(actions).join(', ')}.`);
      const args = typeof event.args === 'object' && event.args ? event.args : {};
      const result = await handler(args, event);
      outcome = { ok: true, message: result.message ?? 'Done.', data: result.data ?? null };
    } catch (error) {
      outcome = { ok: false, message: error.message ?? String(error) };
    }
    await fetch(`api/remote/result/${encodeURIComponent(event.id)}`, { method: 'POST', body: JSON.stringify(outcome), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  }

  let source = null;
  const connect = () => {
    source = new EventSource('api/remote/events');
    source.addEventListener('action', (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      perform(event);
    });
    source.onerror = () => {
      source.close();
      setTimeout(connect, 2000);
    };
  };
  connect();
  app.remoteActions = actions;
  return { disconnect: () => source?.close() };
}
