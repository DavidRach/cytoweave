// Data-driven gate proposals. Each returns a geometry in the plot's scale space plus an
// explanation, so the user can accept, adjust or reject it; nothing is applied silently.

import { bin2d, blur2d, bin1d, blur1d } from './density.js';
import { convexHull, simplifyPolyline } from './gates.js';
import { sortedValues, quantileSorted } from './stats.js';

// Magic wand: the density basin around (u, v). Climbs from the clicked cell to its density peak,
// grows the region of cells above `level` × peak that are connected to it without climbing over a
// saddle into another peak, and returns the region's outline as a polygon.
export function densityGateAt(xs, ys, indices, u, v, options = {}) {
  const size = options.size ?? 128;
  const counts = bin2d(xs, ys, indices, size, size, { pile: false });
  const smooth = blur2d(counts, size, size, options.sigma ?? 2.2);
  let cx = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
  let cy = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
  // Hill-climb to the local maximum.
  for (let step = 0; step < size * 2; step += 1) {
    let best = smooth[cy * size + cx];
    let bx = cx; let by = cy;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = cx + dx; const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const value = smooth[y * size + x];
        if (value > best) { best = value; bx = x; by = y; }
      }
    }
    if (bx === cx && by === cy) break;
    cx = bx; cy = by;
  }
  const peak = smooth[cy * size + cx];
  if (!(peak > 0)) return null;
  const level = (options.level ?? 0.08) * peak;
  // Region growing in decreasing density order (watershed-like): a cell joins only from a
  // neighbor that is at least as dense, so the region stops at saddles.
  const inside = new Uint8Array(size * size);
  const queue = [cy * size + cx];
  inside[queue[0]] = 1;
  while (queue.length) {
    const index = queue.pop();
    const x = index % size;
    const y = (index - x) / size;
    const here = smooth[index];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const ni = ny * size + nx;
        if (inside[ni]) continue;
        const value = smooth[ni];
        if (value < level || value > here * 1.02) continue;
        inside[ni] = 1;
        queue.push(ni);
      }
    }
  }
  const outline = traceRegion(inside, size);
  if (outline.length < 3) return null;
  const vertices = simplifyPolyline(outline.map(([x, y]) => [x / size, y / size]), options.tolerance ?? 0.006);
  let enclosed = 0;
  let total = 0;
  for (let i = 0; i < counts.length; i += 1) {
    total += counts[i];
    if (inside[i]) enclosed += counts[i];
  }
  return {
    type: 'polygon',
    geometry: { vertices },
    explanation: `The density basin around the clicked point (${((100 * enclosed) / (total || 1)).toFixed(1)}% of the plotted events), bounded at ${Math.round((options.level ?? 0.08) * 100)}% of its peak density or at the valley next to another population.`,
  };
}

// The outer boundary of a binary region on a grid, as an ordered ring of corner points
// (Moore-neighbor tracing on cell corners via the region's convex-ish hull of edge cells).
function traceRegion(mask, size) {
  // Collect boundary edges of the region and chain them into the longest ring.
  const edges = new Map();
  const key = (x, y) => y * (size + 1) + x;
  const addEdge = (x0, y0, x1, y1) => {
    edges.set(key(x0, y0), [x1, y1]);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!mask[y * size + x]) continue;
      // Counter-clockwise edges around the cell where the neighbor is outside.
      if (y === 0 || !mask[(y - 1) * size + x]) addEdge(x, y, x + 1, y);
      if (x === size - 1 || !mask[y * size + x + 1]) addEdge(x + 1, y, x + 1, y + 1);
      if (y === size - 1 || !mask[(y + 1) * size + x]) addEdge(x + 1, y + 1, x, y + 1);
      if (x === 0 || !mask[y * size + x - 1]) addEdge(x, y + 1, x, y);
    }
  }
  let best = [];
  const visited = new Set();
  for (const [start] of edges) {
    if (visited.has(start)) continue;
    const ring = [];
    let current = start;
    for (let guard = 0; guard < edges.size + 2; guard += 1) {
      if (visited.has(current)) break;
      visited.add(current);
      const x = current % (size + 1);
      const y = (current - x) / (size + 1);
      ring.push([x, y]);
      const next = edges.get(current);
      if (!next) break;
      current = key(next[0], next[1]);
    }
    if (ring.length > best.length) best = ring;
  }
  return best;
}

