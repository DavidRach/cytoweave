// Remote control: actions sent by programs on this computer (AI agents through "cytoweave mcp",
// or scripts through /api/remote/action) are performed here, in the open window, where the user
// sees them and can undo them. Each action returns { ok, message, data }.

import { channelTransform, computeStatistic, countOf, describePopulation, gateRobustness, population, populationSet } from '../lib/engine.js';
import { createTransform } from '../lib/transforms.js';
import { drawScene } from '../lib/plot.js';
import { newId, quadrantGates, quadrantNames, splitGates } from '../lib/gates.js';
import { densityGateAt, suggestSinglets, valleyThreshold } from '../lib/autogate.js';
import { ROOT, SAMPLE_ROLES, gateById, gatePath, uniqueGateName } from '../lib/workspace.js';
import { describeProposal, openProposals, proposalHistory, proposeAnnotations, proposeCompensation, proposeDerived, proposeFigure, proposeGateAdjustments, proposeGateEdit, proposeGateRemoval, proposeGates, proposeRootGate } from '../lib/proposals.js';
import { spilloverFromControls } from './controls.js';
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
  // Who sent the action being performed (an MCP client's name, or a script's).
  let author = 'an AI agent';

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
      return { message: `${ws().gates.length} population${ws().gates.length === 1 ? '' : 's'} in ${sample.name} (${view.eventCount} events).`, data: { sample: sample.name, events: view.eventCount, populations: populationRows(view) } };
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
        const result = proposeGateRemoval(ws(), author, id);
        store.commit(result.ws, `${author} ${result.held ? 'proposed deleting' : 'deleted'} ${gate.name}`);
        if (result.held) toast(`${author} proposes deleting ${gate.name}. Review the proposal to accept or reject it.`);
        return { message: result.held ? `Proposed deleting ${gate.name} and its subpopulations; it stays until the user accepts your proposal.` : `Deleted ${gate.name}, which you had proposed, with its subpopulations.`, data: { proposal: proposalSummary() } };
      }
      const patch = {};
      if (args.name && String(args.name) !== gate.name) patch.name = uniqueGateName(ws(), gate.parentId, String(args.name));
      if (args.color && /^#[0-9a-f]{6}$/i.test(args.color)) patch.color = args.color;
      if (!Object.keys(patch).length) throw new ActionError('Give a new name, a color or delete: true.');
      const result = proposeGateEdit(ws(), author, id, patch);
      store.commit(result.ws, `${author} ${result.held ? 'proposed changing' : 'changed'} ${gate.name}`);
      return { message: result.held ? `Proposed the change to ${gatePath(ws(), id)}; it applies when the user accepts your proposal.` : `Updated ${gatePath(ws(), id)}.`, data: { proposal: proposalSummary() } };
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

    async adapt_gate(args) {
      const { adaptAcrossSamples, autogatingRecord, cannotAdapt } = await import('../lib/autogating.js');
      const id = resolvePopulation(args.population);
      if (id === ROOT) throw new ActionError('Name a gated population.');
      let gate = gateById(ws(), id);
      // Quadrants and splits move as a family: adapt their first member.
      if (gate.linkId) gate = ws().gates.find((g) => g.linkId === gate.linkId) ?? gate;
      const reason = cannotAdapt(gate);
      if (reason) throw new ActionError(`${gate.name}: ${reason}.`);
      const views = new Map();
      for (const sample of ws().samples.filter((s) => s.role === 'sample' || s.role === 'reference' || gate.overrides?.[s.id] || gate.meta?.drawnOn === s.id)) {
        const view = await loadedView(sample).catch(() => null);
        if (view) views.set(sample.id, view);
      }
      let run;
      try {
        run = adaptAcrossSamples(ws(), gate.id, views, { groupBy: args.groupBy || undefined });
      } catch (error) {
        throw new ActionError(`${gate.name}: ${error.message}`);
      }
      const name = (sampleId) => ws().samples.find((s) => s.id === sampleId)?.name ?? sampleId;
      const confident = run.results.filter((r) => r.status === 'adjust');
      if (confident.length) {
        const record = { ...autogatingRecord(ws(), gate, run, confident.map((r) => r.sampleId), app.version), proposedBy: author };
        const result = proposeGateAdjustments(ws(), author, gate.id, Object.fromEntries(confident.map((r) => [r.sampleId, r.geometry])), Object.fromEntries(confident.map((r) => [r.sampleId, round(r.confidence, 3)])), record);
        store.commit(result.ws, `${author} ${result.held ? 'proposed adapting' : 'adapted'} ${gate.name} to ${confident.length} sample${confident.length === 1 ? '' : 's'}`);
        if (result.held) toast(`${author} proposes adjusting ${gate.name} for ${confident.length} sample${confident.length === 1 ? '' : 's'}. Review the proposal to accept or reject it.`);
      }
      const order = { review: 0, adjust: 1, keep: 2 };
      const rows = run.results.slice().sort((a, b) => order[a.status] - order[b.status] || a.confidence - b.confidence).map((r) => ({
        sample: name(r.sampleId),
        group: r.group ?? undefined,
        status: r.status,
        confidence: round(r.confidence, 3),
        percentOfParentNow: round(100 * r.frequencies.current),
        percentOfParentAdapted: round(100 * r.frequencies.adapted),
        reason: r.reason,
      }));
      const counts = { adjust: 0, keep: 0, review: 0 };
      for (const r of run.results) counts[r.status] += 1;
      const review = rows.filter((r) => r.status === 'review').map((r) => r.sample);
      return {
        message: `${gate.name}, learned from ${run.exemplars.map((e) => `${name(e.sampleId)} (${e.kind})`).join(', ')}: ${counts.keep} sample${counts.keep === 1 ? '' : 's'} already fit; ${counts.adjust ? `proposed adjustments for ${counts.adjust}, which apply when the user accepts your proposal` : 'nothing to adjust'}; ${review.length ? `${review.length} uncertain, for the user to check by hand: ${review.join(', ')}` : 'none uncertain'}.${run.skipped.length ? ` Not adapted: ${run.skipped.map((s) => `${name(s.sampleId)} (${s.reason})`).join('; ')}.` : ''}`,
        data: { population: gatePath(ws(), gate.id), learnedFrom: run.exemplars.map((e) => ({ sample: name(e.sampleId), kind: e.kind })), rows, skipped: run.skipped.map((s) => ({ sample: name(s.sampleId), reason: s.reason })), proposal: proposalSummary() },
      };
    },

    async propose_compensation(args) {
      const gateId = args.population ? resolvePopulation(args.population) : ROOT;
      const unstained = args.unstained ? resolveSample(args.unstained) : null;
      const method = args.method === 'regression' ? 'regression' : 'median';
      let result;
      try {
        result = await spilloverFromControls(data, ws(), { gateId: gateId === ROOT ? null : gateId, unstainedId: unstained?.id ?? null, method });
      } catch (error) {
        throw new ActionError(`${error.message} Single-stain controls have the role "single-stain" and a stained channel (workspace_summary lists the samples).`);
      }
      const targets = args.samples?.length ? args.samples.map((s) => resolveSample(s)) : ws().samples.filter((s) => s.role !== 'single-stain' && s.role !== 'unstained');
      if (!targets.length) throw new ActionError('No samples to apply the matrix to.');
      const name = `Proposed by ${author} (${method}, ${new Date().toLocaleDateString()})`;
      const proposed = proposeCompensation(ws(), author, { name, channels: result.detectors, matrix: result.matrix, source: 'computed', method, report: result.report }, targets.map((s) => s.id));
      store.commit(proposed.ws, `${author} proposed a compensation matrix`);
      toast(`${author} proposes a compensation matrix from ${result.controls.length} controls. Review the proposal to accept or reject it.`);
      const n = result.detectors.length;
      const largest = [];
      for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (i !== j) largest.push({ from: result.detectors[i], into: result.detectors[j], spillover: round(result.matrix[i * n + j], 3) });
      largest.sort((a, b) => b.spillover - a.spillover);
      const warnings = result.report.flatMap((r) => (r.warnings ?? []).map((w) => `${r.control}: ${w}`));
      return { message: `Proposed a ${n}×${n} matrix from ${result.controls.length} single-stain controls for ${targets.length} sample${targets.length === 1 ? '' : 's'}; it applies when the user accepts your proposal.${warnings.length ? ` Warnings: ${warnings.slice(0, 4).join(' ')}` : ''}`, data: { detectors: result.detectors, largest: largest.slice(0, 12), warnings, proposal: proposalSummary() } };
    },

    async annotate_samples(args) {
      const list = Array.isArray(args.samples) ? args.samples : [];
      if (!list.length) throw new ActionError('Give samples: [{ "sample": "name", "meta": { "condition": "stim" }, "role": "single-stain", "stain": "FITC-A" }, ...].');
      const changes = {};
      const described = [];
      for (const entry of list) {
        const sample = resolveSample(entry.sample);
        const change = {};
        if (entry.meta && typeof entry.meta === 'object') {
          change.meta = {};
          for (const [field, value] of Object.entries(entry.meta)) {
            const key = String(field).trim();
            if (!key) continue;
            change.meta[key] = value === null || value === undefined || value === '' ? null : String(value);
          }
        }
        if (entry.role !== undefined) {
          if (!SAMPLE_ROLES.includes(entry.role)) throw new ActionError(`Role "${entry.role}" is not one of ${SAMPLE_ROLES.join(', ')}.`);
          change.role = entry.role;
        }
        if (entry.stain !== undefined) {
          if (entry.stain === null || entry.stain === '') change.stain = null;
          else {
            const channel = sample.channels.find((c) => c.name === entry.stain || c.name.toLowerCase() === String(entry.stain).toLowerCase() || (c.marker && c.marker.toLowerCase() === String(entry.stain).toLowerCase()));
            if (!channel) throw new ActionError(`${sample.name} has no channel "${entry.stain}". Channels: ${sample.channels.map((c) => c.name).join(', ')}`);
            change.stain = channel.name;
          }
        }
        if (!Object.keys(change).length) continue;
        changes[sample.id] = { ...(changes[sample.id] ?? {}), ...change, meta: { ...(changes[sample.id]?.meta ?? {}), ...(change.meta ?? {}) } };
        described.push(`${sample.name}: ${[...Object.entries(change.meta ?? {}).map(([k, v]) => `${k} = ${v ?? '(removed)'}`), ...(change.role ? [`role ${change.role}`] : []), ...(change.stain !== undefined ? [`stained channel ${change.stain ?? '(none)'}`] : [])].join(', ')}`);
      }
      if (!described.length) throw new ActionError('Nothing to annotate: give meta, role or stain for each sample.');
      const result = proposeAnnotations(ws(), author, changes);
      store.commit(result.ws, `${author} proposed annotating ${described.length} sample${described.length === 1 ? '' : 's'}`);
      toast(`${author} proposes annotations for ${described.length} sample${described.length === 1 ? '' : 's'}. Review the proposal to accept or reject them.`);
      return { message: `Proposed annotations for ${described.length} sample${described.length === 1 ? '' : 's'}; they apply when the user accepts your proposal (until then, compare and the other tools see the current annotations).`, data: { annotations: described, proposal: proposalSummary() } };
    },

    async run_qc(args) {
      const qc = await import('./qc-run.js');
      const w = ws();
      const chosen = args.samples?.length ? args.samples.map((s) => resolveSample(s)) : w.samples.filter((s) => s.role === 'sample' || s.role === 'reference' || (args.includeControls && s.role !== 'bead'));
      if (!chosen.length) throw new ActionError('No samples to check.');
      const existing = w.derived.find((d) => d.kind === 'qc' && !d.proposal && d.outputs?.includes(qc.QC_CHANNEL));
      const proposed = w.derived.find((d) => d.kind === 'qc' && d.proposal && d.proposedBy === author);
      const already = chosen.filter((s) => existing?.files?.[s.id]);
      const todo = chosen.filter((s) => !existing?.files?.[s.id]);
      const settings = structuredClone(app.qcState?.settings ?? qc.DEFAULT_SETTINGS);
      if (args.variant) {
        if (!['refined', 'classic'].includes(args.variant)) throw new ActionError('variant is refined or classic.');
        settings.variant = args.variant;
      }
      if (args.mad !== undefined) settings.mad = Number(args.mad);
      const results = new Map();
      for (const sample of todo) {
        const result = await qc.runQC(app, sample, settings);
        results.set(sample.id, result);
        app.qcState?.results?.set(sample.id, result);
      }
      if (results.size) {
        const perSample = new Map();
        const summaries = { ...(proposed?.summary?.perSample ?? {}) };
        for (const [id, result] of results) {
          perSample.set(id, { [qc.QC_CHANNEL]: Float32Array.from(result.mask) });
          summaries[id] = result.persisted;
        }
        await proposeResult({
          id: proposed?.id,
          kind: 'qc',
          name: 'Acquisition QC',
          method: 'PeacoQC + flow rate + margins',
          params: qc.paramsOf(settings),
          seed: 1,
          outputs: [qc.QC_CHANNEL],
          files: proposed?.files ?? {},
          summary: { version: 1, software: `CytoWeave ${app.version ?? ''}`.trim(), references: [qc.QC_CITE.peacoqc, qc.QC_CITE.flowai], perSample: summaries },
        }, perSample, `${author} proposed acquisition QC of ${results.size} sample${results.size === 1 ? '' : 's'}`);
      }
      let gate = null;
      if (args.addGate) {
        if (w.gates.some((g) => g.dims.some((d) => d.channel === qc.QC_CHANNEL))) gate = 'a gate on QC pass exists already';
        else {
          store.commit(proposeRootGate(ws(), author, qc.qcPassGate()).ws, `${author} proposed a QC pass gate at the top`);
          gate = 'proposed at the top of the gating tree';
        }
      }
      if (results.size || gate) toast(`${author} proposes ${[results.size ? `acquisition QC of ${results.size} sample${results.size === 1 ? '' : 's'}` : '', gate === 'proposed at the top of the gating tree' ? 'a “QC pass” gate at the top' : ''].filter(Boolean).join(' and ')}. Review the proposal to accept or reject it.`);
      const rows = [...results.entries()].map(([id, r]) => {
        const p = r.persisted;
        return { sample: p.name, score: p.score, grade: p.grade, percentRemoved: round(p.percentRemoved, 3), events: p.eventCount, removed: p.removed, findings: p.findings.filter((f) => f.method !== 'summary' && f.severity !== 'info').slice(0, 4).map((f) => f.text), drifted: p.drifted };
      }).sort((a, b) => a.score - b.score);
      const low = rows.filter((r) => r.score < 70).map((r) => `${r.sample} (${r.score})`);
      return {
        message: `${rows.length ? `Checked ${rows.length} sample${rows.length === 1 ? '' : 's'} (${settings.variant ?? 'refined'} PeacoQC, flow rate, margins, drift): ${low.length ? `low scores: ${low.join(', ')}` : 'all scored 70 or more'}. The results are proposed: their "${qc.QC_CHANNEL}" channel (1 = passed) can be gated at once.` : 'No sample needed checking.'}${already.length ? ` Already checked by the user (their result stands): ${already.map((s) => s.name).join(', ')}.` : ''}${gate ? ` QC pass gate: ${gate}${gate.startsWith('proposed') ? '; it moves every population beneath it when the user accepts' : ''}.` : ''}`,
        data: { rows, alreadyChecked: already.map((s) => s.name), gate, proposal: proposalSummary() },
      };
    },

    async unmix(args) {
      const run = await import('./spectral-run.js');
      const { AF_MODES, METHODS } = await import('../lib/spectral-ui.js');
      let state = run.spectralState(ws());
      if (!state.controls.length) throw new ActionError('Spectral unmixing needs single-stain reference controls: give them the role "single-stain" (annotate_samples; the user must accept), and an unstained control the role "unstained" for autofluorescence.');
      const steps = [];
      const setup = state.setup;
      const mine = setup?.proposal && setup.proposedBy === author;
      const hasSpectra = state.activeRefs().length > 0;
      // The user's reference library is used as it is; the agent builds (or rebuilds) only its own.
      if (setup && !setup.proposal && !hasSpectra) throw new ActionError('The reference library has no spectra yet. The user computes them in the Spectral view (or, with no library, unmix computes a proposed one).');
      if (!setup || (mine && (args.recompute || !hasSpectra))) {
        const refs = await run.computeReferences(app, {});
        let record = { ...(setup ?? run.baseSetup(state, app.version)), references: refs.references, params: refs.params, spreading: null, modified: new Date().toISOString() };
        record = proposeDerived(ws(), author, record);
        store.commit(record.ws, `${author} proposed reference spectra from ${refs.computed.length} controls`, ['derived']);
        const failed = refs.computed.filter((r) => r.error);
        steps.push(`reference spectra from ${refs.computed.length - failed.length} of ${refs.computed.length} controls${failed.length ? ` (failed: ${failed.map((r) => `${r.sampleName}: ${r.error}`).join('; ')})` : ''}`);
        state = run.spectralState(ws());
        if (state.unstainedSample && args.autofluorescence !== false) {
          const gateId = args.unstainedPopulation ? resolvePopulation(args.unstainedPopulation) : null;
          const af = await run.findAutofluorescence(app, { gateId });
          if (af) {
            const next = proposeDerived(ws(), author, { ...state.setup, autofluorescence: af.autofluorescence, settings: { ...(state.setup.settings ?? {}), afMode: af.afMode }, modified: new Date().toISOString() });
            store.commit(next.ws, `${author} proposed ${af.autofluorescence.k} autofluorescence signature${af.autofluorescence.k > 1 ? 's' : ''}`, ['derived']);
            steps.push(`${af.autofluorescence.k} autofluorescence signature${af.autofluorescence.k > 1 ? 's' : ''} from ${state.unstainedSample.name} (${af.autofluorescence.population})`);
          }
        }
        state = run.spectralState(ws());
      } else {
        steps.push(`the ${setup.proposal ? 'proposed' : "user's"} reference library (${state.activeRefs().length} spectra, ${state.afSignatures().length} autofluorescence signature${state.afSignatures().length === 1 ? '' : 's'})`);
      }
      const existing = ws().derived.find((d) => d.kind === 'unmixing' && !d.proposal);
      const chosen = args.samples?.length ? args.samples.map((x) => resolveSample(x)) : ws().samples.filter((x) => x.role === 'sample' || x.role === 'reference');
      const already = chosen.filter((x) => existing?.files?.[x.id]);
      const todo = chosen.filter((x) => !existing?.files?.[x.id]);
      if (args.method && !METHODS.some((m) => m.id === args.method)) throw new ActionError(`method is one of ${METHODS.map((m) => m.id).join(', ')}.`);
      if (args.autofluorescenceMode && !AF_MODES.some((m) => m.id === args.autofluorescenceMode)) throw new ActionError(`autofluorescenceMode is one of ${AF_MODES.map((m) => m.id).join(', ')}.`);
      let unmixed = null;
      if (todo.length) {
        try {
          unmixed = await run.unmixSamples(app, todo, { method: args.method, afMode: args.autofluorescenceMode });
        } catch (error) {
          throw new ActionError(`${error.message}${steps.length ? ` (done so far, proposed: ${steps.join('; ')})` : ''}`);
        }
        const { perSample, ...record } = unmixed.result;
        await proposeResult(record, perSample, `${author} proposed unmixing ${perSample.size} sample${perSample.size === 1 ? '' : 's'} (${unmixed.methodLabel})`);
        if (unmixed.channelSettings) store.commit(run.withChannelSettings(ws(), unmixed.channelSettings, unmixed.outputs.length), 'Scales for unmixed channels', ['ws']);
        toast(`${author} proposes unmixing ${perSample.size} sample${perSample.size === 1 ? '' : 's'}. Review the proposal to accept or reject it.`);
      }
      const refs = state.activeRefs().map((r) => ({ fluorochrome: r.name, control: r.sample.name, peakDetector: r.ref.peakDetector, stainIndex: round(r.ref.stainIndex, 3), warnings: r.ref.warnings?.length ? r.ref.warnings : undefined }));
      const complexity = state.panelComplexity();
      return {
        message: `${unmixed ? `Unmixed ${unmixed.result.perSample.size} sample${unmixed.result.perSample.size === 1 ? '' : 's'} (${unmixed.methodLabel}${unmixed.result.params.afMode !== 'none' ? `, autofluorescence ${unmixed.result.params.afMode}` : ''}) into ${unmixed.outputs.length} channels, proposed: they can be gated at once (e.g. ${unmixed.outputs.slice(0, 3).join(', ')}).` : 'No sample needed unmixing.'} Used ${steps.join('; ')}. Panel complexity index ${round(complexity, 3)}.${already.length ? ` Already unmixed by the user (their channels stand): ${already.map((x) => x.name).join(', ')}.` : ''}${unmixed?.skipped.length ? ` Skipped: ${unmixed.skipped.join('; ')}.` : ''}`,
        data: { channels: unmixed?.outputs ?? existing?.outputs ?? [], references: refs, complexityIndex: round(complexity, 4), samples: unmixed?.result.summary.samples.map((x) => ({ sample: x.sample, events: x.events, medianResidual: x.medianResidual })) ?? [], alreadyUnmixed: already.map((x) => x.name), proposal: proposalSummary() },
      };
    },

    async explore(args) {
      const run = await import('./explore-run.js');
      const { markerCandidates } = await import('../lib/explore.js');
      const w = ws();
      const popId = resolvePopulation(args.population);
      let samples;
      if (args.samples?.length) samples = args.samples.map((x) => resolveSample(x));
      else if (args.group) {
        const group = w.groups.find((g) => g.name.toLowerCase() === String(args.group).toLowerCase());
        if (!group) throw new ActionError(`No group "${args.group}". Groups: ${w.groups.map((g) => g.name).join(', ') || 'none'}.`);
        samples = w.samples.filter((x) => group.sampleIds.includes(x.id));
      } else samples = w.samples.filter((x) => x.role === 'sample' || x.role === 'reference');
      if (!samples.length) throw new ActionError('No samples to analyze.');
      const first = await loadedView(samples[0]);
      const markers = args.markers?.length ? args.markers.map((m) => resolveChannel(first, m)) : markerCandidates(first).filter((c) => c.selected).map((c) => c.name);
      const clustering = args.clustering ?? 'flowsom';
      const embedding = args.embedding ?? 'umap';
      if (!run.CLUSTERINGS.some((c) => c.id === clustering)) throw new ActionError(`clustering is one of ${run.CLUSTERINGS.map((c) => c.id).join(', ')}.`);
      if (!run.EMBEDDINGS.some((e) => e.id === embedding)) throw new ActionError(`embedding is one of ${run.EMBEDDINGS.map((e) => e.id).join(', ')}.`);
      const settings = { ...run.DEFAULT_SETTINGS, markers, clustering, embedding };
      for (const key of ['k', 'seed', 'nNeighbors', 'minDist', 'perplexity', 'resolution']) if (args[key] !== undefined) settings[key] = Number(args[key]);
      if (args.neighbors !== undefined) settings.leidenK = Number(args.neighbors);
      if (args.eventsPerSample !== undefined) settings.perSample = Number(args.eventsPerSample);
      const outputs = [...(embedding !== 'none' ? [`${run.EMBEDDINGS.find((e) => e.id === embedding).axis} 1`] : []), ...(clustering !== 'none' ? [run.CLUSTERINGS.find((c) => c.id === clustering).channel] : [])];
      const taken = w.derived.find((d) => !d.proposal && d.outputs?.some((o) => outputs.includes(o)));
      if (taken) throw new ActionError(`The workspace already has ${taken.name} with the channel${outputs.length > 1 ? 's' : ''} ${outputs.join(', ')}; the user's result stands. Choose another method, or ask the user to remove it.`);
      let computed;
      try {
        computed = await run.runExplore(app, { settings, samples, popId });
      } catch (error) {
        throw new ActionError(error.message);
      }
      // A proposal of the same method replaces the agent's earlier one.
      const earlier = w.derived.find((d) => d.proposal && d.proposedBy === author && d.outputs?.some((o) => computed.result.outputs.includes(o)));
      const { perSample, ...record } = computed.result;
      await proposeResult({ ...record, id: earlier?.id }, perSample, `${author} proposed ${record.name}`);
      const r = computed.run;
      let populations = null;
      if (args.populations && r.k) {
        const gates = run.clusterGates(ws(), { popId, k: r.k, names: r.names, clustering: r.clustering, mem: r.summary?.mem?.labels });
        if (gates.length) {
          const result = proposeGates(ws(), author, gates);
          store.commit(result.ws, `${author} proposed ${gates.length} cluster populations`);
          populations = gates.map((g) => gatePath(store.ws, g.id));
        }
      }
      toast(`${author} proposes ${record.name}${populations ? ` and ${populations.length} cluster populations` : ''}. Review the proposal to accept or reject it.`);
      const q = r.quality;
      const clusters = r.k ? Array.from({ length: r.k }, (_, c) => ({ cluster: c, name: r.names[c], frequency: round(r.summary?.summary?.frequencies?.[c] ?? 0, 4), enrichment: r.summary?.mem?.labels?.[c] ?? undefined, abundanceBySample: Object.fromEntries(r.loaded.map((l, i) => [l.sample.name, round(r.abundance[i][c], 4)])) })) : [];
      return {
        message: `${record.name} of ${popId === ROOT ? 'all events' : gatePath(w, popId)} in ${r.loaded.length} sample${r.loaded.length === 1 ? '' : 's'} on ${markers.length} markers${r.k ? `: ${r.k} clusters` : ''}${r.embedding ? `, a map of ${r.n} events${q ? ` (trustworthiness ${round(q.trustworthiness, 3)}, continuity ${round(q.continuity, 3)})` : ''}` : ''}. Proposed: the channels ${computed.result.outputs.join(', ')} can be gated and plotted at once${populations ? `; ${populations.length} cluster populations proposed` : r.k ? '; pass populations: true to propose the clusters as populations' : ''}.${q?.warnings?.length ? ` Map warnings: ${q.warnings.join(' ')}` : ''}`,
        data: { channels: computed.result.outputs, markers, clusters, quality: q ? { trustworthiness: round(q.trustworthiness, 4), continuity: round(q.continuity, 4), knnPreservation: round(q.knnPreservation, 4), sampleMixing: q.batch ?? undefined, warnings: q.warnings } : null, populations, proposal: proposalSummary() },
      };
    },

    async build_figure(args) {
      const { gatingStrategyFigure, samplesGridFigure } = await import('../lib/figures.js');
      const { plotsOf } = await import('../lib/workspace.js');
      const w = ws();
      const popId = resolvePopulation(args.population);
      let figure;
      if ((args.kind ?? 'gating-strategy') === 'gating-strategy') {
        if (popId === ROOT) throw new ActionError('Name the population whose gating strategy to show.');
        const sample = resolveSample(args.sample);
        try {
          figure = gatingStrategyFigure(w, popId, sample.id);
        } catch (error) {
          throw new ActionError(error.message);
        }
      } else if (args.kind === 'across-samples') {
        let samples;
        let groupName = null;
        if (args.samples?.length) samples = args.samples.map((x) => resolveSample(x));
        else if (args.group) {
          const group = w.groups.find((g) => g.name.toLowerCase() === String(args.group).toLowerCase());
          if (!group) throw new ActionError(`No group "${args.group}".`);
          samples = w.samples.filter((x) => group.sampleIds.includes(x.id));
          groupName = group.name;
        } else samples = w.samples.filter((x) => x.role === 'sample');
        if (!samples.length) throw new ActionError('No samples to show.');
        const view = await loadedView(samples[0]);
        const plots = args.plots?.length
          ? args.plots.map((p) => ({ x: resolveChannel(view, p.x), y: p.y ? resolveChannel(view, p.y) : null, type: p.type ?? (p.y ? 'pseudocolor' : 'histogram') }))
          : plotsOf(w, popId).map((p) => ({ x: p.x, y: p.y, type: p.type, options: p.options }));
        if (!plots.length) throw new ActionError('Give plots: [{ "x": "CD4", "y": "CD8" }, ...] (the population has no plots shown in the Gate view to copy).');
        figure = samplesGridFigure(w, popId, plots, samples, groupName);
      } else {
        throw new ActionError('kind is gating-strategy or across-samples.');
      }
      if (args.name) figure.name = String(args.name);
      const result = proposeFigure(ws(), author, figure);
      store.commit(result.ws, `${author} proposed the figure ${figure.name}`, ['figures']);
      toast(`${author} proposes the figure “${figure.name}”. Review the proposal to accept or reject it.`, { action: { label: 'Open Figures', onClick: () => app.setMode('figures') } });
      const plots = figure.items.filter((i) => i.kind === 'plot');
      return { message: `Proposed the figure "${figure.name}" (${plots.length} plot${plots.length === 1 ? '' : 's'}, ${figure.width} × ${figure.height} px). It stays live until exported; export_figure writes it as SVG, PNG or PDF.`, data: { figure: figure.name, plots: plots.map((p) => ({ sample: ws().samples.find((x) => x.id === p.sampleId)?.name, population: p.spec.populationId === ROOT ? 'All events' : gatePath(ws(), p.spec.populationId), x: p.spec.x, y: p.spec.y, type: p.spec.type })), proposal: proposalSummary() } };
    },

    async export_flowjo(args) {
      requireExtension(args.path, args.files ? ['.zip'] : ['.wsp'], args.files ? 'a ZIP of the workspace and its FCS files' : 'a FlowJo workspace');
      if (!ws().samples.length) throw new ActionError('The workspace has no samples.');
      const samples = args.samples?.length ? args.samples.map((x) => resolveSample(x).id) : undefined;
      const out = await app.buildFlowJoExport({ counts: args.counts !== false, files: Boolean(args.files), deidentify: Boolean(args.deidentify), samples });
      const { exact, approximated, omitted } = out.report.summary;
      const notExact = [...new Map(out.report.populations.filter((p) => p.status !== 'exact').map((p) => [`${p.status}|${p.path}`, { population: p.path, status: p.status === 'approximated' ? 'traced' : 'not exported', why: p.detail }])).values()];
      return {
        file: out.bytes,
        message: `FlowJo workspace: ${exact} population-sample pairs exact${approximated ? `, ${approximated} traced on another scale` : ''}${omitted ? `, ${omitted} not exported` : ''}${args.files ? `, with ${ws().samples.length - out.missing} FCS files` : '; keep the FCS files beside it (FlowJo 11 asks to reconnect them once)'}${args.deidentify ? ', de-identified' : ''}.${out.missing ? ` ${out.missing} FCS files were not in the library and are left out.` : ''}`,
        data: { notExact: notExact.slice(0, 50), warnings: out.report.warnings },
      };
    },

    async export_fcs(args) {
      const format = requireExtension(args.path, ['.zip', '.acs'], 'de-identified FCS files (.zip), or the workspace with them (.acs)') === '.acs' ? 'acs' : 'zip';
      const samples = args.samples?.length ? args.samples.map((x) => resolveSample(x).id) : undefined;
      const out = await app.buildDeidentified({ keepDates: Boolean(args.keepDates), format, samples });
      if (!out.files) throw new ActionError('None of the FCS files is in the library.');
      return { file: out.bytes, message: `${out.files} de-identified FCS file${out.files === 1 ? '' : 's'}${format === 'acs' ? ' with the workspace (ACS archive)' : ''}: only technical keywords kept, ${out.removed.length} kinds of keyword removed, the events copied byte for byte. Files are named after their samples, whose names are kept.${out.missing ? ` ${out.missing} files were not in the library.` : ''}`, data: { removed: out.removed } };
    },

    async export_figure(args) {
      const extension = requireExtension(args.path, ['.svg', '.png', '.pdf'], 'a figure');
      const figures = ws().figures;
      if (!figures.length) throw new ActionError('The workspace has no figures; build_figure makes one.');
      const fig = args.figure ? figures.find((f) => f.name.toLowerCase() === String(args.figure).toLowerCase()) ?? figures.find((f) => f.name.toLowerCase().includes(String(args.figure).toLowerCase())) : figures.at(-1);
      if (!fig) throw new ActionError(`No figure "${args.figure}". Figures: ${figures.map((f) => f.name).join(', ')}.`);
      const exporter = await import('./figure-export.js');
      const provenance = args.provenance !== false;
      const file = extension === '.svg' ? await exporter.figureSVG(app, fig, { provenance }) : extension === '.png' ? await exporter.figurePNG(app, fig, { provenance }) : await exporter.figurePDF(app, fig, { provenance });
      return { file, message: `The figure "${fig.name}" as ${extension.slice(1).toUpperCase()}${extension === '.pdf' ? ' (300 dpi)' : extension === '.png' ? ' (3×)' : ''}${provenance ? ', carrying the analysis behind its plots (opening it in CytoWeave shows what changed since)' : ''}.${fig.proposal ? ' The figure is still part of your proposal.' : ''}` };
    },

    async export_table(args) {
      const extension = requireExtension(args.path, ['.csv', '.tsv'], 'a table');
      const table = await actions.statistics_table(args);
      const separator = extension === '.tsv' ? '\t' : ',';
      const quote = (v) => {
        const text = v === null || v === undefined ? '' : String(v);
        return /[",\t\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const rows = table.data.rows;
      const fields = [...new Set(rows.flatMap((r) => Object.keys(r.meta ?? {})))];
      const columns = rows.length ? Object.keys(rows[0].values) : [];
      const lines = [['Sample', ...fields, ...columns].map(quote).join(separator), ...rows.map((r) => [r.sample, ...fields.map((f) => r.meta?.[f] ?? ''), ...columns.map((c) => r.values[c])].map(quote).join(separator))];
      return { file: `${lines.join('\n')}\n`, message: `${table.message} ${rows.length} rows, ${columns.length} population column${columns.length === 1 ? '' : 's'}.` };
    },

    async watch_folder(args) {
      const live = app.live;
      if (!live?.available) throw new ActionError('Folder watching needs the CytoWeave program (it is not available when the page is served as a web site).');
      const action = args.action ?? 'status';
      if (action === 'start') {
        if (!args.path) throw new ActionError('Give the folder\'s absolute path.');
        if (args.qc !== undefined) live.options.qc = Boolean(args.qc);
        if (args.beads !== undefined) live.options.beads = Boolean(args.beads);
        await live.start(String(args.path)).catch((error) => { throw new ActionError(error.message); });
        if (args.existing) await live.handOverExisting();
      } else if (action === 'stop') {
        if (live.status?.watching) await live.stop();
      } else if (action === 'existing') {
        if (!live.status?.watching) throw new ActionError('No folder is being watched.');
        await live.handOverExisting();
      } else if (action !== 'status') {
        throw new ActionError('action is start, stop, existing or status.');
      }
      const status = live.status ?? {};
      const files = live.queue.map((q) => ({ file: q.name, state: q.state, sample: q.sampleId ? ws().samples.find((s) => s.id === q.sampleId)?.name : undefined, score: q.score, percentRemoved: q.percentRemoved === undefined ? undefined : round(q.percentRemoved, 3), finding: q.finding ?? undefined, detectorsOutOfControl: q.rejected, error: q.error }));
      return {
        message: status.watching ? `Watching ${status.folder}: ${files.length} file${files.length === 1 ? '' : 's'} so far${status.pending?.length ? `, ${status.pending.length} still being written` : ''}${status.existing ? `; ${status.existing} were there before (action existing checks them)` : ''}. Each finished FCS file is added to the workspace and checked at once (acquisition QC for samples, Q and B for bead files); the folder is only read.` : `No folder is being watched${files.length ? ` (${files.length} files handled earlier)` : ''}.`,
        data: { watching: Boolean(status.watching), folder: status.folder ?? null, pending: status.pending ?? [], existing: status.existing ?? 0, options: { ...live.options }, files },
      };
    },

    async proposals() {
      const history = proposalHistory(ws(), 10).map((e) => ({ time: e.time, decision: e.action === 'accept-proposal' ? 'accepted' : 'rejected', detail: e.detail }));
      const mine = proposalSummary();
      const others = openProposals(ws()).filter((p) => p.author !== author).map((p) => ({ author: p.author, changes: describeProposal(ws(), p).map((i) => i.text) }));
      return { message: `${mine ? `Your open proposal: ${mine.changes.join('; ') || 'nothing left'}.` : 'You have no open proposal.'}${history.length ? ` Latest decision: ${history[0].decision} (${history[0].time}).` : ''}`, data: { open: mine, others, decisions: history } };
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

    async check_robustness(args) {
      const { checkRobustness } = await import('./robustness.js');
      const { methodsSentence } = await import('../lib/multiverse.js');
      const w = ws();
      const id = resolvePopulation(args.population);
      if (id === ROOT) throw new ActionError('Choose a gated population: the check varies its gates.');
      const field = String(args.groupBy);
      const samples = w.samples.filter((s) => (s.role === 'sample' || s.role === 'reference') && s.meta?.[field] !== undefined && s.meta[field] !== '');
      const levels = args.groups?.length ? args.groups.map(String) : [...new Set(samples.map((s) => String(s.meta[field])))].sort();
      if (levels.length !== 2) throw new ActionError(`The check compares two groups; "${field}" has ${levels.length} (${levels.join(', ')}). Pass groups: [reference, other].`);
      const chosen = samples.filter((s) => levels.includes(String(s.meta[field])));
      for (const sample of chosen) await loadedView(sample);
      const stat = args.statistic ?? 'freqParent';
      const statistic = { stat, gateId: id, channel: args.channel ? resolveChannel(await loadedView(chosen[0]), args.channel) : undefined };
      const design = args.pairBy ? 'paired-two' : 'two';
      const { summary, choices } = await checkRobustness(app, {
        statistic,
        samples: chosen.map((s) => ({ id: s.id, group: levels.indexOf(String(s.meta[field])), pair: args.pairBy ? s.meta?.[args.pairBy] ?? null : null })),
        design,
        pairField: args.pairBy,
        labels: levels,
        qcReruns: Boolean(args.rerunQC),
      });
      const r = summary.declared?.result;
      const clean = (list) => list.map((d) => ({ choice: d.choice, alternative: d.option, conclusion: d.conclusion, difference: round(d.estimate, 4), p: round(d.p, 6) }));
      return {
        message: `${stat} of ${gatePath(w, id)}, ${levels[1]} vs ${levels[0]}${args.pairBy ? `, paired by ${args.pairBy}` : ''}: ${summary.verdict}. ${summary.text}${summary.verdict !== 'undetermined' ? ` ${methodsSentence(summary, choices)}` : ''}`,
        data: {
          verdict: summary.verdict,
          analyses: summary.total,
          agree: summary.agree,
          declared: r ? { conclusion: summary.declared.conclusion, difference: round(r.estimate, 4), ci: r.ci.map((v) => round(v, 4)), p: round(r.p, 6) } : null,
          dependsOn: clean(summary.dependsOn ?? []),
          sizeDependsOn: clean(summary.sizeDependsOn ?? []),
          choices: choices.map((c) => ({ choice: c.label, alternatives: c.options.slice(1).map((o) => o.label), omitted: c.omitted ?? undefined })),
        },
      };
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

  // The extension of an export's path, which must be one of `allowed`.
  function requireExtension(path, allowed, what) {
    const match = /\.[a-z0-9]+$/i.exec(String(path ?? ''));
    const extension = match ? match[0].toLowerCase() : '';
    if (!allowed.includes(extension)) throw new ActionError(`The path for ${what} must end in ${allowed.join(' or ')}.`);
    return extension;
  }

  // Records a computed result as part of the agent's proposal: attaches the per-event columns to
  // the samples, stores them in the library, and adds the record marked as proposed.
  //   record: as app.saveDerived's result without perSample (files: columns already stored);
  //   perSample: Map(sampleId → { channel: Float32Array }).
  async function proposeResult(record, perSample, label) {
    const files = { ...(record.files ?? {}) };
    for (const [sampleId, columns] of perSample) {
      files[sampleId] = {};
      for (const [name, column] of Object.entries(columns)) {
        data.setDerived(sampleId, name, column);
        files[sampleId][name] = await data.persistColumn(column);
      }
    }
    const result = proposeDerived(ws(), author, { ...record, files });
    store.commit(result.ws, label, ['derived', 'data']);
    return result.derived;
  }

  // Adds gates as a proposal of the agent, for the user to review.
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
    const result = proposeGates(w, author, records);
    store.commit(result.ws, `${author} proposed ${records.map((r) => r.name).join(', ')}`);
    app.selectGate(records[records.length > 1 ? 1 : 0].id, { keepMode: true });
    toast(`${author} proposed ${records.map((r) => r.name).join(', ')}. Review the proposal to keep or discard it.`);
    const parent = populationSet(view, store.ws, parentId ?? ROOT);
    const created = records.map((r) => {
      const indices = populationSet(view, store.ws, r.id);
      return { population: gatePath(store.ws, r.id), count: indices === undefined ? null : countOf(indices, view), percentOfParent: indices === undefined ? null : round((100 * countOf(indices, view)) / (countOf(parent, view) || 1)) };
    });
    return { message: `Proposed ${created.map((c) => `${c.population}: ${c.percentOfParent}% of parent (${c.count} events)`).join('; ')} in ${view.record.name}.${explanation ? ` ${explanation}` : ''} The user will accept or reject your proposal; meanwhile the populations can be used as parents.`, data: { created, proposal: proposalSummary() } };
  }

  function proposalSummary() {
    const proposal = openProposals(ws()).find((p) => p.author === author);
    return proposal ? { id: proposal.id, opened: proposal.opened, changes: describeProposal(ws(), proposal).map((i) => i.text) } : null;
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
      author = event.client || 'a program on this computer';
      const result = await handler(args, event);
      let message = result.message ?? 'Done.';
      // An export: the file goes to the program, which writes it where the caller asked.
      if (result.file !== undefined) {
        if (!event.output) throw new ActionError('Writing files needs the CytoWeave program.');
        const response = await fetch(event.output, { method: 'POST', body: result.file, headers: { 'Content-Type': 'application/octet-stream' } });
        const written = await response.json().catch(() => ({}));
        if (!response.ok) throw new ActionError(`The file could not be written: ${written.error ?? `HTTP ${response.status}`}`);
        message = `Wrote ${written.path} (${written.bytes} bytes). ${message}`;
      }
      outcome = { ok: true, message, data: result.data ?? null };
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
