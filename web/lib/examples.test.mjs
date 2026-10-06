import assert from 'node:assert/strict';
import test from 'node:test';
import { compensate } from './compensation.js';
import {
  EXAMPLES,
  PBMC_GROUPS,
  PBMC_TREE,
  PRECURSOR_FREQUENCIES,
  generateExample,
  generateExampleAsync,
  getExample,
  listExamples,
  proliferationStatistics,
  treeWeights,
} from './examples.js';
import { detectTechnology, parseFCS, readSpillover } from './fcs.js';
import { membership } from './gates.js';
import { applyTransform, createTransform } from './transforms.js';

function median(values) {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
}

function parse(file) {
  const [dataset] = parseFCS(file.bytes).datasets;
  const columns = Object.fromEntries(dataset.parameters.map((p, i) => [p.name, dataset.data[i]]));
  return { dataset, columns };
}

function countLabels(truth, names) {
  const wanted = new Set(names.map((n) => truth.names.indexOf(n)).filter((i) => i >= 0));
  let n = 0;
  for (const label of truth.labels) if (wanted.has(label)) n += 1;
  return n;
}

function correlation(x, y) {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

function eventRate(times, start, end) {
  let inside = 0;
  for (const t of times) if (t >= start && t < end) inside += 1;
  return inside / (end - start);
}

const ROLES = new Set(['sample', 'unstained', 'single-stain', 'fmo', 'bead', 'reference']);

test('the catalog describes twelve examples as plain data', () => {
  assert.deepEqual(EXAMPLES.map((e) => e.id), ['pbmc-immunophenotyping', 'flowjo-workspace', 'spectral-25color', 'cell-cycle', 'proliferation', 'calcium-flux', 'cytof-cohort', 'cytof-barcoded', 'index-sort', 'qc-showcase', 'bead-qc', 'titration-voltage']);
  for (const entry of EXAMPLES) {
    const sentences = entry.description.match(/[.!?](?=\s+[A-Z]|$)/g) ?? [];
    assert.ok(sentences.length >= 2 && sentences.length <= 4, `${entry.id}: ${sentences.length} sentences`);
    assert.ok(['conventional', 'spectral', 'mass'].includes(entry.technology));
    assert.ok(entry.tags.length >= 3 && entry.title && entry.instrument);
    // A barcoded plate is one pooled file; every other example has several.
    assert.ok(entry.samples.length >= (entry.id === 'cytof-barcoded' ? 1 : 2) && entry.defaultEvents > 0);
    for (const sample of entry.samples) assert.ok(ROLES.has(sample.role) && sample.events > 0 && sample.name.endsWith('.fcs'));
    for (const spec of Object.values(entry.transforms)) createTransform(spec);
    assert.ok(entry.answerKey && typeof entry.answerKey === 'object');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(EXAMPLES)), EXAMPLES);
  assert.equal(listExamples().length, 12);
  assert.equal(getExample('cell-cycle').samples.length, 2);
  assert.throws(() => getExample('nope'), /no example/);
  assert.throws(() => generateExample('nope'), /no example/);
});

test('every example writes FCS 3.1 files that parse cleanly with the documented channels', () => {
  for (const entry of EXAMPLES) {
    const { files, workspaceHints } = generateExample(entry.id, { scale: 0.02 });
    assert.equal(files.length, entry.samples.length);
    const documented = entry.channels.map((c) => c.name);
    const seen = new Set();
    for (const file of files) {
      const { dataset } = parse(file);
      assert.equal(dataset.version, 'FCS3.1');
      assert.deepEqual(dataset.diagnostics.filter((d) => d.level !== 'info'), [], `${entry.id}/${file.name}`);
      assert.equal(dataset.keywords.$FIL, file.name);
      assert.equal(dataset.eventCount, file.meta.eventCount);
      for (const p of dataset.parameters) {
        assert.ok(documented.includes(p.name), `${entry.id}/${file.name}: ${p.name} is documented`);
        seen.add(p.name);
        assert.ok(dataset.data[p.index].every((v) => Number.isFinite(v) && v <= p.range - 1), `${p.name} within $PnR`);
      }
      const { labels, names } = file.meta.truth;
      assert.equal(labels.length, dataset.eventCount);
      assert.ok(labels.every((l) => l >= 0 && l < names.length));
      assert.equal(detectTechnology(dataset.keywords, dataset.parameters), entry.technology, `${entry.id} technology`);
    }
    for (const name of documented) assert.ok(seen.has(name), `${entry.id}: ${name} appears in some file`);
    assert.ok(workspaceHints.groups.length && Object.keys(workspaceHints.sampleMeta).length === files.length);
  }
});

