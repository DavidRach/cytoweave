// Published gating strategies as templates (templates.js) whose gates are recipes placed on each
// experiment's own data (recipes.js), so that a strategy applies to any panel that measures its
// markers. Each strategy is written for CytoWeave from the article's gating hierarchy, in our own
// words (a gating hierarchy is a method, cited here); where a panel lacks a marker a step uses,
// the substitution is listed. Populations carry the Cell Ontology term the article's phenotype
// denotes, as a suggestion for the user to confirm.

import { PRACTICE_CITATIONS } from './cell-ontology.js';

const fl = (marker) => ({ name: `${marker}-A`, marker, type: 'fluorescence' });
const CHANNELS = {
  fscA: { name: 'FSC-A', marker: '', type: 'scatter' },
  fscH: { name: 'FSC-H', marker: '', type: 'scatter' },
  sscA: { name: 'SSC-A', marker: '', type: 'scatter' },
  viability: fl('Viability'),
  cd45: fl('CD45'),
  cd3: fl('CD3'),
  cd4: fl('CD4'),
  cd8: fl('CD8'),
  cd19: fl('CD19'),
  cd56: fl('CD56'),
  cd14: fl('CD14'),
  cd16: fl('CD16'),
  hladr: fl('HLA-DR'),
  cd45ra: fl('CD45RA'),
  ccr7: fl('CCR7'),
  cd25: fl('CD25'),
  cd127: fl('CD127'),
};

const term = (id, label, source) => ({ id, label, status: 'suggested', source });

function gate(id, name, parentId, method, dims, extra = {}) {
  const { keep, target, ontology, level, edge } = extra;
  return { id, name, parentId, type: 'recipe', recipe: { method, ...(keep ? { keep } : {}), ...(target ? { target } : {}), ...(level ? { level } : {}), ...(edge ? { edge } : {}) }, dims: dims.map((key) => ({ channel: key })), meta: {}, ...(ontology ? { ontology } : {}) };
}

