// Binning, smoothing and contouring of scaled event data for plots. Inputs are display
// coordinates (0–1 along each axis after the axis transform); outputs are grids and rasters with
// no DOM, so the same code renders on screen, in workers and in exported figures.

import { colormapLUT, hexToRgb } from './colormaps.js';

// Counts events per cell of a width × height grid over [0,1]². With `pile`, events beyond the
// axes are counted in the edge cells, as cytometry plots show off-scale events on the axes.
export function bin2d(xs, ys, indices, width, height, options = {}) {
  const grid = new Float32Array(width * height);
  const pile = options.pile ?? true;
  const x0 = options.xRange?.[0] ?? 0;
  const x1 = options.xRange?.[1] ?? 1;
  const y0 = options.yRange?.[0] ?? 0;
  const y1 = options.yRange?.[1] ?? 1;
  const sx = width / (x1 - x0);
  const sy = height / (y1 - y0);
  const n = indices ? indices.length : xs.length;
  const wMax = width - 1;
  const hMax = height - 1;
  for (let k = 0; k < n; k += 1) {
    const e = indices ? indices[k] : k;
    let cx = Math.floor((xs[e] - x0) * sx);
    let cy = Math.floor((ys[e] - y0) * sy);
    if (cx < 0 || cx > wMax || cy < 0 || cy > hMax) {
      if (!pile || !(cx === cx) || !(cy === cy)) continue; // NaN check
      cx = cx < 0 ? 0 : cx > wMax ? wMax : cx;
      cy = cy < 0 ? 0 : cy > hMax ? hMax : cy;
    }
    grid[cy * width + cx] += 1;
  }
  return grid;
}

export function bin1d(xs, indices, bins, options = {}) {
  const counts = new Float64Array(bins);
  const x0 = options.range?.[0] ?? 0;
  const x1 = options.range?.[1] ?? 1;
  const s = bins / (x1 - x0);
  const pile = options.pile ?? true;
  const n = indices ? indices.length : xs.length;
  for (let k = 0; k < n; k += 1) {
    const v = xs[indices ? indices[k] : k];
    let b = Math.floor((v - x0) * s);
    if (b < 0 || b >= bins) {
      if (!pile || !(b === b)) continue;
      b = b < 0 ? 0 : bins - 1;
    }
    counts[b] += 1;
  }
  return counts;
}

function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;
  return { kernel, radius };
}

// Separable Gaussian blur with edges treated as zero (density leaks off-plot like a KDE would).
export function blur2d(grid, width, height, sigma) {
  if (!(sigma > 0)) return Float32Array.from(grid);
  const { kernel, radius } = gaussianKernel(sigma);
  const temp = new Float32Array(grid.length);
  const out = new Float32Array(grid.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const v = grid[row + x];
      if (v === 0) continue;
      const lo = Math.max(0, x - radius);
      const hi = Math.min(width - 1, x + radius);
      for (let xx = lo; xx <= hi; xx += 1) temp[row + xx] += v * kernel[xx - x + radius];
    }
  }
  for (let y = 0; y < height; y += 1) {
    const lo = Math.max(0, y - radius);
    const hi = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const v = temp[y * width + x];
      if (v === 0) continue;
      for (let yy = lo; yy <= hi; yy += 1) out[yy * width + x] += v * kernel[yy - y + radius];
    }
  }
  return out;
}

export function blur1d(counts, sigma) {
  if (!(sigma > 0)) return Float64Array.from(counts);
  const { kernel, radius } = gaussianKernel(sigma);
  const out = new Float64Array(counts.length);
  for (let i = 0; i < counts.length; i += 1) {
    const v = counts[i];
    if (v === 0) continue;
    const lo = Math.max(0, i - radius);
    const hi = Math.min(counts.length - 1, i + radius);
    for (let j = lo; j <= hi; j += 1) out[j] += v * kernel[j - i + radius];
  }
  return out;
}

// Maps a density value to 0–1 for coloring. 'log' compresses dense cores so rare events stay
// visible; 'sqrt' sits between; 'linear' is faithful to counts.
function densityScaler(max, scale) {
  if (!(max > 0)) return () => 0;
  if (scale === 'linear') return (v) => v / max;
  if (scale === 'sqrt') {
    const s = Math.sqrt(max);
    return (v) => Math.sqrt(v) / s;
  }
  const l = Math.log1p(max);
  return (v) => Math.log1p(v) / l;
}

