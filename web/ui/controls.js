// Spillover from the workspace's single-stain controls, shared by the Compensate view and agents.

import { computeSpillover, compensate, spilloverSpreading } from '../lib/compensation.js';
import { population } from '../lib/engine.js';

// Computes a spillover matrix from the single-stain controls (role "single-stain" with a stained
// channel), each restricted to `gateId` (null: all events), with an unstained sample as the
// negative reference when given. Returns { detectors, matrix, report, spreading, controls }.
export async function spilloverFromControls(data, ws, { gateId = null, unstainedId = null, method = 'median', onProgress } = {}) {
  const usable = ws.samples.filter((s) => s.role === 'single-stain' && s.stain);
  if (usable.length < 2) throw new Error('At least two single-stain controls with a stained channel are needed.');
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
  return { detectors, matrix: result.matrix, report, spreading, controls: usable };
}
