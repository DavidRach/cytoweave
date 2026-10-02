import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFlowJoMigration,
  consensusTransforms,
  explainCountRows,
  matchFlowJoSamples,
  migrationCSV,
  migrationCountRows,
  missingFiles,
  normalizeSampleName,
  planCompensations,
  sameSpillover,
  scaleChanges,
  summarizeCountRows,
  summarizeFidelity,
} from './flowjo-match.js';
import { importFlowJo } from './flowjo.js';
import { compensate } from './compensation.js';
import { SampleView, countOf, population } from './engine.js';
import { createWorkspace, gateById } from './workspace.js';
import { createRandom } from './random.js';

const NS = 'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';
const dim = (name, { min, max } = {}) => `<gating:dimension${min !== undefined ? ` gating:min="${min}"` : ''}${max !== undefined ? ` gating:max="${max}"` : ''}><data-type:fcs-dimension data-type:name="${name}"/></gating:dimension>`;
const vertex = ([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
let ids = 0;
const pop = (name, count, gate, kids = '', attrs = '') => `<Population name="${name}" count="${count}"><Gate gating:id="ID${(ids += 1)}"${attrs}>${gate}</Gate><Subpopulations>${kids}</Subpopulations></Population>`;
const rect = (...dims) => `<gating:RectangleGate eventsInside="1">${dims.join('')}</gating:RectangleGate>`;
const poly = (x, y, vs) => `<gating:PolygonGate eventsInside="1">${dim(x)}${dim(y)}${vs.map(vertex).join('')}</gating:PolygonGate>`;

const SPILL = [1, 0.15, 0.04, 1];
const LYMPH = [[20000, 10000], [150000, 12000], [140000, 120000], [25000, 90000]];

function sampleXML(id, file, counts, { stimOnly = false, eventCount = 3000 } = {}) {
  const quads = [['Q1', { max: 500 }, { min: 800 }], ['Q2', { min: 500 }, { min: 800 }], ['Q3', { min: 500 }, { max: 800 }], ['Q4', { max: 500 }, { max: 800 }]]
    .map(([q, x, y]) => pop(`${q}: CD3 CD4`, counts[`Lymphocytes/CD3+/${q}: CD3 CD4`], rect(dim('Comp-FITC-A', x), dim('Comp-PE-A', y)), '', ` quadId="Q${id}"`)).join('');
  return `<Sample>
    <DataSet uri="file:/data/run%201/${encodeURIComponent(file)}" sampleID="${id}"/>
    <transforms:spilloverMatrix prefix="Comp-" name="Acquisition-defined" transforms:id="S${id}">
      <data-type:parameters><data-type:parameter data-type:name="FITC-A"/><data-type:parameter data-type:name="PE-A"/></data-type:parameters>
      <transforms:spillover data-type:parameter="FITC-A"><transforms:coefficient data-type:parameter="FITC-A" transforms:value="${SPILL[0]}"/><transforms:coefficient data-type:parameter="PE-A" transforms:value="${SPILL[1]}"/></transforms:spillover>
      <transforms:spillover data-type:parameter="PE-A"><transforms:coefficient data-type:parameter="FITC-A" transforms:value="${SPILL[2]}"/><transforms:coefficient data-type:parameter="PE-A" transforms:value="${SPILL[3]}"/></transforms:spillover>
    </transforms:spilloverMatrix>
    <Transformations>
      <transforms:linear transforms:minRange="0" transforms:maxRange="262144"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
      <transforms:linear transforms:minRange="0" transforms:maxRange="262144"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
      <transforms:biex transforms:maxRange="262144" transforms:neg="0" transforms:width="-100" transforms:pos="4.42"><data-type:parameter data-type:name="Comp-FITC-A"/></transforms:biex>
      <transforms:logicle transforms:T="262144" transforms:w="0.5" transforms:m="4.5" transforms:a="0"><data-type:parameter data-type:name="Comp-PE-A"/></transforms:logicle>
    </Transformations>
    <Keywords><Keyword name="$FIL" value="${file}"/><Keyword name="$TOT" value="${eventCount}"/></Keywords>
    <SampleNode name="${file}" count="${eventCount}" sampleID="${id}"><Subpopulations>
      ${pop('Lymphocytes', counts.Lymphocytes, poly('FSC-A', 'SSC-A', LYMPH),
    pop('CD3+', counts['Lymphocytes/CD3+'], rect(dim('Comp-FITC-A', { min: 500 })), quads)
    + (stimOnly ? pop('Activated', counts['Lymphocytes/Activated'], rect(dim('Comp-PE-A', { min: 5000 }))) : ''))}
    </Subpopulations></SampleNode>
  </Sample>`;
}

function workspaceXML(samples) {
  return `<Workspace version="20.0" flowJoVersion="10.9.0" ${NS}>
    <Groups>
      <GroupNode name="All Samples"><Group name="All Samples" builtIn="1"><SampleRefs>${samples.map((s) => `<SampleRef sampleID="${s.id}"/>`).join('')}</SampleRefs></Group></GroupNode>
      <GroupNode name="Stim"><Group name="Stim"><SampleRefs>${samples.filter((s) => s.stimOnly).map((s) => `<SampleRef sampleID="${s.id}"/>`).join('')}</SampleRefs></Group></GroupNode>
    </Groups>
    <SampleList>${samples.map((s) => sampleXML(s.id, s.file, s.counts, s)).join('')}</SampleList>
  </Workspace>`;
}

// Synthetic events and FlowJo's counts for them, computed in data units with FlowJo's definitions.
function syntheticSample(seed, n = 3000) {
  const random = createRandom(seed);
  const raw = { 'FSC-A': new Float32Array(n), 'SSC-A': new Float32Array(n), 'FITC-A': new Float32Array(n), 'PE-A': new Float32Array(n) };
  for (let e = 0; e < n; e += 1) {
    raw['FSC-A'][e] = Math.max(0, 80000 + 45000 * random.gaussian());
    raw['SSC-A'][e] = Math.max(0, 50000 + 30000 * random.gaussian());
    raw['FITC-A'][e] = random() < 0.5 ? 150 * random.gaussian() : 10 ** (2.5 + random() * 1.5);
    raw['PE-A'][e] = random() < 0.4 ? 200 * random.gaussian() : 10 ** (2.5 + random() * 2);
  }
  const comp = compensate({ 'FITC-A': raw['FITC-A'], 'PE-A': raw['PE-A'] }, { channels: ['FITC-A', 'PE-A'], matrix: SPILL });
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = LYMPH.length - 1; i < LYMPH.length; j = i, i += 1) {
      const [xi, yi] = LYMPH[i];
      const [xj, yj] = LYMPH[j];
      if ((yi > y) !== (yj > y) && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) c = !c;
    }
    return c;
  };
  const counts = { Lymphocytes: 0, 'Lymphocytes/CD3+': 0, 'Lymphocytes/Activated': 0 };
  for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) counts[`Lymphocytes/CD3+/${q}: CD3 CD4`] = 0;
  for (let e = 0; e < n; e += 1) {
    if (!inside(raw['FSC-A'][e], raw['SSC-A'][e])) continue;
    counts.Lymphocytes += 1;
    const f = comp['FITC-A'][e];
    const p = comp['PE-A'][e];
    if (p >= 5000) counts['Lymphocytes/Activated'] += 1;
    if (f < 500) continue;
    counts['Lymphocytes/CD3+'] += 1;
    // All four quadrants sit under CD3+ (x ≥ 500), so Q1 and Q4 (x < 500) are empty.
    counts[`Lymphocytes/CD3+/${f >= 500 ? (p >= 800 ? 'Q2' : 'Q3') : (p >= 800 ? 'Q1' : 'Q4')}: CD3 CD4`] += 1;
  }
  const parameters = ['FSC-A', 'SSC-A', 'FITC-A', 'PE-A'].map((name, index) => ({ index, name, label: '', type: name.includes('SC') ? 'scatter' : 'fluorescence', range: 262144 }));
  const dataset = { parameters, eventCount: n, data: parameters.map((p) => raw[p.name]), keywords: {} };
  return { dataset, counts };
}