// Writes an RGBA raster (row 0 at the top) from a grid whose row 0 is the bottom of the plot.
function rasterFrom(grid, width, height, colorOf) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const src = y * width;
    const dst = (height - 1 - y) * width;
    for (let x = 0; x < width; x += 1) {
      const c = colorOf(grid[src + x], src + x);
      if (!c) continue;
      const o = (dst + x) * 4;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = c[3] ?? 255;
    }
  }
  return rgba;
}

function maxOf(values) {
  let m = 0;
  for (let i = 0; i < values.length; i += 1) if (values[i] > m) m = values[i];
  return m;
}

// Pseudocolor dot plot: every occupied pixel is colored by the smoothed local density.
export function pseudocolorRaster(counts, width, height, options = {}) {
  const smooth = blur2d(counts, width, height, options.sigma ?? Math.max(1, width / 160));
  const lut = colormapLUT(options.colormap ?? 'classic');
  const toUnit = densityScaler(maxOf(smooth), options.scale ?? 'log');
  const color = [0, 0, 0, 255];
  // Low densities start at 15% into the map so the sparsest events remain visible.
  const floor = options.floor ?? 0.12;
  return rasterFrom(counts, width, height, (count, i) => {
    if (count <= 0) return null;
    const t = floor + (1 - floor) * Math.min(1, toUnit(smooth[i]));
    const k = Math.round(t * 255) * 3;
    color[0] = lut[k]; color[1] = lut[k + 1]; color[2] = lut[k + 2];
    return color;
  });
}

// Density plot: smoothed density shaded everywhere above a small threshold.
export function densityRaster(counts, width, height, options = {}) {
  const smooth = blur2d(counts, width, height, options.sigma ?? Math.max(1.5, width / 110));
  const lut = colormapLUT(options.colormap ?? 'viridis');
  const max = maxOf(smooth);
  const toUnit = densityScaler(max, options.scale ?? 'log');
  const threshold = max * (options.threshold ?? 0.002);
  const color = [0, 0, 0, 255];
  return rasterFrom(smooth, width, height, (v) => {
    if (v <= threshold) return null;
    const t = Math.min(1, toUnit(v));
    const k = Math.round(t * 255) * 3;
    color[0] = lut[k]; color[1] = lut[k + 1]; color[2] = lut[k + 2];
    color[3] = Math.round(255 * Math.min(1, 0.35 + t));
    return color;
  });
}

// Plain dots in one color (dot plot and backgating overlays).
export function dotRaster(counts, width, height, options = {}) {
  const [r, g, b] = hexToRgb(options.color ?? '#1f2937');
  const alpha = Math.round(255 * (options.alpha ?? 1));
  const color = [r, g, b, alpha];
  return rasterFrom(counts, width, height, (count) => (count > 0 ? color : null));
}

// Density thresholds that enclose the given fractions of events (probability contours).
export function probabilityLevels(smooth, fractions) {
  const values = Float32Array.from(smooth).sort();
  const total = values.reduce((s, v) => s + v, 0);
  const levels = [];
  for (const fraction of fractions) {
    let acc = 0;
    let level = 0;
    for (let i = values.length - 1; i >= 0; i -= 1) {
      acc += values[i];
      if (acc >= fraction * total) {
        level = values[i];
        break;
      }
    }
    levels.push(level);
  }
  return levels;
}

// Marching squares: segments [x0, y0, x1, y1] (grid units, row 0 at the bottom) of the iso-line.
export function isoLines(grid, width, height, threshold) {
  const segments = [];
  const at = (x, y) => grid[y * width + x];
  const interp = (a, b) => (threshold - a) / (b - a || 1e-12);
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const v0 = at(x, y);
      const v1 = at(x + 1, y);
      const v2 = at(x + 1, y + 1);
      const v3 = at(x, y + 1);
      let code = 0;
      if (v0 >= threshold) code |= 1;
      if (v1 >= threshold) code |= 2;
      if (v2 >= threshold) code |= 4;
      if (v3 >= threshold) code |= 8;
      if (code === 0 || code === 15) continue;
      const bottom = () => [x + interp(v0, v1), y];
      const right = () => [x + 1, y + interp(v1, v2)];
      const top = () => [x + interp(v3, v2), y + 1];
      const left = () => [x, y + interp(v0, v3)];
      const add = (a, b) => segments.push(a[0], a[1], b[0], b[1]);
      switch (code) {
        case 1: case 14: add(left(), bottom()); break;
        case 2: case 13: add(bottom(), right()); break;
        case 3: case 12: add(left(), right()); break;
        case 4: case 11: add(top(), right()); break;
        case 6: case 9: add(bottom(), top()); break;
        case 7: case 8: add(left(), top()); break;
        case 5: {
          const center = (v0 + v1 + v2 + v3) / 4;
          if (center >= threshold) { add(left(), top()); add(bottom(), right()); } else { add(left(), bottom()); add(top(), right()); }
          break;
        }
        case 10: {
          const center = (v0 + v1 + v2 + v3) / 4;
          if (center >= threshold) { add(left(), bottom()); add(top(), right()); } else { add(left(), top()); add(bottom(), right()); }
          break;
        }
        default: break;
      }
    }
  }
  return Float32Array.from(segments);
}