test('generation is deterministic for a seed, and one file regenerates identically on its own', () => {
  for (const id of ['qc-showcase', 'cytof-cohort', 'cell-cycle']) {
    const a = generateExample(id, { scale: 0.02, seed: 7 });
    const b = generateExample(id, { scale: 0.02, seed: 7 });
    a.files.forEach((file, i) => assert.deepEqual(file.bytes, b.files[i].bytes));
    const c = generateExample(id, { scale: 0.02, seed: 8 });
    assert.notDeepEqual(a.files[0].bytes, c.files[0].bytes);
    const last = a.files[a.files.length - 1];
    const alone = generateExample(id, { scale: 0.02, seed: 7, samples: [last.name] });
    assert.deepEqual(alone.files[0].bytes, last.bytes);
  }
});

test('composition tree gives the specified PBMC frequencies', () => {
  const leaf = treeWeights(PBMC_TREE);
  const sum = (names) => names.reduce((s, n) => s + leaf.get(n), 0);
  const lymph = sum(PBMC_GROUPS.Lymphocytes);
  assert.ok(Math.abs(sum([...leaf.keys()]) - 1) < 1e-12);
  assert.ok(Math.abs(sum(PBMC_GROUPS['T cells']) / lymph - 0.64 / 0.97) < 1e-9);
  assert.ok(Math.abs(sum(PBMC_GROUPS['CD4 T']) / sum(PBMC_GROUPS['CD8 T']) - 0.64 / 0.31) < 1e-9);
  assert.ok(Math.abs(leaf.get('Regulatory T') / sum(PBMC_GROUPS['CD4 T']) - 0.07) < 1e-9);
  assert.ok(Math.abs(sum(PBMC_GROUPS.Monocytes) - 0.2) < 1e-9);
});

const pbmc = generateExample('pbmc-immunophenotyping', { scale: 0.05 });
const pbmcFile = (name) => pbmc.files.find((f) => f.name === name);

test('PBMC samples have realistic frequencies within donor variation', () => {
  const stats = pbmc.files.filter((f) => f.meta.role === 'sample' && f.meta.condition === 'Unstimulated').map((f) => {
    const t = f.meta.truth;
    const singlets = t.labels.length - countLabels(t, ['Doublets', 'Junk']);
    const lymph = countLabels(t, PBMC_GROUPS.Lymphocytes);
    const cd4 = countLabels(t, PBMC_GROUPS['CD4 T']);
    return {
      lymph: lymph / singlets,
      mono: countLabels(t, PBMC_GROUPS.Monocytes) / singlets,
      t: countLabels(t, PBMC_GROUPS['T cells']) / lymph,
      ratio: cd4 / countLabels(t, PBMC_GROUPS['CD8 T']),
      b: countLabels(t, PBMC_GROUPS['B cells']) / lymph,
      nk: countLabels(t, PBMC_GROUPS['NK cells']) / lymph,
      treg: countLabels(t, ['Regulatory T']) / cd4,
    };
  });
  const ranges = { lymph: [0.55, 0.72, 0.6, 0.7], mono: [0.12, 0.24, 0.15, 0.2], t: [0.55, 0.75, 0.6, 0.7], ratio: [1, 3.5, 1.5, 2.6], b: [0.06, 0.18, 0.08, 0.15], nk: [0.06, 0.2, 0.08, 0.16], treg: [0.04, 0.11, 0.055, 0.085] };
  for (const [key, [lo, hi, mlo, mhi]] of Object.entries(ranges)) {
    for (const s of stats) assert.ok(s[key] >= lo && s[key] <= hi, `${key} ${s[key]}`);
    const m = median(stats.map((s) => s[key]));
    assert.ok(m >= mlo && m <= mhi, `median ${key} ${m}`);
  }
  const stim = pbmcFile('D01_Stim.fcs').meta.truth;
  const activated = stim.state.reduce((a, b) => a + b, 0) / countLabels(stim, PBMC_GROUPS['T cells']);
  assert.ok(activated > 0.2 && activated < 0.45, `activated T fraction ${activated}`);
  assert.equal(pbmcFile('D01_Unstim.fcs').meta.truth.state.reduce((a, b) => a + b, 0), 0);
});

