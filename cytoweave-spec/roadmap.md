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

Four slices, in this order: the comparisons first, so that the later work on
large files is checked against them.

1. **Agreement with reference tools (V3, G4): done.** The public test data are
   fetched and checksummed by `validation/fetch.mjs`, not stored in the
   repository.
   - ISAC's Gating-ML 2.0 compliance suite: all 190 gates match on every event.
     This added transformation bounds, gates of three or more dimensions,
     per-dimension compensation, spectral unmixing matrices and computed ratio
     channels, and decides boundary events in double precision.
   - FlowKit 1.3.2 and FlowIO on FlowKit's test data: FCS decoding,
     compensation, OLS unmixing and transforms agree; on FlowJo workspaces
     CytoWeave reproduces FlowJo's saved counts at least as often as FlowKit.
     This fixed the import of FlowJo time gates, linear gains, ellipses and
     biexponential ends.
   - A corpus of instrument FCS files (fcsparser's tests), against FlowIO and
     fcsparser's published values. This fixed floating-point log channels
     (Guava) and files cut off before their data.
   - FlowJo's logicle (G4): BD's tables are reproduced by formula, but FlowJo's
     counts follow the reference logicle, which CytoWeave keeps.
2. **R reference comparisons (V3): done.** `validation/reference/generate_r.R`
   runs flowCore 2.24, PeacoQC 1.22, FlowSOM 2.20 and CytoNorm 2.0.12 on their
   own example data, a FACSDiva file, a FlowKit file and the simulated QC
   wells; the results are committed (`r.json`), so the checks need no R.
   - flowCore: values read, compensation, estimated logicle widths and the
     logicle transform agree to 1e-7 or better. This fixed `estimateLogicleW`,
     which took the 5th percentile of all values instead of the negatives.
   - PeacoQC: the classic mode is now an exact port of 1.22 (R's `density()`,
     peak tracking, the isolation tree's rising gain limit and
     `smooth.spline`), and removes the same events on all 7 files.
   - FlowSOM: events map to the same nodes of R's map and R's metaclustering
     is reproduced; whole runs agree with R as closely as R's own seeds do.
   - CytoNorm: now 2.x's 99 quantiles, and a batch with 50 or fewer cells in a
     cluster is left unchanged there, as in CytoNorm. Agrees to 1e-5.
   - FACSDiva: spillover from 15 real single-stain controls within 0.015 of
     Diva's own matrix, after leaving saturated events out of the positives.
3. **Large files (D6): done.** Measured on a 10-million-event, 21-parameter
   sample (`validation/bench.mjs`), the page stays responsive.
   - Files are read in parts: from a dropped file by slices, from the program
     by range requests. The page never holds a whole file. The program stores
     and hashes files itself (in the browser, a streaming SHA-256).
   - Populations are bitsets when large, indices when small: 7 MB instead of
     148 MB for six populations. Caches are bounded by size.
   - Compensation is computed per channel when needed. Statistics use exact
     selection instead of sorting (11 s → 0.8 s for a 14-channel table).
     Polygon gates use a cell grid (moving the top gate: 1.6 s → 0.4 s).
   - Event columns are shared with workers. Before, QC on ten million events
     failed: the browser would not copy 1.3 GB to the worker.
   - WebGL was not needed: binning ten million events onto a plot takes about
     30 ms, so drawing is not the bottleneck. Everything runs on the CPU.
4. **Workbench gaps: done.**
   - Agent proposals (M3): an agent's gates arrive as marked proposals
     (usable at once, removed if rejected). Its renames, deletions and
     compensation matrices (a new `propose_compensation` tool) wait for
     review. A strip above the population tree reviews, accepts or rejects
     each agent's proposal as a group. The change log records the agent's
     name (from its MCP client) and the decision; a `proposals` tool tells the
     agent the outcome.
   - Boolean populations (G1) from the population menu: all of, any of or
     none of chosen populations, with a live count, and editable later.
   - Index-sort plate view (A3) in Gate mode. Wells come from BD's
     `INDEX SORTING LOCATIONS` or well parameters, are colored by population
     or channel, and mark their cells on the plots; they export as CSV.
   - Explore offers k-means and Louvain, and places samples left out of a
     UMAP on the finished map (H1, H5). The methods paragraph now describes a
     result's clustering and embedding separately.

Found by slice 1 and not yet solved: FlowJo evaluates gates at its display
resolution, which moves events near boundaries (0.1–0.3% of large populations
on real workspaces; FlowKit differs the same way). Reproducing it needs
FlowJo's exact method, which is not documented.

Found by slice 3: at ten million events, the analyses in workers work, but
slowly. QC takes about 70 s, mostly PeacoQC's per-bin density estimates
(about 5 s a channel). They could run in parallel across channels on the
shared columns.

## Then (0.3): beyond a single tool

Two waves. Wave 3 builds what no single tool combines, each part checked against a reference;
wave 4 completes the release.

### Wave 3

1. **FlowJo workspace export (I4) and FCS de-identification (D7): done.**
   - A workspace exports as a FlowJo 10 workspace: one gating tree per sample with its own
     overrides and group scopes, compensation, scales, groups and, optionally, CytoWeave's counts
     and the FCS files. Gates drawn on another scale than the one exported are traced with enough
     vertices to follow their outline; populations FlowJo cannot evaluate (category gates, gates on
     computed channels, gates of three or more dimensions) are reported and left out.
   - Checked three ways: every case (the bundled example, ten FlowKit test workspaces and a
     workspace built in CytoWeave with splits, quadrants on mixed scales, Booleans, overrides and
     scopes) imports back with every count unchanged; FlowKit 1.3.2 reads every export and counts
     what CytoWeave counts (ellipse boundaries aside, as on the originals); and FlowKit's counts on
     an export equal its counts on the original workspace, or come closer to FlowJo's saved counts
     (time gates, which the export writes in `$TIMESTEP` units).
   - De-identification keeps an allowlist of technical keywords and removes everything else
     (operator, specimen and patient fields, free text, file names, dates, serial numbers, vendor
     keywords). Only the TEXT segment is rewritten; the events are copied byte for byte, checked on
     every example and corpus file. It applies to population exports, the FlowJo export, a ZIP of
     the files and an ACS archive whose workspace keeps none of the removed keywords.
   - **To do:** open an export in FlowJo itself (no FlowJo licence was available while building
     it): check that FlowJo 10 and 11 open it, find its FCS files, and show the same counts.
2. **Provenance in figures (R5): done.** Exported figures and plots (SVG metadata, a PNG iTXt
   chunk, a PDF attachment) embed the samples with their files' checksums, every gate the plots
   depend on with per-sample adjustments, the scales, the compensation each sample was drawn with,
   and each plot's event count; no keywords or events. Opening one reports, plot by plot, what
   changed since (gates, scales, compensation, counts), matching another workspace by checksum and
   population path; it rebuilds the figure in a new workspace from the library's files, or adds it
   back. The `figures` suite reads a 60-plot record back intact from all three formats, rebuilds
   every plot from the same events, and checks that a moved gate flags exactly the plots it
   affects; pypdf lists the PDF attachment.
3. **Uncertainty-aware autogating (G9): done.** A shared gate is carried to each sample by
   landmark registration of its parent population's density along each axis (after gaussNorm),
   from its exemplars: the samples it was drawn, adjusted or confirmed on, the most similar first.
   An ensemble over exemplars, smoothing bandwidths, halves of the events and left-out landmarks
   gives each sample a confidence and each event a membership probability (exported as CLR).
   Confident adjustments are ticked in a review dialog (or held in a proposal, for agents); the
   uncertain are listed first with the reason; "Looks right" adds an exemplar.
   - Real expert gates changed the design. On four FlowJo workspaces of an intracellular cytokine
     study (four donors × negative, peptide and PMA wells, gates adjusted per donor), the first
     version made agreement with the expert worse: it followed populations that moved for
     biological reasons (PMA down-regulates CD3 and CD4; one CD4 gate fell from F1 1.00 to 0.37).
     Now a gate is moved only where its boundary cuts into a population (it is not robust there)
     and the adaptation finds sparser events; landmarks are matched only within 0.16 of the axis;
     and "keep one gate per" a metadata field adapts a donor's wells together, as the expert did,
     sending a well unlike the rest of its donor to review. With one gate per donor no adjustment
     lowers agreement with the expert and the mean is unchanged (0.9876 → 0.9877); wells the
     expert gated differently go to review three times as often (45% vs 14%).
   - On a simulated cohort with up to fivefold gains, the gates' mean F1 against the true cell
     types rises (T cells 0.954 → 0.994, monocytes 0.752 → 0.803), no adjustment lowers a
     population's, nothing is sent to review without a shift, and an expert reviewing the 4 of 66
     flagged pairs brings the gates' mean F1 to 0.969 (0.982 on the sample they were drawn on). Robust boundaries left
     off-center by large shifts are kept by design; offering those moves as optional adjustments
     was tried and rejected (on the expert data they lowered agreement four times as often as
     they raised it).
   - Found on the way: FlowJo writes "LIVE/DEAD" as "LIVE_DEAD", and those channels were missing
     on import (fixed); FlowJo appears to evaluate gates at its display resolution, so cytokine
     gates whose edges sit in dense negative events differ by a few events (to investigate).
4. **Instrument characterization (Q5) and a spectral reference library (S7): done.**
   - Q, B and the beads' CV per detector from multi-level beads or an LED series, as flowQB
     computes them (Parks et al. 2017): a scatter gate and k-means on the logicle-scaled detectors
     find the levels, a normal fitted to each level's central 80% gives its mean and SD, and the
     weighted quadratic fit is re-weighted until it settles. On flowQB's own LSR II data (an LED
     series, 8-peak and 6-peak beads) the peaks, coefficients and standard errors equal flowQB's
     within 6e-9 in all 36 detectors. flowQB is deprecated in Bioconductor and needs a one-line
     fix to run on R 4 (in `generate_flowqb.R`).
   - The simulator now knows every detector's Q and B (its noise model is the same quadratic), and
     a new example has 30 daily bead runs with a PMT ageing, a dirty flow cell and a weaker laser:
     Q within 2% and B within 6% (median), every problem flagged at once on the Levey–Jennings
     charts (Westgard rules against the first 20 runs), nothing in the baseline, 0.8% false flags
     after. The standard errors are somewhat optimistic (87% of the truths within 2 SE): the robust
     peak statistics are less efficient than the weights assume, as in flowQB.
   - Bead-level charts follow one level that is in the linear range in every run: following "the
     brightest kept level" made a weaker laser look like a brighter one when the top level came
     back into range.
   - The library now keeps records across workspaces (instrument runs, spectra). Reference spectra
     are compared peak-normalized, detector by detector: cosine similarity hardly moves when a
     tandem loses 5% of its emission (0.9988), the donor's detector moves by 0.05. Independent
     controls of the simulated instrument agree within 0.01, so 0.03 flags a change; a stale
     PE-Cy7 spectrum cost PE nearly a third of its correlation with the truth (0.68 → 0.48). Real controls will vary
     more than simulated ones; the threshold may need to be per laboratory.

