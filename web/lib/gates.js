// Gate geometry and membership.
//
// A gate's geometry is stored in its own scale space: each dimension names a channel and the
// transform the gate was drawn in (Gating-ML 2.0's model of gates on transformed dimensions).
// Membership is evaluated in that space, so a gate keeps its meaning when a plot's axes change;
// drawn on other axes, its edges are mapped point by point (and may curve).
//
// Gate types and geometry (scale units):
//   rectangle { min: [x, y], max: [x, y] }        either bound may be null (open)
//   range     { min, max }                         one dimension
//   polygon   { vertices: [[x, y], ...] }
//   ellipse   { center: [x, y], radii: [rx, ry], angle }   angle in radians
//   ellipsoid { mean, covariance, distanceSquare }  any number of dimensions (imported)
//   A rectangle may have more than two dimensions (imported); it is then evaluated by membershipN.
//   quadrant  { center: [x, y], quadrant: 'UR'|'UL'|'LL'|'LR' }  four linked gates share linkId
//   split     { threshold, side: 'lo'|'hi' }       two linked gates share linkId
//   category  { values: [...] }                    a derived channel (clusters, QC masks) in values
//   boolean   { op: 'and'|'or'|'not', operands: [gateId, ...] }  evaluated by the engine

import { createTransform } from './transforms.js';
import { SetBuilder, forEachChunk, sizeOf } from './eventset.js';

export const GATE_TYPES = ['rectangle', 'range', 'polygon', 'ellipse', 'ellipsoid', 'quadrant', 'split', 'category', 'boolean'];

export const QUADRANTS = ['UL', 'UR', 'LR', 'LL'];

// Members of `candidates` (a Uint32Array of event indices, or null for all events) that fall in
// the geometry. xs and ys are the dimensions' scaled columns. With `refine` ({ near, exact }),
// events that near(x, y) places within rounding distance of the boundary are decided by
// exact(event) instead: the scaled columns are float32 (and logicle-type scales come from a lookup
// table), so only an exact recomputation agrees with double-precision references at the boundary.
export function membership(type, geometry, xs, ys, candidates, count = xs?.length ?? 0, refine = null) {
  return membershipSet(type, geometry, xs, ys, candidates, count, refine).toIndices();
}

// As membership, as an EventSet (eventset.js); candidates may also be an EventSet.
export function membershipSet(type, geometry, xs, ys, candidates, count = xs?.length ?? 0, refine = null) {
  const test = pointTest(type, geometry);
  const near = refine?.near ?? null;
  const exact = refine?.exact ?? null;
  const oneD = type === 'range' || type === 'split' || type === 'category';
  const builder = new SetBuilder(count);
  const grid = type === 'polygon' && sizeOf(candidates, count) >= GRID_MIN_EVENTS ? polygonGrid(geometry.vertices) : null;
  forEachChunk(candidates, count, (chunk, length) => {
    if (grid) {
      const { cells, side, x0, y0, sx, sy } = grid;
      for (let k = 0; k < length; k += 1) {
        const e = chunk[k];
        const x = xs[e];
        const y = ys[e];
        const cx = Math.floor((x - x0) * sx);
        const cy = Math.floor((y - y0) * sy);
        // Outside the grid (or NaN): outside the polygon and far from it.
        if (!(cx >= 0 && cx < side && cy >= 0 && cy < side)) continue;
        const state = cells[cy * side + cx];
        if (state === CELL_IN) builder.add(e);
        else if (state === CELL_EDGE && (near && near(x, y) ? exact(e) : test(x, y))) builder.add(e);
      }
      return;
    }
    for (let k = 0; k < length; k += 1) {
      const e = chunk[k];
      const x = xs[e];
      const y = oneD ? 0 : ys[e];
      if (near && near(x, y) ? exact(e) : test(x, y)) builder.add(e);
    }
  });
  return builder.finish();
}

// Members for gates of any number of dimensions: rectangles with three or more dimensions and
// ellipsoids. columns are the dimensions' scaled columns; refine as in membership.
export function membershipN(type, geometry, columns, candidates, count = columns[0]?.length ?? 0, refine = null) {
  return membershipNSet(type, geometry, columns, candidates, count, refine).toIndices();
}

