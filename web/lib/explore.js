// Building blocks of the Explore view (high-dimensional analysis): which markers to use, how many
// events to take from each sample, the analysis matrix, assignment of events that were not
// clustered, and rasters of an embedding colored by density, category or marker.

import { createRandom, sampleIndices } from './random.js';
import { colormapLUT, hexToRgb } from './colormaps.js';
import { blur2d } from './density.js';

// Channels that describe cells but should not drive clustering by default: viability and dump
// dyes, DNA intercalators, barcodes, beads, autofluorescence and residuals.
const EXCLUDE = /(viab|live|dead|zombie|7-?aad|\bdapi\b|\bpi\b|sytox|l\/d|dump|dna|iridium|ir19[13]|cisplatin|pt19[4-8]|barcode|bead|ce140|eu15[13]|ho165|lu175|\baf\b|residual|time)/i;

// Candidate markers of a sample: fluorescence channels (or unmixed abundances, when present)
// with { name, label, selected }.
export function markerCandidates(view) {
  const unmixed = [...view.derived.keys()].filter((name) => name.endsWith('(unmixed)') && !/^(AF|AF signature|Residual) /.test(name));
  if (unmixed.length) return unmixed.map((name) => ({ name, label: name.replace(' (unmixed)', ''), selected: true }));
  return view.parameters
    .filter((p) => p.type === 'fluorescence')
    .map((p) => ({ name: p.name, label: p.marker ? `${p.marker} (${p.name})` : p.name, marker: p.marker, selected: Boolean(p.marker) && !EXCLUDE.test(`${p.marker} ${p.name}`) }))
    .map((c, _, all) => (all.some((x) => x.marker) ? c : { ...c, selected: !EXCLUDE.test(c.name) }));
}

// Events to take from each sample: `perSample` each, capped so the total stays within `maxTotal`;
// samples with fewer events give what they have.
export function samplingPlan(counts, perSample = 5000, maxTotal = 100000) {
  const n = counts.length;
  if (!n) return [];
  let quota = Math.min(perSample, Math.floor(maxTotal / n));
  const plan = counts.map((c) => Math.min(c, quota));
  // Unused quota of small samples goes to the others, up to perSample.
  let spare = Math.min(maxTotal, perSample * n) - plan.reduce((a, b) => a + b, 0);
  while (spare > 0) {
    const open = plan.map((p, i) => (p < Math.min(counts[i], perSample) ? i : -1)).filter((i) => i >= 0);
    if (!open.length) break;
    const extra = Math.max(1, Math.floor(spare / open.length));
    for (const i of open) {
      const add = Math.min(extra, Math.min(counts[i], perSample) - plan[i], spare);
      plan[i] += add;
      spare -= add;
      if (spare <= 0) break;
    }
    quota += extra;
  }
  return plan;
}

// Picks `take` events of a population (sorted indices, or null for all `eventCount` events).
export function pickEvents(indices, eventCount, take, seed) {
  const total = indices ? indices.length : eventCount;
  return sampleIndices(total, Math.min(take, total), createRandom(seed), indices);
}

// Row-major analysis matrix (events × markers) from scaled columns at the given event indices.
export function gatherMatrix(columns, events, out = null, offset = 0) {
  const dim = columns.length;
  const matrix = out ?? new Float32Array(events.length * dim);
  for (let r = 0; r < events.length; r += 1) {
    const e = events[r];
    const base = (offset + r) * dim;
    for (let c = 0; c < dim; c += 1) {
      const v = columns[c][e];
      matrix[base + c] = Number.isFinite(v) ? v : 0;
    }
  }
  return matrix;
}

// Cluster centroids (means) of a labeled matrix; labels < 0 are ignored.
export function centroids(matrix, n, dim, labels, k) {
  const sums = new Float64Array(k * dim);
  const counts = new Float64Array(k);
  for (let i = 0; i < n; i += 1) {
    const c = labels[i];
    if (c < 0 || c >= k) continue;
    counts[c] += 1;
    for (let d = 0; d < dim; d += 1) sums[c * dim + d] += matrix[i * dim + d];
  }
  for (let c = 0; c < k; c += 1) if (counts[c]) for (let d = 0; d < dim; d += 1) sums[c * dim + d] /= counts[c];
  return Float32Array.from(sums);
}

// Nearest centroid of every row of `matrix` (squared Euclidean distance).
export function assignNearest(matrix, n, dim, centers, k) {
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    let best = 0;
    let bestDistance = Infinity;
    for (let c = 0; c < k; c += 1) {
      let s = 0;
      for (let d = 0; d < dim; d += 1) {
        const diff = matrix[i * dim + d] - centers[c * dim + d];
        s += diff * diff;
      }
      if (s < bestDistance) {
        bestDistance = s;
        best = c;
      }
    }
    labels[i] = best;
  }
  return labels;
}

// The range of each embedding axis padded by 4%, for a linear display transform.
export function embeddingRanges(embedding, n) {
  const ranges = [[Infinity, -Infinity], [Infinity, -Infinity]];
  for (let i = 0; i < n; i += 1) {
    for (let a = 0; a < 2; a += 1) {
      const v = embedding[i * 2 + a];
      if (v < ranges[a][0]) ranges[a][0] = v;
      if (v > ranges[a][1]) ranges[a][1] = v;
    }
  }
  return ranges.map(([lo, hi]) => {
    const pad = (hi - lo) * 0.04 || 1;
    return [lo - pad, hi + pad];
  });
}