// Singlets on an area-versus-height plot: events whose A/H ratio lies within `k` robust SDs of
// the main ratio, as a polygon band from the 1st to the 99.5th percentile of area.
export function suggestSinglets(area, height, indices, xTransform, yTransform, options = {}) {
  const n = indices ? indices.length : area.length;
  const ratios = new Float64Array(n);
  let m = 0;
  for (let k = 0; k < n; k += 1) {
    const e = indices ? indices[k] : k;
    if (area[e] > 0 && height[e] > 0) ratios[m++] = area[e] / height[e];
  }
  const sorted = ratios.slice(0, m).sort();
  if (m < 50) return null;
  const median = quantileSorted(sorted, 0.5);
  const rsd = (quantileSorted(sorted, 0.8413) - quantileSorted(sorted, 0.1587)) / 2;
  const k = options.k ?? 2.5;
  const lo = Math.max(median - k * rsd, median * 0.7);
  const hi = median + k * rsd;
  const areas = sortedValues(area, indices);
  const a0 = Math.max(quantileSorted(areas, 0.005), 1);
  const a1 = quantileSorted(areas, 0.998) * 1.05;
  const point = (a, ratio) => [xTransform.forward(a), yTransform.forward(a / ratio)];
  const vertices = [point(a0, hi), point(a1, hi), point(a1, lo), point(a0, lo)];
  return {
    type: 'polygon',
    geometry: { vertices },
    explanation: `Events whose area-to-height ratio is within ${k} robust SDs of the median (${median.toFixed(3)}); doublets have a larger ratio.`,
  };
}

// The valley between the two main modes of a 1-D distribution in scale space (e.g. live/dead,
// marker −/+), for a split or range gate.
export function valleyThreshold(values, indices, options = {}) {
  const bins = options.bins ?? 256;
  const counts = bin1d(values, indices, bins, { pile: false });
  const smooth = blur1d(counts, options.sigma ?? 3);
  const peaks = [];
  for (let i = 1; i < bins - 1; i += 1) {
    if (smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1]) peaks.push(i);
  }
  const max = Math.max(...smooth);
  const major = peaks.filter((i) => smooth[i] > max * (options.minPeak ?? 0.03)).sort((a, b) => smooth[b] - smooth[a]).slice(0, 2).sort((a, b) => a - b);
  if (major.length < 2) {
    // Unimodal: Otsu's threshold on the histogram.
    return { threshold: otsu(counts) / bins, explanation: 'One mode only; the threshold is Otsu\'s split of the histogram.', modes: major.map((i) => (i + 0.5) / bins) };
  }
  let valley = major[0];
  for (let i = major[0]; i <= major[1]; i += 1) if (smooth[i] < smooth[valley]) valley = i;
  return {
    threshold: (valley + 0.5) / bins,
    explanation: `The density minimum between the two main modes (at ${((major[0] + 0.5) / bins).toFixed(2)} and ${((major[1] + 0.5) / bins).toFixed(2)} of the axis).`,
    modes: major.map((i) => (i + 0.5) / bins),
  };
}

export function otsu(counts) {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < counts.length; i += 1) {
    total += counts[i];
    sum += i * counts[i];
  }
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let threshold = 0;
  for (let i = 0; i < counts.length; i += 1) {
    weightB += counts[i];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += i * counts[i];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > best) {
      best = between;
      threshold = i + 1;
    }
  }
  return threshold;
}

// Cells versus debris on FSC/SSC: the convex hull of the densest basin above a debris cutoff.
export function suggestCells(xs, ys, indices, options = {}) {
  const proposal = densityGateAt(xs, ys, indices, options.u ?? 0.45, options.v ?? 0.3, { level: options.level ?? 0.04, size: 96, sigma: 2.5 });
  if (!proposal) return null;
  const hull = convexHull(proposal.geometry.vertices);
  return { type: 'polygon', geometry: { vertices: hull }, explanation: `The main population on scatter, excluding low-scatter debris. ${proposal.explanation}` };
}