test('stimulation raises CD25 and HLA-DR on T cells', () => {
  const t = (name) => {
    const file = pbmcFile(name);
    const { dataset, columns } = parse(file);
    const comp = compensate(columns, readSpillover(dataset.keywords, dataset.parameters));
    const set = new Set(PBMC_GROUPS['T cells'].map((n) => file.meta.truth.names.indexOf(n)));
    const pick = (channel) => Array.from(comp[channel]).filter((_, e) => set.has(file.meta.truth.labels[e]));
    return { cd25: pick('PE-A'), dr: pick('BV650-A') };
  };
  const unstim = t('D02_Unstim.fcs');
  const stim = t('D02_Stim.fcs');
  const above = (values, threshold) => values.filter((v) => v > threshold).length / values.length;
  assert.ok(above(stim.cd25, 1500) > above(unstim.cd25, 1500) + 0.15);
  assert.ok(above(stim.dr, 1000) > above(unstim.dr, 1000) + 0.15);
});

test('$SPILLOVER parses and is off in exactly the documented entry', () => {
  const { dataset } = parse(pbmcFile('D01_Unstim.fcs'));
  const spill = readSpillover(dataset.keywords, dataset.parameters);
  assert.equal(spill.keyword, '$SPILLOVER');
  assert.equal(spill.n, 14);
  assert.deepEqual(spill.channels, dataset.parameters.filter((p) => p.type === 'fluorescence').map((p) => p.name));
  assert.equal(spill.identity, false);
  const error = getExample('pbmc-immunophenotyping').answerKey.compensationError;
  const i = spill.channels.indexOf(error.from);
  const j = spill.channels.indexOf(error.to);
  assert.equal(spill.matrix[i * spill.n + j], error.written);
  assert.ok(error.true > error.written * 1.3);
  assert.equal(readSpillover(parse(pbmcFile('Comp_FITC.fcs')).dataset.keywords), null, 'controls are acquired uncompensated');
});

test('compensating single-stain controls with $SPILLOVER removes their correlations (except the planted error)', () => {
  const { dataset } = parse(pbmcFile('D01_Unstim.fcs'));
  const spill = readSpillover(dataset.keywords, dataset.parameters);
  const error = getExample('pbmc-immunophenotyping').answerKey.compensationError;
  for (const file of pbmc.files.filter((f) => f.meta.role === 'single-stain')) {
    const { columns } = parse(file);
    const comp = compensate(columns, spill);
    const i = spill.channels.indexOf(file.meta.stain);
    for (let j = 0; j < spill.n; j += 1) {
      if (j === i || spill.matrix[i * spill.n + j] < 0.03) continue;
      const to = spill.channels[j];
      const before = Math.abs(correlation(columns[file.meta.stain], columns[to]));
      const after = Math.abs(correlation(comp[file.meta.stain], comp[to]));
      assert.ok(before > 0.7, `${file.name} ${to} raw correlation ${before}`);
      if (file.meta.stain === error.from && to === error.to) assert.ok(after > 0.8, 'the under-compensated pair stays correlated');
      else assert.ok(after < 0.4, `${file.name} → ${to}: ${before.toFixed(2)} → ${after.toFixed(2)}`);
    }
  }
});

