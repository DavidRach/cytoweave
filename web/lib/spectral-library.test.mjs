import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSpectra, compareWithLibrary, latestEntries, libraryEntry, missingFromPanel, spectrumOn, withEntries } from './spectral-library.js';

const detectors = ['V1-A', 'V2-A', 'B1-A', 'B2-A', 'YG1-A'];
const pe = [0, 0.02, 0.3, 0.6, 1];
const fitc = [0, 0.1, 1, 0.4, 0.05];

test('spectra are compared peak-normalized, detector by detector', () => {
  const c = compareSpectra(pe.map((v) => 3 * v), pe);
  assert.ok(c.maxDiff < 1e-12 && Math.abs(c.cosine - 1) < 1e-12, 'scale does not matter');
  const shifted = compareSpectra([0, 0.02, 0.3, 0.66, 1], pe);
  assert.equal(shifted.at, 3);
  assert.ok(Math.abs(shifted.maxDiff - 0.06) < 1e-9 && shifted.signed > 0);
});

test('entries map onto a panel\'s detectors by name, and the latest wins', () => {
  const e1 = libraryEntry({ fluorochrome: 'PE', spectrum: pe, detectors, date: '2026-01-05', sha256: 'a'.repeat(64) });
  const e2 = libraryEntry({ fluorochrome: 'pe', spectrum: [0, 0.02, 0.3, 0.6, 0.98], detectors, date: '2026-02-05', sha256: 'b'.repeat(64) });
  const e3 = libraryEntry({ fluorochrome: 'FITC', spectrum: fitc, detectors, date: '2026-02-05', sha256: 'c'.repeat(64) });
  let record = withEntries({ name: 'Aurora' }, [e2, e1]);
  record = withEntries(record, [e3, e1]);
  assert.equal(record.entries.length, 3, 'an entry replaces itself');
  // Another panel order, and a panel the entry does not cover.
  assert.deepEqual(Array.from(spectrumOn(e1, ['YG1-A', 'B1-A'])), [1, 0.3]);
  assert.equal(spectrumOn(e1, ['R1-A']), null);
  assert.equal(latestEntries(record, detectors).get('pe').date, '2026-02-05');
  assert.equal(latestEntries(record, detectors, '2026-02-01').get('pe').date, '2026-01-05');
  // A degraded tandem is caught; a new fluorochrome is new; library dyes missing from the panel are offered.
  const rows = compareWithLibrary([{ name: 'PE', spectrum: [0, 0.02, 0.38, 0.6, 1] }, { name: 'FITC', spectrum: fitc }, { name: 'APC', spectrum: pe }], record, detectors);
  assert.deepEqual(rows.map((r) => r.status), ['changed', 'match', 'new']);
  assert.equal(rows[0].detector, 'B1-A');
  assert.deepEqual(missingFromPanel(record, detectors, ['FITC']).map((e) => e.fluorochrome), ['pe']);
});
