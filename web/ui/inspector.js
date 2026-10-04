// The right-hand inspector: the selected sample, population and gate, with live statistics.

import { h, icon, clear, formatCount, formatPercent, iconButton } from './dom.js';
import { showMenu, toast } from './overlays.js';
import { channelTransform, countOf, describePopulation, gateRobustness, isMultidimensional, populationSet } from '../lib/engine.js';
import { createTransform, formatNumber } from '../lib/transforms.js';
import { formatStatistic, wilsonInterval } from '../lib/stats.js';
import { BOOLEAN_OPS, ROOT, channelLabel, clearOverride, effectiveGeometry, gateAncestors, gateById, gatePath, setGateGeometry, setSampleCompensation, updateGate } from '../lib/workspace.js';
import { CATEGORICAL, colorVisionFriendly } from '../lib/colormaps.js';
import { isInteracting } from './activity.js';
import { suggestForPopulation, termById } from '../lib/ontology.js';

export function mountInspector(app) {
  const { store, data } = app;
  const container = document.getElementById('inspector');
  let robustnessCache = new Map();

  function section(title, ...content) {
    return h('section.inspector-section', h('h3', title), ...content);
  }

  function render() {
    clear(container);
    const ws = store.ws;
    const sampleId = store.ui.sampleId;
    const sample = ws.samples.find((s) => s.id === sampleId);
    if (!sample) {
      container.append(section('Inspector', h('p.muted', 'Select a sample to see its populations, statistics and acquisition details.')));
      return;
    }
    const view = data.view(sampleId);
    const gateId = store.ui.gateId;
    const gate = gateId ? gateById(ws, gateId) : null;
    container.append(populationSection(ws, view, gate));
    if (gate) container.append(gateSection(ws, view, gate, sampleId));
    if (view) container.append(statisticsSection(ws, view, gate));
    container.append(sampleSection(ws, sample, view));
  }

  function populationSection(ws, view, gate) {
    if (!view) return section('Population', h('p.muted', data.statusOf(store.ui.sampleId) === 'loading' ? 'Loading events…' : 'Events not loaded.'));
    const indices = populationSet(view, ws, gate?.id ?? ROOT);
    if (indices === undefined) return section('Population', h('p.muted', 'This population does not apply to this sample.'));
    const count = countOf(indices, view);
    const parent = gate ? populationSet(view, ws, gate.parentId ?? ROOT) : null;
    const parentCount = gate ? countOf(parent, view) : view.eventCount;
    const freqParent = gate ? (100 * count) / (parentCount || 1) : 100;
    const grand = gate?.parentId ? gateById(ws, gate.parentId) : null;
    const grandCount = grand ? countOf(populationSet(view, ws, grand.parentId ?? ROOT), view) : view.eventCount;
    const [lo, hi] = wilsonInterval(count, parentCount || 1);
    return section(gate ? gate.name : 'All events',
      h('div.big-stat', h('span.value', gate ? formatPercent(freqParent) : formatCount(count)), h('span.unit', gate ? `of ${gate.parentId ? gateById(ws, gate.parentId)?.name : 'all events'}` : 'events')),
      gate ? h('div.muted', { style: { fontSize: '11.5px', marginTop: '2px' } }, `95% CI ${formatPercent(lo * 100)} – ${formatPercent(hi * 100)} (binomial)`) : null,
      h('div.stat-grid',
        h('div.stat-tile', h('div.k', 'Events'), h('div.v', formatCount(count))),
        h('div.stat-tile', h('div.k', '% of total'), h('div.v', formatPercent((100 * count) / (view.eventCount || 1)))),
        h('div.stat-tile', h('div.k', '% of grandparent'), h('div.v', gate?.parentId ? formatPercent((100 * count) / (grandCount || 1)) : '—'))));
  }

  // The population's Cell Ontology term: confirmed, or suggested from its marker phenotype for the
  // user to confirm (lib/ontology.js). Confirmed terms go into exports and the methods.
  function cellTypeRow(ws, view, gate) {
    const set = (ontology, label) => store.commit(updateGate(store.ws, gate.id, { ontology }, 'set-cell-type'), label);
    const link = (id) => h('a', { href: `https://www.ebi.ac.uk/ols4/ontologies/cl/classes/${encodeURIComponent(`http://purl.obolibrary.org/obo/${id.replace(':', '_')}`)}`, target: '_blank', rel: 'noopener', title: `${id} in the EBI Ontology Lookup Service` }, id);
    const confirmed = gate.ontology?.status === 'confirmed' ? gate.ontology : null;
    let suggestions = [];
    if (view && gate.type !== 'boolean') {
      try {
        suggestions = suggestForPopulation(view, ws, gate.id).suggestions;
      } catch {
        suggestions = [];
      }
    }
    const confirm = (s) => set({ id: s.id, label: s.label, status: 'confirmed', by: 'the user', at: new Date().toISOString(), evidence: s.reason }, `Cell type of ${gate.name}: ${s.label}`);
    const choose = (anchor) => showMenu(anchor, [
      { section: 'Suggested from the phenotype' },
      ...(suggestions.length ? suggestions.map((s) => ({ label: `${s.label} (${s.confidence})`, icon: 'tag', hint: s.id, onSelect: () => confirm(s) })) : [{ label: 'No term fits the gated markers', disabled: true }]),
      ...(confirmed ? ['-', { label: 'Clear the cell type', icon: 'close', onSelect: () => set(undefined, `Clear the cell type of ${gate.name}`) }] : []),
    ]);
    // A term a template or published strategy suggests for the gate comes first, with its source.
    const stored = gate.ontology?.status === 'suggested' && gate.ontology.id ? gate.ontology : null;
    if (stored) {
      const fromData = suggestions.find((s) => s.id === stored.id);
      suggestions = [{ id: stored.id, label: stored.label, confidence: fromData?.confidence ?? 'exact', reason: `suggested by ${stored.source ?? 'the template'}${fromData ? `; the phenotype agrees (${fromData.reason})` : ''}`, stored: true }, ...suggestions.filter((s) => s.id !== stored.id)];
    }
    const top = suggestions[0];
    const body = confirmed
      ? h('div', h('div', h('strong', confirmed.label), ' ', h('span.muted', link(confirmed.id))), h('div.row', { style: { gap: '6px', marginTop: '4px' } }, h('button.btn.small.ghost', { type: 'button', onclick: (e) => choose(e.currentTarget) }, 'Change')))
      : top
        ? h('div',
          h('div', top.label, ' ', h('span.muted', link(top.id)), ' ', h(`span.badge.${top.confidence === 'exact' || top.stored ? 'ok' : 'accent'}`, top.confidence === 'exact' || top.stored ? 'Suggested' : 'Likely')),
          h('div.muted', { style: { fontSize: '11.5px', marginTop: '2px' } }, `${top.stored ? top.reason[0].toUpperCase() + top.reason.slice(1) : `From ${top.reason}`}. ${termById(top.id)?.definition ?? ''}`),
          h('div.row', { style: { gap: '6px', marginTop: '6px' } },
            h('button.btn.small', { type: 'button', onclick: () => confirm(top) }, icon('check'), 'Confirm'),
            suggestions.length > 1 ? h('button.btn.small.ghost', { type: 'button', onclick: (e) => choose(e.currentTarget) }, 'Other terms') : null))
        : h('span.muted', 'No Cell Ontology term fits the markers this population is gated on.');
    return h('div', { style: { marginTop: '10px' } }, h('div.section-title', 'Cell type (Cell Ontology)'), body);
  }

  function gateSection(ws, view, gate, sampleId) {
    const geometry = effectiveGeometry(gate, sampleId);
    const overridden = Boolean(gate.overrides?.[sampleId]);
    const overrideCount = Object.keys(gate.overrides ?? {}).length;
    const dims = gate.dims.map((d) => channelLabel(ws, d.channel)).join(' × ');
    const typeName = { rectangle: 'Rectangle', range: 'Range', polygon: 'Polygon', ellipse: 'Ellipse', ellipsoid: 'Ellipsoid', quadrant: 'Quadrant', split: 'Split', boolean: 'Boolean', category: 'Category' }[gate.type];
    // Dimensions that name their own compensation (imported Gating-ML) rather than the sample's.
    const compensationName = (ref) => (ref === 'uncompensated' ? 'none' : ref === 'file' ? "the file's matrix" : ws.compensations.find((c) => c.id === ref)?.name ?? 'a missing matrix');
    const pinned = gate.dims.filter((d) => d.compensation !== undefined && d.compensation !== null);
    const pinnedText = pinned.length ? [...new Set(pinned.map((d) => compensationName(d.compensation)))].join(', ') : null;
    const content = [
      h('dl.kv',
        h('dt', 'Type'), h('dd', typeName),
        gate.dims.length ? [h('dt', 'Axes'), h('dd', { title: dims }, dims)] : null,
        pinnedText ? [h('dt', 'Compensation'), h('dd', { title: 'This gate keeps the compensation its Gating-ML file names, whatever the sample uses.' }, pinnedText)] : null,
        h('dt', 'Path'), h('dd', { title: gatePath(ws, gate.id) }, gatePath(ws, gate.id)),
        h('dt', 'Applies to'), h('dd', gate.scope?.groupId ? ws.groups.find((g) => g.id === gate.scope.groupId)?.name ?? 'a group' : 'All samples'),
        h('dt', 'Origin'), h('dd', gate.meta?.proposedBy
          ? `Proposed by ${gate.meta.proposedBy}${gate.meta.origin === 'auto' ? ` from the data (${gate.meta.method ?? 'density'})` : ''}${gate.meta.acceptedBy ? `; accepted by ${gate.meta.acceptedBy}` : '; waiting for your review'}`
          : gate.meta?.origin === 'auto' && gate.meta.template ? `Placed on ${gate.meta.placedOn ?? 'a sample'}'s data by ${gate.meta.template} (${gate.meta.method ?? 'recipe'})`
          : gate.meta?.origin === 'auto' ? `Proposed from the data (${gate.meta.method ?? 'density'})` : gate.meta?.origin === 'imported' ? 'Imported' : gate.meta?.origin === 'agent' ? 'Added by an AI agent' : 'Drawn')),
    ];
    if (gate.meta?.note) content.push(h('div.callout.accent', { style: { marginTop: '8px' } }, icon('sparkles'), h('span', gate.meta.note)));
    if (gate.type === 'boolean') {
      const operands = (geometry.operands ?? []).map((id) => gateById(ws, id)?.name ?? 'a missing population');
      content.push(h('div', { style: { marginTop: '10px', fontSize: '12.5px' } },
        h('div', `In ${BOOLEAN_OPS[geometry.op] ?? geometry.op}: ${operands.join(', ')}.`),
        h('button.btn.small', { type: 'button', style: { marginTop: '8px' }, onclick: () => import('./boolean-gate.js').then((m) => m.openBooleanGate(app, { gateId: gate.id })) }, icon('edit'), 'Edit')));
    } else {
      content.push(geometryEditor(gate, geometry, sampleId));
    }
    if (overridden || overrideCount) {
      content.push(h('div.callout.warn', { style: { marginTop: '8px' } }, icon('info'),
        h('div', overridden ? 'This gate is adjusted for this sample.' : `Adjusted for ${overrideCount} other sample(s).`,
          overridden ? h('div', { style: { marginTop: '6px' } }, h('button.btn.small', { type: 'button', onclick: () => store.commit(clearOverride(store.ws, gate.id, sampleId), 'Reset gate for sample') }, 'Use the shared gate')) : null)));
    }
    // With color-vision-friendly colors on, populations take the friendly palette in order, so
    // a color picked here would not show: say so instead.
    if (colorVisionFriendly()) content.push(h('p.muted', { style: { fontSize: '11.5px', margin: '10px 0 0' } }, 'Colors follow the color-vision-friendly palette (Appearance menu); colors picked here show when it is off.'));
    else {
      const swatches = h('div.row', { style: { flexWrap: 'wrap', gap: '4px', marginTop: '10px' } },
        ...CATEGORICAL.slice(0, 12).map((color) => h('button', {
          type: 'button',
          title: color,
          'aria-label': `Color ${color}`,
          style: { width: '18px', height: '18px', borderRadius: '5px', border: color === gate.color ? '2px solid var(--text)' : '1px solid var(--line)', background: color },
          onclick: () => store.commit(updateGate(store.ws, gate.id, { color }), 'Recolor gate'),
        })));
      content.push(swatches);
    }
    if (gate.type !== 'boolean' && gate.type !== 'category' && !isMultidimensional(gate) && view) content.push(robustnessBlock(ws, view, gate));
    content.push(cellTypeRow(ws, view, gate));
    return section('Gate', ...content);
  }

  // Numeric editing of a gate's position, in data units (the inverse of the gate's transforms).
  function geometryEditor(gate, geometry, sampleId) {
    const wrap = h('div', { style: { marginTop: '10px' } });
    const tx = gate.dims[0] ? createTransform(gate.dims[0].transform) : null;
    const ty = gate.dims[1] ? createTransform(gate.dims[1].transform) : null;
    const field = (label, value, transform, onCommit) => {
      const input = h('input.input.small.num', { value: Number.isFinite(value) ? formatNumber(transform.inverse(value)).replace('−', '-') : '', title: 'Data value' });
      input.addEventListener('change', () => {
        const parsed = parseValue(input.value);
        if (!Number.isFinite(parsed)) return;
        onCommit(transform.forward(parsed));
      });
      return h('label.field', { style: { marginBottom: '6px' } }, h('span', label), input);
    };
    const commit = (next) => {
      const scope = store.ui.editScope === 'sample' ? { sampleId } : { editedOn: sampleId };
      store.commit(setGateGeometry(store.ws, gate.id, next, scope), `Edit ${gate.name}`);
    };
    if (gate.type === 'ellipsoid' || (gate.type === 'rectangle' && gate.dims.length !== 2)) {
      wrap.append(h('div.muted', `An imported ${gate.dims.length}-dimensional ${gate.type === 'ellipsoid' ? 'ellipsoid' : 'rectangle'} on ${gate.dims.map((d) => d.channel).join(', ')}. It is evaluated in all its dimensions but cannot be drawn or edited on a 2-D plot.`));
    } else if (gate.type === 'rectangle') {
      wrap.append(h('div.row',
        field('x min', geometry.min[0], tx, (v) => commit({ ...geometry, min: [v, geometry.min[1]] })),
        field('x max', geometry.max[0], tx, (v) => commit({ ...geometry, max: [v, geometry.max[1]] }))),
      h('div.row',
        field('y min', geometry.min[1], ty, (v) => commit({ ...geometry, min: [geometry.min[0], v] })),
        field('y max', geometry.max[1], ty, (v) => commit({ ...geometry, max: [geometry.max[0], v] }))));
    } else if (gate.type === 'range') {
      wrap.append(h('div.row',
        field('min', geometry.min, tx, (v) => commit({ ...geometry, min: v })),
        field('max', geometry.max, tx, (v) => commit({ ...geometry, max: v }))));
    } else if (gate.type === 'split') {
      wrap.append(field('Threshold', geometry.threshold, tx, (v) => commit({ ...geometry, threshold: v })));
    } else if (gate.type === 'quadrant') {
      wrap.append(h('div.row',
        field('x', geometry.center[0], tx, (v) => commit({ ...geometry, center: [v, geometry.center[1]] })),
        field('y', geometry.center[1], ty, (v) => commit({ ...geometry, center: [geometry.center[0], v] }))));
    } else if (gate.type === 'polygon') {
      wrap.append(h('div.muted', `${geometry.vertices.length} vertices. Drag them on the plot; arrow keys nudge the gate.`));
    } else if (gate.type === 'ellipse') {
      wrap.append(h('div.row',
        field('center x', geometry.center[0], tx, (v) => commit({ ...geometry, center: [v, geometry.center[1]] })),
        field('center y', geometry.center[1], ty, (v) => commit({ ...geometry, center: [geometry.center[0], v] }))));
    }
    return wrap;
  }

  function parseValue(text) {
    const t = String(text).trim().replace('−', '-').toUpperCase();
    const m = t.match(/^(-?[\d.]+)\s*([KM])?$/);
    if (m) return Number.parseFloat(m[1]) * (m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : 1);
    return Number.parseFloat(t);
  }

  // Gate robustness: how much the frequency depends on the exact boundary.
  function robustnessBlock(ws, view, gate) {
    const key = `${view.version}|${gate.id}|${JSON.stringify(effectiveGeometry(gate, view.id))}|${gate.parentId}`;
    const holder = h('div', { style: { marginTop: '12px' } });
    const show = (result) => {
      clear(holder);
      if (!result) return;
      const canvas = h('canvas', { width: 240, height: 68 });
      const ctx = canvas.getContext('2d');
      const freqs = result.points.map((p) => p.frequency);
      const min = Math.min(...freqs);
      const max = Math.max(...freqs);
      const span = max - min || 1;
      ctx.strokeStyle = result.rating === 'robust' ? '#138a52' : result.rating === 'moderate' ? '#c27a00' : '#d63b4a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      result.points.forEach((p, i) => {
        const x = 8 + (i / (result.points.length - 1)) * 224;
        const y = 60 - ((p.frequency - min) / span) * 52;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
      const badge = result.rating === 'robust' ? 'ok' : result.rating === 'moderate' ? 'warn' : 'danger';
      holder.append(
        h('div.row', h('span.field-label', 'Boundary robustness'), h('span.grow'), h(`span.badge.${badge}`, result.rating)),
        h('div.robustness', canvas, h('div.muted', { style: { fontSize: '11px' } }, `${result.sensitivity >= 0 ? '+' : ''}${result.sensitivity.toFixed(2)} pts per 1% of axis`)),
        h('div.muted', { style: { fontSize: '11px' } }, result.rating === 'robust'
          ? 'The boundary sits in a density valley: moving it slightly barely changes the frequency.'
          : 'The boundary cuts through dense events: small changes in where it is drawn change the frequency. Consider moving it into a valley or reviewing it across samples.'));
    };
    if (robustnessCache.has(key)) show(robustnessCache.get(key));
    else {
      holder.append(h('button.btn.small', {
        type: 'button',
        onclick: () => {
          const result = gateRobustness(view, ws, gate.id);
          robustnessCache.set(key, result);
          show(result);
        },
      }, icon('target'), 'Check boundary robustness'));
    }
    return holder;
  }

  // Each population's summaries (median, mean, rSD) by channel, kept while the population is the
  // same (populations are cached sets, so the set itself is the key).
  const summaries = new WeakMap();
  let statisticsToken = 0;

  function statisticsSection(ws, view, gate) {
    const indices = populationSet(view, ws, gate?.id ?? ROOT);
    if (indices === undefined) return h('div');
    // Spectral data: the unmixed abundances, when present, rather than the raw detectors.
    const unmixed = [...view.derived.keys()].filter((name) => name.endsWith('(unmixed)') && !/^(AF signature|Residual) /.test(name));
    const channels = (unmixed.length ? unmixed : view.parameters.filter((p) => p.type === 'fluorescence').map((p) => p.name)).slice(0, 60);
    const count = countOf(indices, view);
    if (!channels.length || !count) return h('div');
    const owner = indices ?? view;
    if (!summaries.has(owner)) summaries.set(owner, new Map());
    const known = summaries.get(owner);
    const prefix = `${view.version}|${gate?.id ?? ROOT}|`;
    const body = h('tbody');
    const table = h('table.data', h('thead', h('tr', h('th', 'Channel'), h('th.r', 'Median'), h('th.r', 'Mean'), h('th.r', 'rSD'))), body);
    const cells = new Map();
    for (const channel of channels) {
      const d = known.get(prefix + channel);
      const values = ['median', 'mean', 'rsd'].map((id) => h('td.r', d ? formatStatistic(id, d[id]) : '…'));
      cells.set(channel, values);
      body.append(h('tr', h('td', { title: channel }, channelLabel(ws, channel, { short: true })), ...values));
    }
    // A large population is summarized a channel at a time, so the inspector shows at once and the
    // page stays responsive; a newer render abandons the work.
    const token = ++statisticsToken;
    const missing = channels.filter((c) => !known.has(prefix + c));
    const fill = (channel) => {
      const d = describePopulation(view, ws, gate?.id ?? ROOT, [channel], { basic: true })?.[channel];
      known.set(prefix + channel, d ?? null);
      cells.get(channel).forEach((cell, i) => { cell.textContent = d ? formatStatistic(['median', 'mean', 'rsd'][i], d[['median', 'mean', 'rsd'][i]]) : '—'; });
    };
    if (count * missing.length <= 2e6) missing.forEach(fill);
    else {
      const next = (k) => {
        if (token !== statisticsToken || k >= missing.length) return;
        // A channel of millions of events takes tens of milliseconds: not while a gate is dragged.
        if (isInteracting()) {
          setTimeout(() => next(k), 120);
          return;
        }
        fill(missing[k]);
        setTimeout(() => next(k + 1), 0);
      };
      setTimeout(() => next(0), 0);
    }
    return section('Statistics', h('div', { style: { maxHeight: '320px', overflow: 'auto' } }, table),
      h('div.muted', { style: { fontSize: '11px', marginTop: '6px' } }, unmixed.length ? 'Unmixed abundances.' : view.compensation ? 'Compensated values.' : 'Uncompensated values.'));
  }

  function sampleSection(ws, sample, view) {
    const acq = sample.acquisition ?? {};
    const compName = sample.compensationId === 'file' ? 'From the file' : sample.compensationId === 'none' ? 'None' : ws.compensations.find((c) => c.id === sample.compensationId)?.name ?? '—';
    const compButton = h('button.btn.small', {
      type: 'button',
      onclick: (event) => {
        const items = [
          { label: 'From the file ($SPILLOVER)', disabled: !sample.hasFileSpillover, onSelect: () => store.commit(setSampleCompensation(store.ws, [sample.id], 'file'), 'Use file compensation') },
          { label: 'None', onSelect: () => store.commit(setSampleCompensation(store.ws, [sample.id], 'none'), 'Remove compensation') },
          ...ws.compensations.map((c) => ({ label: c.name, onSelect: () => store.commit(setSampleCompensation(store.ws, [sample.id], c.id), `Apply ${c.name}`) })),
        ];
        showMenu(event.currentTarget, items);
      },
    }, compName, icon('chevronDown'));
    const items = [
      ['File', sample.fileName],
      ['Events', formatCount(sample.eventCount)],
      ['Format', sample.fcsVersion],
      ['Cytometer', acq.cytometer],
      ['Date', acq.date],
      ['Operator', acq.operator],
      ['Software', acq.software],
      ['Technology', sample.technology],
      ['Role', sample.role],
    ].filter(([, v]) => v);
    const notes = [...(sample.diagnostics ?? [])];
    if (view?.compensationNote) notes.push(view.compensationNote);
    if (view?.compensationError) notes.push(`Compensation failed: ${view.compensationError}`);
    return section('Sample',
      h('dl.kv', ...items.flatMap(([k, v]) => [h('dt', k), h('dd', { title: String(v) }, String(v))])),
      h('div.row', { style: { marginTop: '10px' } }, h('span.field-label', 'Compensation'), h('span.grow'), compButton),
      ...notes.map((note) => h('div.callout.warn', { style: { marginTop: '8px' } }, icon('warning'), h('span', note))),
      h('div', { style: { marginTop: '10px' } }, h('button.btn.small.ghost', { type: 'button', onclick: () => app.showKeywords(sample.id) }, icon('tag'), 'All keywords')));
  }

  return {
    update(topics) {
      if (topics.has('ws') || topics.has('data') || topics.has('sample') || topics.has('gate') || topics.has('scope') || topics.has('colors')) render();
    },
    render,
  };
}
