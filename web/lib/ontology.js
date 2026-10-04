// Cell Ontology terms suggested for gated populations from their marker phenotype (phenotype.js),
// never from their names. A term fits when every marker it requires (cell-ontology.js) is in an
// accepted state; markers the population was not gated on are unknown and never count against it.
// Confidence: 'exact' when every requirement is met; 'likely' when every positive requirement is
// met and only negative ones are unknown (a "CD4+" gate drawn without CD8 is likely CD4 T cells).
// The term the most markers support comes first (the more general one when two are supported
// equally). Terms of the thymus are not suggested. The user confirms a suggestion before it is used in
// exports or the methods.
//
// Scatter-only gates are classed from their own extent on side scatter (scatterClass): a gate held
// to low side scatter is lymphocytes; one at intermediate side scatter and higher forward scatter,
// monocytes; one at high side scatter, granulocytes. A gate spanning the whole axis (cells, debris
// exclusion) gets no scatter class.

import { TERMS } from './cell-ontology.js';
import { normalizeMarker } from './templates.js';
import { gateAncestors, gateById } from './workspace.js';
import { populationPhenotype } from './phenotype.js';

const byId = new Map(TERMS.map((t) => [t.id, t]));
export const termById = (id) => byId.get(id) ?? null;

// The depth of a term in the curated hierarchy (more specific terms are deeper).
const depthCache = new Map();
// A term's ancestors among the curated terms (its is_a closure in the Cell Ontology).
const ancestorSets = new Map(TERMS.map((t) => [t.id, new Set(t.ancestors ?? [])]));
const ancestors = (id) => ancestorSets.get(id) ?? new Set();

function depth(id, seen = new Set()) {
  if (depthCache.has(id)) return depthCache.get(id);
  if (seen.has(id)) return 0;
  seen.add(id);
  const term = byId.get(id);
  const d = term?.parents?.length ? 1 + Math.max(...term.parents.map((p) => depth(p, seen))) : 0;
  depthCache.set(id, d);
  return d;
}

// The scatter class of a gate drawn on forward against side scatter (or side scatter alone), from
// its extent in the gate's scale coordinates (0–1 of the axis): 'granulocytic' when it starts high
// on side scatter, 'monocytic' when it starts above the lymphocytes on forward scatter at
// intermediate side scatter, 'lymphoid' when it is held to low side scatter, else null (a gate
// spanning the axis: cells, debris exclusion). Singlet gates (area against height of one scatter)
// and gates with a fluorescence axis get none. Among sibling scatter gates of one class, the one
// further out on forward scatter is the monocytes (siblings: gates under the same parent).
const FSC_RE = /^(FSC|FS)(-|$|[ _])/i;
const SSC_RE = /^(SSC|SS)(-|$|[ _])/i;

function scatterExtent(gate) {
  const ssc = gate.dims.findIndex((d) => SSC_RE.test(d.channel));
  const fsc = gate.dims.findIndex((d) => FSC_RE.test(d.channel));
  const scatterOnly = gate.dims.length === 1 ? ssc === 0 : gate.dims.length === 2 && ssc >= 0 && fsc >= 0;
  if (!scatterOnly) return null;
  const extent = (i) => {
    const g = gate.geometry ?? {};
    let values = [];
    if (gate.type === 'polygon') values = (g.vertices ?? []).map((v) => v[i]);
    else if (gate.type === 'rectangle') values = [g.min?.[i] ?? 0, g.max?.[i] ?? 1];
    else if (gate.type === 'ellipse') {
      // The bounding box of the rotated ellipse.
      const [rx, ry] = g.radii;
      const c = Math.cos(g.angle ?? 0);
      const sn = Math.sin(g.angle ?? 0);
      const half = i === 0 ? Math.hypot(rx * c, ry * sn) : Math.hypot(rx * sn, ry * c);
      values = [g.center[i] - half, g.center[i] + half];
    } else if (gate.type === 'range' && gate.dims.length === 1) values = [g.min ?? 0, g.max ?? 1];
    values = values.filter(Number.isFinite);
    return values.length ? [Math.min(...values), Math.max(...values)] : null;
  };
  const s = extent(ssc);
  return s ? { s, f: fsc >= 0 ? extent(fsc) : null } : null;
}

