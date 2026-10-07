// The panel optimizer (S9): which dye each marker of a panel should carry, from the dyes' spectra
// and the instrument's noise (spread.js), the markers' expression and which markers are on the
// same cells.
//
// A marker b on dye j gives its positive cells a signal ΔF_b = S · e_b · B_j: its expression e_b
// (molecules per cell: high 10^5, medium 10^4, low 10^3, or a number), the dye's relative
// brightness B_j (dyes.js, or given) and the signal one bound antibody of a brightness-1 dye gives
// on the instrument, S (1 on a 2^18 scale, as a BD instrument gives about 0.5 per PE molecule;
// 12 on a 2^22 scale such as the Aurora's). Its negative cells, in a group of co-expressed
// markers, spread in j's unmixed (or compensated) channel with a variance
//   σ²_bG = σ0²_j + Σ_{a ∈ G, a ≠ b} (photon_{a→j} ΔF_a + laser_{a→j} ΔF_a²),
// the background of channel j (the unstained control's detector covariance carried through the
// unmixing, or a typical one) plus the spread every other marker of the group adds at its own
// brightness (spread.js: photon noise in every detector the dye reaches and the lasers'
// fluctuations for dyes excited by several). The marker's resolution is ΔF_b / σ_b in its worst
// group; its predicted stain index is half that. The panel's cost is Σ_b w_b σ²_b / ΔF²_b: the
// noise-to-signal of every marker, so a dim marker co-expressed with bright ones dominates, a dim
// marker wants a bright dye in a quiet channel, and a bright marker on a dye that spreads into its
// neighbors' channels costs them.
//
// The unmixing operator, and so every spread term and background, depends on which dyes are in
// the panel (similar spectra amplify noise): the terms are computed for each set of dyes tried,
// by ordinary least squares over all detectors (spectral) or the inverse of the spillover matrix
// on the dyes' own detectors (conventional, `square`). Small problems are solved exhaustively;
// larger ones by iterated local search (swapping two markers' dyes, giving a marker an unused
// dye, from several seeded starts), which validation/panel-cases.mjs checks against exhaustive
// optima and simulated panels.

import { dyeBrightness, energyTransferPairs } from './dyes.js';
import { createRandom } from './random.js';
import { agreement, detectorLaser } from './spread.js';

export const LEVELS = { high: 1e5, medium: 1e4, low: 1e3 };

// The per-detector SD of the background, in units of the signal scale, when no unstained control
// gives it: electronic noise and autofluorescence of lymphocytes on the simulated instruments
// (validation/panel-cases.mjs).
export const DEFAULT_BACKGROUND_SD = 60;

// Signal per bound antibody of a brightness-1 dye on an instrument with this data range.
export function defaultSignalScale(range) {
  return range > 1 << 20 ? 12 : 1;
}

export function levelValue(level) {
  if (typeof level === 'number') {
    if (level > 0) return level;
  } else {
    const named = LEVELS[String(level ?? '').trim().toLowerCase()];
    if (named) return named;
    const number = Number(level);
    if (number > 0) return number;
  }
  throw new Error(`Unknown expression level "${level}": high, medium, low or a number of molecules per cell.`);
}

export function levelLabel(value) {
  const named = Object.entries(LEVELS).find(([, v]) => v === value);
  return named ? named[0] : Number(value).toExponential(1).replace('e+', 'e');
}

