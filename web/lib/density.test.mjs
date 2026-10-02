import assert from 'node:assert/strict';
import test from 'node:test';
import { bin1d, bin2d, blur2d, contours, histogram, isoLines, probabilityLevels, pseudocolorRaster } from './density.js';
import { colormapLUT, colormapColor, categoricalColor } from './colormaps.js';
import { describe, formatStatistic, quantileSorted, stainIndex, wilsonInterval } from './stats.js';
import { createRandom, sampleIndices } from './random.js';

test('2-D binning counts events and piles off-scale ones on the axes', () => {
  const xs = Float32Array.from([0.05, 0.95, 1.5, -0.2, 0.5]);
  const ys = Float32Array.from([0.05, 0.95, 0.5, 0.5, 2]);
  const grid = bin2d(xs, ys, null, 10, 10);
  assert.equal(grid.reduce((s, v) => s + v, 0), 5);
  assert.equal(grid[0], 1);
  assert.equal(grid[9 * 10 + 9], 1);
  assert.equal(grid[5 * 10 + 9], 1); // x 1.5 piled at the right edge
  assert.equal(grid[5 * 10 + 0], 1); // x −0.2 piled at the left edge
  const strict = bin2d(xs, ys, null, 10, 10, { pile: false });
  assert.equal(strict.reduce((s, v) => s + v, 0), 2);
  const sub = bin2d(xs, ys, Uint32Array.from([0, 1]), 10, 10);
  assert.equal(sub.reduce((s, v) => s + v, 0), 2);
  assert.deepEqual(Array.from(bin1d(Float32Array.from([0.1, 0.1, 0.9]), null, 2)), [2, 1]);
});

test('blurring preserves mass away from the edges', () => {
  const grid = new Float32Array(50 * 50);
  grid[25 * 50 + 25] = 100;
  const smooth = blur2d(grid, 50, 50, 2);
  const total = smooth.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 100) < 1e-3);
  assert.ok(smooth[25 * 50 + 25] < 100 && smooth[25 * 50 + 25] > 1);
});

test('probability contours enclose the requested fractions', () => {
  const random = createRandom(2);
  const n = 20000;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = 0.5 + 0.08 * random.gaussian();
    ys[i] = 0.5 + 0.08 * random.gaussian();
  }
  const counts = bin2d(xs, ys, null, 128, 128);
  const smooth = blur2d(counts, 128, 128, 2);
  const [level50] = probabilityLevels(smooth, [0.5]);
  let inside = 0; let total = 0;
  for (let i = 0; i < smooth.length; i += 1) {
    total += smooth[i];
    if (smooth[i] >= level50) inside += smooth[i];
  }
  assert.ok(Math.abs(inside / total - 0.5) < 0.02);
  const { lines } = contours(counts, 128, 128, { fractions: [0.9, 0.5] });
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.segments.length > 0));
  for (const line of lines) for (const v of line.segments) assert.ok(v >= 0 && v <= 1);
});

test('iso-lines around a single peak form a closed ring', () => {
  const grid = new Float32Array(9 * 9);
  grid[4 * 9 + 4] = 10;
  const segments = isoLines(grid, 9, 9, 5);
  assert.equal(segments.length / 4, 4);
});

test('pseudocolor rasters color only occupied pixels, top row first', () => {
  const counts = new Float32Array(4 * 4);
  counts[0] = 5; // bottom-left in plot space
  const rgba = pseudocolorRaster(counts, 4, 4);
  // Bottom-left of the plot is the last row of the raster.
  assert.equal(rgba[(3 * 4 + 0) * 4 + 3], 255);
  assert.equal(rgba[3], 0);
});

test('histograms find the mode', () => {
  const values = Float32Array.from({ length: 1000 }, (_, i) => (i < 800 ? 0.3 : 0.7) + (i % 7) * 0.001);
  const h = histogram(values, null, { bins: 100 });
  assert.equal(h.total, 1000);
  assert.ok(Math.abs(h.mode - 0.305) < 0.02);
});

test('descriptive statistics match hand computation', () => {
  const values = Float32Array.from([1, 2, 3, 4, 100]);
  const d = describe(values);
  assert.equal(d.median, 3);
  assert.equal(d.mean, 22);
  assert.ok(Math.abs(d.sd - Math.sqrt(((21 ** 2) + (20 ** 2) + (19 ** 2) + (18 ** 2) + (78 ** 2)) / 4)) < 1e-9);
  assert.ok(Math.abs(d.geomean - Math.exp((Math.log(1) + Math.log(2) + Math.log(3) + Math.log(4) + Math.log(100)) / 5)) < 1e-9);
  assert.equal(d.mad, 1);
  assert.equal(quantileSorted(Float64Array.from([1, 2, 3, 4]), 0.5), 2.5);
  const sub = describe(values, Uint32Array.from([0, 1, 2]));
  assert.equal(sub.median, 2);
  assert.equal(formatStatistic('count', 12345), '12,345');
  assert.equal(formatStatistic('freqParent', 45.678), '45.7');
});

test('stain index and binomial intervals', () => {
  const random = createRandom(4);
  const neg = Float32Array.from({ length: 5000 }, () => 100 * random.gaussian());
  const pos = Float32Array.from({ length: 5000 }, () => 2000 + 300 * random.gaussian());
  const si = stainIndex(pos, neg);
  assert.ok(Math.abs(si - 10) < 0.5, `SI ${si}`);
  const [lo, hi] = wilsonInterval(5, 100);
  assert.ok(lo < 0.05 && hi > 0.05 && lo > 0.01 && hi < 0.12);
});

test('seeded randomness is reproducible and samples without replacement', () => {
  const a = createRandom(42);
  const b = createRandom(42);
  for (let i = 0; i < 10; i += 1) assert.equal(a(), b());
  const picked = sampleIndices(1000, 100, createRandom(1));
  assert.equal(new Set(picked).size, 100);
  for (let i = 1; i < picked.length; i += 1) assert.ok(picked[i] > picked[i - 1]);
  const large = sampleIndices(100, 60, createRandom(1));
  assert.equal(new Set(large).size, 60);
});

test('colormaps', () => {
  assert.equal(colormapLUT('viridis').length, 768);
  assert.equal(colormapColor('viridis', 0), '#440154');
  assert.equal(colormapColor('viridis', 1), '#fde725');
  assert.notEqual(categoricalColor(0), categoricalColor(1));
  assert.match(categoricalColor(40), /^#[0-9a-f]{6}$/);
});
