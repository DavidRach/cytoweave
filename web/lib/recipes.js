// Recipe gates: gates a template describes by how to place them on the data rather than by a fixed
// outline, so that a published strategy (strategies.js) applies to anyone's experiment. Each recipe
// is placed on one sample's parent population, in the channels' own scales, and returns a gate
// geometry with an explanation; the gate is then shared by every sample like any other (adapt it
// to each sample where the data shift).
//
// Recipes:
//   singlets               area against height of forward scatter (autogate.suggestSinglets)
//   scatter                the lymphocyte or monocyte density peak on forward against side scatter
//                          (peaks against the left edge of forward scatter, debris, left out)
//   split                  one marker, '+' (positiveThreshold: above the negative population as
//                          all events show it) or '-' (sideThreshold: below the valley under the
//                          parent's brightest mode)
//   quadrant               two markers, each '+' or '-' ('+-': first positive, second negative),
//                          on one divider per axis shared by the four populations; edge: [false,
//                          true] cuts the second axis at the upper edge of its negative
//                          population among the first axis's positive cells
//   level                  two markers, each 'high' (as positive) or 'low' (below the valley under
//                          the brightest mode, or the median of a single mode), the 'high' axis
//                          judged among the cells on the 'low' side; for populations defined by
//                          brightness such as Tregs

import { bin1d, blur1d, bin2d, blur2d } from './density.js';
import { densityGateAt, suggestSinglets } from './autogate.js';
import { createTransform } from './transforms.js';
import { sortedValues, quantileSorted } from './stats.js';
import { channelTransform, population } from './engine.js';
import { ROOT } from './workspace.js';

const SIZE = 96;

// The major density peaks of a 2-D distribution: [{ u, v, height }] in axis fractions, highest
// first, those above `floor` of the highest.
export function densityPeaks(xs, ys, indices, floor = 0.05) {
  const counts = bin2d(xs, ys, indices, SIZE, SIZE, { pile: false });
  const smooth = blur2d(counts, SIZE, SIZE, 2.5);
  let max = 0;
  for (const v of smooth) if (v > max) max = v;
  const peaks = [];
  for (let y = 1; y < SIZE - 1; y += 1) {
    for (let x = 1; x < SIZE - 1; x += 1) {
      const here = smooth[y * SIZE + x];
      if (here < max * floor) continue;
      let top = true;
      for (let dy = -1; dy <= 1 && top; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if ((dx || dy) && smooth[(y + dy) * SIZE + x + dx] > here) { top = false; break; }
      if (top) peaks.push({ u: (x + 0.5) / SIZE, v: (y + 0.5) / SIZE, height: here / max });
    }
  }
  return peaks.sort((a, b) => b.height - a.height);
}

// The modes of a marker's distribution in scale space, dimmest first, and the smoothed histogram.
// floor: the smallest mode kept, as a fraction of the highest.
function modesOf(values, indices, floor = 0.03) {
  const bins = 256;
  // Smoothed by Silverman's rule (at least 3 bins), so that the few cells in a small population's
  // tails do not make modes of their own.
  const sorted = sortedValues(values, indices);
  const n = sorted.length;
  let mean = 0;
  for (const v of sorted) mean += v;
  mean /= n || 1;
  let sq = 0;
  for (const v of sorted) sq += (v - mean) ** 2;
  const spread = Math.min(Math.sqrt(sq / (n || 1)), (quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25)) / 1.34);
  const sigma = Math.max(3, 0.9 * spread * n ** -0.2 * bins);
  const smooth = blur1d(bin1d(values, indices, bins, { pile: false }), sigma);
  let max = 0;
  for (const v of smooth) if (v > max) max = v;
  const modes = [];
  for (let i = 1; i < bins - 1; i += 1) {
    if (!(smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1] && smooth[i] > max * floor)) continue;
    // Two maxima are separate modes only with a real valley between them (below 80% of the
    // lower); otherwise they are noise on one population, and the higher stands for it.
    const last = modes.at(-1);
    if (last !== undefined && smooth[valleyBetween(smooth, last, i)] > 0.8 * Math.min(smooth[last], smooth[i])) {
      if (smooth[i] > smooth[last]) modes[modes.length - 1] = i;
      continue;
    }
    modes.push(i);
  }
  return { modes, smooth, bins };
}

// Where positive begins on a marker, judged on all events (as an FMO would show the negative
// population): the valley just above the dimmest main mode. Positive selections use it, so that a
// parent whose populations are all positive (monocytes and dendritic cells on HLA-DR) is not cut
// between them. When all events show one mode (every cell positive, as on CD45), the parent's own
// distribution decides (sideThreshold).
export function positiveThreshold(all, indices) {
  const { modes, smooth, bins } = modesOf(all, null, 0.1);
  if (modes.length >= 2) return { threshold: (valleyBetween(smooth, modes[0], modes[1]) + 0.5) / bins, how: 'the valley above the negative population (on all events)' };
  return sideThreshold(all, indices, '+');
}