// A problem from plain inputs:
// { markers: [{ name, level, weight?, dye? (fixed), exclude? (dye names) }],
//   groups: [{ name, markers: [names] } | [names]],
//   dyes: [{ name, spectrum (over detectors), brightness?, detector? (square: the dye's own) }],
//   detectors, noise ({ detectors, c1, lasers, laserCV }: spread.js noiseRecord, or { c1, laserCV }
//   on these detectors and the lasers of their names), background ({ covariance: D × D } |
//   { sd: per detector } | null), signalScale, range (for the default scale), square }.
export function panelProblem(input) {
  const detectors = [...input.detectors];
  const D = detectors.length;
  const dyes = input.dyes.map((d) => ({ ...d, spectrum: Float64Array.from(d.spectrum) }));
  const N = dyes.length;
  if (!N) throw new Error('No dyes to choose from.');
  for (const d of dyes) if (d.spectrum.length !== D) throw new Error(`The spectrum of ${d.name} does not cover the ${D} detectors.`);
  const names = dyes.map((d) => d.name);
  if (new Set(names).size !== N) throw new Error('Two candidate dyes have the same name.');
  const markers = input.markers.map((m) => ({ ...m, name: String(m.name), value: levelValue(m.level), weight: m.weight ?? 1 }));
  const M = markers.length;
  if (!M) throw new Error('No markers to assign.');
  if (new Set(markers.map((m) => m.name)).size !== M) throw new Error('Two markers have the same name.');
  if (M > N) throw new Error(`${M} markers but only ${N} dyes to choose from.`);
  const square = Boolean(input.square);
  if (!square && M > D) throw new Error(`${M} markers but only ${D} detectors: unmixing needs at least as many detectors as dyes.`);
  const markerIndex = new Map(markers.map((m, k) => [m.name, k]));
  const dyeIndex = new Map(names.map((n, k) => [n, k]));

  // Brightness: given, else the table's, else the median of the others.
  const known = dyes.map((d) => (d.brightness > 0 ? d.brightness : dyeBrightness(d.name)));
  const found = known.filter((v) => v > 0).sort((a, b) => a - b);
  const fallback = found.length ? found[Math.floor(found.length / 2)] : 1;
  const brightness = Float64Array.from(known, (v) => (v > 0 ? v : fallback));
  const assumedBrightness = names.filter((_, k) => !(known[k] > 0));

  // Groups of co-expressed markers, as marker indices.
  const groups = (input.groups ?? []).map((g, k) => {
    const list = Array.isArray(g) ? g : g.markers;
    const members = [...new Set(list.map((n) => {
      if (!markerIndex.has(n)) throw new Error(`The group ${g.name ?? k + 1} names ${n}, which is not a marker of the panel.`);
      return markerIndex.get(n);
    }))];
    return { name: (Array.isArray(g) ? null : g.name) ?? `Group ${k + 1}`, members };
  }).filter((g) => g.members.length > 0);
  const groupsOf = markers.map((_, b) => groups.map((g, k) => (g.members.includes(b) ? k : -1)).filter((k) => k >= 0));

  // Allowed dyes per marker: a fixed dye, or every dye not excluded and not fixed to another.
  const fixed = new Int32Array(M).fill(-1);
  markers.forEach((m, b) => {
    if (!m.dye) return;
    if (!dyeIndex.has(m.dye)) throw new Error(`${m.name} is fixed to ${m.dye}, which is not among the dyes.`);
    fixed[b] = dyeIndex.get(m.dye);
  });
  if (new Set(Array.from(fixed).filter((i) => i >= 0)).size !== Array.from(fixed).filter((i) => i >= 0).length) throw new Error('Two markers are fixed to the same dye.');
  const taken = new Set(Array.from(fixed).filter((i) => i >= 0));
  const allowed = markers.map((m, b) => {
    if (fixed[b] >= 0) return Uint8Array.from(names, (_, i) => (i === fixed[b] ? 1 : 0));
    const excluded = new Set(m.exclude ?? []);
    return Uint8Array.from(names, (n, i) => (taken.has(i) || excluded.has(n) ? 0 : 1));
  });
  markers.forEach((m, b) => {
    if (!allowed[b].some(Boolean)) throw new Error(`No dye is left for ${m.name}.`);
  });

  // The instrument's noise on these detectors.
  const noise = input.noise;
  if (!noise?.c1) throw new Error('The panel optimizer needs the instrument\'s noise model (photon noise per detector, fitted to controls or from bead runs).');
  let c1;
  let laserOf;
  let laserCV;
  if (noise.detectors) {
    const index = new Map(noise.detectors.map((d, k) => [d, k]));
    const missing = detectors.filter((d) => !index.has(d));
    if (missing.length) throw new Error(`The noise model does not cover ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}.`);
    c1 = Float64Array.from(detectors, (d) => noise.c1[index.get(d)]);
  } else {
    if (noise.c1.length !== D) throw new Error('The noise model does not match the detectors.');
    c1 = Float64Array.from(noise.c1);
  }
  const lasers = [];
  laserOf = new Int32Array(D).fill(-1);
  detectors.forEach((name, d) => {
    const laser = detectorLaser(name);
    if (!laser) return;
    if (!lasers.includes(laser)) lasers.push(laser);
    laserOf[d] = lasers.indexOf(laser);
  });
  laserCV = Float64Array.from(lasers, (l, k) => {
    if (noise.lasers) {
      const at = noise.lasers.indexOf(l);
      return at >= 0 ? noise.laserCV?.[at] ?? 0 : 0;
    }
    return noise.laserCV?.[k] ?? 0;
  });

  const signalScale = input.signalScale ?? defaultSignalScale(input.range ?? (square ? 262144 : 4194304));
  // Background covariance (or variance per detector) in the data's units.
  let covariance = null;
  let variance = null;
  let backgroundSource;
  if (input.background?.covariance) {
    covariance = Float64Array.from(input.background.covariance);
    if (covariance.length !== D * D) throw new Error('The background covariance does not match the detectors.');
    backgroundSource = input.background.source ?? 'unstained';
  } else if (input.background?.sd) {
    variance = Float64Array.from(input.background.sd, (s) => s * s);
    backgroundSource = input.background.source ?? 'given';
  } else {
    variance = new Float64Array(D).fill((DEFAULT_BACKGROUND_SD * signalScale) ** 2);
    backgroundSource = 'assumed';
  }

  const own = square ? Int32Array.from(dyes, (d) => {
    const at = typeof d.detector === 'number' ? d.detector : detectors.indexOf(d.detector);
    if (!(at >= 0)) throw new Error(`${d.name} has no detector of its own (a compensation needs one per dye).`);
    return at;
  }) : null;

  return {
    detectors, D, dyes, names, N, markers, M, groups, groupsOf, allowed, fixed, brightness, assumedBrightness,
    c1, lasers, laserOf, laserCV, signalScale, covariance, variance, backgroundSource, square, own,
    cache: new Map(), evaluations: 0,
  };
}