export function membershipNSet(type, geometry, columns, candidates, count = columns[0]?.length ?? 0, refine = null) {
  const test = pointTestN(type, geometry);
  const near = refine?.near;
  const d = columns.length;
  const point = new Float64Array(d);
  const builder = new SetBuilder(count);
  forEachChunk(candidates, count, (chunk, length) => {
    for (let k = 0; k < length; k += 1) {
      const e = chunk[k];
      for (let i = 0; i < d; i += 1) point[i] = columns[i][e];
      if (near && near(point) ? refine.exact(e) : test(point)) builder.add(e);
    }
  });
  return builder.finish();
}

// --- Polygon cell grid ----------------------------------------------------------------------
//
// A polygon's point test costs one step per edge. For many events, a grid of cells over the
// polygon's box says for most of them at once: each cell is inside, outside, or near an edge.
// A cell is "near" when its center is within 2t + half its diagonal of an edge, t being the
// boundary tolerance of boundaryTest: no point of any other cell is within t of an edge (so none
// needs the exact test) or across one (so the cell's center decides for all of it). Only events
// in cells near an edge take the full test, as without the grid, so the result is identical.

const GRID_MIN_EVENTS = 20000;
const GRID_SIDE = 256;
const CELL_OUT = 0;
const CELL_IN = 1;
const CELL_EDGE = 2;

function polygonGrid(vertices) {
  const n = vertices.length;
  if (n < 3) return null;
  let scale = 1;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [vx, vy] of vertices) {
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
    scale = Math.max(scale, Math.abs(vx), Math.abs(vy));
    minX = Math.min(minX, vx); maxX = Math.max(maxX, vx);
    minY = Math.min(minY, vy); maxY = Math.max(maxY, vy);
  }
  const t = BOUNDARY_TOLERANCE * scale;
  const pad = 4 * t;
  const x0 = minX - pad;
  const y0 = minY - pad;
  const w = maxX - minX + 2 * pad;
  const hgt = maxY - minY + 2 * pad;
  const side = GRID_SIDE;
  const cw = w / side;
  const ch = hgt / side;
  if (!(cw > 0 && ch > 0 && Number.isFinite(cw) && Number.isFinite(ch))) return null;
  const reach = 2 * t + 0.5 * Math.hypot(cw, ch) * (1 + 1e-9) + 1e-12 * scale;
  const cells = new Uint8Array(side * side);
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const [ax, ay] = vertices[j];
    const [bx, by] = vertices[i];
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / cw));
    const c1 = Math.min(side - 1, Math.floor((Math.max(ax, bx) + reach - x0) / cw));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - y0) / ch));
    const r1 = Math.min(side - 1, Math.floor((Math.max(ay, by) + reach - y0) / ch));
    for (let r = r0; r <= r1; r += 1) {
      const py = y0 + (r + 0.5) * ch;
      for (let c = c0; c <= c1; c += 1) {
        const px = x0 + (c + 0.5) * cw;
        const u = length2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
        if (Math.hypot(px - ax - u * dx, py - ay - u * dy) <= reach) cells[r * side + c] = CELL_EDGE;
      }
    }
  }
  const test = polygonTest(vertices);
  for (let r = 0; r < side; r += 1) {
    const py = y0 + (r + 0.5) * ch;
    for (let c = 0; c < side; c += 1) {
      if (cells[r * side + c] === CELL_EDGE) continue;
      cells[r * side + c] = test(x0 + (c + 0.5) * cw, py) ? CELL_IN : CELL_OUT;
    }
  }
  return { cells, side, x0, y0, sx: 1 / cw, sy: 1 / ch };
}

// A predicate (point) → boolean for N-dimensional geometries:
//   rectangle { min: [...], max: [...] }   half-open [min, max) per dimension; null bounds are open
//   ellipsoid { mean: [...], covariance: [[...]], distanceSquare }   (x − μ)ᵀ Σ⁻¹ (x − μ) ≤ D²
export function pointTestN(type, geometry) {
  switch (type) {
    case 'rectangle': {
      const lo = geometry.min.map((v) => v ?? -Infinity);
      const hi = geometry.max.map((v) => v ?? Infinity);
      return (p) => {
        for (let i = 0; i < lo.length; i += 1) if (!(p[i] >= lo[i] && p[i] < hi[i])) return false;
        return true;
      };
    }
    case 'ellipsoid': {
      const { mean, distanceSquare } = geometry;
      const inverse = invertSymmetric(geometry.covariance);
      const d = mean.length;
      const delta = new Float64Array(d);
      return (p) => {
        for (let i = 0; i < d; i += 1) delta[i] = p[i] - mean[i];
        let q = 0;
        for (let i = 0; i < d; i += 1) for (let j = 0; j < d; j += 1) q += delta[i] * inverse[i][j] * delta[j];
        return q <= distanceSquare;
      };
    }
    default: throw new Error(`Gate type ${type} has no N-dimensional point test.`);
  }
}