// The divider between the two tallest modes (shared by a quadrant's four populations).
function dividerOf(smooth, modes, bins) {
  const [a, b] = [...modes].sort((x, y) => smooth[y] - smooth[x]).slice(0, 2).sort((x, y) => x - y);
  return { threshold: (valleyBetween(smooth, a, b) + 0.5) / bins, how: 'the valley between its two main modes' };
}

// The upper edge of the dimmest population on a marker: its mode plus two SDs, the SD taken from
// its dim side only, so that a shoulder of brighter cells (intermediate monocytes on CD16 above the
// classical ones) does not widen it.
export function negativeEdge(values, indices) {
  const { modes, bins } = modesOf(values, indices);
  if (!modes.length) return null;
  const mode = (modes[0] + 0.5) / bins;
  let sum = 0;
  let n = 0;
  const each = (e) => { const v = values[e]; if (v <= mode) { sum += (v - mode) ** 2; n += 1; } };
  if (indices) for (const e of indices) each(e);
  else for (let e = 0; e < values.length; e += 1) each(e);
  if (n < 10) return null;
  return { threshold: mode + 2 * Math.sqrt(sum / n), how: 'the upper edge of its negative population (mode plus two SDs from its dim side)' };
}

// A quadrant's divider on one axis: the valley between the two main modes; with one mode, as for
// a positive or negative selection of it.
export function quadrantDivider(values, indices, side) {
  const { modes, smooth, bins } = modesOf(values, indices);
  return modes.length >= 2 ? dividerOf(smooth, modes, bins) : sideThreshold(values, indices, side);
}

function valleyBetween(smooth, a, b) {
  let valley = a;
  for (let i = a; i <= b; i += 1) if (smooth[i] < smooth[valley]) valley = i;
  return valley;
}

// The threshold for selecting one side of a marker: for positive cells, the valley between its
// two main modes; for negative cells, the valley just below the brightest mode (everything but the
// positive population, so that dim autofluorescent cells, such as monocytes on a viability dye,
// stay). With one mode, that mode is the population asked for, and the
// threshold cuts its far tail three robust SDs from its median. Returns { threshold, how }.
export function sideThreshold(values, indices, side) {
  const { modes, smooth, bins } = modesOf(values, indices);
  if (modes.length >= 2) {
    if (side === '-' || side === 'low') {
      const [a, b] = modes.slice(-2);
      return { threshold: (valleyBetween(smooth, a, b) + 0.5) / bins, how: 'the valley below its brightest mode' };
    }
    return dividerOf(smooth, modes, bins);
  }
  // One mode: it is the population asked for; the threshold cuts its far tail.
  const sorted = sortedValues(values, indices);
  const median = quantileSorted(sorted, 0.5);
  const rsd = (quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25)) / 1.349;
  return side === '+' || side === 'high'
    ? { threshold: median - 3 * rsd, how: 'three robust SDs below its median (one mode, taken as positive)' }
    : { threshold: median + 3 * rsd, how: 'three robust SDs above its median (one mode, taken as negative)' };
}

// A threshold for brightness levels: 'high' as a positive side; 'low' below the median of a
// single mode, or below the valley under the brightest mode.
function levelThreshold(values, indices, side) {
  if (side === 'high') return sideThreshold(values, indices, '+');
  const { modes } = modesOf(values, indices);
  if (modes.length >= 2) return sideThreshold(values, indices, '-');
  const sorted = sortedValues(values, indices);
  return { threshold: quantileSorted(sorted, 0.5), how: 'its median (one mode)' };
}

