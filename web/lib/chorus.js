// Gates BD FACSChorus recorded in its FCS files (FACSDiscover S8 and A8, FACSMelody): every FCS
// file FACSChorus writes carries the recording's gates in its BDCHORUSDATARECORD keyword, as JSON
// (RecordingConfiguration.AnalysisModel.Gates). FACSChorus has one gate set per panel and cannot
// export gates in any other form, so this is how they reach other software.
//
// Each gate is a GateKind (Polygon and Rectangle are what FACSChorus draws; Saturated and
// Unsaturated are its automatic gates), two Parameters (named as the FCS file names them), its
// Vertices in data values, the population it defines (Children[0], whose PopulationId is
// "<GateId>-1") and its parent (ParentPopulationId, "0-1" for all events). A gate's edges are
// straight on the axes it was drawn on, each Linear, Log or Biexponential. Linear and log axes
// are reproduced exactly; FACSChorus chooses a biexponential axis' width automatically and does
// not record it, so a polygon on one is imported with straight edges in data values and marked
// approximated (GateLab, which reads the same record, measured such gates within 2.4% of
// FACSChorus's own counts). Rectangles are exact on any axis.
//
// The record is large (most of a megabyte), so a sample keeps only its gates (chorusGates), and
// importChorus turns the gates of one or more samples into the result of importFlowJo, for the
// same import dialog and report. FACSChorus does not store its counts in the file, so the report
// has nothing to compare with until counts are added from FACSChorus's statistics export.

import { newId } from './gates.js';

const AUTOMATIC = new Set(['Saturated', 'Unsaturated']);
const ROOT = '0-1';

// The gates of a FACSChorus record, compactly, or null when the keywords carry none:
// { software, version, cytometer, gates: [{ id, kind, name, population, parent, inputs,
// parameters: [{ name, scale }], vertices: [[x, y]] }] }.
export function chorusGates(keywords) {
  const text = keywords?.BDCHORUSDATARECORD;
  if (!text) return null;
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  const model = record?.RecordingConfiguration?.AnalysisModel ?? record?.recordingConfiguration?.analysisModel;
  const gates = model?.Gates ?? model?.gates;
  if (!Array.isArray(gates)) return null;
  const get = (o, key) => o?.[key] ?? o?.[key[0].toLowerCase() + key.slice(1)];
  return {
    software: 'FACSChorus',
    version: String(keywords.CREATOR ?? '').replace(/^BD\s+FACSChorus\s*/i, '') || null,
    cytometer: keywords.$CYT ?? null,
    gates: gates.map((g) => {
      const child = (get(g, 'Children') ?? [])[0] ?? {};
      return {
        id: String(get(g, 'GateId') ?? ''),
        kind: String(get(g, 'GateKind') ?? ''),
        name: String(get(child, 'Name') ?? get(g, 'Name') ?? ''),
        population: String(get(child, 'PopulationId') ?? `${get(g, 'GateId')}-1`),
        parent: String(get(g, 'ParentPopulationId') ?? ROOT),
        inputs: get(g, 'InputPopulationIds') ?? null,
        color: get(child, 'Color') ?? null,
        parameters: (get(g, 'Parameters') ?? []).map((p) => ({ name: String(get(p, 'Name') ?? ''), scale: String(get(p, 'Scale') ?? 'Linear') })),
        vertices: (get(g, 'Vertices') ?? []).map((v) => [Number(get(v, 'X')), Number(get(v, 'Y'))]),
      };
    }),
  };
}

// The scale a gate's axis is straight on, for a channel of `range`.
function axisSpec(scale, range) {
  if (/^log/i.test(scale)) return { spec: { type: 'log', min: 1, max: range }, exact: true };
  return { spec: { type: 'linear', min: 0, max: range }, exact: !/^biex/i.test(scale) };
}

const rgb = (color) => {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(color ?? ''));
  return m ? `#${m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}` : null;
};