// Near the boundary of an N-dimensional geometry (see boundaryTest)?
export function boundaryTestN(type, geometry, rel = BOUNDARY_TOLERANCE) {
  switch (type) {
    case 'rectangle': {
      const edges = [...geometry.min, ...geometry.max].map((v, k) => [k % geometry.min.length, v]).filter(([, v]) => v !== null && v !== undefined && Number.isFinite(v));
      return (p) => edges.some(([i, v]) => Math.abs(p[i] - v) <= rel * Math.max(1, Math.abs(v)));
    }
    case 'ellipsoid': {
      const { mean, distanceSquare } = geometry;
      const inverse = invertSymmetric(geometry.covariance);
      const scale = Math.max(1, ...mean.map(Math.abs));
      // q = D² on the boundary; a coordinate error δ changes q by at most 2·√(q·λmax)·δ.
      let lambda = 0;
      for (const row of inverse) lambda = Math.max(lambda, row.reduce((sum, v) => sum + Math.abs(v), 0));
      const band = 2 * Math.sqrt(distanceSquare * lambda) * rel * scale;
      const d = mean.length;
      return (p) => {
        let q = 0;
        for (let i = 0; i < d; i += 1) for (let j = 0; j < d; j += 1) q += (p[i] - mean[i]) * inverse[i][j] * (p[j] - mean[j]);
        return Math.abs(q - distanceSquare) <= band;
      };
    }
    default: return null;
  }
}

// Inverse of a small symmetric positive-definite matrix (Gauss–Jordan with partial pivoting).
function invertSymmetric(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row.map(Number), ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-300) throw new Error('The ellipsoid covariance matrix is singular.');
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const div = a[c][c];
    for (let k = 0; k < 2 * n; k += 1) a[c][k] /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = a[r][c];
      if (f !== 0) for (let k = 0; k < 2 * n; k += 1) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row) => row.slice(n));
}

// The relative distance within which float32 scaled values may fall on the wrong side of a
// boundary (float32 rounding is 6e-8; lookup-table interpolation adds about 1e-7).
export const BOUNDARY_TOLERANCE = 1e-6;