// The signal of marker b on dye i.
const signalOf = (p, b, i) => p.signalScale * p.markers[b].value * p.brightness[i];

// The spread and background terms of a set of dyes (sorted indices), or null when their spectra
// cannot be unmixed: { set, pos (dye → position, -1 when absent), K, photon (K × K: variance per
// unit of the spreader's signal), laser (K × K: per unit squared), bg (K: background variance) }.
export function setTerms(p, set) {
  const id = set.join(',');
  const cached = p.cache.get(id);
  if (cached !== undefined) return cached;
  p.evaluations += 1;
  const K = set.length;
  const dets = p.square ? set.map((i) => p.own[i]) : null;
  const Dn = p.square ? K : p.D;
  const det = (k) => (dets ? dets[k] : k);
  // S (K × Dn), Gram G = S Sᵀ, W = G⁻¹ S (row q: the unmixing weights of channel q).
  const S = new Float64Array(K * Dn);
  for (let a = 0; a < K; a += 1) {
    const s = p.dyes[set[a]].spectrum;
    for (let k = 0; k < Dn; k += 1) S[a * Dn + k] = s[det(k)];
  }
  const G = new Float64Array(K * K);
  let maxDiag = 0;
  for (let a = 0; a < K; a += 1) {
    for (let b = 0; b <= a; b += 1) {
      let v = 0;
      for (let k = 0; k < Dn; k += 1) v += S[a * Dn + k] * S[b * Dn + k];
      G[a * K + b] = v;
      G[b * K + a] = v;
    }
    maxDiag = Math.max(maxDiag, G[a * K + a]);
  }
  // Cholesky; a pivot this small means the spectra are (nearly) linearly dependent.
  const L = new Float64Array(K * K);
  for (let a = 0; a < K; a += 1) {
    for (let b = 0; b <= a; b += 1) {
      let v = G[a * K + b];
      for (let c = 0; c < b; c += 1) v -= L[a * K + c] * L[b * K + c];
      if (a === b) {
        if (!(v > 1e-10 * maxDiag)) {
          p.cache.set(id, null);
          return null;
        }
        L[a * K + a] = Math.sqrt(v);
      } else L[a * K + b] = v / L[b * K + b];
    }
  }
  const W = Float64Array.from(S);
  for (let k = 0; k < Dn; k += 1) {
    for (let a = 0; a < K; a += 1) {
      let v = W[a * Dn + k];
      for (let c = 0; c < a; c += 1) v -= L[a * K + c] * W[c * Dn + k];
      W[a * Dn + k] = v / L[a * K + a];
    }
    for (let a = K - 1; a >= 0; a -= 1) {
      let v = W[a * Dn + k];
      for (let c = a + 1; c < K; c += 1) v -= L[c * K + a] * W[c * Dn + k];
      W[a * Dn + k] = v / L[a * K + a];
    }
  }
  const nL = p.lasers.length;
  const photon = new Float64Array(K * K);
  const laser = new Float64Array(K * K);
  const sums = new Float64Array(nL);
  for (let q = 0; q < K; q += 1) {
    for (let a = 0; a < K; a += 1) {
      if (a === q) continue;
      let ph = 0;
      sums.fill(0);
      for (let k = 0; k < Dn; k += 1) {
        const u = W[q * Dn + k];
        const s = S[a * Dn + k];
        const d = det(k);
        if (s > 0) ph += u * u * s * p.c1[d];
        const l = p.laserOf[d];
        if (l >= 0) sums[l] += u * s;
      }
      let la = 0;
      for (let l = 0; l < nL; l += 1) la += p.laserCV[l] * p.laserCV[l] * sums[l] * sums[l];
      photon[a * K + q] = ph;
      laser[a * K + q] = la;
    }
  }
  const bg = new Float64Array(K);
  for (let q = 0; q < K; q += 1) {
    let v = 0;
    if (p.covariance) {
      for (let k = 0; k < Dn; k += 1) {
        const u = W[q * Dn + k];
        if (!u) continue;
        const row = det(k) * p.D;
        for (let m = 0; m < Dn; m += 1) v += u * W[q * Dn + m] * p.covariance[row + det(m)];
      }
    } else {
      for (let k = 0; k < Dn; k += 1) v += W[q * Dn + k] ** 2 * p.variance[det(k)];
    }
    bg[q] = Math.max(v, 0);
  }
  const pos = new Int32Array(p.N).fill(-1);
  set.forEach((i, k) => { pos[i] = k; });
  const terms = { set: [...set], pos, K, photon, laser, bg };
  if (p.cache.size >= 1500) p.cache.delete(p.cache.keys().next().value);
  p.cache.set(id, terms);
  return terms;
}