// Imports the FACSChorus gates of samples ([{ id, name, fileName, eventCount, channels,
// acquisitionGates }]) as importFlowJo's result (format 'chorus'): one result sample per sample,
// matched to it by file name.
export function importChorus(samples) {
  const warnings = [];
  const fidelity = [];
  const out = [];
  for (const sample of samples) {
    const record = sample.acquisitionGates;
    if (!record?.gates?.length) continue;
    const name = sample.fileName ?? sample.name;
    const note = (path, status, detail) => fidelity.push({ sample: name, sampleId: sample.id, path, status, detail });
    const rangeOf = (channel) => sample.channels?.find((c) => c.name === channel)?.range ?? 262144;
    const hasChannel = (channel) => !sample.channels || sample.channels.some((c) => c.name === channel);
    const byParent = new Map();
    for (const g of record.gates) byParent.set(g.parent, [...(byParent.get(g.parent) ?? []), g]);
    const gates = [];
    const transforms = {};
    const seen = new Set();
    const visit = (g, parentPath, parentId, belowAutomatic, lost = false) => {
      if (AUTOMATIC.has(g.kind)) {
        // FACSChorus's saturation filter: its children are kept under its parent.
        for (const child of byParent.get(g.population) ?? []) visit(child, parentPath, parentId, g.kind, lost);
        return;
      }
      let path = parentPath ? `${parentPath}/${g.name || `Gate ${g.id}`}` : g.name || `Gate ${g.id}`;
      if (seen.has(path)) path = `${path} (${g.id})`;
      seen.add(path);
      const details = [];
      let status = 'imported';
      let gate = null;
      try {
        if (lost) throw new Error('its parent population could not be imported');
        if (g.inputs?.length) throw new Error(`FACSChorus Boolean populations (${g.kind}) are not read yet`);
        if (!['Polygon', 'Rectangle'].includes(g.kind)) throw new Error(`the FACSChorus gate kind "${g.kind}" is not supported`);
        if (g.parameters.length !== 2) throw new Error(`the gate names ${g.parameters.length} parameters, not 2`);
        const missing = g.parameters.filter((p) => !hasChannel(p.name));
        if (missing.length) throw new Error(`the file has no parameter ${missing.map((p) => `"${p.name}"`).join(', ')}`);
        const vertices = g.vertices.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
        const axes = g.parameters.map((p) => ({ ...axisSpec(p.scale, rangeOf(p.name)), p }));
        const dims = axes.map((a) => ({ channel: a.p.name, transform: a.spec }));
        // Linear and log axes are FACSChorus's scales; a biexponential one is not (its width is
        // unrecorded), so the channel keeps CytoWeave's scale for plots.
        axes.forEach((a, k) => { if (a.exact && !transforms[dims[k].channel]) transforms[dims[k].channel] = dims[k].transform; });
        const forward = (k, v) => {
          const { spec } = axes[k];
          return spec.type === 'log' ? (v > 0 ? Math.log10(v / spec.min) / Math.log10(spec.max / spec.min) : -Infinity) : (v - spec.min) / (spec.max - spec.min);
        };
        const base = { id: newId('g'), name: g.name || `Gate ${g.id}`, parentId, dims, scope: null, overrides: {}, meta: { origin: 'imported', source: 'chorus', compensated: [false, false], flowJo: { path, key: `${path}|${g.kind}|${g.parameters.map((p) => p.name).join('|')}` } } };
        const color = rgb(g.color);
        if (color) base.color = color;
        if (g.kind === 'Rectangle') {
          if (vertices.length < 2) throw new Error('the rectangle has fewer than 2 corners');
          const xs = vertices.map(([x]) => forward(0, x));
          const ys = vertices.map(([, y]) => forward(1, y));
          gate = { ...base, type: 'rectangle', geometry: { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] } };
        } else {
          if (vertices.length < 3) throw new Error('the polygon has fewer than 3 vertices');
          gate = { ...base, type: 'polygon', geometry: { vertices: vertices.map(([x, y]) => [forward(0, x), forward(1, y)]) } };
          const biex = axes.filter((a) => !a.exact).map((a) => a.p.name);
          if (biex.length) {
            status = 'approximated';
            details.push(`drawn on a biexponential axis (${biex.join(', ')}) whose width FACSChorus chose automatically and did not record; the outline is straight in data values here, so events near its edges may differ`);
          }
        }
        if (belowAutomatic) {
          status = 'approximated';
          details.push(belowAutomatic === 'Saturated' ? 'under FACSChorus\'s automatic Saturated gate, which is not applied: unsaturated events are counted too' : 'under FACSChorus\'s automatic Unsaturated gate, which is not applied: saturated events are counted');
        }
        gates.push(gate);
        note(path, status, details.join('; ') || 'exact');
      } catch (error) {
        note(path, 'unsupported', error.message);
      }
      for (const child of byParent.get(g.population) ?? []) visit(child, path, gate?.id ?? null, belowAutomatic, !gate);
    };
    for (const g of byParent.get(ROOT) ?? []) visit(g, '', null, false);
    const automatic = record.gates.filter((g) => AUTOMATIC.has(g.kind));
    if (automatic.length) warnings.push(`${name}: FACSChorus's automatic ${automatic.map((g) => g.kind).join(' and ')} gate${automatic.length > 1 ? 's were' : ' was'} not imported (CytoWeave's QC flags saturated events instead).`);
    out.push({ name, uri: sample.fileName ?? '', fileName: sample.fileName ?? name, sampleId: sample.id, keywords: {}, groupNames: [], eventCount: sample.eventCount ?? null, compensation: null, transforms, gates, populationCounts: {} });
  }
  const first = samples.find((s) => s.acquisitionGates)?.acquisitionGates;
  return { version: first?.version ?? null, flowJoVersion: null, format: 'chorus', samples: out, groups: [], warnings, fidelity };
}