test('doublets have a higher FSC-A/FSC-H ratio and the suggested singlet gate removes them', () => {
  const file = pbmcFile('D01_Unstim.fcs');
  const { columns } = parse(file);
  const { labels, names } = file.meta.truth;
  const ratio = (label) => median(Array.from(labels).flatMap((l, e) => (l === label ? [columns['FSC-A'][e] / columns['FSC-H'][e]] : [])));
  const doublet = names.indexOf('Doublets');
  assert.ok(ratio(doublet) > 1.35 * ratio(names.indexOf('CD4 naive T')));
  assert.ok(median(Array.from(labels).flatMap((l, e) => (l === doublet ? [columns['FSC-W'][e]] : []))) > 90000);
  const singletGate = pbmc.workspaceHints.suggestedGates.find((g) => g.id === 'gsim-singlets');
  const [dx, dy] = singletGate.dims;
  const xs = applyTransform(columns[dx.channel], dx.transform);
  const ys = applyTransform(columns[dy.channel], dy.transform);
  const inside = new Set(membership('polygon', singletGate.geometry, xs, ys, null));
  let cells = 0;
  let cellsIn = 0;
  let doublets = 0;
  let doubletsIn = 0;
  labels.forEach((l, e) => {
    if (l === doublet) {
      doublets += 1;
      if (inside.has(e)) doubletsIn += 1;
    } else if (names[l] !== 'Debris' && names[l] !== 'Dead cells') {
      cells += 1;
      if (inside.has(e)) cellsIn += 1;
    }
  });
  assert.ok(cellsIn / cells > 0.97, `singlets kept ${cellsIn / cells}`);
  assert.ok(doubletsIn / doublets < 0.3, `doublets kept ${doubletsIn / doublets}`);
});

test('the clog sample loses event rate inside the clog window', () => {
  const file = pbmcFile('D05_Unstim.fcs');
  const { dataset, columns } = parse(file);
  const step = Number(dataset.keywords.$TIMESTEP);
  const times = Array.from(columns.Time, (v) => v * step);
  const [clog] = file.meta.truth.anomalies;
  assert.equal(clog.kind, 'clog');
  const inside = eventRate(times, clog.start, clog.end);
  const before = eventRate(times, 0, clog.start);
  assert.ok(inside < 0.3 * before, `${inside} vs ${before} events/s`);
  assert.equal(pbmcFile('D01_Unstim.fcs').meta.truth.anomalies.length, 0);
});