const setOf = (dyeOf) => Array.from(dyeOf).sort((a, b) => a - b);

// Each marker's variance in its worst group and that group: { variance, group } per marker.
function markerVariances(p, dyeOf, t) {
  const signals = Float64Array.from(dyeOf, (i, b) => signalOf(p, b, i));
  return Array.from({ length: p.M }, (_, b) => {
    const q = t.pos[dyeOf[b]];
    let worst = t.bg[q];
    let group = -1;
    for (const g of p.groupsOf[b]) {
      let v = t.bg[q];
      for (const a of p.groups[g].members) {
        if (a === b) continue;
        const r = t.pos[dyeOf[a]] * t.K + q;
        v += t.photon[r] * signals[a] + t.laser[r] * signals[a] * signals[a];
      }
      if (v > worst || group < 0) {
        worst = v;
        group = g;
      }
    }
    return { variance: worst, group, signal: signals[b] };
  });
}

// The cost of an assignment (dye index per marker) with its set's terms: Σ w σ² / ΔF².
function costWith(p, dyeOf, t) {
  if (!t) return Infinity;
  const signals = new Float64Array(p.M);
  for (let b = 0; b < p.M; b += 1) signals[b] = signalOf(p, b, dyeOf[b]);
  let cost = 0;
  for (let b = 0; b < p.M; b += 1) {
    const q = t.pos[dyeOf[b]];
    let worst = t.bg[q];
    for (const g of p.groupsOf[b]) {
      let v = t.bg[q];
      for (const a of p.groups[g].members) {
        if (a === b) continue;
        const r = t.pos[dyeOf[a]] * t.K + q;
        v += t.photon[r] * signals[a] + t.laser[r] * signals[a] * signals[a];
      }
      if (v > worst) worst = v;
    }
    cost += (p.markers[b].weight * worst) / (signals[b] * signals[b]);
  }
  return cost;
}

export function assignmentCost(p, dyeOf) {
  return costWith(p, dyeOf, setTerms(p, setOf(dyeOf)));
}

// The number of assignments the constraints allow (stops counting above limit).
function countAssignments(p, limit) {
  let count = 0;
  const used = new Uint8Array(p.N);
  const order = orderForSearch(p);
  const walk = (k) => {
    if (count > limit) return;
    if (k === order.length) {
      count += 1;
      return;
    }
    const b = order[k];
    for (let i = 0; i < p.N; i += 1) {
      if (!p.allowed[b][i] || used[i]) continue;
      used[i] = 1;
      walk(k + 1);
      used[i] = 0;
    }
  };
  walk(0);
  return count;
}

// Markers with the fewest allowed dyes first (fixed ones first of all).
function orderForSearch(p) {
  return Array.from({ length: p.M }, (_, b) => b).sort((a, b) => p.allowed[a].reduce((s, v) => s + v, 0) - p.allowed[b].reduce((s, v) => s + v, 0) || a - b);
}

// Every allowed assignment, set by set (each set's terms computed once); keep: how many of the
// best to return as well.
function exhaustive(p, onProgress, keep = 0) {
  const order = orderForSearch(p);
  const bySet = new Map();
  const used = new Uint8Array(p.N);
  const dyeOf = new Int32Array(p.M);
  const walk = (k) => {
    if (k === order.length) {
      const id = setOf(dyeOf).join(',');
      if (!bySet.has(id)) bySet.set(id, []);
      bySet.get(id).push(Int32Array.from(dyeOf));
      return;
    }
    const b = order[k];
    for (let i = 0; i < p.N; i += 1) {
      if (!p.allowed[b][i] || used[i]) continue;
      used[i] = 1;
      dyeOf[b] = i;
      walk(k + 1);
      used[i] = 0;
    }
  };
  walk(0);
  let best = { cost: Infinity, dyeOf: null };
  const top = [];
  let done = 0;
  for (const [id, list] of bySet) {
    const t = setTerms(p, id.split(',').map(Number));
    for (const a of list) {
      const cost = costWith(p, a, t);
      if (cost < best.cost) best = { cost, dyeOf: a };
      if (keep && (top.length < keep || cost < top[top.length - 1].cost)) {
        let k = top.length;
        while (k > 0 && top[k - 1].cost > cost) k -= 1;
        top.splice(k, 0, { cost, dyeOf: a });
        if (top.length > keep) top.pop();
      }
    }
    done += 1;
    if (done % 20 === 0) onProgress?.(done / bySet.size, `Tried ${done} of ${bySet.size} dye sets`);
  }
  return { ...best, top, assignments: [...bySet.values()].reduce((a, l) => a + l.length, 0), sets: bySet.size };
}