// Places a recipe. context: { view, parent (event indices or null for all), dims: [{ channel,
// transform }], marker(channel) → name }. Returns { type, geometry, explanation } or { error }.
export function placeRecipe(recipe, context) {
  const { view, parent, dims } = context;
  const name = (i) => context.marker?.(dims[i].channel) ?? dims[i].channel;
  const scaled = (i) => view.scaled(dims[i].channel, dims[i].transform);
  switch (recipe.method) {
    case 'singlets': {
      const proposal = suggestSinglets(view.column(dims[0].channel), view.column(dims[1].channel), parent, createTransform(dims[0].transform), createTransform(dims[1].transform));
      return proposal ?? { error: 'too few events for a singlet gate' };
    }
    case 'scatter': {
      const xs = scaled(0);
      const ys = scaled(1);
      // Peaks against the left edge of forward scatter are debris.
      const peaks = densityPeaks(xs, ys, parent, 0.03).filter((p) => p.v < 0.9 && p.u >= 0.08);
      if (!peaks.length) return { error: 'no density peak on forward against side scatter' };
      // Lymphocytes: the lowest side-scatter peak. Monocytes: the highest peak above and to the right
      // of it, below the granulocytes' side scatter.
      const lymph = [...peaks].sort((a, b) => a.v - b.v)[0];
      let target = lymph;
      if (recipe.target === 'monocytes') {
        target = peaks.filter((p) => p !== lymph && p.u > lymph.u && p.v > lymph.v && p.v < 0.35).sort((a, b) => b.height - a.height)[0];
        if (!target) return { error: 'no monocyte peak (with higher forward and side scatter than the lymphocytes)' };
      }
      const proposal = densityGateAt(xs, ys, parent, target.u, target.v, { level: recipe.level ?? 0.12, size: 128, sigma: 2.5 });
      if (!proposal) return { error: `no ${recipe.target} region` };
      return { ...proposal, explanation: `The ${recipe.target === 'monocytes' ? 'monocyte' : 'lymphocyte'} density peak on ${name(0)} against ${name(1)} (at ${target.u.toFixed(2)}, ${target.v.toFixed(2)} of the axes), down to ${Math.round(100 * (recipe.level ?? 0.12))}% of its height.` };
    }
    case 'split': {
      const positive = recipe.keep === '+';
      const { threshold: t, how } = positive ? positiveThreshold(scaled(0), parent) : sideThreshold(scaled(0), parent, recipe.keep);
      return { type: 'range', geometry: { min: positive ? t : null, max: positive ? null : t }, explanation: `${name(0)}${positive ? '+' : '−'}: ${positive ? 'above' : 'below'} ${how}.` };
    }
    case 'quadrant':
    case 'level': {
      const sides = recipe.method === 'quadrant' ? [...recipe.keep] : recipe.keep;
      const min = [null, null];
      const max = [null, null];
      const parts = [];
      const values = [scaled(0), scaled(1)];
      // A level recipe places its 'low' axes first and judges a 'high' axis among the cells below
      // them, as an analyst reads CD25 among CD127-low cells, where regulatory T cells are a
      // population of their own rather than a shoulder on the rest.
      const order = recipe.method === 'level' ? [0, 1].sort((a, b) => (sides[a] === 'high') - (sides[b] === 'high')) : [0, 1];
      let within = parent;
      for (const i of order) {
        const side = sides[i];
        const up = side === '+' || side === 'high';
        let threshold;
        let how;
        if (recipe.method === 'quadrant' && recipe.edge?.[i]) {
          // edge: this axis is cut at the upper edge of its negative population among the cells on
          // the other axis's positive side (CD16 among CD14+ monocytes).
          const other = 1 - i;
          const t = quadrantDivider(values[other], parent, '+').threshold;
          const pool = (parent ?? Array.from({ length: values[other].length }, (_, k) => k)).filter((e) => values[other][e] >= t);
          ({ threshold, how } = negativeEdge(values[i], pool) ?? quadrantDivider(values[i], parent, side));
          if (how.startsWith('the upper edge')) how += ` among the ${name(other)}+ cells`;
        } else if (recipe.method === 'quadrant') ({ threshold, how } = quadrantDivider(values[i], parent, side));
        else ({ threshold, how } = levelThreshold(values[i], within, side));
        if (up) min[i] = threshold;
        else max[i] = threshold;
        if (recipe.method === 'level' && !up) {
          const pool = within ?? Array.from({ length: values[i].length }, (_, k) => k);
          within = pool.filter((e) => values[i][e] < threshold);
        } else if (recipe.method === 'level' && order.indexOf(i) > 0) how += `, among the cells ${name(order[0])} ${sides[order[0]]}`;
        parts[i] = `${name(i)} ${side === '+' ? '+' : side === '-' ? '−' : side} (${up ? 'above' : 'below'} ${how})`;
      }
      return { type: 'rectangle', geometry: { min, max }, explanation: parts.join(', ') };
    }
    default:
      return { error: `unknown recipe ${recipe.method}` };
  }
}

// The place option of applyTemplate (templates.js) for recipe gates: each is placed on this
// sample's events in its parent population, on the channels' current scales.
export function placeOnSample(view, sampleName) {
  return (record, recipe, working) => {
    const parent = population(view, working, record.parentId ?? ROOT);
    if (parent === undefined) return { error: 'its parent does not apply to the sample' };
    const dims = record.dims.map((d) => ({ channel: d.channel, transform: { ...channelTransform(working, view, d.channel) } }));
    const placed = placeRecipe(recipe, { view, parent, dims, marker: (channel) => view.channelInfo?.(channel)?.marker || channel });
    return placed.error ? placed : { ...placed, dims, sampleName };
  };
}
