// The spectral reference library (S7): reference spectra kept across experiments, per
// instrument, in the library (records of kind SPECTRA_RECORDS, one per instrument: { name,
// instrument, entries }). A new experiment's controls are compared with the library to catch a
// changed dye (a degraded tandem, a new lot, a realigned laser), and a fluorochrome without a
// control can be unmixed with its library spectrum.
//
// Spectra are compared peak-normalized, detector by detector: the largest difference says how
// far apart they are where it matters (cosine similarity barely moves when a tandem loses 5% of
// its emission to its donor; the donor's detector moves by 0.05).

export const SPECTRA_RECORDS = 'spectra';

// A spectrum differing from the library by more than this in any detector (peak-normalized) has
// changed. Independent controls of one simulated instrument differ by ≤ 0.007; a tandem that
// lost 5% of its emission to its donor differs by 0.05.
export const LIBRARY_TOLERANCE = 0.03;

const norm = (name) => String(name ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');

function peakNormalized(values) {
  let peak = 0;
  for (const v of values) if (v > peak) peak = v;
  return Float64Array.from(values, (v) => (peak > 0 ? v / peak : 0));
}

// { maxDiff, at (index of the largest difference), cosine } of two spectra on the same detectors.
export function compareSpectra(a, b) {
  const x = peakNormalized(a);
  const y = peakNormalized(b);
  let dot = 0; let nx = 0; let ny = 0; let maxDiff = 0; let at = -1;
  for (let i = 0; i < x.length; i += 1) {
    dot += x[i] * y[i];
    nx += x[i] * x[i];
    ny += y[i] * y[i];
    const d = Math.abs(x[i] - y[i]);
    if (d > maxDiff) { maxDiff = d; at = i; }
  }
  return { maxDiff, at, cosine: nx && ny ? dot / Math.sqrt(nx * ny) : 0, signed: at >= 0 ? x[at] - y[at] : 0 };
}

// An entry's spectrum on the given detectors (by name), or null when it lacks any of them.
export function spectrumOn(entry, detectors) {
  const index = new Map(entry.detectors.map((d, i) => [d, i]));
  if (!detectors.every((d) => index.has(d))) return null;
  return Float64Array.from(detectors, (d) => entry.spectrum[index.get(d)]);
}

// A library entry for a reference spectrum.
export function libraryEntry({ fluorochrome, marker = '', spectrum, detectors, peakDetector = null, date = null, file = null, sha256 = null, workspace = null, carrier = null, quality = null }) {
  return {
    id: `${norm(fluorochrome).replace(/ /g, '-')}-${(sha256 ?? `${file}-${date}`).slice(0, 16)}`,
    fluorochrome,
    marker,
    detectors: [...detectors],
    spectrum: Array.from(peakNormalized(spectrum), (v) => +v.toFixed(6)),
    peakDetector,
    date,
    file,
    sha256,
    workspace,
    carrier,
    quality,
    added: new Date().toISOString(),
  };
}

// A record with entries added (an entry replaces one with the same id), newest last.
export function withEntries(record, entries) {
  const ids = new Set(entries.map((e) => e.id));
  const all = [...(record.entries ?? []).filter((e) => !ids.has(e.id)), ...entries]
    .sort((a, b) => String(a.date ?? a.added).localeCompare(String(b.date ?? b.added)));
  return { ...record, entries: all, modified: new Date().toISOString() };
}

// The latest entries of each fluorochrome that cover the detectors (optionally acquired before
// a date): Map normalized name → entry.
export function latestEntries(record, detectors, before = null) {
  const out = new Map();
  for (const e of record?.entries ?? []) {
    if (before && e.date && e.date >= before) continue;
    if (!spectrumOn(e, detectors)) continue;
    out.set(norm(e.fluorochrome), e);
  }
  return out;
}

// Each reference compared with the library's latest entry of its fluorochrome: [{ name, entry,
// maxDiff, detector, signed, cosine, status: 'match' | 'changed' | 'new' }].
export function compareWithLibrary(references, record, detectors, options = {}) {
  const tolerance = options.tolerance ?? LIBRARY_TOLERANCE;
  const latest = latestEntries(record, detectors, options.before ?? null);
  return references.map(({ name, spectrum }) => {
    const entry = latest.get(norm(name));
    if (!entry) return { name, entry: null, status: 'new' };
    const c = compareSpectra(spectrum, spectrumOn(entry, detectors));
    return { name, entry, maxDiff: c.maxDiff, detector: detectors[c.at] ?? null, signed: c.signed, cosine: c.cosine, status: c.maxDiff > tolerance ? 'changed' : 'match' };
  });
}

// Library fluorochromes with no reference in the panel: [entry] (the latest of each).
export function missingFromPanel(record, detectors, names) {
  const have = new Set(names.map(norm));
  return [...latestEntries(record, detectors).values()].filter((e) => !have.has(norm(e.fluorochrome)));
}