// The classical rule as a start: the dimmest markers get the brightest dyes they may have.
function ruleStart(p) {
  const dyeOf = new Int32Array(p.M).fill(-1);
  const used = new Uint8Array(p.N);
  p.fixed.forEach((i, b) => {
    if (i >= 0) {
      dyeOf[b] = i;
      used[i] = 1;
    }
  });
  const markers = Array.from({ length: p.M }, (_, b) => b).filter((b) => dyeOf[b] < 0).sort((a, b) => p.markers[a].value / p.markers[a].weight - p.markers[b].value / p.markers[b].weight || a - b);
  const dyes = Array.from({ length: p.N }, (_, i) => i).sort((a, b) => p.brightness[b] - p.brightness[a] || a - b);
  for (const b of markers) {
    const i = dyes.find((d) => !used[d] && p.allowed[b][d]) ?? -1;
    if (i < 0) return null;
    dyeOf[b] = i;
    used[i] = 1;
  }
  return dyeOf;
}

function randomStart(p, random) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const dyeOf = new Int32Array(p.M).fill(-1);
    const used = new Uint8Array(p.N);
    let ok = true;
    for (const b of orderForSearch(p)) {
      const choices = [];
      for (let i = 0; i < p.N; i += 1) if (p.allowed[b][i] && !used[i]) choices.push(i);
      if (!choices.length) {
        ok = false;
        break;
      }
      const i = choices[Math.floor(random() * choices.length)];
      dyeOf[b] = i;
      used[i] = 1;
    }
    if (ok) return dyeOf;
  }
  return null;
}

// Local search from an assignment: the best swap of two markers' dyes, else the first unused dye
// that improves a marker (in a random order), until neither improves.
function climb(p, start, random, budget) {
  let dyeOf = Int32Array.from(start);
  let t = setTerms(p, setOf(dyeOf));
  let cost = costWith(p, dyeOf, t);
  const free = Array.from({ length: p.M }, (_, b) => b).filter((b) => p.fixed[b] < 0);
  for (;;) {
    if (p.evaluations > budget) break;
    let best = null;
    for (let x = 0; x < free.length; x += 1) {
      for (let y = x + 1; y < free.length; y += 1) {
        const b = free[x];
        const c = free[y];
        if (!p.allowed[b][dyeOf[c]] || !p.allowed[c][dyeOf[b]]) continue;
        const next = Int32Array.from(dyeOf);
        next[b] = dyeOf[c];
        next[c] = dyeOf[b];
        const v = costWith(p, next, t);
        if (v < cost * (1 - 1e-12) && (!best || v < best.cost)) best = { cost: v, dyeOf: next, t };
      }
    }
    if (!best && p.N > p.M) {
      const used = new Uint8Array(p.N);
      for (const i of dyeOf) used[i] = 1;
      const moves = [];
      for (const b of free) for (let i = 0; i < p.N; i += 1) if (!used[i] && p.allowed[b][i]) moves.push([b, i]);
      for (let k = moves.length - 1; k > 0; k -= 1) {
        const j = Math.floor(random() * (k + 1));
        [moves[k], moves[j]] = [moves[j], moves[k]];
      }
      for (const [b, i] of moves) {
        const next = Int32Array.from(dyeOf);
        next[b] = i;
        const nt = setTerms(p, setOf(next));
        const v = costWith(p, next, nt);
        if (v < cost * (1 - 1e-12)) {
          best = { cost: v, dyeOf: next, t: nt };
          break;
        }
        if (p.evaluations > budget) break;
      }
    }
    if (!best) break;
    ({ dyeOf, cost, t } = best);
  }
  return { dyeOf, cost };
}