// One plot of each recipe gate's parent on the gate's channels, for the Gate view.
function plotsOf(gates) {
  const seen = new Set();
  const plots = [];
  for (const g of gates) {
    const key = `${g.parentId}|${g.dims.map((d) => d.channel).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plots.push({ populationId: g.parentId ?? 'root', x: g.dims[0].channel, y: g.dims[1]?.channel ?? null, type: g.dims.length === 2 ? 'pseudocolor' : 'histogram', options: {} });
  }
  return plots;
}

function strategy(fields, gates) {
  const used = new Set(gates.flatMap((g) => g.dims.map((d) => d.channel)));
  return {
    format: 'cytoweave-template',
    version: 1,
    created: '2026-10-04',
    software: 'CytoWeave',
    channels: Object.fromEntries(Object.entries(CHANNELS).filter(([key]) => used.has(key))),
    gates,
    plots: plotsOf(gates),
    tables: [],
    figures: [],
    scales: {},
    compensation: { source: 'file' },
    notes: [],
    builtIn: true,
    ...fields,
  };
}

const OMIP101 = 'OMIP-101';
const memory = (prefix, parent, ids) => [
  gate(`${prefix}-naive`, `${prefix.toUpperCase()} naive`, parent, 'quadrant', ['cd45ra', 'ccr7'], { keep: '++', ontology: term(ids[0][0], ids[0][1], OMIP101) }),
  gate(`${prefix}-cm`, `${prefix.toUpperCase()} central memory`, parent, 'quadrant', ['cd45ra', 'ccr7'], { keep: '-+', ontology: term(ids[1][0], ids[1][1], OMIP101) }),
  gate(`${prefix}-em`, `${prefix.toUpperCase()} effector memory`, parent, 'quadrant', ['cd45ra', 'ccr7'], { keep: '--', ontology: term(ids[2][0], ids[2][1], OMIP101) }),
  gate(`${prefix}-temra`, `${prefix.toUpperCase()} TEMRA`, parent, 'quadrant', ['cd45ra', 'ccr7'], { keep: '+-', ontology: term(ids[3][0], ids[3][1], OMIP101) }),
];

export const STRATEGIES = [
  strategy({
    id: 'omip-101',
    name: 'OMIP-101: major leukocyte populations',
    citation: PRACTICE_CITATIONS['OMIP-101'],
    doi: '10.1002/cyto.a.24827',
    license: 'The article is CC BY 4.0; the hierarchy is written for CytoWeave from it.',
    description: 'Leukocytes, then lymphocytes and myeloid cells; T cells with CD4 and CD8 and their naive, central memory, effector memory and TEMRA subsets; B and NK cells; classical, intermediate and non-classical monocytes.',
    substitutions: [
      'A viability gate is added where the panel has a viability dye (the article stains fixed whole blood).',
      'Lymphocytes and myeloid cells are separated on forward and side scatter (the article uses CD33 and side scatter).',
      'Gamma-delta T cells and MAIT cells are not excluded from the CD4 and CD8 T cells when the panel lacks TCRgd, TRAV1-2 and CD161.',
      'NK cells are CD56-positive CD3− CD19− lymphocytes (the article also uses CD16 and excludes CD4).',
    ],
  }, [
    gate('singlets', 'Single cells', null, 'singlets', ['fscA', 'fscH']),
    gate('live', 'Live', 'singlets', 'split', ['viability'], { keep: '-' }),
    gate('leukocytes', 'Leukocytes', 'live', 'split', ['cd45'], { keep: '+', ontology: term('CL:0000738', 'leukocyte', OMIP101) }),
    gate('lymphocytes', 'Lymphocytes', 'leukocytes', 'scatter', ['fscA', 'sscA'], { target: 'lymphocytes', ontology: term('CL:0000542', 'lymphocyte', OMIP101) }),
    gate('myeloid', 'Myeloid cells', 'leukocytes', 'scatter', ['fscA', 'sscA'], { target: 'monocytes', ontology: term('CL:0000766', 'myeloid leukocyte', OMIP101) }),
    gate('t', 'T cells', 'lymphocytes', 'split', ['cd3'], { keep: '+', ontology: term('CL:0000084', 'T cell', OMIP101) }),
    gate('cd4', 'CD4 T cells', 't', 'quadrant', ['cd4', 'cd8'], { keep: '+-', ontology: term('CL:0000624', 'CD4-positive, alpha-beta T cell', OMIP101) }),
    gate('cd8', 'CD8 T cells', 't', 'quadrant', ['cd4', 'cd8'], { keep: '-+', ontology: term('CL:0000625', 'CD8-positive, alpha-beta T cell', OMIP101) }),
    ...memory('cd4', 'cd4', [['CL:0000895', 'naive thymus-derived CD4-positive, alpha-beta T cell'], ['CL:0000904', 'central memory CD4-positive, alpha-beta T cell'], ['CL:0000905', 'effector memory CD4-positive, alpha-beta T cell'], ['CL:0001087', 'effector memory CD4-positive, alpha-beta T cell, terminally differentiated']]),
    ...memory('cd8', 'cd8', [['CL:0000900', 'naive thymus-derived CD8-positive, alpha-beta T cell'], ['CL:0000907', 'central memory CD8-positive, alpha-beta T cell'], ['CL:0000913', 'effector memory CD8-positive, alpha-beta T cell'], ['CL:0001062', 'effector memory CD8-positive, alpha-beta T cell, terminally differentiated']]),
    gate('cd3neg', 'CD3− lymphocytes', 'lymphocytes', 'split', ['cd3'], { keep: '-' }),
    gate('b', 'B cells', 'cd3neg', 'split', ['cd19'], { keep: '+', ontology: term('CL:0000236', 'B cell', OMIP101) }),
    gate('cd19neg', 'CD3− CD19− lymphocytes', 'cd3neg', 'split', ['cd19'], { keep: '-' }),
    gate('nk', 'NK cells', 'cd19neg', 'split', ['cd56'], { keep: '+', ontology: term('CL:0000623', 'natural killer cell', OMIP101) }),
    gate('my-lin', 'Myeloid, CD3− CD19−', 'myeloid', 'quadrant', ['cd3', 'cd19'], { keep: '--' }),
    gate('my-dr', 'Myeloid, HLA-DR+', 'my-lin', 'split', ['hladr'], { keep: '+' }),
    gate('mono-classical', 'Classical monocytes', 'my-dr', 'quadrant', ['cd14', 'cd16'], { keep: '+-', edge: [false, true], ontology: term('CL:0000860', 'classical monocyte', OMIP101) }),
    gate('mono-intermediate', 'Intermediate monocytes', 'my-dr', 'quadrant', ['cd14', 'cd16'], { keep: '++', edge: [false, true], ontology: term('CL:0002393', 'intermediate monocyte', OMIP101) }),
    gate('mono-nonclassical', 'Non-classical monocytes', 'my-dr', 'quadrant', ['cd14', 'cd16'], { keep: '-+', edge: [false, true], ontology: term('CL:0000875', 'non-classical monocyte', OMIP101) }),
  ]),
  strategy({
    id: 'omip-090',
    name: 'OMIP-090: regulatory T cells',
    citation: PRACTICE_CITATIONS['OMIP-090'],
    doi: '10.1002/cyto.a.24720',
    license: 'The article is CC BY 4.0; the hierarchy is written for CytoWeave from it.',
    description: 'Lymphocytes, single and live cells, CD3+ CD4+ T cells, and regulatory T cells as CD25-high CD127-low.',
    substitutions: [
      'Single cells are gated on forward scatter only (the article also uses side-scatter width).',
      'The article goes on to the homing and memory subsets of regulatory and conventional T cells, with markers this strategy leaves out.',
    ],
  }, [
    gate('lymphocytes', 'Lymphocytes', null, 'scatter', ['fscA', 'sscA'], { target: 'lymphocytes', ontology: term('CL:0000542', 'lymphocyte', 'OMIP-090') }),
    gate('singlets', 'Single cells', 'lymphocytes', 'singlets', ['fscA', 'fscH']),
    gate('live', 'Live', 'singlets', 'split', ['viability'], { keep: '-' }),
    gate('cd4', 'CD3+ CD4+ T cells', 'live', 'quadrant', ['cd3', 'cd4'], { keep: '++', ontology: term('CL:0000624', 'CD4-positive, alpha-beta T cell', 'OMIP-090') }),
    gate('treg', 'Tregs', 'cd4', 'level', ['cd25', 'cd127'], { keep: ['high', 'low'], ontology: term('CL:0000792', 'CD4-positive, CD25-positive, alpha-beta regulatory T cell', 'OMIP-090') }),
  ]),
];

export const strategyById = (id) => STRATEGIES.find((s) => s.id === id) ?? null;
