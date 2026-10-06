import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { diagnoseControls, diagnoseUnmixing, donorOf } from './spectral-doctor.js';

// A small synthetic instrument: 24 detectors, dyes as bands (a tandem with a small donor peak),
// cellular autofluorescence as a broad shape, and photon noise that grows with the signal.
const D = 24;
const detectors = Array.from({ length: D }, (_, d) => `${d < 8 ? 'V' : d < 16 ? 'B' : 'R'}${(d % 8) + 1}-A`);
const band = (center, width, extra = []) => Float64Array.from({ length: D }, (_, d) => {
  let v = Math.exp(-((d - center) ** 2) / (2 * width ** 2));
  for (const [c, w, h] of extra) v += h * Math.exp(-((d - c) ** 2) / (2 * w ** 2));
  return v;
});
const peak1 = (v) => {
  const m = Math.max(...v);
  return Float64Array.from(v, (x) => x / m);
};
const DYES = {
  A: peak1(band(2, 1.2)),
  B: peak1(band(6, 1.4)),
  C: peak1(band(10, 1.2)),
  PE: peak1(band(13, 1.1)),
  E: peak1(band(17, 1.3)),
  'PE-Cy7': peak1(band(21, 1.3, [[13, 1.1, 0.04]])),
};
const AF = peak1(band(4, 6));

// Events: each dye on 30% of cells (log-normal amounts), autofluorescence on all.
function simulate({ n = 6000, dyes = DYES, seed = 7, present = Object.keys(DYES), extra = null } = {}) {
  const random = createRandom(seed);
  const normal = () => random.gaussian();
  const cols = Array.from({ length: D }, () => new Float64Array(n));
  for (let i = 0; i < n; i += 1) {
    const signal = new Float64Array(D);
    for (const name of present) {
      if (random() < 0.3) {
        const amount = 20000 * Math.exp(0.5 * normal());
        for (let d = 0; d < D; d += 1) signal[d] += amount * dyes[name][d];
      }
    }
    const af = 800 * Math.exp(0.4 * normal());
    for (let d = 0; d < D; d += 1) signal[d] += af * AF[d];
    if (extra && random() < extra.fraction) {
      const amount = extra.amount * Math.exp(0.4 * normal());
      for (let d = 0; d < D; d += 1) signal[d] += amount * extra.spectrum[d];
    }
    for (let d = 0; d < D; d += 1) cols[d][i] = signal[d] + Math.sqrt(400 + 2 * Math.max(0, signal[d])) * normal();
  }
  return cols;
}

const model = (names = Object.keys(DYES), dyes = DYES) => ({
  detectors,
  spectra: names.map((name) => ({ name, spectrum: Array.from(dyes[name]) })),
  afSignatures: [{ name: 'AF1', spectrum: Array.from(AF) }],
});

test('the donors of tandem dyes', () => {
  const pairs = { 'PE-Cy7': 'PE', 'PE-Dazzle 594': 'PE', 'APC-Fire 750': 'APC', 'PerCP-Cy5.5': 'PerCP', BV605: 'BV421', BUV805: 'BUV395', BV510: null, BUV496: null, PE: null, FITC: null };
  for (const [dye, donor] of Object.entries(pairs)) assert.equal(donorOf(dye), donor, dye);
});

test('a well-described sample: no fault', () => {
  const result = diagnoseUnmixing(simulate(), model());
  assert.equal(result.healthy, true, JSON.stringify(result.findings.map((f) => f.title)));
  assert.equal(result.findings.filter((f) => f.severity !== 'low').length, 0);
});

test('a dye without a reference, named from the library', () => {
  const cols = simulate();
  const library = [{ id: 'lib-c', fluorochrome: 'C', spectrum: Array.from(DYES.C), date: '2026-01-01' }];
  const result = diagnoseUnmixing(cols, model(['A', 'B', 'PE', 'E', 'PE-Cy7']), { library });
  const [first] = result.findings;
  assert.equal(first.kind, 'missing-reference');
  assert.equal(first.subject, 'C');
  assert.equal(first.fix.action, 'add-library');
  assert.ok(first.effect.after.unexplained < 0.1 * first.effect.before.unexplained, JSON.stringify(first.effect));
  // Without the library: unnamed, at the dye's peak, with its spectrum estimated.
  const blind = diagnoseUnmixing(cols, model(['A', 'B', 'PE', 'E', 'PE-Cy7']));
  assert.equal(blind.findings[0].kind, 'missing-reference');
  assert.equal(blind.findings[0].measures.peak, detectors[10]);
  const estimate = blind.findings[0].spectrum;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let d = 0; d < D; d += 1) {
    dot += estimate[d] * DYES.C[d];
    a += estimate[d] ** 2;
    b += DYES.C[d] ** 2;
  }
  assert.ok(dot / Math.sqrt(a * b) > 0.97, `estimated spectrum cosine ${dot / Math.sqrt(a * b)}`);
});