test('spectral single-stain references reproduce the generating spectra and unmix to the true abundances', () => {
  const { files, workspaceHints } = generateExample('spectral-25color', { scale: 0.1 });
  const detectors = workspaceHints.spectral.detectors;
  assert.equal(detectors.length, 64);
  const references = files.filter((f) => f.meta.role === 'single-stain');
  assert.equal(references.length, 25);
  for (const file of references) {
    const { columns } = parse(file);
    const { labels, names } = file.meta.truth;
    const beads = names.indexOf('Positive beads');
    const isBeads = labels.some((l) => l === beads);
    const positive = isBeads ? beads : names.indexOf('Dead cells');
    const negative = new Set(isBeads ? [names.indexOf('Negative beads')] : names.map((n, i) => (n === 'Debris' || n === 'Doublets' || n === 'Dead cells' ? -1 : i)));
    const spectrum = detectors.map((d) => {
      const c = columns[d];
      const pos = [];
      const neg = [];
      labels.forEach((l, e) => {
        if (l === positive) pos.push(c[e]);
        else if (negative.has(l)) neg.push(c[e]);
      });
      return median(pos) - median(neg);
    });
    const truth = workspaceHints.spectral.signatures[file.meta.stain];
    let dot = 0;
    let a = 0;
    let b = 0;
    spectrum.forEach((v, i) => {
      dot += v * truth[i];
      a += v * v;
      b += truth[i] * truth[i];
    });
    assert.ok(dot / Math.sqrt(a * b) >= 0.99, `${file.name} cosine ${dot / Math.sqrt(a * b)}`);
  }
  // Ordinary least squares with the true spectra (plus both autofluorescence signatures).
  const donor = files.find((f) => f.name === 'Donor_S1.fcs');
  const { columns } = parse(donor);
  const rows = [workspaceHints.spectral.signatures.AF, workspaceHints.spectral.signatures.AFM, ...workspaceHints.spectral.fluorochromes.map((f) => workspaceHints.spectral.signatures[f.name])];
  const k = rows.length;
  const gram = new Float64Array(k * k);
  for (let i = 0; i < k; i += 1) for (let j = 0; j < k; j += 1) gram[i * k + j] = rows[i].reduce((s, v, t) => s + v * rows[j][t], 0);
  const spill = { channels: rows.map((_, i) => `c${i}`), matrix: gram };
  const projected = Object.fromEntries(rows.map((row, i) => [`c${i}`, Float32Array.from(columns[detectors[0]], (_, e) => row.reduce((s, v, t) => s + v * columns[detectors[t]][e], 0))]));
  const unmixed = compensate(projected, spill); // solves (MᵀM) a = Mᵀy, since compensate applies x · G⁻¹
  const truth = donor.meta.truth.abundances;
  for (let i = 0; i < k; i += 1) {
    let sxy = 0;
    let sxx = 0;
    unmixed[`c${i}`].forEach((v, e) => {
      sxy += v * truth[i][e];
      sxx += truth[i][e] ** 2;
    });
    assert.ok(Math.abs(sxy / sxx - 1) < 0.08, `${donor.meta.truth.abundanceNames[i]} slope ${sxy / sxx}`);
  }
  // Myeloid autofluorescence is brighter than lymphoid in the unstained control's peak detector.
  const unstained = files.find((f) => f.name === 'Unstained.fcs');
  const peak = detectors[workspaceHints.spectral.signatures.AF.indexOf(1)];
  const { columns: u } = parse(unstained);
  const level = (names) => median(Array.from(unstained.meta.truth.labels).flatMap((l, e) => (names.includes(unstained.meta.truth.names[l]) ? [u[peak][e]] : [])));
  assert.ok(level(['Classical monocytes']) > 2 * level(['CD4 naive T']));
});

test('cell-cycle phase fractions are within 1 percentage point of the specification', () => {
  const { files, workspaceHints } = generateExample('cell-cycle', { scale: 0.3 });
  for (const file of files) {
    const t = file.meta.truth;
    const counts = ['G1', 'S', 'G2/M'].map((n) => countLabels(t, [n]));
    const singlets = counts.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(counts[0] / singlets - t.phases.G1) <= 0.01);
    assert.ok(Math.abs(counts[1] / singlets - t.phases.S) <= 0.01);
    assert.ok(Math.abs(counts[2] / singlets - t.phases.G2M) <= 0.01);
  }
  assert.equal(files[1].meta.truth.phases.G2M, 0.45);
  const gate = workspaceHints.suggestedGates.find((g) => g.id === 'gsim-dna-singlets');
  const { columns } = parse(files[0]);
  const xs = applyTransform(columns['PI-A'], gate.dims[0].transform);
  const ys = applyTransform(columns['PI-W'], gate.dims[1].transform);
  const inside = new Set(membership('polygon', gate.geometry, xs, ys, null));
  const t = files[0].meta.truth;
  const kept = (name) => {
    const label = t.names.indexOf(name);
    let n = 0;
    let k = 0;
    t.labels.forEach((l, e) => {
      if (l === label) {
        n += 1;
        if (inside.has(e)) k += 1;
      }
    });
    return k / n;
  };
  assert.ok(kept('G2/M') > 0.95 && kept('G1') > 0.97);
  assert.ok(kept('Doublets') < 0.3, `doublets kept ${kept('Doublets')}`);
});