// A few random moves (swaps, or an unused dye) away from an assignment.
function perturb(p, dyeOf, random, moves) {
  const next = Int32Array.from(dyeOf);
  const free = Array.from({ length: p.M }, (_, b) => b).filter((b) => p.fixed[b] < 0);
  if (!free.length) return next;
  for (let m = 0; m < moves; m += 1) {
    const b = free[Math.floor(random() * free.length)];
    const used = new Uint8Array(p.N);
    for (const i of next) used[i] = 1;
    const unused = [];
    for (let i = 0; i < p.N; i += 1) if (!used[i] && p.allowed[b][i]) unused.push(i);
    if (unused.length && random() < 0.5) {
      next[b] = unused[Math.floor(random() * unused.length)];
      continue;
    }
    const c = free[Math.floor(random() * free.length)];
    if (c !== b && p.allowed[b][next[c]] && p.allowed[c][next[b]]) [next[b], next[c]] = [next[c], next[b]];
  }
  return next;
}

// The best assignment of dyes to markers. options: { seed (1), restarts (6), perturbations (40 per
// restart), budget (dye sets evaluated, 40 000), exhaustiveLimit (assignments, 50 000: below it
// every assignment is tried), keep (exhaustive: how many of the best to return), onProgress,
// signal }.
// Returns { assignment: [dye index per marker], cost, method: 'exhaustive' | 'local search',
// evaluations (dye sets), assignments (exhaustive: how many), top (exhaustive, with keep:
// [{ cost, dyeOf }]) }.
export function searchPanel(p, options = {}) {
  const limit = options.exhaustiveLimit ?? 50000;
  const total = countAssignments(p, limit);
  if (total <= limit) {
    const r = exhaustive(p, options.onProgress, options.keep ?? 0);
    if (!r.dyeOf) throw new Error('No allowed assignment of dyes can be unmixed.');
    return { assignment: r.dyeOf, cost: r.cost, method: 'exhaustive', evaluations: p.evaluations, assignments: r.assignments, sets: r.sets, top: r.top };
  }
  const random = createRandom(options.seed ?? 1);
  const restarts = options.restarts ?? 6;
  const perturbations = options.perturbations ?? 40;
  const budget = options.budget ?? 40000;
  let best = null;
  for (let r = 0; r < restarts; r += 1) {
    if (options.signal?.aborted) throw new Error('Canceled.');
    const start = r === 0 ? ruleStart(p) ?? randomStart(p, random) : randomStart(p, random);
    if (!start) continue;
    let state = climb(p, start, random, budget);
    for (let k = 0; k < perturbations && p.evaluations <= budget; k += 1) {
      if (options.signal?.aborted) throw new Error('Canceled.');
      const candidate = climb(p, perturb(p, state.dyeOf, random, 2 + Math.floor(random() * 3)), random, budget);
      if (candidate.cost < state.cost * (1 - 1e-12)) state = candidate;
    }
    if (!best || state.cost < best.cost) best = state;
    options.onProgress?.((r + 1) / restarts, `Search ${r + 1} of ${restarts}: ${p.evaluations} dye sets tried`);
  }
  if (!best || !Number.isFinite(best.cost)) throw new Error('No allowed assignment of dyes can be unmixed.');
  return { assignment: best.dyeOf, cost: best.cost, method: 'local search', evaluations: p.evaluations };
}

// What an assignment predicts, marker by marker: [{ marker, level, dye, brightness, signal, sd,
// stainIndex, group, background (share of the variance), from: [{ marker, dye, share }] }].
export function explainAssignment(p, dyeOf) {
  const t = setTerms(p, setOf(dyeOf));
  if (!t) throw new Error('These dyes cannot be unmixed together (their spectra are linearly dependent).');
  const rows = markerVariances(p, dyeOf, t);
  return rows.map((row, b) => {
    const q = t.pos[dyeOf[b]];
    const from = [];
    if (row.group >= 0) {
      for (const a of p.groups[row.group].members) {
        if (a === b) continue;
        const r = t.pos[dyeOf[a]] * t.K + q;
        const s = rows[a].signal;
        const v = t.photon[r] * s + t.laser[r] * s * s;
        if (v > 0) from.push({ marker: p.markers[a].name, dye: p.names[dyeOf[a]], share: v / row.variance });
      }
    }
    from.sort((x, y) => y.share - x.share);
    const sd = Math.sqrt(row.variance);
    return {
      marker: p.markers[b].name,
      level: p.markers[b].value,
      dye: p.names[dyeOf[b]],
      fixed: p.fixed[b] >= 0,
      brightness: p.brightness[dyeOf[b]],
      signal: row.signal,
      sd,
      stainIndex: sd > 0 ? row.signal / (2 * sd) : Infinity,
      group: row.group >= 0 ? p.groups[row.group].name : null,
      background: row.variance > 0 ? t.bg[q] / row.variance : 1,
      from,
    };
  });
}

