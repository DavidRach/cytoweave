import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestFieldsFromNames } from './workspace.js';

test('fields suggested from file names follow what the parts look like', () => {
  const summary = (names) => suggestFieldsFromNames(names).map((f) => `${f.field}:${f.values.join('/')}`);
  // A zero-padded "D01" is a donor, not a day; the part with few words is the condition.
  assert.deepEqual(summary(['D01_Unstim.fcs', 'D01_Stim.fcs', 'D02_Unstim.fcs', 'D02_Stim.fcs']), ['subject:D01/D01/D02/D02', 'condition:Unstim/Stim/Unstim/Stim']);
  assert.deepEqual(summary(['B1_S01_Ctrl_d0.fcs', 'B1_S02_Case_d7.fcs', 'B2_S03_Ctrl_d0.fcs', 'B2_S04_Case_d7.fcs']), ['batch:B1/B1/B2/B2', 'subject:S01/S02/S03/S04', 'condition:Ctrl/Case/Ctrl/Case', 'timepoint:d0/d7/d0/d7']);
  assert.deepEqual(summary(['Patient3_24h_LPS', 'Patient3_0h_LPS', 'Patient4_24h_none']), ['subject:Patient3/Patient3/Patient4', 'timepoint:24h/0h/24h', 'condition:LPS/LPS/none']);
  assert.deepEqual(summary(['Ctrl_mouse1_spleen', 'KO_mouse2_spleen', 'Ctrl_mouse3_LN', 'KO_mouse4_LN']), ['condition:Ctrl/KO/Ctrl/KO', 'subject:mouse1/mouse2/mouse3/mouse4', 'tissue:spleen/spleen/LN/LN']);
  assert.deepEqual(summary(['A1 unstim rep1', 'A2 stim rep2']), ['subject:A1/A2', 'condition:unstim/stim', 'replicate:rep1/rep2']);
  assert.deepEqual(summary(['same.fcs', 'same.fcs']), []);
});