function wsSample(id, fileName, eventCount, keywords = {}) {
  return { id, name: fileName.replace(/\.fcs$/i, ''), fileName, eventCount, keywords, channels: [{ name: 'FITC-A', label: '' }, { name: 'PE-A', label: '' }], compensationId: 'none', meta: {}, role: 'sample' };
}

test('sample names normalize for matching', () => {
  assert.equal(normalizeSampleName('file:/data/run%201/A1%20Unstim.FCS'), 'a1 unstim');
  assert.equal(normalizeSampleName('C:\\data\\B2  stim.fcs'), 'b2 stim');
  assert.equal(normalizeSampleName(undefined), '');
});

test('FlowJo samples match workspace samples by file name, $FIL and name', () => {
  const flowJo = [
    { name: 'A1.fcs', fileName: 'A1.fcs', keywords: {}, eventCount: 100 },
    { name: 'renamed in FlowJo', fileName: 'tube_002.fcs', keywords: { $FIL: 'B2.fcs' }, eventCount: 200 },
    { name: 'C3', fileName: '', keywords: {}, eventCount: 300 },
    { name: 'D4.fcs', fileName: 'D4.fcs', keywords: {}, eventCount: 400 },
    { name: 'A1 copy', fileName: 'A1.fcs', keywords: {}, eventCount: 100 },
  ];
  const workspace = [wsSample('s1', 'A1.fcs', 100), wsSample('s2', 'B2.fcs', 200), wsSample('s3', 'C3.fcs', 999)];
  const matches = matchFlowJoSamples(flowJo, workspace);
  assert.deepEqual(matches.map((m) => [m.sample?.id ?? null, m.how]), [['s1', 'file name'], ['s2', '$FIL keyword'], ['s3', 'sample name'], [null, null], [null, null]]);
  assert.match(matches[2].note, /FlowJo recorded 300 events; the file has 999/);
  assert.match(matches[4].note, /already matched/);
  assert.deepEqual(missingFiles(matches), ['D4.fcs', 'A1.fcs']);
});

