// Semantic comparison of two analyses: which gates, compensation matrices, scales and derived
// results were added, removed or changed, described in words a cytometrist would use. The Report
// view pairs this with the statistics before and after, so a reviewer sees what changed and what
// the change did to the numbers.

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function byId(list) {
  return new Map((list ?? []).map((item) => [item.id, item]));
}

function pathOf(gates, id) {
  const map = byId(gates);
  const names = [];
  let gate = map.get(id);
  const seen = new Set();
  while (gate && !seen.has(gate.id)) {
    seen.add(gate.id);
    names.unshift(gate.name);
    gate = gate.parentId ? map.get(gate.parentId) : null;
  }
  return names.join(' / ');
}

// Largest movement of a gate's vertices or bounds, in scale units (fractions of the axis).
export function geometryShift(type, a, b) {
  const flat = (g) => {
    switch (type) {
      case 'polygon': return g.vertices.flat();
      case 'rectangle': return [...g.min, ...g.max].map((v) => v ?? 0);
      case 'range': return [g.min ?? 0, g.max ?? 0];
      case 'ellipse': return [...g.center, ...g.radii, g.angle ?? 0];
      case 'quadrant': return g.center;
      case 'split': return [g.threshold];
      default: return [];
    }
  };
  const fa = flat(a);
  const fb = flat(b);
  if (fa.length !== fb.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < fa.length; i += 1) worst = Math.max(worst, Math.abs(fa[i] - fb[i]));
  return worst;
}