// A predicate (x, y) → boolean: is the point within rounding distance of the geometry's
// boundary? Null for geometries without one (categories).
export function boundaryTest(type, geometry, rel = BOUNDARY_TOLERANCE) {
  const tol = (v) => rel * Math.max(1, Math.abs(v));
  const near = (v, edge) => edge !== null && edge !== undefined && Number.isFinite(edge) && Math.abs(v - edge) <= tol(edge);
  switch (type) {
    case 'rectangle': {
      const [x0, y0] = geometry.min ?? [null, null];
      const [x1, y1] = geometry.max ?? [null, null];
      return (x, y) => near(x, x0) || near(x, x1) || near(y, y0) || near(y, y1);
    }
    case 'range': return (x) => near(x, geometry.min) || near(x, geometry.max);
    case 'split': return (x) => near(x, geometry.threshold);
    case 'quadrant': {
      const [cx, cy] = geometry.center;
      return (x, y) => near(x, cx) || near(y, cy);
    }
    case 'ellipse': {
      const [cx, cy] = geometry.center;
      const [rx, ry] = geometry.radii;
      const cos = Math.cos(geometry.angle ?? 0);
      const sin = Math.sin(geometry.angle ?? 0);
      // q = 1 on the boundary; a coordinate error δ changes q by about 2δ / r.
      const band = (2 * rel * Math.max(1, Math.abs(cx), Math.abs(cy), rx, ry)) / Math.min(rx, ry);
      return (x, y) => {
        const dx = x - cx;
        const dy = y - cy;
        const u = dx * cos + dy * sin;
        const v = -dx * sin + dy * cos;
        return Math.abs((u * u) / (rx * rx) + (v * v) / (ry * ry) - 1) <= band;
      };
    }
    case 'polygon': {
      const { vertices } = geometry;
      const n = vertices.length;
      let scale = 1;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [vx, vy] of vertices) {
        scale = Math.max(scale, Math.abs(vx), Math.abs(vy));
        minY = Math.min(minY, vy);
        maxY = Math.max(maxY, vy);
      }
      const t = rel * scale;
      // Edges indexed by horizontal bands, so each point checks only the edges near its y.
      const edges = [];
      for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
        const [xi, yi] = vertices[i];
        const [xj, yj] = vertices[j];
        edges.push({ xi, yi, dx: xj - xi, dy: yj - yi, length: Math.hypot(xj - xi, yj - yi), x0: Math.min(xi, xj) - t, x1: Math.max(xi, xj) + t, y0: Math.min(yi, yj) - t, y1: Math.max(yi, yj) + t });
      }
      const bandCount = Math.min(256, 4 * n);
      const lo = minY - t;
      const height = (maxY + t - lo) / bandCount || 1;
      const bands = Array.from({ length: bandCount }, () => []);
      for (const edge of edges) {
        const first = Math.max(0, Math.floor((edge.y0 - lo) / height));
        const last = Math.min(bandCount - 1, Math.floor((edge.y1 - lo) / height));
        for (let k = first; k <= last; k += 1) bands[k].push(edge);
      }
      return (x, y) => {
        const k = Math.floor((y - lo) / height);
        if (!(k >= 0 && k < bandCount)) return false;
        for (const edge of bands[k]) {
          if (y < edge.y0 || y > edge.y1 || x < edge.x0 || x > edge.x1) continue;
          if (edge.length === 0 ? Math.hypot(x - edge.xi, y - edge.yi) <= t : Math.abs(edge.dx * (y - edge.yi) - edge.dy * (x - edge.xi)) <= t * edge.length) return true;
        }
        return false;
      };
    }
    default: return null;
  }
}

// A predicate (x, y) → boolean for the geometry, with precomputed constants.
export function pointTest(type, geometry) {
  switch (type) {
    case 'rectangle': {
      const [x0, y0] = geometry.min ?? [null, null];
      const [x1, y1] = geometry.max ?? [null, null];
      const lx = x0 ?? -Infinity; const ly = y0 ?? -Infinity;
      const hx = x1 ?? Infinity; const hy = y1 ?? Infinity;
      return (x, y) => x >= lx && x < hx && y >= ly && y < hy;
    }
    case 'range': {
      const lo = geometry.min ?? -Infinity;
      const hi = geometry.max ?? Infinity;
      return (x) => x >= lo && x < hi;
    }
    // Upper sides are half-open intervals [t, +∞), as in Gating-ML: +Infinity (a ratio over zero)
    // is in none of them, while −Infinity is in the lower side.
    case 'split': {
      const t = geometry.threshold;
      return geometry.side === 'hi' ? (x) => x >= t && x < Infinity : (x) => x < t;
    }
    case 'quadrant': {
      const [cx, cy] = geometry.center;
      switch (geometry.quadrant) {
        case 'UR': return (x, y) => x >= cx && x < Infinity && y >= cy && y < Infinity;
        case 'UL': return (x, y) => x < cx && y >= cy && y < Infinity;
        case 'LL': return (x, y) => x < cx && y < cy;
        case 'LR': return (x, y) => x >= cx && x < Infinity && y < cy;
        default: throw new Error(`Unknown quadrant ${geometry.quadrant}`);
      }
    }
    case 'ellipse': {
      const [cx, cy] = geometry.center;
      const [rx, ry] = geometry.radii;
      const cos = Math.cos(geometry.angle ?? 0);
      const sin = Math.sin(geometry.angle ?? 0);
      const irx2 = 1 / (rx * rx);
      const iry2 = 1 / (ry * ry);
      return (x, y) => {
        const dx = x - cx;
        const dy = y - cy;
        const u = dx * cos + dy * sin;
        const v = -dx * sin + dy * cos;
        return u * u * irx2 + v * v * iry2 <= 1;
      };
    }
    case 'polygon': return polygonTest(geometry.vertices);
    case 'category': {
      const set = new Set(geometry.values);
      return (x) => set.has(Math.round(x));
    }
    default: throw new Error(`Gate type ${type} has no point test.`);
  }
}

