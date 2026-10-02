# CytoWeave roadmap

The order follows the principle of `research.md` §8:
1. trust first: numbers that match the standards, FlowJo, R and Python;
2. then the daily workbench;
3. then what no single tool combines.

Each item links to the requirement it serves (`requirements.md`).

## 0.1.0 (first release)

The foundations and most of the workbench:
- FCS 2.0–3.2 with repairs, and the content-addressed library.
- The reference logicle and FlowJo's exact biexponential.
- Gating with shared gates and per-sample overrides, and review across samples
  with boundary robustness.
- Compensation computed from controls and checked against them.
- Spectral unmixing with multiple and per-event autofluorescence, and a
  comparison of unmixing models.
- Refined PeacoQC, flow rate, margins and drift; CytoNorm, beads and
  debarcoding.
- FlowSOM, Leiden, UMAP, t-SNE and PCA, with faithfulness metrics.
- Cell cycle and proliferation.
- Tables and design-aware group comparisons.
- Figures; methods, MIFlowCyt, checkpoints and semantic diff.
- FlowJo import with fidelity and count reports; Gating-ML, CLR and ACS.
- MCP server and remote control.
- Nine simulated examples with ground truth, and a validation suite.

## Next (0.2): trust and scale

1. **Reference-tool comparisons on public data (V3).**
   - Run FlowKit 1.3, flowCore, PeacoQC 1.22, FlowSOM, CytoNorm and FlowJo on
     a small set of redistributable public files, and keep their outputs as
     golden numbers in `validation/reference/`.
   - Add the ISAC Gating-ML 2.0 compliance suite (per-event truth, in
     FlowKit's test data).
   - Candidate data sets are listed in `research.md` §6.
2. **FlowJo-compatible logicle (G4).** BD's published tables show FlowJo's
   logicle departing from the reference at W > 0.5. Fit FlowJo's
   construction, or ship the tables (MIT) for its parameter grid, so that
   imported polygons on such axes match FlowJo's counts.
3. **Large files (D6).**
   - Stream FCS data from the host with HTTP range requests.
   - Keep populations as bitsets once they are large.
   - Optional WebGL rendering for plots of 10M+ events.
   - Keep a CPU path for everything.
4. **Agent proposals (M3).** Gates and matrices from an agent arrive as
   proposals in a review queue, accepted or rejected as a group, and the
   change log records who accepted them.
5. **Drawing Boolean gates (G1)** in the population tree.
6. **Index-sort plate view (A3):** a 96/384-well plate linked to the plots.
7. **Explore:** offer k-means and Louvain (already in the library), and
   place new samples on an existing UMAP (H1, H5).

## Then (0.3): beyond a single tool

1. **Uncertainty-aware autogating (G9).** Learn per-sample adjustments of a
   template from the user's own gated examples. Each sample gets a confidence
   value; low-confidence samples go to the review queue instead of being
   moved silently. Per-event probabilities export as CLR.
2. **Provenance in figures (R5).** SVG and PDF exports embed the gates,
   scales, matrices and file checksums they show, so a figure can be traced
   to, and rebuilt from, its analysis.
3. **Predicted spread for panel design (S6).** Compute the unmixed covariance
   U Σ Uᵀ from the user's own reference library and the instrument's noise
   model, and compare candidate panels before staining. This needs a
   **spectral reference library (S7)** kept across experiments, and
   **instrument characterization (Q5)**: Q and B, and Levey–Jennings charts
   from bead files.
4. **Acquisition-time QC (Q4).** The host watches the instrument's export
   folder and runs QC on each file as it lands.
5. **Counterfactual preprocessing.** Generalize the comparison of unmixing
   models to every analysis choice: logicle width or cofactor, matrix, QC
   thresholds, gate variants. Report whether the conclusion of a comparison
   survives them.
6. **FlowJo workspace export (I4)** and **FCS de-identification (D7).**

## Later
- Branches of an analysis, three-way merge of non-conflicting edits, and
  signed approval of checkpoints, building on the semantic diff.
- A tool contract for external algorithms: declared inputs and outputs,
  parameters and a pinned runtime (a WASM module, or a container run by the
  host without network). Results are imported as ordinary derived channels,
  so a tool cannot change a workspace invisibly. This would replace the
  plugin approach of other tools, which depends on the user's own R or Python
  installation.
- A Python package wrapping remote control, for notebooks and pipelines.
- Design studies with one or two core facilities, and tutorials built on
  public FlowRepository studies.

- Imaging flow cytometry: image galleries for FACSDiscover CellView and Amnis
  files.
- Audit trail and electronic signatures for regulated labs (R6).
- Real-time co-annotation of one workspace by several people.
- Ontology-mapped population names (Cell Ontology) for machine-comparable
  results.
- Kinetics and calcium-flux analysis (A4).

## Risks

| Risk | Why it matters | What CytoWeave does |
| --- | --- | --- |
| FCS and vendor edge cases | A reader that fails on real instrument exports loses trust at once | Forgiving reader that reports every repair; next: a fuzzed corpus of vendor files |
| Numerical disagreement with FlowJo, R or Python | Small transform, compensation or boundary differences move rare populations | Gating-ML boundary semantics, FlowJo's exact biexponential, golden validation; next: reference-tool comparisons on public data |
| FlowJo lock-in | Labs cannot leave years of analyses behind | Workspace import with a fidelity report and count-by-count migration report; Gating-ML export |
| Algorithms that look more certain than they are | Automated gates and embeddings can seem authoritative | Boundary robustness, review across samples, embedding faithfulness, plain-language caveats |
| Browser memory and speed | Many samples of millions of events | Lazy loading, caches, workers; next: streaming and bitset populations |
| Clinical use | Research software mistaken for a diagnostic device | "Research use only" in the app and README |
| Scope | A broad tool stalls before it is dependable | Validation first; features land with tests and a validation check |
| Data governance | Sample data that may not leave the institution | Local-first, no uploads, no network requests of its own |