// An RGBA raster (row 0 at the top) of embedded points.
//   coloring: { kind: 'density', colormap } | { kind: 'category', labels, colors, order? }
//           | { kind: 'value', values, lo, hi, colormap }
//   dim:      Float32Array (0–1) of per-point dimming (e.g. 1 − reliability); null for none.
export function embeddingRaster(embedding, n, ranges, width, height, coloring, options = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const [[x0, x1], [y0, y1]] = ranges;
  const sx = width / (x1 - x0);
  const sy = height / (y1 - y0);
  const pixel = (i) => {
    const px = Math.floor((embedding[i * 2] - x0) * sx);
    const py = Math.floor((embedding[i * 2 + 1] - y0) * sy);
    if (!(px >= 0 && px < width && py >= 0 && py < height)) return -1;
    return (height - 1 - py) * width + px;
  };
  const size = Math.max(1, options.dotSize ?? 1);
  const paint = (p, r, g, b, a) => {
    const cx = p % width;
    const cy = (p - cx) / width;
    for (let dy = 0; dy < size; dy += 1) {
      for (let dx = 0; dx < size; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= width || y >= height) continue;
        const o = (y * width + x) * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
      }
    }
  };
  const alphaOf = (i) => (options.dim ? Math.round(255 * (1 - 0.8 * options.dim[i])) : 255);
  if (coloring.kind === 'density') {
    const counts = new Float32Array(width * height);
    const where = new Int32Array(n);
    for (let i = 0; i < n; i += 1) {
      where[i] = pixel(i);
      if (where[i] >= 0) counts[where[i]] += 1;
    }
    const smooth = blur2d(counts, width, height, options.sigma ?? Math.max(1.2, width / 180));
    let max = 0;
    for (let p = 0; p < smooth.length; p += 1) if (smooth[p] > max) max = smooth[p];
    const lut = colormapLUT(coloring.colormap ?? 'classic');
    const scale = max > 0 ? 1 / Math.log1p(max) : 0;
    for (let i = 0; i < n; i += 1) {
      const p = where[i];
      if (p < 0) continue;
      const t = 0.12 + 0.88 * Math.min(1, Math.log1p(smooth[p]) * scale);
      const k = Math.round(t * 255) * 3;
      paint(p, lut[k], lut[k + 1], lut[k + 2], alphaOf(i));
    }
    return rgba;
  }
  // Category and value colorings: draw in an order that does not favor one group (seeded
  // shuffle for categories, ascending value so bright events stay visible).
  const order = Uint32Array.from({ length: n }, (_, i) => i);
  if (coloring.kind === 'value') {
    const values = coloring.values;
    order.sort((a, b) => values[a] - values[b]);
  } else {
    const random = createRandom(options.seed ?? 7);
    for (let i = n - 1; i > 0; i -= 1) {
      const j = random.int(i + 1);
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
  }
  const lut = coloring.kind === 'value' ? colormapLUT(coloring.colormap ?? 'viridis') : null;
  const palette = coloring.kind === 'category' ? coloring.colors.map((c) => hexToRgb(c)) : null;
  const span = coloring.kind === 'value' ? (coloring.hi - coloring.lo) || 1 : 1;
  for (let r = 0; r < n; r += 1) {
    const i = order[r];
    const p = pixel(i);
    if (p < 0) continue;
    if (coloring.kind === 'category') {
      const label = coloring.labels[i];
      if (label < 0 || coloring.hidden?.has(label)) continue;
      const rgb = palette[label % palette.length];
      const faded = coloring.highlight !== undefined && coloring.highlight !== null && label !== coloring.highlight;
      if (faded) paint(p, 200, 204, 212, 120);
      else paint(p, rgb[0], rgb[1], rgb[2], alphaOf(i));
    } else {
      const t = Math.max(0, Math.min(1, (coloring.values[i] - coloring.lo) / span));
      const k = Math.round(t * 255) * 3;
      paint(p, lut[k], lut[k + 1], lut[k + 2], alphaOf(i));
    }
  }
  // Highlighted category drawn last, on top.
  if (coloring.kind === 'category' && coloring.highlight !== undefined && coloring.highlight !== null) {
    const rgb = palette[coloring.highlight % palette.length];
    for (let i = 0; i < n; i += 1) {
      if (coloring.labels[i] !== coloring.highlight) continue;
      const p = pixel(i);
      if (p >= 0) paint(p, rgb[0], rgb[1], rgb[2], 255);
    }
  }
  return rgba;
}

// Lower and upper 1st/99th percentiles of a value array, for marker color scales.
export function robustRange(values) {
  const sorted = Float32Array.from(values).filter(Number.isFinite).sort();
  if (!sorted.length) return [0, 1];
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const lo = at(0.01);
  const hi = at(0.99);
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

// Short names for clusters from marker enrichment labels ("CD3+8 CD8+6 CD4−4") or annotation.
export function clusterName(index, annotation, memLabel) {
  if (annotation) return annotation;
  if (memLabel) {
    const top = memLabel.split(/\s+/).filter((part) => /\+\d/.test(part)).slice(0, 3).map((part) => part.replace(/\+\d+$/, '+'));
    if (top.length) return `C${index + 1} ${top.join(' ')}`;
  }
  return `Cluster ${index + 1}`;
}