// Even–odd ray casting with a bounding-box prefilter. Points on an edge are inside (Gating-ML 2.0
// polygons include their boundary, as the ISAC compliance suite's expected results show).
export function polygonTest(vertices) {
  const n = vertices.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    xs[i] = vertices[i][0];
    ys[i] = vertices[i][1];
    minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]);
    minY = Math.min(minY, ys[i]); maxY = Math.max(maxY, ys[i]);
  }
  return (x, y) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const yi = ys[i];
      const yj = ys[j];
      // On the edge: collinear with it (exact cross product) and within its extent.
      if (y >= Math.min(yi, yj) && y <= Math.max(yi, yj) && x >= Math.min(xs[i], xs[j]) && x <= Math.max(xs[i], xs[j])
        && (xs[j] - xs[i]) * (y - yi) === (x - xs[i]) * (yj - yi)) return true;
      if ((yi > y) !== (yj > y)) {
        const xCross = xs[i] + ((y - yi) * (xs[j] - xs[i])) / (yj - yi);
        if (x < xCross) inside = !inside;
      }
    }
    return inside;
  };
}

// --- Set operations on sorted index arrays -------------------------------------------------

export function intersect(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  const out = new Uint32Array(Math.min(a.length, b.length));
  let i = 0; let j = 0; let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out[n++] = a[i]; i += 1; j += 1; } else if (a[i] < b[j]) i += 1; else j += 1;
  }
  return out.slice(0, n);
}

export function union(a, b, count) {
  if (a === null || b === null) return null;
  const out = new Uint32Array(a.length + b.length);
  let i = 0; let j = 0; let n = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) out[n++] = a[i++];
    else if (i >= a.length || b[j] < a[i]) out[n++] = b[j++];
    else { out[n++] = a[i]; i += 1; j += 1; }
  }
  const result = out.slice(0, n);
  return count !== undefined && result.length === count ? null : result;
}

// Members of `universe` (sorted indices, or null for 0…count−1) not in `remove`.
export function difference(universe, remove, count) {
  if (remove === null) return new Uint32Array(0);
  const total = universe ? universe.length : count;
  const out = new Uint32Array(total);
  let n = 0; let j = 0;
  for (let k = 0; k < total; k += 1) {
    const e = universe ? universe[k] : k;
    while (j < remove.length && remove[j] < e) j += 1;
    if (j < remove.length && remove[j] === e) continue;
    out[n++] = e;
  }
  return out.slice(0, n);
}

export function populationCount(indices, eventCount) {
  return indices === null ? eventCount : indices.length;
}

// --- Geometry helpers ------------------------------------------------------------------------

export function polygonArea(vertices) {
  let area = 0;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    area += (vertices[j][0] + vertices[i][0]) * (vertices[j][1] - vertices[i][1]);
  }
  return Math.abs(area) / 2;
}