function classOf({ s, f }) {
  if (s[0] >= 0.3) return 'granulocytic';
  if (f && f[0] >= 0.2 && s[0] >= 0.05 && s[1] <= 0.7) return 'monocytic';
  if (s[1] <= 0.35 && s[1] - s[0] < 0.4) return 'lymphoid';
  return null;
}

export function scatterClass(gate, ws = null) {
  const extent = scatterExtent(gate);
  if (!extent) return null;
  const own = classOf(extent);
  if (own !== 'lymphoid' || !ws) return own;
  const center = (e) => (e.f ? (e.f[0] + e.f[1]) / 2 : 0);
  const siblings = ws.gates.filter((g) => g.id !== gate.id && (g.parentId ?? null) === (gate.parentId ?? null)).map(scatterExtent).filter((e) => e && classOf(e) === 'lymphoid');
  return siblings.some((e) => center(e) < center(extent)) ? 'monocytic' : own;
}

const SCATTER_TERMS = { lymphoid: 'CL:0000542', monocytic: 'CL:0000576', granulocytic: 'CL:0000094' };
// The forward and side scatter states of each scatter class, for terms that require scatter.
const SCATTER_STATES = {
  lymphoid: { FSC: ['low', 'mid'], SSC: ['low', '-'] },
  monocytic: { FSC: ['mid', 'high'], SSC: ['mid'] },
  granulocytic: { FSC: ['mid', 'high'], SSC: ['high'] },
};

// A phenotype's state for a marker, matching marker names across spellings ("HLA-DR", "HLADR").
function stateOf(markers, marker) {
  if (marker in markers) return markers[marker];
  const want = normalizeMarker(marker);
  for (const [name, state] of Object.entries(markers)) {
    if (normalizeMarker(name) === want) return state;
    // Labels that hold the fluorochrome too ("CD3 APC-H7"): the first word.
    if (normalizeMarker(String(name).split(/[\s_]+/)[0]) === want) return state;
  }
  return undefined;
}

const POSITIVE = new Set(['+', 'high']);

// The ancestors whose phenotype a term keeps: those its own does not contradict. The conventional
// phenotype of an innate lymphoid cell (CD56−, CD127+) describes the helper ILCs, not the NK cells
// that CL also counts as ILCs, so NK cells do not inherit it.
const inheritedCache = new Map();
function inherited(term) {
  if (inheritedCache.has(term.id)) return inheritedCache.get(term.id);
  const own = [...Object.entries(term.requires), ...(term.anyOf ?? []).flat()];
  const keep = (term.ancestors ?? []).filter((id) => {
    const theirs = byId.get(id)?.requires ?? {};
    return own.every(([marker, accepted]) => !theirs[marker] || accepted.some((a) => theirs[marker].includes(a)));
  });
  inheritedCache.set(term.id, keep);
  return keep;
}

// How a phenotype (and the gate's scatter class, if known) fits a term: { term, confidence, matched,
// unknown } or null when a requirement is contradicted or a positive one is not known.
export function fitTerm(term, markers, scatter = null) {
  const matched = [];
  const unknown = [];
  // A term is a kind of each of its ancestors, so a phenotype that contradicts an ancestor's
  // requirement rules it out (CD8+ cells are no CD4-positive memory T cells); an ancestor's marker
  // not gated does not count against it.
  for (const id of inherited(term)) {
    for (const [marker, accepted] of Object.entries(byId.get(id)?.requires ?? {})) {
      if (marker in term.requires || marker === 'FSC' || marker === 'SSC') continue;
      const state = stateOf(markers, marker);
      if (state !== undefined && !accepted.includes(state)) return null;
    }
  }
  // Scatter requirements against the gate's scatter class, when it has one.
  const states = SCATTER_STATES[scatter];
  if (states && (term.requires.FSC || term.requires.SSC)) {
    for (const axis of ['FSC', 'SSC']) if (term.requires[axis] && !term.requires[axis].some((a) => states[axis].includes(a))) return null;
    matched.push('scatter');
  }
  for (const [marker, accepted] of Object.entries(term.requires)) {
    if (marker === 'FSC' || marker === 'SSC') continue;
    const state = stateOf(markers, marker);
    if (state === undefined) {
      if (accepted.some((a) => POSITIVE.has(a))) return null;
      unknown.push(marker);
    } else if (accepted.includes(state)) matched.push(marker);
    else return null;
  }
  for (const group of term.anyOf ?? []) {
    const hit = group.find(([marker, accepted]) => accepted.includes(stateOf(markers, marker)));
    if (!hit) return null;
    matched.push(hit[0]);
  }
  if (!matched.some((m) => m !== 'scatter')) return null;
  return { term, confidence: unknown.length ? 'likely' : 'exact', matched, unknown };
}