// before, after: workspaces (or checkpoints' snapshots with gates, compensations, channelSettings,
// derived). Returns { changes: [{ kind, action, id, name, detail }], summary }.
export function diffAnalyses(before, after) {
  const changes = [];
  const gatesA = byId(before.gates);
  const gatesB = byId(after.gates);
  for (const [id, gate] of gatesB) {
    const old = gatesA.get(id);
    if (!old) {
      changes.push({ kind: 'gate', action: 'added', id, name: pathOf(after.gates, id), detail: `${gate.type} gate on ${gate.dims.map((d) => d.channel).join(' × ') || 'populations'}` });
      continue;
    }
    const details = [];
    if (old.name !== gate.name) details.push(`renamed from "${old.name}"`);
    if (old.parentId !== gate.parentId) details.push(`moved from under ${old.parentId ? pathOf(before.gates, old.parentId) : 'all events'}`);
    if (!same(old.dims, gate.dims)) details.push('axes or scales changed');
    if (!same(old.geometry, gate.geometry)) {
      const shift = old.type === gate.type ? geometryShift(gate.type, old.geometry, gate.geometry) : Infinity;
      details.push(Number.isFinite(shift) ? `boundary moved by up to ${(shift * 100).toFixed(1)}% of the axis` : 'shape changed');
    }
    const oa = Object.keys(old.overrides ?? {});
    const ob = Object.keys(gate.overrides ?? {});
    const addedOverrides = ob.filter((s) => !oa.includes(s)).length;
    const removedOverrides = oa.filter((s) => !ob.includes(s)).length;
    const changedOverrides = ob.filter((s) => oa.includes(s) && !same(old.overrides[s], gate.overrides[s])).length;
    if (addedOverrides) details.push(`adjusted for ${addedOverrides} more sample(s)`);
    if (removedOverrides) details.push(`sample adjustments removed for ${removedOverrides} sample(s)`);
    if (changedOverrides) details.push(`sample adjustments changed for ${changedOverrides} sample(s)`);
    if (!same(old.scope ?? null, gate.scope ?? null)) details.push('now applies to different samples');
    if (old.type === 'boolean' && !same(old.geometry, gate.geometry)) details.push('boolean definition changed');
    if (details.length) changes.push({ kind: 'gate', action: 'changed', id, name: pathOf(after.gates, id), detail: details.join('; ') });
  }
  for (const [id, gate] of gatesA) {
    if (!gatesB.has(id)) changes.push({ kind: 'gate', action: 'removed', id, name: pathOf(before.gates, id), detail: `${gate.type} gate` });
  }
  const compA = byId(before.compensations);
  const compB = byId(after.compensations);
  for (const [id, comp] of compB) {
    const old = compA.get(id);
    if (!old) {
      changes.push({ kind: 'compensation', action: 'added', id, name: comp.name, detail: `${comp.channels.length}×${comp.channels.length} (${comp.source})` });
      continue;
    }
    if (!same(old.matrix, comp.matrix) || !same(old.channels, comp.channels)) {
      const n = comp.channels.length;
      let changed = 0;
      let worst = 0;
      let where = '';
      if (same(old.channels, comp.channels)) {
        for (let i = 0; i < n * n; i += 1) {
          const d = Math.abs(comp.matrix[i] - old.matrix[i]);
          if (d > 1e-12) changed += 1;
          if (d > worst) {
            worst = d;
            where = `${comp.channels[Math.floor(i / n)]} → ${comp.channels[i % n]}`;
          }
        }
        changes.push({ kind: 'compensation', action: 'changed', id, name: comp.name, detail: `${changed} value(s) changed; the largest, ${where}, by ${(worst * 100).toFixed(2)} percentage points` });
      } else {
        changes.push({ kind: 'compensation', action: 'changed', id, name: comp.name, detail: 'channels changed' });
      }
    }
  }
  for (const [id, comp] of compA) if (!compB.has(id)) changes.push({ kind: 'compensation', action: 'removed', id, name: comp.name, detail: '' });
  const scalesA = before.channelSettings ?? {};
  const scalesB = after.channelSettings ?? {};
  for (const channel of new Set([...Object.keys(scalesA), ...Object.keys(scalesB)])) {
    const a = scalesA[channel]?.transform;
    const b = scalesB[channel]?.transform;
    if (!same(a ?? null, b ?? null)) changes.push({ kind: 'scale', action: a && b ? 'changed' : b ? 'added' : 'removed', id: channel, name: channel, detail: b ? `${b.type}${b.type === 'logicle' ? ` (W ${b.W}, M ${b.M})` : b.type === 'arcsinh' ? ` (cofactor ${b.cofactor})` : ''}` : '' });
  }
  const assignA = new Map((before.samples ?? []).map((s) => [s.id, s.compensationId]));
  for (const sample of after.samples ?? []) {
    if (assignA.has(sample.id) && assignA.get(sample.id) !== sample.compensationId) changes.push({ kind: 'sample', action: 'changed', id: sample.id, name: sample.name, detail: `compensation ${assignA.get(sample.id)} → ${sample.compensationId}` });
  }
  const derivedA = byId(before.derived);
  const derivedB = byId(after.derived);
  for (const [id, d] of derivedB) if (!derivedA.has(id)) changes.push({ kind: 'result', action: 'added', id, name: d.name ?? d.kind, detail: d.method ?? d.kind });
  for (const [id, d] of derivedA) if (!derivedB.has(id)) changes.push({ kind: 'result', action: 'removed', id, name: d.name ?? d.kind, detail: d.method ?? d.kind });
  const count = (kind) => changes.filter((c) => c.kind === kind).length;
  const summary = changes.length
    ? [`${count('gate')} gate change(s)`, `${count('compensation')} compensation change(s)`, `${count('scale')} scale change(s)`, `${count('result')} result change(s)`].filter((s) => !s.startsWith('0 ')).join(', ')
    : 'No differences in the analysis.';
  return { changes, summary };
}

// The analysis part of a workspace, as kept in a checkpoint.
export function analysisSnapshot(ws) {
  return {
    gates: ws.gates,
    compensations: ws.compensations,
    channelSettings: ws.channelSettings,
    derived: (ws.derived ?? []).map(({ files, ...rest }) => rest),
    samples: ws.samples.map((s) => ({ id: s.id, name: s.name, compensationId: s.compensationId })),
  };
}