export function polygonCentroid(vertices) {
  let cx = 0; let cy = 0; let a = 0;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const cross = vertices[j][0] * vertices[i][1] - vertices[i][0] * vertices[j][1];
    a += cross;
    cx += (vertices[j][0] + vertices[i][0]) * cross;
    cy += (vertices[j][1] + vertices[i][1]) * cross;
  }
  if (Math.abs(a) < 1e-15) {
    const n = vertices.length;
    return [vertices.reduce((s, v) => s + v[0], 0) / n, vertices.reduce((s, v) => s + v[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// Ramer–Douglas–Peucker simplification, for freehand (lasso) gates.
export function simplifyPolyline(points, tolerance) {
  if (points.length <= 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const [ax, ay] = points[start];
    const [bx, by] = points[end];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) || 1e-12;
    let worst = -1;
    let index = -1;
    for (let i = start + 1; i < end; i += 1) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / length;
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (worst > tolerance) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function convexHull(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// The center of a gate in its scale space, for labels.
export function gateCenter(type, geometry) {
  switch (type) {
    case 'rectangle': {
      const x0 = geometry.min[0] ?? 0; const y0 = geometry.min[1] ?? 0;
      const x1 = geometry.max[0] ?? 1; const y1 = geometry.max[1] ?? 1;
      return [(Math.max(x0, -0.05) + Math.min(x1, 1.05)) / 2, (Math.max(y0, -0.05) + Math.min(y1, 1.05)) / 2];
    }
    case 'range': return [((geometry.min ?? 0) + (geometry.max ?? 1)) / 2, 0.85];
    case 'split': return [geometry.side === 'hi' ? (geometry.threshold + 1) / 2 : geometry.threshold / 2, 0.85];
    case 'polygon': return polygonCentroid(geometry.vertices);
    case 'ellipse': return geometry.center.slice();
    case 'quadrant': {
      const [cx, cy] = geometry.center;
      const right = geometry.quadrant === 'UR' || geometry.quadrant === 'LR';
      const up = geometry.quadrant === 'UR' || geometry.quadrant === 'UL';
      return [right ? (cx + 1) / 2 : cx / 2, up ? (cy + 1) / 2 : cy / 2];
    }
    default: return [0.5, 0.5];
  }
}

// Moves a gate by (dx, dy) in its scale space.
export function translateGeometry(type, geometry, dx, dy = 0) {
  switch (type) {
    case 'rectangle': return {
      min: [geometry.min[0] == null ? null : geometry.min[0] + dx, geometry.min[1] == null ? null : geometry.min[1] + dy],
      max: [geometry.max[0] == null ? null : geometry.max[0] + dx, geometry.max[1] == null ? null : geometry.max[1] + dy],
    };
    case 'range': return { min: geometry.min == null ? null : geometry.min + dx, max: geometry.max == null ? null : geometry.max + dx };
    case 'split': return { ...geometry, threshold: geometry.threshold + dx };
    case 'polygon': return { vertices: geometry.vertices.map(([x, y]) => [x + dx, y + dy]) };
    case 'ellipse': return { ...geometry, center: [geometry.center[0] + dx, geometry.center[1] + dy] };
    case 'quadrant': return { ...geometry, center: [geometry.center[0] + dx, geometry.center[1] + dy] };
    default: return geometry;
  }
}

// Scales a gate about its center by factor (for robustness analysis and keyboard resizing).
export function scaleGeometry(type, geometry, factor) {
  const [cx, cy] = gateCenter(type, geometry);
  const sx = (x) => (x == null ? null : cx + (x - cx) * factor);
  const sy = (y) => (y == null ? null : cy + (y - cy) * factor);
  switch (type) {
    case 'rectangle': return { min: [sx(geometry.min[0]), sy(geometry.min[1])], max: [sx(geometry.max[0]), sy(geometry.max[1])] };
    case 'range': {
      const mid = ((geometry.min ?? 0) + (geometry.max ?? 1)) / 2;
      return { min: geometry.min === null ? null : mid + (geometry.min - mid) * factor, max: geometry.max === null ? null : mid + (geometry.max - mid) * factor };
    }
    case 'polygon': return { vertices: geometry.vertices.map(([x, y]) => [sx(x), sy(y)]) };
    case 'ellipse': return { ...geometry, radii: [geometry.radii[0] * factor, geometry.radii[1] * factor] };
    default: return geometry;
  }
}

// Expands (positive) or shrinks (negative) a gate's boundary by `distance` scale units: the
// perturbation used by the gate robustness analysis.
export function offsetGeometry(type, geometry, distance) {
  switch (type) {
    case 'rectangle': return {
      min: [geometry.min[0] == null ? null : geometry.min[0] - distance, geometry.min[1] == null ? null : geometry.min[1] - distance],
      max: [geometry.max[0] == null ? null : geometry.max[0] + distance, geometry.max[1] == null ? null : geometry.max[1] + distance],
    };
    case 'range': return { min: geometry.min == null ? null : geometry.min - distance, max: geometry.max == null ? null : geometry.max + distance };
    case 'ellipse': return { ...geometry, radii: [Math.max(1e-6, geometry.radii[0] + distance), Math.max(1e-6, geometry.radii[1] + distance)] };
    case 'polygon': return { vertices: offsetPolygon(geometry.vertices, distance) };
    case 'split': return { ...geometry, threshold: geometry.threshold + (geometry.side === 'hi' ? -distance : distance) };
    case 'quadrant': {
      const [cx, cy] = geometry.center;
      const right = geometry.quadrant === 'UR' || geometry.quadrant === 'LR';
      const up = geometry.quadrant === 'UR' || geometry.quadrant === 'UL';
      return { ...geometry, center: [cx + (right ? -distance : distance), cy + (up ? -distance : distance)] };
    }
    default: return geometry;
  }
}

// Offsets each vertex along the bisector of its edges' outward normals (miter, limited).
export function offsetPolygon(vertices, distance) {
  const n = vertices.length;
  let signedArea = 0;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) signedArea += (vertices[j][0] * vertices[i][1] - vertices[i][0] * vertices[j][1]);
  const orientation = signedArea >= 0 ? 1 : -1; // +1 counter-clockwise
  return vertices.map((v, i) => {
    const prev = vertices[(i - 1 + n) % n];
    const next = vertices[(i + 1) % n];
    const e1 = normalize2([v[0] - prev[0], v[1] - prev[1]]);
    const e2 = normalize2([next[0] - v[0], next[1] - v[1]]);
    // Outward normals for a counter-clockwise polygon are (dy, −dx).
    const n1 = [e1[1] * orientation, -e1[0] * orientation];
    const n2 = [e2[1] * orientation, -e2[0] * orientation];
    let bisector = normalize2([n1[0] + n2[0], n1[1] + n2[1]]);
    if (!Number.isFinite(bisector[0])) bisector = n1;
    const cos = bisector[0] * n1[0] + bisector[1] * n1[1];
    const miter = Math.min(3, 1 / Math.max(cos, 1e-3));
    return [v[0] + bisector[0] * distance * miter, v[1] + bisector[1] * distance * miter];
  });
}

function normalize2([x, y]) {
  const length = Math.hypot(x, y);
  return length ? [x / length, y / length] : [Number.NaN, Number.NaN];
}

// --- Mapping between a gate's space and a plot's space ----------------------------------------

function sameTransform(a, b) {
  return createTransform(a).key === createTransform(b).key;
}

// Maps a coordinate from one transform's scale to another's.
export function remapScale(value, from, to) {
  if (sameTransform(from, to)) return value;
  const data = createTransform(from).inverse(value);
  return createTransform(to).forward(data);
}

// The outline of a gate as polylines in a plot's scale space, or null when the plot does not
// show the gate's dimensions. plotDims: [{ channel, transform }, { channel, transform } | null].
export function gateOutline(gate, geometry, plotDims) {
  const [px, py] = plotDims;
  const dims = gate.dims;
  // Gates of three or more dimensions (imported) have no outline on a 2-D plot.
  if (gate.type === 'ellipsoid' || (gate.type === 'rectangle' && dims.length !== 2)) return null;
  if (gate.type === 'range' || gate.type === 'split') {
    const onX = px && dims[0].channel === px.channel;
    const onY = py && dims[0].channel === py.channel;
    if (!onX && !onY) return null;
    const target = onX ? px : py;
    const map = (v) => (v === null || v === undefined ? null : remapScale(v, dims[0].transform, target.transform));
    if (gate.type === 'range') return { kind: 'range', axis: onX ? 'x' : 'y', min: map(geometry.min), max: map(geometry.max) };
    return { kind: 'split', axis: onX ? 'x' : 'y', threshold: map(geometry.threshold), side: geometry.side };
  }
  if (!px || !py || dims.length < 2) return null;
  let swap;
  if (dims[0].channel === px.channel && dims[1].channel === py.channel) swap = false;
  else if (dims[0].channel === py.channel && dims[1].channel === px.channel) swap = true;
  else return null;
  const tx = swap ? dims[1].transform : dims[0].transform;
  const ty = swap ? dims[0].transform : dims[1].transform;
  const identical = sameTransform(tx, px.transform) && sameTransform(ty, py.transform);
  const toPlot = ([gx, gy]) => {
    const x = swap ? gy : gx;
    const y = swap ? gx : gy;
    return identical ? [x, y] : [remapScale(x, tx, px.transform), remapScale(y, ty, py.transform)];
  };
  const densify = (points, closed) => {
    if (identical) return points;
    const out = [];
    const segments = closed ? points.length : points.length - 1;
    for (let i = 0; i < segments; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      for (let s = 0; s < 24; s += 1) out.push([a[0] + ((b[0] - a[0]) * s) / 24, a[1] + ((b[1] - a[1]) * s) / 24]);
    }
    if (!closed) out.push(points[points.length - 1]);
    return out;
  };
  switch (gate.type) {
    case 'polygon': return { kind: 'polygon', points: densify(geometry.vertices, true).map(toPlot), vertices: geometry.vertices.map(toPlot) };
    case 'rectangle': {
      const big = 4;
      const x0 = geometry.min[0] ?? -big; const y0 = geometry.min[1] ?? -big;
      const x1 = geometry.max[0] ?? big; const y1 = geometry.max[1] ?? big;
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      return { kind: 'polygon', points: densify(corners, true).map(toPlot), vertices: corners.map(toPlot), rect: true };
    }
    case 'ellipse': {
      const points = [];
      const [cx, cy] = geometry.center;
      const [rx, ry] = geometry.radii;
      const cos = Math.cos(geometry.angle ?? 0);
      const sin = Math.sin(geometry.angle ?? 0);
      for (let k = 0; k < 96; k += 1) {
        const t = (2 * Math.PI * k) / 96;
        const u = rx * Math.cos(t);
        const v = ry * Math.sin(t);
        points.push([cx + u * cos - v * sin, cy + u * sin + v * cos]);
      }
      return { kind: 'polygon', points: points.map(toPlot), ellipse: true };
    }
    case 'quadrant': {
      const center = toPlot(geometry.center);
      return { kind: 'quadrant', center, quadrant: swap ? swapQuadrant(geometry.quadrant) : geometry.quadrant };
    }
    default: return null;
  }
}

function swapQuadrant(q) {
  return { UL: 'LR', LR: 'UL', UR: 'UR', LL: 'LL' }[q];
}

// Converts a geometry drawn in a plot's scale space into a gate's own space; with identical
// transforms it is unchanged. Used when the user draws or edits a gate on a plot.
export function geometryFromPlot(type, geometry, plotDims) {
  // Gates drawn on a plot take that plot's transforms as their own, so no conversion is needed;
  // this function exists for symmetry and for edits on plots whose axes differ from the gate's.
  return { type, geometry, dims: plotDims.filter(Boolean).map((d) => ({ channel: d.channel, transform: { ...d.transform } })) };
}

// Maps a plot-space edit back into a gate's space (inverse of the outline mapping).
export function plotPointToGate(point, gate, plotDims) {
  const [px, py] = plotDims;
  const dims = gate.dims;
  if (dims.length === 1) {
    const onX = px && dims[0].channel === px.channel;
    const source = onX ? px : py;
    const value = onX ? point[0] : point[1];
    return [remapScale(value, source.transform, dims[0].transform)];
  }
  const swap = dims[0].channel === py?.channel;
  const gx = swap ? point[1] : point[0];
  const gy = swap ? point[0] : point[1];
  const sx = swap ? py : px;
  const sy = swap ? px : py;
  return [remapScale(gx, sx.transform, dims[0].transform), remapScale(gy, sy.transform, dims[1].transform)];
}

let idCounter = 0;
export function newId(prefix = 'g') {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${random}`;
}

// The four linked gates of a quadrant at center, named after the axes' markers.
export function quadrantGates({ parentId, dims, center, names, linkId = newId('q'), colors = [] }) {
  return QUADRANTS.map((quadrant, i) => ({
    id: newId('g'),
    parentId,
    type: 'quadrant',
    name: names?.[quadrant] ?? quadrant,
    dims,
    geometry: { center: center.slice(), quadrant },
    linkId,
    color: colors[i],
  }));
}

// Quadrant names in the cytometry convention, e.g. "CD4+ CD8−".
export function quadrantNames(xName, yName) {
  return {
    UL: `${xName}− ${yName}+`,
    UR: `${xName}+ ${yName}+`,
    LR: `${xName}+ ${yName}−`,
    LL: `${xName}− ${yName}−`,
  };
}

export function splitGates({ parentId, dims, threshold, xName, linkId = newId('s') }) {
  return ['lo', 'hi'].map((side) => ({
    id: newId('g'),
    parentId,
    type: 'split',
    name: `${xName}${side === 'hi' ? '+' : '−'}`,
    dims,
    geometry: { threshold, side },
    linkId,
  }));
}
