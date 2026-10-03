// The robustness check of a two-group comparison on the app's samples (lib/multiverse.js), shared
// by Compare and the agents' check_robustness: the loaded views, the other compensations to try
// (the files' matrix and the workspace's), QC re-run with stricter and looser settings when asked,
// and the gates adapted to each sample (one gate per subject in a paired design).

import { adaptPath, choicesFor, denominatorOf, pathGates, qcGateOf, runMultiverseAsync, specifications, summarize } from '../lib/multiverse.js';
import { DEFAULT_SETTINGS, QC_CHANNEL, runQC } from './qc-run.js';

// input: { statistic ({ stat, gateId, channel?, ancestorId?, value? }), samples ([{ id, group: 0 |
// 1, pair }]), design ('two' | 'paired-two'), pairField (metadata field, paired designs), labels
// ([A, B]), qcReruns, max (64), signal, onProgress (message, fraction) }. The samples must be
// loaded. Returns { summary, results, choices, adapted }.
export async function checkRobustness(app, input) {
  const { store, data } = app;
  const ws = store.ws;
  const { statistic, samples, design } = input;
  const signal = input.signal ?? { aborted: false };
  const step = (message, fraction) => input.onProgress?.(message, fraction);
  const cancelled = () => Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
  const views = new Map(samples.map((s) => [s.id, data.view(s.id)]));
  if ([...views.values()].some((v) => !v)) throw new Error('Load every sample first.');
  const ancestorId = denominatorOf(ws, statistic);
  const gates = pathGates(ws, statistic.gateId, ancestorId);
  const temporary = [];
  try {
    step('Adapting the gates to each sample', 0.05);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let adapted = null;
    try {
      adapted = adaptPath(ws, gates, views, { groupBy: design === 'paired-two' ? input.pairField : undefined });
    } catch {
      adapted = null;
    }
    // QC re-run with stricter and looser settings, as temporary channels.
    const qcVariants = [];
    if (qcGateOf(gates, QC_CHANNEL) && input.qcReruns) {
      const base = structuredClone(app.qcState?.settings ?? DEFAULT_SETTINGS);
      const variants = [{ id: 'mad4', label: 'stricter (MAD 4)', mad: 4 }, { id: 'mad8', label: 'looser (MAD 8)', mad: 8 }];
      let done = 0;
      for (const variant of variants) {
        const channel = `${QC_CHANNEL} · MAD ${variant.mad}`;
        for (const s of samples) {
          if (signal.aborted) throw cancelled();
          step(`Re-running QC with MAD ${variant.mad}`, 0.1 + (0.3 * done) / (variants.length * samples.length));
          const result = await runQC(app, ws.samples.find((x) => x.id === s.id), { ...base, mad: variant.mad });
          views.get(s.id).setDerived(channel, Float32Array.from(result.mask));
          temporary.push([s.id, channel]);
          done += 1;
        }
        qcVariants.push({ id: variant.id, label: variant.label, channel });
      }
    }
    // Other compensations: the files' own matrix and the workspace's matrices.
    const assigned = new Set(samples.map((s) => ws.samples.find((x) => x.id === s.id)?.compensationId ?? 'none'));
    const one = assigned.size === 1 ? [...assigned][0] : null;
    const compensations = [];
    if (one !== 'file' && [...views.values()].some((view) => data.compensationFor({ compensationId: 'file' }, view))) compensations.push({ id: 'file', label: 'the files\' matrix ($SPILLOVER)' });
    for (const comp of ws.compensations) if (comp.id !== one && compensations.length < 3) compensations.push({ id: comp.id, label: comp.name });
    const setCompensation = (vs, id) => {
      for (const view of vs.values()) {
        if (id === 'declared') data.syncCompensation(view);
        else view.setCompensation(data.compensationFor({ compensationId: id }, view));
      }
    };
    const counts = design === 'paired-two' ? [new Set(samples.filter((s) => s.pair !== null && s.pair !== undefined).map((s) => s.pair)).size] : [samples.filter((s) => s.group === 0).length, samples.filter((s) => s.group === 1).length];
    const choices = choicesFor({ ws, gateId: statistic.gateId, ancestorId, design, counts, adapted, compensations, qcVariants, qcChannel: QC_CHANNEL });
    const specs = specifications(choices, { max: input.max ?? 64 });
    const results = await runMultiverseAsync({ ws, views, samples, design, statistic, choices, specs, gateId: statistic.gateId, ancestorId, adapted, setCompensation, signal, onProgress: (f) => step(`Analysing ${specs.length} specifications`, 0.4 + 0.6 * f) });
    return { summary: summarize(results, choices, { labels: input.labels }), results, choices, adapted };
  } finally {
    for (const [id, channel] of temporary) views.get(id)?.removeDerived(channel);
  }
}
