import assert from 'node:assert/strict';
import test from 'node:test';
import { cytekDetectors, importSpectroFlo, planSpectroFloControls } from './spectroflo.js';

const NS = 'xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="http://schemas.microsoft.com/2003/10/Serialization/" xmlns="http://schemas.datacontract.org/2004/07/Rainbow.DataPersistence.Experiment"';
const vector = (values) => `<d4p1:_SpilloverVectorArea z:Size="${values.length}">${values.map((v) => `<d5p1:float xmlns:d5p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">${v}</d5p1:float>`).join('')}</d4p1:_SpilloverVectorArea>`;
const column = (id, fluor, label, file, values, unstained) => `<d4p1:SpilloverColumn z:Id="${id}">${vector(values)}<d4p1:_DateTimeCreated>2025-02-18T17:52:04Z</d4p1:_DateTimeCreated>
  <d4p1:_RefControlDesc z:Id="${id}1"><d4p1:Fluorochrome z:Id="${id}2">${fluor}</d4p1:Fluorochrome><d4p1:Label z:Id="${id}3">${label}</d4p1:Label>${unstained}</d4p1:_RefControlDesc>
  <d4p1:_Url>C:\\Cytek\\Raw\\Reference Group\\${file}</d4p1:_Url></d4p1:SpilloverColumn>`;
const v14 = (peak, top = 1) => Array.from({ length: 14 }, (_, i) => (i === peak ? top : i === peak + 1 ? 0.5 : 0.01));
const EXPT = `<?xml version="1.0" encoding="utf-8"?><Experiment ${NS} z:Id="1"><Version>3300</Version>
<Info z:Id="2"><Name z:Id="3">Demo</Name><ExperimentDesc z:Id="4" xmlns:d4p1="http://schemas.datacontract.org/2004/07/Rainbow.DataPersistence.Experiment">
<d4p1:_UnmixingScheme>AutofluorescenceAsFluorescentTag</d4p1:_UnmixingScheme>
<d4p1:_RefSetupResult z:Id="5"><d4p1:SpilloverColumnList z:Size="2">
${column('10', 'FITC', 'CD3', 'A1 CD3 FITC (Beads).fcs', v14(1), '<d4p1:NameOfSeparateUnstained z:Id="99">Unstained</d4p1:NameOfSeparateUnstained>')}
${column('20', 'PE', '', 'A2 PE (Cells).fcs', v14(5, 1), '<d4p1:NameOfSeparateUnstained z:Ref="99" i:nil="true" />')}
</d4p1:SpilloverColumnList>
<d4p1:UnstainedMfiColumn z:Id="30">${vector(v14(0, 100))}<d4p1:_RefControlDesc z:Id="31"><d4p1:Fluorochrome i:nil="true" /></d4p1:_RefControlDesc><d4p1:_Url>C:\\Cytek\\Raw\\Reference Group\\A0 Unstained (Cells).fcs</d4p1:_Url></d4p1:UnstainedMfiColumn>
</d4p1:_RefSetupResult></ExperimentDesc></Info></Experiment>`;

test('Cytek detector names by detector count', () => {
  assert.equal(cytekDetectors(64).length, 64);
  assert.deepEqual(cytekDetectors(64).slice(15, 18), ['UV16-A', 'V1-A', 'V2-A']);
  assert.deepEqual(cytekDetectors(64).slice(-1), ['R8-A']);
  assert.deepEqual(cytekDetectors(14).slice(0, 2), ['B1-A', 'B2-A']);
  assert.equal(cytekDetectors(13), null);
});

test('reference controls, shared values (z:Ref), the unstained control and matching to samples', () => {
  const result = importSpectroFlo(EXPT);
  assert.equal(result.name, 'Demo');
  assert.equal(result.inferred, true);
  assert.deepEqual(result.detectors.slice(0, 2), ['B1-A', 'B2-A']);
  assert.deepEqual(result.references.map((r) => [r.fluorochrome, r.marker, r.carrier, r.gatedDetector, r.unstained, r.controlFile]), [
    ['FITC', 'CD3', 'beads', 'B2-A', 'Unstained', 'A1 CD3 FITC (Beads).fcs'],
    ['PE', '', 'cells', 'B6-A', 'Unstained', 'A2 PE (Cells).fcs'],
  ]);
  assert.equal(result.unstained.controlFile, 'A0 Unstained (Cells).fcs');
  assert.equal(result.unmixing.scheme, 'AutofluorescenceAsFluorescentTag');
  // Detector names from a raw file win over the inferred ones.
  const named = importSpectroFlo(EXPT, { detectors: Array.from({ length: 14 }, (_, i) => `D${i}`) });
  assert.equal(named.inferred, false);
  assert.equal(named.references[0].gatedDetector, 'D1');

  const samples = [
    { id: 'a', name: 'A1 CD3 FITC (Beads)', fileName: 'A1 CD3 FITC (Beads).fcs', meta: { note: 'kept' } },
    { id: 'u', name: 'A0 Unstained (Cells)', fileName: 'a0 unstained (cells).FCS', meta: {} },
  ];
  const plan = planSpectroFloControls(result, samples);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan[0].patch, { role: 'single-stain', stain: 'FITC', meta: { note: 'kept', fluorochrome: 'FITC', marker: 'CD3', carrier: 'beads' } });
  assert.equal(plan[1].sample, null);
  assert.deepEqual(plan[2].patch, { role: 'unstained', stain: null, meta: { carrier: 'cells' } });
});

test('not a SpectroFlo experiment', () => {
  assert.throws(() => importSpectroFlo('<Workspace/>'), /not a SpectroFlo experiment/);
});