test('a reference that does not match the dye in the sample', () => {
  const wrong = { ...DYES, E: peak1(Float64Array.from(DYES.E, (v, d) => v + (d === 19 ? 0.15 : 0))) };
  const result = diagnoseUnmixing(simulate(), model(Object.keys(DYES), wrong));
  const [first] = result.findings;
  assert.equal(first.kind, 'wrong-reference');
  assert.equal(first.subject, 'E');
  assert.equal(first.measures.detector, detectors[19]);
  assert.equal(first.fix.action, 'replace-spectrum');
  assert.ok(first.effect.after.mismatch < 0.3 * first.effect.before.mismatch, JSON.stringify(first.effect));
  // On beads, the same departure is put down to the carrier.
  const beads = diagnoseUnmixing(simulate(), model(Object.keys(DYES), wrong), { references: [{ name: 'E', spectrum: Array.from(wrong.E), carrier: 'beads' }] });
  assert.equal(beads.findings[0].kind, 'bead-control');
});

test('a tandem degraded in the sample leaks into its donor', () => {
  const degraded = { ...DYES, 'PE-Cy7': peak1(Float64Array.from(DYES['PE-Cy7'], (v, d) => 0.9 * v + 0.1 * DYES.PE[d])) };
  const result = diagnoseUnmixing(simulate({ dyes: degraded }), model());
  const [first] = result.findings;
  assert.equal(first.kind, 'degraded-tandem');
  assert.equal(first.subject, 'PE-Cy7');
  assert.ok(first.measures.slope > 0.05, String(first.measures.slope));
  assert.ok(Math.abs(first.effect.after.leak) < 0.2 * first.effect.before.leak, JSON.stringify(first.effect));
});

test('autofluorescence the model does not describe', () => {
  const other = peak1(band(8, 4));
  const result = diagnoseUnmixing(simulate({ extra: { fraction: 0.4, amount: 3000, spectrum: other } }), model(), { unstainedAF: [{ name: 'AF1', spectrum: Array.from(AF) }] });
  assert.ok(result.findings.length > 0);
  assert.ok(['autofluorescence', 'missing-reference'].includes(result.findings[0].kind), result.findings[0].kind);
});

test('controls alone: autofluorescent positives on cells, not on beads; a degraded tandem against the library', () => {
  const mixture = Array.from(AF, (v) => 0.12 * v);
  const findings = diagnoseControls([
    { name: 'C', spectrum: Array.from(DYES.C), carrier: 'cells', mixture },
    { name: 'B', spectrum: Array.from(DYES.B), carrier: 'beads', mixture },
    { name: 'A', spectrum: Array.from(DYES.A), carrier: 'cells', mixture: Array.from({ length: D }, () => 0.001) },
  ], { detectors, afSignatures: [{ name: 'AF1', spectrum: Array.from(AF) }] });
  assert.deepEqual(findings.map((f) => `${f.kind}:${f.subject}`), ['control-autofluorescence:C']);
  const degraded = peak1(Float64Array.from(DYES['PE-Cy7'], (v, d) => 0.9 * v + 0.1 * DYES.PE[d]));
  const vsLibrary = diagnoseControls([
    { name: 'PE', spectrum: Array.from(DYES.PE) },
    { name: 'PE-Cy7', spectrum: Array.from(degraded) },
  ], { detectors, library: [{ id: 'old', fluorochrome: 'PE-Cy7', spectrum: Array.from(DYES['PE-Cy7']), date: '2026-01-01' }] });
  assert.equal(vsLibrary.length, 1);
  assert.equal(vsLibrary[0].kind, 'degraded-tandem');
  assert.ok(vsLibrary[0].measures.donorFraction > 0.05, String(vsLibrary[0].measures.donorFraction));
});