test('proliferation: CTV halves per generation and generations follow the precursor frequencies', () => {
  const stats = proliferationStatistics(PRECURSOR_FREQUENCIES.stimulated.CD4);
  assert.equal(stats.percentDivided, 70);
  assert.ok(Math.abs(stats.divisionIndex - 2.37) < 1e-12);
  assert.ok(Math.abs(stats.expansionIndex - 11.9) < 1e-12);
  const { files } = generateExample('proliferation', { scale: 0.3, samples: ['Day4_aCD3CD28.fcs'] });
  const [file] = files;
  const { columns } = parse(file);
  const t = file.meta.truth;
  const ctv = (g) => median(Array.from(t.labels).flatMap((l, e) => (t.names[l] === `CD4 T gen ${g}` ? [columns['BV421-A'][e]] : [])));
  for (let g = 1; g <= 6; g += 1) {
    const ratio = ctv(g) / ctv(g - 1);
    assert.ok(ratio > 0.45 && ratio < 0.55, `gen ${g}/${g - 1} = ${ratio}`);
  }
  const p = PRECURSOR_FREQUENCIES.stimulated.CD4;
  const expected = p.map((f, i) => f * 2 ** i);
  const total = expected.reduce((a, b) => a + b, 0);
  const counts = p.map((_, g) => countLabels(t, [`CD4 T gen ${g}`]));
  const sum = counts.reduce((a, b) => a + b, 0);
  // Each generation's share is a multinomial draw: within 4 binomial SDs of its expectation.
  counts.forEach((c, g) => {
    const share = expected[g] / total;
    assert.ok(Math.abs(c / sum - share) < 4 * Math.sqrt((share * (1 - share)) / sum) + 1e-3, `gen ${g}: ${c / sum} vs ${share}`);
  });
  assert.deepEqual(t.proliferation.CD4, stats);
});

test('mass cytometry cohort: channels, zero inflation, batch effects and differential abundance', () => {
  const { files, workspaceHints } = generateExample('cytof-cohort', { scale: 0.2 });
  const anchor1 = files.find((f) => f.name === 'B1_Anchor.fcs');
  const { dataset, columns } = parse(anchor1);
  const yb = dataset.parameters.find((p) => p.name === 'Yb176Di');
  assert.equal(yb.label, '176Yb_CD56');
  assert.equal(yb.marker, 'CD56');
  assert.ok(columns.Sm154Di.filter((v) => v === 0).length / dataset.eventCount > 0.2, 'zero inflation');
  assert.ok(dataset.parameters.find((p) => p.name === 'Ir191Di').marker === 'DNA1');
  // Anchors share a donor: same composition, but batch 2 has lower bead and marker signal.
  const anchor2 = files.find((f) => f.name === 'B2_Anchor.fcs');
  assert.deepEqual(anchor1.meta.truth.expectedFrequencies, anchor2.meta.truth.expectedFrequencies);
  const beads = (file) => {
    const { columns: c } = parse(file);
    const label = file.meta.truth.names.indexOf('Beads');
    return median(Array.from(file.meta.truth.labels).flatMap((l, e) => (l === label ? [c.Ce140Di[e]] : [])));
  };
  assert.ok(beads(anchor2) < 0.95 * beads(anchor1));
  // Differential abundance: non-classical monocytes doubled in cases.
  const share = (file) => {
    const t = file.meta.truth;
    const live = t.labels.length - countLabels(t, ['Dead cells', 'Debris', 'Doublets', 'Beads']);
    return countLabels(t, ['Non-classical monocytes']) / live;
  };
  const cases = files.filter((f) => f.meta.condition === 'Case').map(share);
  const controls = files.filter((f) => f.meta.condition === 'Control').map(share);
  const ratio = cases.reduce((a, b) => a + b, 0) / controls.reduce((a, b) => a + b, 0);
  assert.ok(ratio > 1.5 && ratio < 2.7, `case/control ${ratio}`);
  assert.equal(workspaceHints.normalization.anchors.Batch2, 'B2_Anchor.fcs');
});

