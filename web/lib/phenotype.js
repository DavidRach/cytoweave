// The marker phenotype of a gated population, from the data rather than its name: each gate on
// the population's path says, for the markers it is drawn on, whether its events are positive or
// negative (or high or low) compared with its parent population. Scatter gates say where the
// population sits on forward and side scatter. Used to suggest Cell Ontology terms (ontology.js).
//
// A marker state: '+' or '-' when the gate's own geometry takes one side of a threshold
// (quadrants, splits, ranges and rectangles open on one side), or when a closed shape holds
// events on one side of the valley between two modes of the parent; otherwise 'high' or 'low'
// when the population's median is more than one robust SD above or below the parent's; otherwise
// unknown (left out). Scatter gives 'low', 'mid' or 'high' by the population's median's
// percentile in its parent.

import { population } from './engine.js';
import { ROOT, gateAncestors, gateById } from './workspace.js';
import { valleyThreshold } from './autogate.js';

const SCATTER = /^(FSC|SSC|FS|SS)/i;

function medianOf(values, indices) {
  const picked = [];
  const n = indices ? indices.length : values.length;
  const step = Math.max(1, Math.floor(n / 20000));
  for (let k = 0; k < n; k += step) {
    const v = values[indices ? indices[k] : k];
    if (Number.isFinite(v)) picked.push(v);
  }
  picked.sort((a, b) => a - b);
  return { median: picked.length ? picked[Math.floor(picked.length / 2)] : Number.NaN, sorted: picked };
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] : Number.NaN);

// A word that names a marker rather than a fluorochrome or detector.
const MARKER_WORD = /^(CD\d+[A-Za-z]*|HLA-?D[RPQ]|CCR\d+|CXCR\d+|CX3CR1|TCR[A-Za-zγδαβ]*|Ig[ADEGM]|IFN-?[gγy]|TNF-?a?|IL-?\d+[A-Za-z]*|Ki-?67|FoxP3|GzmB|Perforin|PD-?1|CTLA-?4|NK1[./_]?1|Ly-?6[CG]|B220|F4\/80)$/i;

// The marker a channel measures, as the phenotype names it: its marker; or, for files that name
// channels after their stain ("CD3 APC-H7 FLR-A") without a $PnS, the first word of the name that
// is a marker; or its scatter name (FSC, SSC) without the -A/-H/-W suffix.
export function markerOfChannel(view, channel) {
  const info = view.channelInfo?.(channel);
  if (info?.marker) return info.marker;
  if (SCATTER.test(channel)) return /^S/i.test(channel) ? 'SSC' : 'FSC';
  const word = String(channel).split(/[\s,;:()]+/).find((w) => MARKER_WORD.test(w));
  return word ?? null;
}

// The side a gate's geometry takes on dimension i: '+' (above a threshold, open upward), '-'
// (below, open downward), or null when it is closed on both sides (decided from the data). A
// bound within 2% of the axis's end counts as open, as FlowJo often writes them.
export function geometrySide(gate, i) {
  const g = gate.geometry ?? {};
  const open = (lo, hi) => {
    const loOpen = lo === null || lo === undefined || lo <= 0.02;
    const hiOpen = hi === null || hi === undefined || hi >= 0.98;
    if (loOpen && !hiOpen) return '-';
    if (hiOpen && !loOpen) return '+';
    return null;
  };
  if (gate.type === 'quadrant') return i === 0 ? (/R$/.test(g.quadrant) ? '+' : '-') : (/^U/.test(g.quadrant) ? '+' : '-');
  if (gate.type === 'split') return g.side === 'hi' ? '+' : '-';
  if (gate.type === 'range') return open(g.min, g.max);
  if (gate.type === 'rectangle') return open(g.min?.[i], g.max?.[i]);
  return null;
}

// The states one gate gives the markers it is drawn on: [{ marker, state, channel, evidence }].
export function gateStates(view, ws, gate) {
  if (!gate || gate.type === 'boolean' || gate.type === 'category') return [];
  const members = population(view, ws, gate.id);
  const parent = population(view, ws, gate.parentId ?? ROOT);
  if (members === undefined || parent === undefined) return [];
  const out = [];
  gate.dims.forEach((dim, i) => {
    const marker = markerOfChannel(view, dim.channel);
    if (!marker) return;
    const values = view.scaled(dim.channel, dim.transform, dim.compensation);
    const mine = medianOf(values, members);
    const theirs = medianOf(values, parent);
    if (!Number.isFinite(mine.median) || !theirs.sorted.length) return;
    if (marker === 'FSC' || marker === 'SSC') {
      // The population's median as a percentile of its parent's events.
      let below = 0;
      for (const v of theirs.sorted) if (v < mine.median) below += 1;
      const rank = below / theirs.sorted.length;
      out.push({ marker, state: rank < 0.4 ? 'low' : rank > 0.6 ? 'high' : 'mid', channel: dim.channel, evidence: `median at the ${(100 * rank).toFixed(0)}th percentile of the parent` });
      return;
    }
    const side = geometrySide(gate, i);
    if (side) {
      out.push({ marker, state: side, channel: dim.channel, evidence: `the gate is ${side === '+' ? 'above' : 'below'} a threshold on ${marker}` });
      return;
    }
    // A closed shape: positive or negative when the population lies on one side of a valley
    // between two modes of its parent; otherwise high or low against the parent's spread.
    const valley = valleyThreshold(values, parent);
    if (valley.modes?.length === 2) {
      const lo = quantile(mine.sorted, 0.1);
      const hi = quantile(mine.sorted, 0.9);
      if (lo > valley.threshold || hi < valley.threshold) {
        out.push({ marker, state: lo > valley.threshold ? '+' : '-', channel: dim.channel, evidence: `its central 80% lies ${lo > valley.threshold ? 'above' : 'below'} the valley between the parent's two modes` });
        return;
      }
    }
    const spread = (quantile(theirs.sorted, 0.75) - quantile(theirs.sorted, 0.25)) / 1.349;
    if (!(spread > 0)) return;
    const z = (mine.median - theirs.median) / spread;
    if (z > 1) out.push({ marker, state: 'high', channel: dim.channel, evidence: `median ${z.toFixed(1)} robust SDs above the parent's` });
    else if (z < -1) out.push({ marker, state: 'low', channel: dim.channel, evidence: `median ${(-z).toFixed(1)} robust SDs below the parent's` });
  });
  return out;
}

// The phenotype of a population: { markers: { marker: state }, steps: [{ gate, states }] }, a
// deeper gate's state for a marker replacing an earlier one's.
export function populationPhenotype(view, ws, gateId) {
  const gate = gateById(ws, gateId);
  if (!gate) return { markers: {}, steps: [] };
  const path = [...gateAncestors(ws, gateId), gate];
  const markers = {};
  const steps = [];
  for (const g of path) {
    const states = gateStates(view, ws, g);
    for (const s of states) markers[s.marker] = s.state;
    steps.push({ gate: g.name, states });
  }
  return { markers, steps };
}

// '+' and 'high' agree, as do '-' and 'low', for comparing phenotypes.
export const positive = (state) => state === '+' || state === 'high';
export const negative = (state) => state === '-' || state === 'low';