test('fidelity summaries, scale consensus and compensation plans', () => {
  const summary = summarizeFidelity([
    { sample: 'a', path: 'A', status: 'imported', detail: 'exact' },
    { sample: 'b', path: 'A', status: 'approximated', detail: 'x; y' },
    { sample: 'a', path: 'A/B', status: 'unsupported', detail: 'z' },
    { sample: 'a', path: 'transform:PerCP', status: 'unsupported', detail: 'w' },
  ]);
  assert.deepEqual(summary.counts, { imported: 0, approximated: 1, unsupported: 1 });
  assert.deepEqual(summary.paths.map((p) => [p.path, p.status]), [['A/B', 'unsupported'], ['A', 'approximated']]);
  assert.equal(summary.transforms.length, 1);

  const logicle = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
  const consensus = consensusTransforms([{ transforms: { 'PE-A': logicle } }, { transforms: { 'PE-A': { ...logicle, W: 1 } } }, { transforms: { 'PE-A': { ...logicle } } }]);
  assert.deepEqual(consensus, { 'PE-A': logicle });
  assert.deepEqual(scaleChanges({ channelSettings: { 'PE-A': { transform: { type: 'linear', min: 0, max: 262144 } } } }, { ...consensus, 'FITC-A': logicle }), { differ: ['PE-A'], unset: ['FITC-A'] });

  assert.ok(sameSpillover({ channels: ['A', 'B'], matrix: [1, 0.1, 0.2, 1] }, { channels: ['B', 'A'], matrix: [1, 0.2, 0.1, 1] }));
  assert.ok(!sameSpillover({ channels: ['A', 'B'], matrix: [1, 0.1, 0.2, 1] }, { channels: ['A', 'B'], matrix: [1, 0.1, 0.3, 1] }));
  const comp = { name: 'Acquisition-defined', channels: ['FITC-A', 'PE-A'], matrix: SPILL };
  const other = { name: 'Edited', channels: ['FITC-A', 'PE-A'], matrix: [1, 0.2, 0, 1] };
  const plans = planCompensations([
    { flowJo: { compensation: comp }, sample: wsSample('s1', 'a.fcs', 1, { $SPILLOVER: `2,FITC-A,PE-A,${SPILL.join(',')}` }) },
    { flowJo: { compensation: other }, sample: wsSample('s2', 'b.fcs', 1) },
    { flowJo: { compensation: { ...other } }, sample: wsSample('s3', 'c.fcs', 1) },
    { flowJo: { compensation: comp }, sample: null },
  ]);
  assert.deepEqual(plans.map((p) => [p.kind, p.sampleIds]), [['file', ['s1']], ['matrix', ['s2', 's3']]]);
});