test('index sort: one event per well with Index X / Index Y parameters', () => {
  const { files } = generateExample('index-sort', { scale: 0.05 });
  const sorted = files.find((f) => f.name === 'Plate1_IndexSort.fcs');
  const { dataset, columns } = parse(sorted);
  assert.equal(dataset.eventCount, 95);
  const wells = sorted.meta.truth.wells;
  assert.equal(new Set(wells).size, 95);
  assert.ok(!wells.includes('H12'));
  wells.forEach((well, e) => {
    assert.equal(columns['Index Y'][e], 'ABCDEFGH'.indexOf(well[0]) + 1);
    assert.equal(columns['Index X'][e], Number(well.slice(1)));
  });
  assert.equal(dataset.parameters.find((p) => p.name === 'Index X').type, 'instrument');
  const locations = dataset.keywords['INDEX SORTING LOCATIONS'].split(';').filter(Boolean);
  assert.equal(locations[0], '0,0');
  assert.equal(locations.length, 95);
  const t = sorted.meta.truth;
  t.labels.forEach((l, e) => {
    const column = columns['Index X'][e];
    const population = t.names[l];
    if (column <= 5) assert.equal(population, 'Memory B');
    else if (column <= 8) assert.equal(population, 'Naive B');
    else if (column <= 11) assert.equal(population, 'Plasmablasts');
    else assert.equal(population, 'T cells');
  });
});

test('QC showcase: clog, drift and burst are where the answer key says', () => {
  const { files } = generateExample('qc-showcase', { scale: 0.25 });
  const [clean, clog, drift, burst] = files;
  assert.equal(parse(clean).dataset.keywords.$WELLID, 'A01');
  assert.equal(clean.meta.truth.anomaly.reduce((a, b) => a + b, 0), 0);
  const times = (file) => {
    const { dataset, columns } = parse(file);
    return Array.from(columns.Time, (v) => v * Number(dataset.keywords.$TIMESTEP));
  };
  const c = clog.meta.truth.anomalies[0];
  assert.ok(eventRate(times(clog), c.start, c.end) < 0.3 * eventRate(times(clog), 0, c.start));
  const b = burst.meta.truth.anomalies[0];
  assert.ok(eventRate(times(burst), b.start, b.end) > 3 * eventRate(times(burst), 0, b.start));
  const { columns } = parse(drift);
  const n = columns['BV786-A'].length;
  const early = median(columns['BV786-A'].slice(0, n / 5));
  const late = median(columns['BV786-A'].slice((4 * n) / 5));
  assert.ok(late < 0.75 * early, `CD45 drifts ${early} → ${late}`);
});

test('progress, cancellation, subsets and the async variant', async () => {
  const fractions = [];
  generateExample('cell-cycle', { scale: 0.02, onProgress: (f) => fractions.push(f) });
  assert.deepEqual(fractions, [0, 0.5, 1]);
  assert.throws(() => generateExample('cell-cycle', { scale: 0.02, signal: { aborted: true } }), /canceled/);
  assert.throws(() => generateExample('cell-cycle', { samples: ['missing.fcs'] }), /None of the requested/);
  assert.throws(() => generateExample('cell-cycle', { scale: 0 }), /positive/);
  const sync = generateExample('qc-showcase', { scale: 0.02 });
  const signal = { aborted: false };
  const result = await generateExampleAsync('qc-showcase', { scale: 0.02, signal });
  result.files.forEach((file, i) => assert.deepEqual(file.bytes, sync.files[i].bytes));
  const withoutTruth = generateExample('cell-cycle', { scale: 0.02, truth: false });
  assert.equal(withoutTruth.files[0].meta.truth, undefined);
});
