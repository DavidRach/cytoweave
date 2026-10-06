// What the Plates view, its dialogs and agents' plate tools share: a statistic of every well, the
// dose-response data of a plate (doses, groups, controls), and the bead groups' events of every
// well for a bead immunoassay. Views come from viewOf(sampleId) → Promise<SampleView>.

import { computeStatistic, countOf, population, populationSet } from '../lib/engine.js';
import { STATISTICS } from '../lib/stats.js';
import { ROOT, gateById } from '../lib/workspace.js';
import { commonDoses, controlRole, zPrime } from '../lib/plates.js';
import { fitLogLogistic, percentOfControls } from '../lib/curves.js';

// Statistics a heat map or a curve can use (not those needing a control sample or counting beads).
export const PLATE_STATISTICS = STATISTICS.filter((s) => !s.needsControl && !s.needsCounting);

// Annotation fields of samples, most common first.
export function annotationFields(samples) {
  const counts = new Map();
  for (const s of samples) for (const [k, v] of Object.entries(s.meta ?? {})) if (v !== '' && v !== null && v !== undefined && k !== 'well' && k !== 'plate') counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

// Likely roles of a plate's annotation fields.
export function guessFields(samples) {
  const fields = annotationFields(samples);
  // Fields whose value differs between wells (a field the same everywhere holds no layout).
  const varies = (f) => new Set(samples.map((s) => s.meta?.[f]).filter((v) => v !== undefined && v !== '')).size > 1;
  const pick = (...patterns) => {
    for (const re of patterns) {
      const found = fields.find((f) => re.test(f) && varies(f));
      if (found) return found;
    }
    return null;
  };
  return {
    dose: pick(/^(dose|conc|concentration)\b/i, /(dose|conc)/i),
    group: pick(/^(compound|drug|treatment|antibody|agent|inhibitor)\b/i, /(compound|drug|treatment)/i),
    control: pick(/^(control|type|well ?type|role)$/i),
    standard: pick(/^(standard|std|calibrator)s?$/i),
    specimen: pick(/^specimen( ?id)?$/i, /^sample( ?id)?$/i, /^(serum|patient|donor)( ?id)?$/i, /^subject( ?id)?$/i),
    // A dilution may be the same for every sample.
    dilution: fields.find((f) => /dilut/i.test(f)) ?? null,
  };
}

// The statistic spec of a heat map or curve: { stat, gateId, channel?, value? }.
export function statisticLabel(ws, spec, channelLabel) {
  const stat = STATISTICS.find((s) => s.id === spec.stat)?.label ?? spec.stat;
  const population = spec.gateId && spec.gateId !== ROOT ? gateById(ws, spec.gateId)?.name ?? '(deleted)' : 'All events';
  const channel = spec.channel ? ` ${channelLabel(ws, spec.channel, { short: true })}` : '';
  return `${population}: ${stat}${channel}`;
}

// The population whose events a well's value rests on: for a percentage, the one it is a
// percentage of (the parent, grandparent or all events); otherwise the population itself.
export function basePopulation(ws, spec) {
  const gate = spec.gateId && spec.gateId !== ROOT ? gateById(ws, spec.gateId) : null;
  if (spec.stat === 'freqParent') return gate?.parentId ?? ROOT;
  if (spec.stat === 'freqGrandparent') return (gate?.parentId ? gateById(ws, gate.parentId)?.parentId : null) ?? ROOT;
  if (spec.stat === 'freqTotal') return ROOT;
  return spec.gateId ?? ROOT;
}

// The statistic for every placed sample of a plate: Map(sampleId → { value, events }), events in
// the base population (above).
export async function plateValues(ws, plate, spec, viewOf, onProgress) {
  const out = new Map();
  let done = 0;
  for (const p of plate.placed) {
    const view = await viewOf(p.sampleId).catch(() => null);
    done += 1;
    onProgress?.(done / plate.placed.length);
    if (!view) continue;
    const events = countOf(populationSet(view, ws, basePopulation(ws, spec)), view);
    out.set(p.sampleId, { value: computeStatistic(view, ws, spec), events: Number.isFinite(events) ? events : 0 });
  }
  return out;
}

// Control wells by an annotation field: { positive: [sampleIds], negative: [sampleIds] }.
export function controlWells(samples, field, options = {}) {
  const out = { positive: [], negative: [] };
  if (!field) return out;
  for (const s of samples) {
    const role = controlRole(s.meta?.[field], options);
    if (role) out[role].push(s.id);
  }
  return out;
}

// Z′ of a plate's statistic from its controls, or null.
export function plateZPrime(values, controls, robust = false) {
  const of = (ids) => ids.map((id) => values.get(id)?.value).filter(Number.isFinite);
  return zPrime(of(controls.positive), of(controls.negative), { robust });
}

// Dose-response data: groups of wells by groupField with their doses (common unit) and responses,
// optionally as % of the controls (0% the negative controls' mean, 100% the positive's) or %
// inhibition (100 minus that). Control wells are left out of the groups. Returns { unit, groups:
// [{ name, x, y, sampleIds }], controls { positive, negative } (values), normalized }.
export function doseResponseData(samples, values, options) {
  const { doseField, groupField, controlField, normalize = 'none', controlValues } = options;
  const controls = controlWells(samples, controlField, controlValues);
  const controlIds = new Set([...controls.positive, ...controls.negative]);
  const valueOf = (id) => values.get(id)?.value;
  const posValues = controls.positive.map(valueOf).filter(Number.isFinite);
  const negValues = controls.negative.map(valueOf).filter(Number.isFinite);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  if (normalize !== 'none' && (!posValues.length || !negValues.length)) throw new Error(`Normalizing needs positive and negative control wells (the annotation "${controlField ?? 'control'}").`);
  const transform = (v) => {
    if (normalize === 'none') return v;
    const p = percentOfControls([v], mean(negValues), mean(posValues))[0];
    return normalize === 'inhibition' ? 100 - p : p;
  };
  const candidates = samples.filter((s) => !controlIds.has(s.id) && s.meta?.[doseField] !== undefined && s.meta?.[doseField] !== '');
  const { unit, values: doses } = commonDoses(candidates.map((s) => s.meta[doseField]));
  const groups = new Map();
  candidates.forEach((s, i) => {
    const y = valueOf(s.id);
    if (!Number.isFinite(doses[i]) || !Number.isFinite(y)) return;
    const name = groupField ? String(s.meta?.[groupField] ?? '(none)') : 'All wells';
    if (!groups.has(name)) groups.set(name, { name, x: [], y: [], sampleIds: [] });
    const g = groups.get(name);
    g.x.push(doses[i]);
    g.y.push(transform(y));
    g.sampleIds.push(s.id);
  });
  return {
    unit,
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    controls: { positive: posValues.map(transform), negative: negValues.map(transform) },
    normalized: normalize,
  };
}

// Fits every group: [{ name, fit | null, error }].
export function fitGroups(data, options) {
  return data.groups.map((g) => {
    try {
      return { ...g, fit: fitLogLogistic(g.x, g.y, options), error: null };
    } catch (error) {
      return { ...g, fit: null, error: error.message };
    }
  });
}

// The wells of a bead immunoassay: [{ id, name, meta, groups: [{ classification, reporter }] }]
// from each bead group's population (gateIds) on the classification and reporter channels.
export async function beadAssayInput(ws, samples, gateIds, channels, viewOf, onProgress) {
  const wells = [];
  let done = 0;
  for (const s of samples) {
    const view = await viewOf(s.id).catch(() => null);
    done += 1;
    onProgress?.(done / samples.length);
    if (!view) continue;
    if (!view.hasChannel(channels.classification) || !view.hasChannel(channels.reporter)) throw new Error(`${s.name} has no channel ${!view.hasChannel(channels.classification) ? channels.classification : channels.reporter}.`);
    const classification = view.column(channels.classification);
    const reporter = view.column(channels.reporter);
    const groups = gateIds.map((gateId) => {
      const indices = population(view, ws, gateId);
      const list = indices === undefined ? [] : indices === null ? [...Array(view.eventCount).keys()] : [...indices];
      return { classification: Float32Array.from(list, (i) => classification[i]), reporter: Float32Array.from(list, (i) => reporter[i]) };
    });
    wells.push({ id: s.id, name: s.name, meta: s.meta ?? {}, groups });
  }
  return wells;
}

// Channels likely to be a bead assay's classification (APC-like, red laser) and reporter (PE).
export function guessBeadChannels(parameters) {
  const fluor = parameters.filter((p) => p.type === 'fluorescence' || (!/^(FSC|SSC|Time)/i.test(p.name) && p.type !== 'time' && p.type !== 'scatter'));
  const text = (p) => `${p.marker ?? ''} ${p.label ?? ''} ${p.name}`;
  const reporter = fluor.find((p) => /report/i.test(text(p))) ?? fluor.find((p) => /^PE-A$|^PE\b|FL2/i.test(p.name)) ?? fluor[0];
  const classification = fluor.find((p) => /(bead ?id|classif)/i.test(text(p))) ?? fluor.find((p) => /^APC-A$|^APC\b|FL6|FL4/i.test(p.name)) ?? fluor.find((p) => p !== reporter);
  return { classification: classification?.name ?? null, reporter: reporter?.name ?? null };
}