test('a migration builds one undoable workspace and its counts agree with FlowJo', () => {
  const s1 = syntheticSample(11);
  const s2 = syntheticSample(23);
  const xml = workspaceXML([
    { id: 1, file: 'A1 unstim.fcs', counts: s1.counts },
    { id: 2, file: 'A2 stim.fcs', counts: s2.counts, stimOnly: true },
    { id: 3, file: 'A3 missing.fcs', counts: s1.counts },
  ]);
  const result = importFlowJo(xml);
  assert.deepEqual(result.warnings, []);
  let ws = createWorkspace('Study');
  ws = { ...ws, samples: [wsSample('w1', 'A1 unstim.fcs', 3000), wsSample('w2', 'A2 stim.fcs', 3000)], channelSettings: { 'FSC-A': { transform: { type: 'linear', min: 0, max: 262144 } } } };
  const matches = matchFlowJoSamples(result.samples, ws.samples);
  assert.deepEqual(matches.map((m) => m.sample?.id ?? null), ['w1', 'w2', null]);
  const before = ws;
  const plan = buildFlowJoMigration(ws, result, matches, { fileName: 'study.wsp', now: '2025-02-03T04:05:06.000Z' });
  assert.equal(before.gates.length, 0, 'the input workspace is not modified');
  const next = plan.ws;
  // Groups: "Stim" with its matched sample; FlowJo's "All Samples" is not duplicated.
  assert.deepEqual(next.groups.map((g) => [g.name, g.sampleIds]), [['Stim', ['w2']]]);
  // One shared matrix for both samples (their files carry no spillover keyword).
  assert.equal(next.compensations.length, 1);
  assert.deepEqual(next.compensations[0].matrix, SPILL);
  assert.ok(next.samples.every((s) => s.compensationId === next.compensations[0].id));
  // Scales: FlowJo's for FITC-A, PE-A and SSC-A; FSC-A already had the same scale.
  assert.deepEqual(plan.scales.sort(), ['FITC-A', 'PE-A', 'SSC-A']);
  assert.equal(next.channelSettings['FITC-A'].transform.type, 'biex');
  // Gates: one tree; the stim-only population is scoped to the Stim group.
  const byPath = (path) => next.gates.find((g) => g.meta.flowJoPath === path && !g.meta.helper);
  assert.equal(next.gates.filter((g) => g.type === 'quadrant').length, 4);
  const activated = byPath('Lymphocytes/Activated');
  assert.deepEqual(activated.scope, { groupId: next.groups[0].id });
  assert.equal(byPath('Lymphocytes/CD3+').parentId, byPath('Lymphocytes').id);
  assert.ok(next.gates.every((g) => g.meta.origin === 'imported' && g.meta.flowJoFile === 'study.wsp'));
  const migration = next.migrations.at(-1);
  assert.equal(migration.source, 'study.wsp');
  assert.deepEqual(migration.samples.map((s) => s.sampleId), ['w1', 'w2', null]);
  assert.equal(migration.gates['Lymphocytes/CD3+'], byPath('Lymphocytes/CD3+').id);
  assert.ok(next.provenance.some((p) => p.action === 'import-flowjo'));

  // Recompute every population with the engine and compare with FlowJo's counts.
  const counts = {};
  for (const [id, synthetic] of [['w1', s1], ['w2', s2]]) {
    const record = next.samples.find((s) => s.id === id);
    const view = new SampleView(record, synthetic.dataset);
    view.setCompensation(next.compensations[0]);
    counts[id] = {};
    for (const [path, gateId] of Object.entries(migration.gates)) {
      const indices = population(view, next, gateId);
      counts[id][path] = indices === undefined ? null : countOf(indices, view);
    }
  }
  assert.ok(gateById(next, migration.gates['Lymphocytes/Activated']));
  const rows = explainCountRows(migrationCountRows({ ...migration, comparison: { counts } }), migration);
  const summary = summarizeCountRows(rows);
  // Activated exists in FlowJo only for the Stim sample; in CytoWeave its group scope keeps it
  // off the other sample.
  assert.deepEqual(rows.filter((r) => r.path === 'Lymphocytes/Activated').map((r) => r.sampleId), ['w2']);
  assert.equal(counts.w1['Lymphocytes/Activated'], null);
  const compared = rows.filter((r) => r.status !== 'missing');
  assert.equal(compared.length, 13);
  for (const row of compared) assert.equal(row.status, 'exact', `${row.sampleName} ${row.path}: FlowJo ${row.flowjo}, CytoWeave ${row.cytoweave}`);
  assert.ok(compared.some((r) => r.flowjo > 100), 'populations are large enough to be meaningful');
  assert.deepEqual(summary, { exact: 13, close: 0, differs: 0, missing: 0 });
  const csv = migrationCSV(rows);
  assert.match(csv.split('\n')[0], /^population,sample,flowjo_count,cytoweave_count/);
  assert.equal(csv.trim().split('\n').length, rows.length + 1);
});

