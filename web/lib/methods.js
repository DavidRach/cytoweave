// A methods paragraph, references and a MIFlowCyt checklist, written from what the workspace
// actually contains: the instruments in the files' keywords, the compensation and scales used,
// the gating hierarchy, and every recorded analysis with its parameters.

export const REFERENCES = {
  cytoweave: { text: 'CytoWeave: open-source flow cytometry analysis. https://github.com/robert-mcdermott/cytoweave', doi: null },
  fcs31: { text: 'Spidlen J, Moore W, Parks D, et al. Data File Standard for Flow Cytometry, version FCS 3.1. Cytometry A. 2010;77(1):97–100.', doi: '10.1002/cyto.a.20825' },
  logicle: { text: 'Parks DR, Roederer M, Moore WA. A new "Logicle" display method avoids deceptive effects of logarithmic scaling for low signals and compensated data. Cytometry A. 2006;69(6):541–551.', doi: '10.1002/cyto.a.20258' },
  logicleAlgorithm: { text: 'Moore WA, Parks DR. Update for the logicle data scale including operational code implementations. Cytometry A. 2012;81(4):273–277.', doi: '10.1002/cyto.a.22030' },
  gatingml: { text: 'Spidlen J, Moore W, Brinkman RR, et al. ISAC\'s Gating-ML 2.0 data exchange standard for gating description. Cytometry A. 2015;87(7):683–687.', doi: '10.1002/cyto.a.22690' },
  ssm: { text: 'Nguyen R, Perfetto S, Mahnke YD, Chattopadhyay P, Roederer M. Quantifying spillover spreading for comparing instrument performance and aiding in multicolor panel design. Cytometry A. 2013;83(3):306–315.', doi: '10.1002/cyto.a.22251' },
  autospill: { text: 'Roca CP, Burton OT, Gergelits V, et al. AutoSpill is a principled framework that simplifies the analysis of multichromatic flow cytometry data. Nat Commun. 2021;12:2890.', doi: '10.1038/s41467-021-23126-8' },
  peacoqc: { text: 'Emmaneel A, Quintelier K, Sichien D, et al. PeacoQC: Peak-based selection of high quality cytometry data. Cytometry A. 2022;101(4):325–338.', doi: '10.1002/cyto.a.24501' },
  flowai: { text: 'Monaco G, Chen H, Poidinger M, Chen J, de Magalhães JP, Larbi A. flowAI: automatic and interactive anomaly discerning tools for flow cytometry data. Bioinformatics. 2016;32(16):2473–2480.', doi: '10.1093/bioinformatics/btw191' },
  flowsom: { text: 'Van Gassen S, Callebaut B, Van Helden MJ, et al. FlowSOM: Using self-organizing maps for visualization and interpretation of cytometry data. Cytometry A. 2015;87(7):636–645.', doi: '10.1002/cyto.a.22625' },
  consensus: { text: 'Wilkerson MD, Hayes DN. ConsensusClusterPlus: a class discovery tool with confidence assessments and item tracking. Bioinformatics. 2010;26(12):1572–1573.', doi: '10.1093/bioinformatics/btq170' },
  umap: { text: 'McInnes L, Healy J, Melville J. UMAP: Uniform Manifold Approximation and Projection for dimension reduction. arXiv:1802.03426. 2018.', doi: null },
  tsne: { text: 'van der Maaten L. Accelerating t-SNE using tree-based algorithms. J Mach Learn Res. 2014;15:3221–3245.', doi: null },
  optsne: { text: 'Belkina AC, Ciccolella CO, Anno R, et al. Automated optimized parameters for T-distributed stochastic neighbor embedding improve visualization and analysis of large datasets. Nat Commun. 2019;10:5415.', doi: '10.1038/s41467-019-13055-y' },
  leiden: { text: 'Traag VA, Waltman L, van Eck NJ. From Louvain to Leiden: guaranteeing well-connected communities. Sci Rep. 2019;9:5233.', doi: '10.1038/s41598-019-41695-z' },
  phenograph: { text: 'Levine JH, Simonds EF, Bendall SC, et al. Data-driven phenotypic dissection of AML reveals progenitor-like cells that correlate with prognosis. Cell. 2015;162(1):184–197.', doi: '10.1016/j.cell.2015.05.047' },
  cytonorm: { text: 'Van Gassen S, Gaudilliere B, Angst MS, Saeys Y, Aghaeepour N. CytoNorm: A normalization algorithm for cytometry data. Cytometry A. 2020;97(3):268–278.', doi: '10.1002/cyto.a.23904' },
  beads: { text: 'Finck R, Simonds EF, Jager A, et al. Normalization of mass cytometry data with bead standards. Cytometry A. 2013;83(5):483–494.', doi: '10.1002/cyto.a.22271' },
  debarcode: { text: 'Zunder ER, Finck R, Behbehani GK, et al. Palladium-based mass tag cell barcoding with a doublet-filtering scheme and single-cell deconvolution algorithm. Nat Protoc. 2015;10(2):316–333.', doi: '10.1038/nprot.2015.020' },
  deanJettFox: { text: 'Fox MH. A model for the computer analysis of synchronous DNA distributions obtained by flow cytometry. Cytometry. 1980;1(1):71–77.', doi: '10.1002/cyto.990010114' },
  watson: { text: 'Watson JV, Chambers SH, Smith PJ. A pragmatic approach to the analysis of DNA histograms with a definable G1 peak. Cytometry. 1987;8(1):1–8.', doi: '10.1002/cyto.990080101' },
  proliferation: { text: 'Roederer M. Interpretation of cellular proliferation data: avoid the panglossian. Cytometry A. 2011;79(2):95–101.', doi: '10.1002/cyto.a.21010' },
  bh: { text: 'Benjamini Y, Hochberg Y. Controlling the false discovery rate: a practical and powerful approach to multiple testing. J R Stat Soc B. 1995;57(1):289–300.', doi: null },
  miflowcyt: { text: 'Lee JA, Spidlen J, Boyce K, et al. MIFlowCyt: the minimum information about a flow cytometry experiment. Cytometry A. 2008;73(10):926–930.', doi: '10.1002/cyto.a.20623' },
  unmixing: { text: 'Novo D, Grégori G, Rajwa B. Generalized unmixing model for multispectral flow cytometry utilizing nonsquare compensation matrices. Cytometry A. 2013;83(5):508–520.', doi: '10.1002/cyto.a.22272' },
  autofluorescence: { text: 'Roet JEG, Mikula AM, de Kok M, et al. Unbiased method for spectral analysis of cells with great diversity of autofluorescence spectra. Cytometry A. 2024;105(8):595–606.', doi: '10.1002/cyto.a.24856' },
  stainIndex: { text: 'Maecker HT, Frey T, Nomura LE, Trotter J. Selecting fluorochrome conjugates for maximum sensitivity. Cytometry A. 2004;62(2):169–173.', doi: '10.1002/cyto.a.20092' },
};