### Wave 4

1. **Predicted spread for panel design (S6)** from the library of wave 3 and the noise model,
   validated against observed spread.
2. **Acquisition-time QC (Q4):** the host watches the instrument's export folder; PeacoQC runs its
   channels in parallel on the shared columns.
3. **Counterfactual preprocessing:** whether a comparison's conclusion survives alternative scales,
   matrices, QC thresholds and gate variants.
4. **Accessibility (V4):** keyboard-only operation, labels on every control, colour maps checked
   for colour-vision deficiency.

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
| FCS and vendor edge cases | A reader that fails on real instrument exports loses trust at once | Forgiving reader that reports every repair, checked on files from several instruments against FlowIO; next: more vendors and a fuzzed corpus |
| Numerical disagreement with FlowJo, R or Python | Small transform, compensation or boundary differences move rare populations | Gating-ML boundary semantics and ISAC's compliance suite, FlowJo's exact biexponential, double-precision boundary decisions, comparisons with FlowKit and FlowJo's saved counts; next: R reference tools |
| FlowJo lock-in | Labs cannot leave years of analyses behind | Workspace import with a fidelity report and count-by-count migration report; Gating-ML export |
| Algorithms that look more certain than they are | Automated gates and embeddings can seem authoritative | Boundary robustness, review across samples, embedding faithfulness, plain-language caveats |
| Browser memory and speed | Many samples of millions of events | Lazy loading, caches, workers; next: streaming and bitset populations |
| Clinical use | Research software mistaken for a diagnostic device | "Research use only" in the app and README |
| Scope | A broad tool stalls before it is dependable | Validation first; features land with tests and a validation check |
| Data governance | Sample data that may not leave the institution | Local-first, no uploads, no network requests of its own |