test('report rows rank and explain differences', () => {
  const migration = {
    samples: [{ sampleId: 'w1', flowJoName: 'A1', note: null, counts: { P: 1000, 'P/C': 500, 'P/D': 200, Q: 50 } }, { sampleId: 'w2', flowJoName: 'A2', note: 'FlowJo recorded 10 events; the file has 9', counts: { P: 10 } }],
    gates: { P: 'g1', 'P/C': 'g2', 'P/D': 'g3', Q: 'g4' },
    fidelity: { paths: [{ path: 'P/D', status: 'approximated', note: 'an ellipse defined in data units was mapped to the closest ellipse on its transformed axes' }] },
  };
  const rows = explainCountRows(migrationCountRows(migration, { w1: { P: 1080, 'P/C': 500, 'P/D': 201, Q: null }, w2: { P: 10 } }), migration);
  assert.deepEqual(rows.map((r) => [r.sampleName, r.path, r.status]), [['A1', 'P', 'differs'], ['A1', 'Q', 'missing'], ['A1', 'P/D', 'close'], ['A2', 'P', 'exact'], ['A1', 'P/C', 'exact']]);
  assert.match(rows[0].causes.join(' '), /compensation/);
  assert.match(rows[2].causes.join(' '), /parent population already differs/);
  assert.match(rows[2].causes.join(' '), /the ellipse was refitted on the transformed axes/);
  const off = explainCountRows(migrationCountRows(migration, { w2: { P: 7 } }), migration);
  assert.match(off[0].causes.join(' '), /may not be the one FlowJo analyzed/);
  // A few events on a small population: boundary events, not a setup problem.
  const few = explainCountRows(migrationCountRows(migration, { w1: { P: 1000, 'P/C': 500, 'P/D': 200, Q: 44 } }), migration);
  assert.match(few.find((r) => r.path === 'Q').causes.join(' '), /only 6 events differ: events on the gate boundary/);
});
