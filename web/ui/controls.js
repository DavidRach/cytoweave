// Spillover from the workspace's single-stain controls, shared by the Compensate view and agents.

import { computeSpillover, compensate, spilloverSpreading } from '../lib/compensation.js';
import { population } from '../lib/engine.js';
import { fitNoise, noiseRecord, spreadModel, spreadRecord } from '../lib/spread.js';

// Whether a channel is one of a sample's fluorescence detectors.
export function isDetectorOf(sample, channel) {
  return Boolean(channel) && (sample.channels ?? []).some((c) => c.name === channel && c.type === 'fluorescence');
}

// Whether the workspace's files are spectral (more detectors than fluorochromes): they are
// unmixed, not compensated.
export function spectralWorkspace(ws) {
  return ws.samples.some((s) => s.technology === 'spectral');
}

// Computes a spillover matrix from the single-stain controls (role "single-stain" with a stained
// channel), each restricted to `gateId` (null: all events), with an unstained sample as the
// negative reference when given. Returns { detectors, matrix, report, spreading, spread,
// controls }: spread is the spread model fitted to the controls (virtual-fmo.js), kept with the
// compensation, or null with fewer than three controls or when it cannot be fitted.
export async function spilloverFromControls(data, ws, { gateId = null, unstainedId = null, method = 'median', onProgress } = {}) {
  const stained = ws.samples.filter((s) => s.role === 'single-stain' && s.stain);
  // Each control's stained channel must be one of its file's detectors. Spectral reference
  // controls name their fluorochrome instead (BUV395), which unmixing uses, not compensation.
  const usable = stained.filter((s) => isDetectorOf(s, s.stain));
  if (usable.length < 2) {
    const named = stained.filter((s) => !usable.includes(s));
    if (named.length) throw new Error(`The single-stain controls name ${named.length === 1 ? 'a fluorochrome' : 'fluorochromes'} (${named.slice(0, 3).map((s) => s.stain).join(', ')}${named.length > 3 ? ', …' : ''}), not the detectors their files record. Compensation needs each control's detector; spectral files, with more detectors than fluorochromes, are unmixed in the Spectral view instead.`);
    throw new Error('At least two single-stain controls with a stained channel are needed.');
  }
  const detectors = [...new Set(usable.map((c) => c.stain))];
  const pick = (view, indices, channel) => {
    const column = view.raw.get(channel);
    if (!indices) return column;
    const out = new Float32Array(indices.length);
    for (let i = 0; i < indices.length; i += 1) out[i] = column[indices[i]];
    return out;
  };
  const inputs = [];
  const ranges = {};
  for (const [i, control] of usable.entries()) {
    const view = await data.ensure(control.id);
    const indices = population(view, ws, gateId);
    const columns = {};
    for (const d of detectors) {
      if (!view.raw.has(d)) continue;
      columns[d] = pick(view, indices ?? null, d);
      // Saturated events are judged against each detector's own range ($PnR).
      ranges[d] ??= view.channelInfo(d)?.range || undefined;
    }
    inputs.push({ channel: control.stain, columns, name: control.name });
    onProgress?.((i + 1) / (usable.length + 1), `Reading ${control.name}`);
  }
  let unstained = null;
  if (unstainedId) {
    const view = await data.ensure(unstainedId);
    const indices = population(view, ws, gateId);
    unstained = { columns: Object.fromEntries(detectors.filter((d) => view.raw.has(d)).map((d) => [d, pick(view, indices ?? null, d)])) };
  }
  const result = computeSpillover(inputs, detectors, { method, unstained, range: 262144, ranges });
  const compensatedControls = inputs.map((input) => ({ channel: input.channel, raw: input.columns, columns: compensate(input.columns, { channels: detectors, matrix: result.matrix }) }));
  const spreading = spilloverSpreading(compensatedControls, detectors, { range: 262144, ranges });
  const report = result.report.map((r, k) => ({ ...r, control: inputs[k]?.name }));
  // The instrument's noise, fitted to the controls' spread (spread.js): what virtual FMOs predict
  // from. A compensation's spectra are its spillover rows.
  let spread = null;
  if (spreading.observations.length >= 3) {
    try {
      const n = detectors.length;
      const rows = Array.from({ length: n }, (_, i) => Array.from(result.matrix.slice(i * n, i * n + n)));
      const model = spreadModel({ names: detectors, detectors, spectra: rows });
      spread = spreadRecord({ names: detectors, detectors, spectra: rows, channels: detectors, noise: noiseRecord(model, fitNoise(model, spreading.observations), { controls: spreading.observations.length }), source: 'single-stain controls' });
    } catch {
      spread = null;
    }
  }
  return { detectors, matrix: result.matrix, report, spreading, spread, controls: usable };
}