const ORDER = Object.keys(REFERENCES);

function list(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describeTransform(spec) {
  if (!spec) return 'linear';
  switch (spec.type) {
    case 'logicle': return `logicle (T = ${spec.T}, W = ${spec.W}, M = ${spec.M}, A = ${spec.A ?? 0})`;
    case 'biex': return `biexponential (width basis ${spec.widthBasis}, ${spec.positiveDecades} positive decades)`;
    case 'arcsinh': return `arcsinh (cofactor ${spec.cofactor})`;
    case 'log': return 'logarithmic';
    default: return spec.type;
  }
}

// Writes the methods: { paragraphs: [string], references: [{ key, text, doi }] }. Citations
// appear in the text as [n] in the order first used.
export function writeMethods(ws, options = {}) {
  const used = [];
  const cite = (key) => {
    if (!REFERENCES[key]) return '';
    if (!used.includes(key)) used.push(key);
    return `[${used.indexOf(key) + 1}]`;
  };
  const paragraphs = [];
  const samples = ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference');
  const controls = ws.samples.filter((s) => s.role !== 'sample' && s.role !== 'reference');
  const cytometers = [...new Set(ws.samples.map((s) => s.acquisition?.cytometer).filter(Boolean))];
  const versions = [...new Set(ws.samples.map((s) => s.fcsVersion).filter(Boolean))];
  const technology = [...new Set(ws.samples.map((s) => s.technology))];
  paragraphs.push(`Flow cytometry data (${samples.length} sample${samples.length === 1 ? '' : 's'}${controls.length ? ` and ${controls.length} control${controls.length === 1 ? '' : 's'}` : ''}${cytometers.length ? `, acquired on ${list(cytometers)}` : ''}; ${list(versions)} files ${cite('fcs31')}) were analyzed with CytoWeave ${options.version ?? ''} ${cite('cytoweave')}.`.replace(/\s+/g, ' ').replace(' .', '.'));

  // Compensation and unmixing.
  const compSentences = [];
  const fileComp = ws.samples.filter((s) => s.compensationId === 'file').length;
  if (fileComp) compSentences.push(`${fileComp} file(s) were compensated with the spillover matrix recorded at acquisition ($SPILLOVER)`);
  for (const comp of ws.compensations) {
    const users = ws.samples.filter((s) => s.compensationId === comp.id).length;
    if (!users) continue;
    if (comp.source === 'computed') compSentences.push(`${users} file(s) were compensated with a ${comp.channels.length}-color spillover matrix computed from single-stain controls by ${comp.method === 'regression' ? `robust regression ${cite('autospill')}` : 'the difference of positive and negative medians'}`);
    else if (comp.source === 'imported') compSentences.push(`${users} file(s) used the imported matrix "${comp.name}"`);
    else compSentences.push(`${users} file(s) used the matrix "${comp.name}", adjusted manually`);
  }
  // Files with several fluorochromes that were left uncompensated are worth stating; a single-dye
  // assay (DNA content, one marker) needs no compensation.
  const dyes = (s) => new Set(s.channels.filter((c) => c.type === 'fluorescence').map((c) => c.marker || c.name.replace(/-[AHW]$/, ''))).size;
  const uncompensated = ws.samples.filter((s) => s.compensationId === 'none' && s.technology === 'conventional' && dyes(s) > 1).length;
  if (uncompensated) compSentences.push(`${uncompensated} file(s) were not compensated`);
  if (compSentences.length) paragraphs.push(`${compSentences.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()));
  const unmixing = ws.derived.filter((d) => d.kind === 'unmixing');
  for (const d of unmixing) paragraphs.push(`Spectral data were unmixed by ${d.method ?? 'least squares'} ${cite('unmixing')}${d.params?.autofluorescence ? `, with ${d.params.autofluorescence === 'multiple' ? 'per-cell selection among multiple autofluorescence signatures' : 'an autofluorescence signature'} ${cite('autofluorescence')}` : ''}.`);

  // Scales: channels sharing a transform family and its fixed parameters are described together,
  // with the range of their per-channel linear widths.
  const families = new Map();
  for (const [channel, setting] of Object.entries(ws.channelSettings ?? {})) {
    const spec = setting.transform;
    if (!spec?.type || spec.type === 'linear') continue;
    const key = spec.type === 'logicle' ? `logicle|${spec.T}|${spec.M}|${spec.A ?? 0}` : spec.type === 'arcsinh' ? `arcsinh|${spec.cofactor}` : describeTransform(spec);
    if (!families.has(key)) families.set(key, { spec, channels: [], widths: [] });
    const family = families.get(key);
    family.channels.push(channel);
    if (spec.type === 'logicle') family.widths.push(spec.W);
  }
  if (families.size) {
    const parts = [...families.values()].map(({ spec, channels, widths }) => {
      const n = `${channels.length} channel${channels.length === 1 ? '' : 's'}`;
      if (spec.type === 'logicle') {
        const lo = Math.min(...widths);
        const hi = Math.max(...widths);
        const width = lo === hi ? `W = ${lo}` : `W from ${+lo.toFixed(2)} to ${+hi.toFixed(2)}, estimated per channel from the negative data`;
        return `logicle (T = ${spec.T}, M = ${spec.M}, A = ${spec.A ?? 0}, ${width}) for ${n}`;
      }
      return `${describeTransform(spec)} for ${n}`;
    });
    const logicle = [...families.values()].some((f) => f.spec.type === 'logicle' || f.spec.type === 'biex');
    paragraphs.push(`Fluorescence was displayed and gated on ${list(parts)}${logicle ? ` ${cite('logicle')}${cite('logicleAlgorithm')}` : ''}.`);
  }

  // Quality control and normalization.
  for (const d of ws.derived.filter((r) => r.kind === 'qc')) {
    const removed = d.summary?.percentRemoved ?? d.summary?.meanRemoved;
    paragraphs.push(`Acquisition anomalies were flagged with a PeacoQC-style algorithm ${cite('peacoqc')} and a flow-rate check ${cite('flowai')}${d.params ? ` (${Object.entries(d.params).slice(0, 4).map(([k, v]) => `${k} = ${v}`).join(', ')})` : ''}${Number.isFinite(removed) ? `, removing ${removed.toFixed(1)}% of events on average` : ''}.`);
  }
  for (const d of ws.derived.filter((r) => r.kind === 'normalization')) paragraphs.push(`Batch effects were corrected with ${d.method?.toLowerCase().includes('bead') ? `bead normalization ${cite('beads')}` : `CytoNorm ${cite('cytonorm')}`}${d.params?.channels ? ` on ${d.params.channels.length} channels` : ''}.`);

  // Gating.
  const roots = ws.gates.filter((g) => !g.parentId);
  if (ws.gates.length) {
    const paths = [];
    const walk = (gate, trail) => {
      const children = ws.gates.filter((g) => g.parentId === gate.id);
      const next = [...trail, gate.name];
      if (!children.length) paths.push(next.join(' → '));
      for (const child of children) walk(child, next);
    };
    for (const root of roots) walk(root, []);
    const adjusted = ws.gates.filter((g) => Object.keys(g.overrides ?? {}).length).length;
    const auto = ws.gates.filter((g) => g.meta?.origin === 'auto').length;
    paragraphs.push(`Populations were identified by sequential gating (${ws.gates.length} gates): ${paths.slice(0, 8).join('; ')}${paths.length > 8 ? `; and ${paths.length - 8} further branches` : ''}. ${auto ? `${auto} gate(s) were proposed automatically from the data's density and accepted by the analyst. ` : ''}${adjusted ? `${adjusted} gate(s) were adjusted for individual samples; all other gates were applied identically to every sample. ` : 'Gates were applied identically to every sample. '}The gating strategy is available in Gating-ML 2.0 format ${cite('gatingml')}.`);
  }

  // High-dimensional analysis.
  for (const d of ws.derived.filter((r) => ['flowsom', 'clustering', 'umap', 'tsne', 'embedding', 'phenograph', 'leiden'].includes(r.kind))) {
    const params = d.params ?? {};
    const seed = d.seed !== undefined ? `, seed ${d.seed}` : '';
    if (d.kind === 'flowsom' || /flowsom/i.test(d.method ?? '')) paragraphs.push(`Cells were clustered with FlowSOM ${cite('flowsom')} (${params.xdim ?? 10}×${params.ydim ?? 10} grid, ${params.k ?? 'k'} metaclusters by consensus clustering ${cite('consensus')}${seed}) on ${params.markers?.length ?? 'the selected'} markers.`);
    else if (d.kind === 'umap' || /umap/i.test(d.method ?? '')) paragraphs.push(`Data were embedded with UMAP ${cite('umap')} (${params.nNeighbors ?? 15} neighbors, minimum distance ${params.minDist ?? 0.1}${seed}) on ${params.markers?.length ?? 'the selected'} markers of ${params.events ? `${params.events.toLocaleString('en-US')} events` : 'a subsample of events'}.`);
    else if (d.kind === 'tsne' || /t-?sne/i.test(d.method ?? '')) paragraphs.push(`Data were embedded with Barnes–Hut t-SNE ${cite('tsne')} (perplexity ${params.perplexity ?? 30}, learning rate set as in opt-SNE ${cite('optsne')}${seed}).`);
    else if (/leiden|phenograph/i.test(`${d.kind} ${d.method}`)) paragraphs.push(`Cells were clustered by Leiden community detection ${cite('leiden')} on a k-nearest-neighbor graph with Jaccard weights as in PhenoGraph ${cite('phenograph')}${seed}.`);
  }
  for (const d of ws.derived.filter((r) => r.kind === 'cellcycle')) paragraphs.push(`DNA content histograms were modeled with the ${/watson/i.test(d.method ?? '') ? `Watson pragmatic model ${cite('watson')}` : `Dean–Jett–Fox model ${cite('deanJettFox')}`}.`);
  for (const d of ws.derived.filter((r) => r.kind === 'proliferation')) paragraphs.push(`Proliferation was modeled by fitting generation peaks of dye dilution; division, proliferation and expansion indices follow Roederer ${cite('proliferation')}.`);

  // Statistics.
  for (const comparison of (ws.comparisons ?? []).slice(-5)) {
    const adjusted = comparison.adjustment ? `, with ${comparison.adjustment === 'BH' ? `Benjamini–Hochberg correction ${cite('bh')}` : `${comparison.adjustment} correction`}` : '';
    paragraphs.push(`${comparison.methods ?? `${comparison.measure ?? 'Values'} were compared between groups with ${comparison.test ?? 'a two-sided test'}`}${adjusted}; each sample was one observation.`.replace(/\.\./g, '.'));
  }
  // Claim MIFlowCyt only when every checklist item is documented; otherwise say how far it goes.
  const checklist = miflowcytChecklist(ws);
  const documented = checklist.filter((item) => item.ok).length;
  paragraphs.push(documented === checklist.length
    ? `Reporting follows MIFlowCyt ${cite('miflowcyt')}.`
    : `This description documents ${documented} of the ${checklist.length} MIFlowCyt items ${cite('miflowcyt')}; the remaining items should be reported with it.`);
  return { paragraphs, references: used.map((key) => ({ key, ...REFERENCES[key] })) };
}

export function toBibTeX(references) {
  return references.map((ref, i) => {
    const authors = ref.text.split('.')[0];
    const year = (ref.text.match(/(19|20)\d{2}/) ?? [''])[0];
    return `@misc{ref${i + 1},\n  note = {${ref.text.replace(/[{}]/g, '')}},\n  author = {${authors}},\n  year = {${year}}${ref.doi ? `,\n  doi = {${ref.doi}}` : ''}\n}`;
  }).join('\n\n');
}

// MIFlowCyt items and whether the workspace documents them.
export function miflowcytChecklist(ws) {
  const keywords = ws.samples.map((s) => s.keywords ?? {});
  const any = (fn) => keywords.some(fn);
  const meta = (field) => ws.samples.some((s) => s.meta?.[field]);
  return [
    { section: 'Experiment overview', item: 'Purpose, keywords and experiment variables', ok: Boolean(ws.notes?.trim()) || meta('condition'), hint: 'Describe the experiment in the workspace notes and annotate conditions.' },
    { section: 'Experiment overview', item: 'Organization, primary contact, date', ok: any((k) => k.$DATE) && Boolean(ws.notes?.match(/contact|lab|@/i)), hint: 'Add the lab and a contact to the notes; acquisition dates come from $DATE.' },
    { section: 'Sample', item: 'Specimen description (source, organism, treatment)', ok: meta('tissue') || meta('treatment') || meta('condition'), hint: 'Annotate samples with tissue, organism and treatment.' },
    { section: 'Sample', item: 'Reagents: analytes, fluorochromes, clones', ok: ws.samples.some((s) => s.channels.some((c) => c.marker)), hint: 'Marker names come from $PnS; clones and lots belong in the notes.' },
    { section: 'Sample', item: 'Controls (unstained, single-stain, FMO, isotype)', ok: ws.samples.some((s) => s.role !== 'sample'), hint: 'Mark control samples with their role.' },
    { section: 'Instrument', item: 'Cytometer, configuration and settings', ok: any((k) => k.$CYT), hint: '$CYT, detector voltages ($PnV) and filters ($PnF) come from the files.' },
    { section: 'Data analysis', item: 'List-mode data files', ok: ws.samples.length > 0, hint: '' },
    { section: 'Data analysis', item: 'Compensation description', ok: ws.samples.every((s) => s.technology !== 'conventional' || s.compensationId !== 'none') || ws.compensations.length > 0, hint: 'Apply or compute a compensation, or state why none was used.' },
    { section: 'Data analysis', item: 'Data transformation', ok: Object.keys(ws.channelSettings ?? {}).length > 0, hint: 'Channel scales are recorded automatically.' },
    { section: 'Data analysis', item: 'Gating description', ok: ws.gates.length > 0, hint: 'Export the gates as Gating-ML and include a gating strategy figure.' },
  ];
}