// Ranked suggestions for a phenotype: [{ id, label, confidence, matched, unknown, reason }].
export function suggestTerms(markers, options = {}) {
  const fits = [];
  for (const term of TERMS) {
    // Thymocyte terms name a tissue the data do not show; blood CD4+ CD8+ T cells are not thymocytes.
    if (/thymocyte/i.test(term.label)) continue;
    // Peripheral blood mononuclear cells name a preparation, not a population a gate selects.
    if (term.id === 'CL:2000001') continue;
    const fit = fitTerm(term, markers, options.scatter);
    if (fit) fits.push(fit);
  }
  // The scatter class is evidence too: lymphoid scatter makes lymphocytes of CD45+ cells.
  const scatterTerm = options.scatter ? byId.get(SCATTER_TERMS[options.scatter]) : null;
  if (scatterTerm && !fits.some((f) => f.term === scatterTerm)) fits.push({ term: scatterTerm, confidence: 'likely', matched: ['scatter'], unknown: [] });
  // A term is superseded when a more specific one fits on evidence it lacks (a T cell, CD3+, is
  // also the leukocyte that CD45+ says); it stays listed, after the rest.
  const superseded = new Set(fits.filter((f) => fits.some((g) => g !== f && ancestors(g.term.id).has(f.term.id) && g.matched.some((m) => !f.matched.includes(m)))));
  const rank = { exact: 0, likely: 1 };
  // Exact before likely; then the term the most markers support, with the fewest unknown; then the
  // more general term, since nothing more supports the more specific one.
  fits.sort((a, b) => superseded.has(a) - superseded.has(b) || rank[a.confidence] - rank[b.confidence] || b.matched.length - a.matched.length || a.unknown.length - b.unknown.length || depth(a.term.id) - depth(b.term.id));
  return fits.slice(0, options.limit ?? 5).map((f) => ({
    id: f.term.id,
    label: f.term.label,
    confidence: f.confidence,
    matched: f.matched,
    unknown: f.unknown,
    reason: f.matched[0] === 'scatter'
      ? `the gate holds ${options.scatter} scatter`
      : `${f.matched.map((m) => `${m}${markers[m] ?? stateOf(markers, m) ?? ''}`).join(' ')}${f.unknown.length ? `; ${f.unknown.join(', ')} not gated` : ''}`,
  }));
}

// Suggestions for a population of a sample: the phenotype along its path, and for a scatter
// gate (or a population under one, with no marker phenotype) the scatter class.
export function suggestForPopulation(view, ws, gateId, options = {}) {
  const phenotype = populationPhenotype(view, ws, gateId);
  const gate = gateById(ws, gateId);
  let scatter = null;
  for (const g of [gate, ...gateAncestors(ws, gateId).reverse()]) {
    scatter = g ? scatterClass(g, ws) : null;
    if (scatter) break;
  }
  const markers = Object.fromEntries(Object.entries(phenotype.markers).filter(([m]) => m !== 'FSC' && m !== 'SSC'));
  return { phenotype, scatter, suggestions: suggestTerms(markers, { ...options, scatter }) };
}