// For each marker, the two best other dyes: an unused one, or another marker's (swapped):
// [{ marker, alternatives: [{ dye, swapWith (marker or null), cost, increase (fraction of the
// panel's cost), stainIndex (the marker's own with that dye) }] }].
export function alternativesFor(p, dyeOf, cost) {
  const used = new Map(Array.from(dyeOf, (i, b) => [i, b]));
  return p.markers.map((m, b) => {
    if (p.fixed[b] >= 0) return { marker: m.name, alternatives: [] };
    const options = [];
    for (let i = 0; i < p.N; i += 1) {
      if (i === dyeOf[b] || !p.allowed[b][i]) continue;
      const next = Int32Array.from(dyeOf);
      const other = used.get(i);
      if (other !== undefined) {
        if (p.fixed[other] >= 0 || !p.allowed[other][dyeOf[b]]) continue;
        next[other] = dyeOf[b];
      }
      next[b] = i;
      const t = setTerms(p, setOf(next));
      const v = costWith(p, next, t);
      if (!Number.isFinite(v)) continue;
      const own = markerVariances(p, next, t)[b];
      options.push({ dye: p.names[i], swapWith: other !== undefined ? p.markers[other].name : null, cost: v, increase: Math.max(v / cost - 1, 0), stainIndex: own.variance > 0 ? own.signal / (2 * Math.sqrt(own.variance)) : Infinity });
    }
    options.sort((x, y) => x.cost - y.cost);
    return { marker: m.name, alternatives: options.slice(0, 2) };
  });
}

// An assignment from { marker: dye name }, as dye indices (null when a marker or dye is missing).
export function assignmentFrom(p, byMarker) {
  const out = new Int32Array(p.M);
  for (let b = 0; b < p.M; b += 1) {
    const i = p.names.indexOf(byMarker[p.markers[b].name]);
    if (i < 0) return null;
    out[b] = i;
  }
  return new Set(out).size === p.M ? out : null;
}

// The predicted spreading of an assignment's dyes: { names, photon (SS² per unit signal, F × F),
// laser (per unit squared) }, to state SS = √(photon + ΔF · laser) at any brightness, as the run's
// controls give it.
export function spreadOfSet(p, dyeOf) {
  const set = setOf(dyeOf);
  const t = setTerms(p, set);
  if (!t) return null;
  return { names: set.map((i) => p.names[i]), photon: Array.from(t.photon, (v) => +v.toPrecision(6)), laser: Array.from(t.laser, (v) => +v.toPrecision(6)) };
}

// The whole design: the problem made, searched and explained. input: as panelProblem; options:
// as searchPanel, plus compare ({ marker: dye } assignments to compare: { name: assignment }).
// Returns { assignments (explainAssignment rows with alternatives), cost, method, evaluations,
// energyTransfer, compared: [{ name, cost, rows }], rule (the dimmest-to-brightest assignment's
// cost), spread, warnings, settings }.
export function designPanel(input, options = {}) {
  const p = panelProblem(input);
  const found = searchPanel(p, options);
  const rows = explainAssignment(p, found.assignment);
  const alternatives = alternativesFor(p, found.assignment, found.cost);
  rows.forEach((row, b) => { row.alternatives = alternatives[b].alternatives; });
  const pairs = [];
  for (const g of p.groups) for (const a of g.members) for (const b of g.members) if (a < b) pairs.push([p.names[found.assignment[a]], p.names[found.assignment[b]]]);
  const transfer = energyTransferPairs(pairs).map((e) => ({ ...e, markers: [p.markers[found.assignment.indexOf(p.names.indexOf(e.a))]?.name, p.markers[found.assignment.indexOf(p.names.indexOf(e.b))]?.name] }));
  const compared = Object.entries(options.compare ?? {}).map(([name, byMarker]) => {
    const a = assignmentFrom(p, byMarker);
    if (!a) return { name, cost: null, rows: null, note: 'not every marker has one of the candidate dyes' };
    const cost = assignmentCost(p, a);
    return { name, cost, rows: Number.isFinite(cost) ? explainAssignment(p, a) : null };
  });
  const rule = ruleStart(p);
  const warnings = [];
  if (p.assumedBrightness.length) warnings.push(`No brightness is known for ${p.assumedBrightness.join(', ')}: the median of the other dyes is used.`);
  if (p.backgroundSource === 'assumed') warnings.push(`No unstained control gives the background: every detector is assumed to have an SD of ${DEFAULT_BACKGROUND_SD * p.signalScale} (electronic noise and autofluorescence of lymphocytes). Dim markers' stain indices depend on it.`);
  const sameLevel = p.markers.every((m) => m.value === p.markers[0].value && m.weight === p.markers[0].weight);
  if (p.M > 1 && sameLevel && p.groups.length <= 1) warnings.push('Every marker has the same expression and is on the same cells, so any order of the same dyes is as good as another: give each marker its expression, and groups of the markers found together, for the assignment to matter.');
  const ungrouped = p.markers.filter((_, b) => !p.groupsOf[b].length).map((m) => m.name);
  if (ungrouped.length && p.groups.length) warnings.push(`${ungrouped.join(', ')} ${ungrouped.length === 1 ? 'is' : 'are'} in no co-expression group: only the background limits ${ungrouped.length === 1 ? 'it' : 'them'}.`);
  return {
    assignments: rows,
    cost: found.cost,
    method: found.method,
    evaluations: found.evaluations,
    assignmentsTried: found.assignments ?? null,
    energyTransfer: transfer,
    compared,
    rule: rule ? { cost: assignmentCost(p, rule), byMarker: Object.fromEntries(Array.from(rule, (i, b) => [p.markers[b].name, p.names[i]])) } : null,
    spread: spreadOfSet(p, found.assignment),
    warnings,
    settings: {
      signalScale: p.signalScale,
      background: p.backgroundSource,
      seed: options.seed ?? 1,
      square: p.square,
      dyes: p.names.length,
      markers: p.M,
      groups: p.groups.map((g) => ({ name: g.name, markers: g.members.map((b) => p.markers[b].name) })),
    },
  };
}