// Contour lines at probability levels, in plot units (0–1), with the outlier mask for zebra plots.
export function contours(counts, width, height, options = {}) {
  const sigma = options.sigma ?? Math.max(1.5, width / 90);
  const smooth = blur2d(counts, width, height, sigma);
  const fractions = options.fractions ?? [0.98, 0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
  const levels = probabilityLevels(smooth, fractions);
  const lines = levels.map((level, i) => {
    const segments = isoLines(smooth, width, height, level);
    // Grid cell centers lie at (i + 0.5) / size.
    for (let k = 0; k < segments.length; k += 2) {
      segments[k] = (segments[k] + 0.5) / width;
      segments[k + 1] = (segments[k + 1] + 0.5) / height;
    }
    return { fraction: fractions[i], level, segments };
  });
  return { lines, smooth, outlierLevel: levels[0] };
}

// Zebra/outlier raster: dots for events in cells below the outermost contour.
export function outlierRaster(counts, smooth, width, height, level, options = {}) {
  const [r, g, b] = hexToRgb(options.color ?? '#1f2937');
  const color = [r, g, b, Math.round(255 * (options.alpha ?? 0.9))];
  return rasterFrom(counts, width, height, (count, i) => (count > 0 && smooth[i] < level ? color : null));
}

// Overlay of several populations, each in its own color (later ones on top), for backgating.
export function overlayRaster(layers, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (const { counts, color, alpha = 1 } of layers) {
    const [r, g, b] = hexToRgb(color);
    for (let y = 0; y < height; y += 1) {
      const src = y * width;
      const dst = (height - 1 - y) * width;
      for (let x = 0; x < width; x += 1) {
        if (counts[src + x] <= 0) continue;
        const o = (dst + x) * 4;
        const a = alpha;
        rgba[o] = Math.round(r * a + rgba[o] * (1 - a));
        rgba[o + 1] = Math.round(g * a + rgba[o + 1] * (1 - a));
        rgba[o + 2] = Math.round(b * a + rgba[o + 2] * (1 - a));
        rgba[o + 3] = 255;
      }
    }
  }
  return rgba;
}

// A 1-D histogram ready to draw: { counts, smoothed, max, mode } over `bins` bins.
export function histogram(xs, indices, options = {}) {
  const bins = options.bins ?? 256;
  const counts = bin1d(xs, indices, bins, options);
  const smoothed = options.smooth === false ? counts : blur1d(counts, options.sigma ?? bins / 170);
  let max = 0;
  let mode = 0;
  for (let i = 0; i < bins; i += 1) {
    if (smoothed[i] > max) {
      max = smoothed[i];
      mode = i;
    }
  }
  let total = 0;
  for (let i = 0; i < bins; i += 1) total += counts[i];
  return { counts, smoothed, max, mode: (mode + 0.5) / bins, total, bins };
}

// Per-event density (normalized 0–1) for coloring dots in vector exports or 3-D views.
export function eventDensities(xs, ys, indices, width, height, options = {}) {
  const counts = bin2d(xs, ys, indices, width, height);
  const smooth = blur2d(counts, width, height, options.sigma ?? Math.max(1, width / 160));
  const max = maxOf(smooth);
  const n = indices ? indices.length : xs.length;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k += 1) {
    const e = indices ? indices[k] : k;
    const cx = Math.min(width - 1, Math.max(0, Math.floor(xs[e] * width)));
    const cy = Math.min(height - 1, Math.max(0, Math.floor(ys[e] * height)));
    out[k] = max > 0 ? Math.log1p(smooth[cy * width + cx]) / Math.log1p(max) : 0;
  }
  return out;
}
