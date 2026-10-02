// Module worker for spectral flow cytometry: reference spectra, unmixing, autofluorescence and
// unmixing diagnostics (web/lib/spectral.js).
//
// Protocol (see cytoweave-spec/conventions.md): the page posts { id, type, payload }; the worker
// replies { id, progress: [fraction, message] } zero or more times, then { id, result } or
// { id, error }. Typed arrays in results are transferred, not copied; transfer the detector
// columns in (they are not modified).
//
// Types and payloads (columns: Float32Array[] in detector order, or { [detector]: Float32Array }):
//   'unmixOLS' | 'unmixWLS' | 'unmixNNLS'   { columns, spectra, options }
//   'unmixWithAutofluorescence'             { columns, spectra, afSignatures, options }
//   'extractAutofluorescence'               { columns, detectors, options }
//   'referenceSpectrum'                     { columns, detectors, positive, negative, options }
//   'autoGateControl'                       { columns, detectors, options }
//   'similarityMatrix'                      { spectra }
//   'complexityIndex'                       { spectra }                → { complexityIndex }
//   'spectralSpreading'                     { controls, names, options }
//   'unmixingResidualReport'                { columns, spectra, abundances, options }
//   'compareUnmixing'                       { columns, models, options }
//   'unmixModel'                            { columns, model, options } → unmixModel() result
// Composite jobs used by the Spectral view (one transfer of the data, several steps):
//   'referenceFromControl'  { columns, detectors, unstained?, options: { negative: 'internal' |
//                           'unstained', peakDetector?, name?, seed?, range? } }
//                           → { gate: counts, peak and warnings, reference | null, error? }
//   'residualCheck'         { columns, model, options } → { report, names, medianResidual }
//   'spreadingFromControls' { controls: [{ fluorochrome, columns, peakDetector?, negative? }],
//                           unstained?, detectors, spectra, options } → spectralSpreading()
//   'cancel'                                { id }                     → cancels a waiting job
// A running job can be stopped through payload.abort, an Int32Array on a SharedArrayBuffer whose
// first element the page sets to 1 (needs cross-origin isolation), or by terminating the worker.

import { median } from '../lib/compensation.js';
import {
  autoGateControl,
  compareUnmixing,
  complexityIndex,
  extractAutofluorescence,
  referenceMatrix,
  referenceSpectrum,
  similarityMatrix,
  spectralSpreading,
  unmixingResidualReport,
  unmixModel,
  unmixNNLS,
  unmixOLS,
  unmixWithAutofluorescence,
  unmixWLS,
} from '../lib/spectral.js';

const cancelledIds = new Set();

function signalFor(id, payload) {
  const flag = payload?.abort instanceof Int32Array ? payload.abort : null;
  return {
    get aborted() {
      return cancelledIds.has(id) || (flag ? Atomics.load(flag, 0) !== 0 : false);
    },
  };
}

function progressFor(id) {
  let last = 0;
  return (fraction, message) => {
    const now = Date.now();
    if (now - last < 100 && fraction < 1) return;
    last = now;
    self.postMessage({ id, progress: [fraction, message] });
  };
}

// Every distinct ArrayBuffer under value (shared buffers cannot be transferred).
function transferables(value, found = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) found.add(value.buffer);
    return found;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) transferables(item, found, seen);
  return found;
}

const handlers = {
  unmixOLS: ({ columns, spectra, options = {} }, common) => unmixOLS(columns, spectra, { ...options, ...common }),
  unmixWLS: ({ columns, spectra, options = {} }, common) => unmixWLS(columns, spectra, { ...options, ...common }),
  unmixNNLS: ({ columns, spectra, options = {} }, common) => unmixNNLS(columns, spectra, { ...options, ...common }),
  unmixWithAutofluorescence: ({ columns, spectra, afSignatures, options = {} }, common) => unmixWithAutofluorescence(columns, spectra, afSignatures, { ...options, ...common }),
  extractAutofluorescence: ({ columns, detectors, options = {} }, common) => extractAutofluorescence(columns, detectors, { ...options, ...common }),
  referenceSpectrum: ({ columns, detectors, positive, negative, options = {} }) => referenceSpectrum(columns, detectors, positive, negative ?? null, options),
  autoGateControl: ({ columns, detectors, options = {} }) => autoGateControl(columns, detectors, options),
  similarityMatrix: ({ spectra }) => similarityMatrix(spectra),
  complexityIndex: ({ spectra }) => ({ complexityIndex: complexityIndex(spectra) }),
  spectralSpreading: ({ controls, names, options = {} }) => spectralSpreading(controls, names, options),
  unmixingResidualReport: ({ columns, spectra, abundances, options = {} }) => unmixingResidualReport(columns, spectra, abundances, options),
  compareUnmixing: ({ columns, models, options = {} }, common) => compareUnmixing(columns, models, { ...options, ...common }),
  unmixModel: ({ columns, model, options = {} }, common) => {
    const result = unmixModel(columns, model, { ...options, ...common });
    delete result.afSignatures;
    return result;
  },
  referenceFromControl: referenceFromControl,
  residualCheck: ({ columns, model, options = {} }, common) => {
    const result = unmixModel(columns, model, { ...options, ...common });
    const report = unmixingResidualReport(columns, model.spectra, result, options);
    return { report, names: result.names, medianResidual: result.residuals ? median(result.residuals) : Number.NaN };
  },
  spreadingFromControls: spreadingFromControls,
};