// The background covariance of detectors from an unstained control's events (columns over the
// detectors), without the outliers (debris, doublets) that would set it: events whose squared
// distance from the median, each detector scaled by its MAD, is beyond what a normal background
// reaches (6 SD of a χ² with D degrees of freedom above its median) are left out.
export function backgroundCovariance(columns, options = {}) {
  const D = columns.length;
  const n = columns[0]?.length ?? 0;
  if (n < 50) throw new Error('The unstained control has too few events.');
  const step = Math.max(1, Math.floor(n / (options.maxEvents ?? 20000)));
  const idx = [];
  for (let e = 0; e < n; e += step) idx.push(e);
  const med = columns.map((c) => {
    const v = Float64Array.from(idx, (e) => c[e]).sort();
    return v[Math.floor(v.length / 2)];
  });
  const scale = columns.map((c, d) => {
    const v = Float64Array.from(idx, (e) => Math.abs(c[e] - med[d])).sort();
    return Math.max(v[Math.floor(v.length / 2)] * 1.4826, 1e-9);
  });
  const dist = Float64Array.from(idx, (e) => {
    let s = 0;
    for (let d = 0; d < D; d += 1) s += ((columns[d][e] - med[d]) / scale[d]) ** 2;
    return s;
  });
  const middle = Float64Array.from(dist).sort()[Math.floor(dist.length / 2)];
  const cutoff = (middle * (D + 6 * Math.sqrt(2 * D))) / Math.max(D - 2 / 3, 0.5);
  const kept = idx.filter((_, k) => dist[k] <= cutoff);
  const mean = columns.map((c) => kept.reduce((a, e) => a + c[e], 0) / kept.length);
  const cov = new Float64Array(D * D);
  for (const e of kept) {
    for (let a = 0; a < D; a += 1) {
      const x = columns[a][e] - mean[a];
      for (let b = 0; b <= a; b += 1) cov[a * D + b] += x * (columns[b][e] - mean[b]);
    }
  }
  for (let a = 0; a < D; a += 1) {
    for (let b = 0; b <= a; b += 1) {
      cov[a * D + b] /= kept.length - 1;
      cov[b * D + a] = cov[a * D + b];
    }
  }
  return { covariance: cov, events: kept.length, source: 'unstained' };
}

// The predicted spread of a design against a run's spreading matrix (spectralSpreading or
// spilloverSpreading: { names, observations: [{ i, deltaF, rows: [{ j, variance, se }] }] }):
// the entries measured to 4 SE, SS predicted at each control's brightness. Returns { rows:
// [{ from, to, observed, predicted }], measurable, medianRatio, within2x, correlation, shared }.
export function compareWithRun(spread, observed) {
  const index = new Map(spread.names.map((n, k) => [n.toLowerCase(), k]));
  const F = spread.names.length;
  const rows = [];
  for (const o of observed.observations ?? []) {
    const i = index.get(String(observed.names[o.i]).toLowerCase());
    if (i === undefined || !(o.deltaF > 0)) continue;
    for (const r of o.rows) {
      const j = index.get(String(observed.names[r.j]).toLowerCase());
      if (j === undefined || i === j || !(r.variance > 4 * r.se)) continue;
      const predicted = Math.sqrt(Math.max(spread.photon[i * F + j] + o.deltaF * spread.laser[i * F + j], 0));
      rows.push({ from: spread.names[i], to: spread.names[j], observed: Math.sqrt(r.variance / o.deltaF), predicted });
    }
  }
  const shared = observed.names.filter((n) => index.has(String(n).toLowerCase())).length;
  return { rows, measurable: rows.length, shared, ...(rows.length ? agreement(rows) : { medianRatio: Number.NaN, within2x: Number.NaN, correlation: Number.NaN }) };
}