function gateOptions(options, unstained) {
  return {
    seed: options.seed ?? 1,
    peakDetector: options.peakDetector ?? undefined,
    unstainedColumns: options.negative === 'unstained' && unstained ? unstained : undefined,
    range: options.range,
  };
}

// Auto-gates a single-stain control and computes its reference spectrum.
function referenceFromControl({ columns, detectors, unstained = null, options = {} }) {
  const gate = autoGateControl(columns, detectors, gateOptions(options, unstained));
  const summary = {
    peakDetector: gate.peakDetector,
    positiveEvents: gate.positive.length,
    negativeEvents: gate.negative.length,
    negativeSource: gate.negativeSource,
    matchedNegatives: gate.matchedNegatives,
    threshold: gate.threshold,
    warnings: gate.warnings,
  };
  if (!gate.positive.length) return { gate: summary, reference: null, error: gate.warnings[0] ?? 'No positive events were found.' };
  try {
    const reference = referenceSpectrum(columns, detectors, gate.positive, gate.negative, {
      name: options.name,
      range: options.range,
      negativeColumns: gate.negativeSource === 'unstained' ? unstained : undefined,
    });
    return { gate: summary, reference };
  } catch (error) {
    return { gate: summary, reference: null, error: error.message };
  }
}

// Unmixes every control with the reference set (OLS) and computes the spillover spreading matrix.
function spreadingFromControls({ controls, unstained = null, detectors, spectra, options = {} }, common) {
  const names = referenceMatrix(spectra).names;
  let unstainedUnmixed = null;
  const list = [];
  controls.forEach((control, i) => {
    if (common.signal.aborted) throw Object.assign(new Error('The spectral analysis was cancelled.'), { name: 'AbortError' });
    common.onProgress(i / controls.length, `Unmixing the ${control.fluorochrome} control`);
    const gate = autoGateControl(control.columns, detectors, gateOptions({ ...options, peakDetector: control.peakDetector, negative: control.negative }, unstained));
    if (!gate.positive.length) return;
    const unmixed = unmixOLS(control.columns, spectra, { residuals: false });
    let negativeAbundances;
    if (gate.negativeSource === 'unstained') {
      unstainedUnmixed ??= unmixOLS(unstained, spectra, { residuals: false });
      negativeAbundances = unstainedUnmixed.abundances;
    }
    list.push({ fluorochrome: control.fluorochrome, abundances: unmixed.abundances, positive: gate.positive, negative: gate.negative, negativeAbundances });
  });
  common.onProgress(1, 'Spreading matrix');
  return spectralSpreading(list, names, options);
}

// Jobs run one at a time from a queue drained on a timer, so a 'cancel' posted while an earlier
// job runs can still remove a waiting job.
const queue = [];
let draining = false;

function run({ id, type, payload }) {
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`The spectral worker does not know "${type}".`);
    const signal = signalFor(id, payload);
    if (signal.aborted) throw Object.assign(new Error('The spectral analysis was cancelled.'), { name: 'AbortError' });
    const result = handler(payload ?? {}, { onProgress: progressFor(id), signal });
    self.postMessage({ id, result }, [...transferables(result)]);
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error), cancelled: error?.name === 'AbortError' });
  } finally {
    cancelledIds.delete(id);
  }
}

function drain() {
  draining = false;
  const job = queue.shift();
  if (job) run(job);
  if (queue.length && !draining) {
    draining = true;
    setTimeout(drain, 0);
  }
}

self.onmessage = (event) => {
  const message = event.data ?? {};
  if (message.type === 'cancel') {
    cancelledIds.add(message.payload?.id ?? message.id);
    return;
  }
  queue.push(message);
  if (!draining) {
    draining = true;
    setTimeout(drain, 0);
  }
};
