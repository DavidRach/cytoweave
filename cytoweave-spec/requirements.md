# CytoWeave requirements

What CytoWeave must do, and the status of each requirement in 0.5.0.
- `research.md` explains why each requirement is here: the methods and
  standards of §3–4 and the design implications of §8.
- `design.md` explains how the requirements are met.

Status: **done**, **partial** (the gap is noted) or **planned** (see
`roadmap.md`).

## Users

- **Bench scientists** analyzing their own experiments. They want the
  FlowJo workflow to be faster, and free.
- **Core facility staff** who check many samples and teach analysis. They
  want consistency, QC and explanations.
- **Computational cytometrists** who need high-dimensional methods,
  reproducibility and scripting without giving up an interactive tool.
- **AI agents** acting for any of them, through a typed and auditable
  interface.

## Distribution and platform

| # | Requirement | Status |
| --- | --- | --- |
| P1 | One self-contained program for macOS, Linux and Windows (x64 and ARM64); a one-line install; no license server, account, Python, R or plugins | done |
| P2 | The web application also runs from a static web server, without the Go host | done (library falls back to OPFS and IndexedDB) |
| P3 | Files never leave the computer; no network requests of its own | done |
| P4 | Apache-2.0; no third-party runtime dependencies | done |
| P5 | Opens as a desktop window; a second launch hands its files to the open window | done |

## Data

| # | Requirement | Status |
| --- | --- | --- |
| D1 | Read FCS 2.0, 3.0, 3.1 and 3.2, all data types, several data sets per file; repair common vendor deviations and report every repair | done (checked on files from several instruments against FlowIO and fcsparser, `validation/`) |
| D2 | Write FCS 3.1 for exported populations | done |
| D3 | Read spillover from all common keywords | done |
| D4 | Annotate samples (condition, subject, batch, …), from file names or a CSV table | done |
| D5 | Content-addressed library: workspaces refer to files by SHA-256 and survive moves | done |
| D6 | Large data: 10 million events per sample at interactive speed | done: files read in parts (never whole), bitset populations, lazy compensation, statistics by selection, shared memory with workers; at 10M events a gate drag draws in about 8 ms and dropping it re-evaluates every population in about 0.4 s (`validation/bench.mjs`) |
| D7 | FCS de-identification on export | done: an allowlist of technical keywords, the rest removed and reported; the TEXT segment rewritten and the events copied byte for byte (checked on every example and corpus file); for population exports, the FlowJo export, a ZIP of the files and an ACS archive |
| D8 | The reader hardened by fuzzing (no crash or hang on any mutated file, a clear message for every refusal) and checked on more instruments | done: seeded fuzzing of 21 generated layouts and 73 instrument files (validation `fuzz`, `fuzz-corpus`; 0 failures in 310,000 cases); 47 files from 42 more instrument models within 3.7e-7 of FlowIO and fcsparser (validation `instruments`) |

## Gating and statistics

| # | Requirement | Status |
| --- | --- | --- |
| G1 | Rectangle, polygon, freehand, ellipse, quadrant, range, split, Boolean and category gates with Gating-ML semantics; imported gates of three or more dimensions; a gate dimension may keep its own compensation | done (all 190 gates of ISAC's Gating-ML compliance suite match on every event; Boolean populations are made from the population menu: all of, any of or none of chosen populations) |
| G2 | Shared gates with per-sample overrides and group scopes | done |
| G3 | Plot types: pseudocolor, dot, density, contour, zebra, histogram, cumulative; backgating; overlays | done |
| G4 | Scales: linear, log, logicle (reference), arcsinh, FlowJo biexponential (exact), fasinh and hyperlog (import); Gating-ML bounds | done (FlowJo's counts follow the reference logicle, not BD's published logicle tables: `validation/README.md`) |
| G5 | Magic-wand gating: density basins and histogram valleys | done |
| G6 | Statistics of FlowJo's set plus confidence intervals for frequencies | done |
| G7 | Batch tables, CSV/TSV export, heat maps | done |
| G8 | Review a gate across samples; boundary robustness | done |
| G9 | Learned per-sample gate adjustment with abstention (uncertainty-aware autogating) | done: landmark registration from the gate's exemplars with an ensemble confidence; confident adjustments proposed, uncertain samples sent to review; one gate per donor or subject; CLR probabilities; validated on simulated shifts (validation `autogating`) and against an expert's per-donor gates in a real ICS study (`experts`) |
| G10 | Population comparison: probability binning, Overton subtraction, SED, Kolmogorov–Smirnov | done: Tables statistics against a control sample (SED, Overton, probability binning T(χ) and excess %, K-S D), shown under overlaid histograms; probability binning equal to flowStats (validation `comparisons`) |
| G11 | Rare-event statistics: Poisson intervals on counts, limits of detection and quantification, events needed | done: exact Poisson and binomial limits as Tables statistics, counting CV and events needed in the inspector, a column's limits of blank, detection and quantification (CLSI EP17) marking each value |
| G12 | Derived parameters from formulas | done: formula channels by marker or detector, previewed as typed, gateable, carried by templates, ratios written to Gating-ML (fratio); equal to R on 7 formulas (validation `calibration`) |
| G13 | Calibrated units (MEF, ERF) from beads; absolute counts from counting beads | done: QC → Calibration as FlowCal computes it (within 1.6% of FlowCal on its example, validation `flowcal`); absolute counts from counting beads with a dilution factor |

## Compensation and spectral

| # | Requirement | Status |
| --- | --- | --- |
| C1 | Spillover from single-stain controls (median difference, robust regression); manual editing with undo | done |
| C2 | Check a matrix against its controls and suggest corrections; recognize autofluorescent positives | done |
| C3 | Spillover spreading matrix; N×N pair plots | done |
| C4 | Virtual FMO: each population's negative without a dye, predicted from the spread model | planned (wave 8) |
| S1 | Reference spectra from controls with automatic gating; control quality metrics | done |
| S2 | Several autofluorescence signatures; per-event autofluorescence | done |
| S3 | OLS, WLS (fixed and per-event weights) and NNLS unmixing; residual channel | done |
| S4 | Complexity index, similarity and spreading matrices | done |
| S5 | Comparison of unmixing models on the user's own sample | done |
| S6 | Predicted spread for panel design from the user's own references | done: photon and laser noise fitted to the controls, kept per instrument or from bead runs; validated on simulated and real (LSRFortessa) controls |
| S7 | Spectral reference library across experiments | done: spectra kept per instrument in the library; controls compared with them (a degraded tandem flagged); library spectra for fluorochromes without a control; validation `spectral` |
| S8 | Unmixing doctor: the likely cause of a poor unmixing, named with its fix | planned (wave 7) |
| S9 | Panel optimizer from the user's instrument model and library | planned (wave 8) |

## Quality control and normalization

| # | Requirement | Status |
| --- | --- | --- |
| Q1 | PeacoQC (classic and refined), flow rate, margins, drift; a reversible "QC pass" channel | done |
| Q2 | Cohort QC overview with scores | done |
| Q3 | CytoNorm with a confounding check; bead normalization; debarcoding | done |
| Q4 | QC of files as they are acquired (folder watching) | done: the program watches a folder read-only and hands over complete files; acquisition QC or Q and B as they land; PeacoQC's channels in parallel |
| Q5 | Instrument characterization (Q and B, Levey–Jennings) | done: Q, B and CV0 from multi-level beads or LED series as flowQB computes them (validation `flowqb`: equal within 6e-9), runs kept per instrument and followed on Levey–Jennings charts with Westgard rules (validation `instrument`) |
| Q6 | Titration and voltage optimization: stain and separation index per step, a recommended titer or voltage | done: QC → Titration reads amounts from names and voltages from $PnV; stain and separation index per step; the recommended amount (twice the 90% saturation amount) and voltage range (2.5 × rSD_EN to the linear range), with a figure and the methods |

## High-dimensional analysis

| # | Requirement | Status |
| --- | --- | --- |
| H1 | FlowSOM, Leiden, Louvain and k-means clustering; UMAP, t-SNE and PCA across samples with equal sampling | done |
| H2 | Cluster naming from marker enrichment; clusters as populations | done |
| H3 | Embedding faithfulness: trustworthiness, continuity, kNN preservation, mixing, seed stability, unreliable regions | done |
| H4 | Differential abundance of clusters across groups | done (quasi-binomial, diffcyt-like) |
| H5 | Placing new samples on an existing map | done: samples left out of a UMAP are placed on it with UMAP's transform, the map unchanged |
| H6 | Differential state of markers per cluster or population across groups | done: diffcyt-DS-limma in Compare (Screen marker states) and the `differential_analysis` tool, equal to diffcyt 1.32 and limma 3.68 in R (validation `differential`) |

## Specialized analyses

| # | Requirement | Status |
| --- | --- | --- |
| A1 | Cell cycle: Dean–Jett–Fox and Watson | done |
| A2 | Proliferation: generation fitting and Roederer's indices | done |
| A3 | Index sorting: well-to-event links | done: a plate view (96- and 384-well and others) from BD's INDEX SORTING LOCATIONS or well parameters, colored by population or channel, wells marked on the plots, CSV export |
| A4 | Kinetics and ratiometric (calcium) analysis | planned (wave 7) |
| A5 | Plates: wells as samples, layouts, heat maps of any statistic | planned (wave 7) |
| A6 | Dose-response (EC50/IC50) and Z′; bead-based immunoassay standard curves | planned (wave 7) |

## Comparison and statistics

| # | Requirement | Status |
| --- | --- | --- |
| T1 | Group comparisons with tests chosen from the design, nonparametric counterparts, effect sizes and confidence intervals | done |
| T2 | Screens of every population or cluster with multiple-testing correction | done |
| T3 | Numbers agree with R | done (validation `reference`) |
| T4 | Robustness of a comparison to preprocessing choices (counterfactual preprocessing, specification curve) | done: gate boundaries, adapted or shared per-sample gates, QC (removed, re-run), compensation and test, alone and combined; verdict, the choices it depends on, a methods sentence; agent tool `check_robustness`; validation `multiverse` (known artifacts) and `multiverse-ics` (real study) |

## Output, provenance and reporting

| # | Requirement | Status |
| --- | --- | --- |
| R1 | Undo and redo of every edit; a change log | done |
| R2 | Checkpoints with a semantic diff and the effect on frequencies | done |
| R3 | Methods paragraph with references, from what the workspace did; MIFlowCyt checklist | done |
| R4 | Publication figures (SVG, PNG, PDF) that stay live until export | done |
| R5 | Figures with embedded provenance (gates, scales, matrices, file checksums) | done: SVG, PNG and PDF exports carry the record; opening one reports what changed since and rebuilds it from the same files (validation `figures`) |
| R6 | Audit trail and electronic signatures (21 CFR Part 11 style) | planned |
| R7 | Batch reports (PDF, PowerPoint) and spreadsheet export (Excel, Prism) | done: a figure repeated by sample or by an annotation as PDF or PowerPoint with every number traced to its source; Excel workbooks with provenance sheets and Prism projects; read back by openpyxl, python-pptx, pypdf and R pzfx (validation `reports`) |
| R8 | Reproducibility certificate that re-runs and confirms every reported number | planned (wave 8) |

## Interchange

| # | Requirement | Status |
| --- | --- | --- |
| I1 | FlowJo 10 workspaces imported with a per-population fidelity report and count comparison | done (on real workspaces, FlowJo's saved counts reproduced at least as often as FlowKit does; FlowJo's display-resolution gating moves 0.1–0.3% of large populations) |
| I2 | Gating-ML 2.0 import and export, including spectrum (unmixing) matrices, ratio dimensions and per-dimension compensation | done |
| I3 | CLR export; ACS containers | done |
| I4 | FlowJo workspace export | done: per-sample trees with overrides and scopes, compensation, scales, groups and counts, with a fidelity report; every validation case imports back with its counts unchanged, and FlowKit reads every export and counts what CytoWeave counts. Compatibility tested with FlowJo 11.2.0 (build 11.2.0.210156, 2026-10-03): three exports within 0.6 percentage points, most within 0.1; CytoML 2.24 reads every export. Logicle and arcsinh scales are written as FlowJo biex for FlowJo 11. FlowJo 10 not tried |
| I5 | Analysis templates applied by marker, with a match report; OMIP gating strategies; populations mapped to Cell Ontology IDs, carried into exports and methods | done: templates matched by marker with a preview and report; OMIP-101 and OMIP-090 placed on the data; Cell Ontology suggestions confirmed by the user, written to FlowJo and Gating-ML exports, tables and methods (not CLR, which has no field for them) |
| I6 | CSV event import; AnnData export (`.h5ad`); concatenated and downsampled FCS export | done: CSV events checked and imported with kinds and scales guessed; concatenated, per-sample and seeded downsampled FCS files; AnnData through our own HDF5 writer, read exactly by anndata 0.10 and 0.13, h5py and pyfive (validation `events`) |
| I7 | Acquisition-software experiments (FACSDiva, FACSChorus, SpectroFlo) and FlowJo 11 `.flowjo` workspaces | planned (wave 7) |

## Automation

| # | Requirement | Status |
| --- | --- | --- |
| M1 | MCP server for AI agents, acting in the visible window, every change undoable | done |
| M2 | Remote control for local scripts | done |
| M3 | Agent changes arrive as proposals to accept or reject | done: new gates as marked proposals, edits, deletions and compensation matrices held; accepted or rejected as a group; the change log records who proposed and who decided |
| M4 | Agent tools for every stage: QC, unmixing, clustering and maps, sample annotation, figures, exports and folder watching | done: 11 new tools (29 in all); results and figures proposed, annotations and root gates held; exports write only to the path given and never replace a file unless told to; validation `agent-session.mjs` (15 checks, in CI) |
| M5 | R and Python clients for remote control | done: `clients/r` and `clients/python`, functions generated from the tools, connection found through `remote.json`, tested in CI against a running CytoWeave (not published to CRAN or PyPI) |
| M6 | Optional on-device assistant, without network | planned (wave 8) |

## Quality

| # | Requirement | Status |
| --- | --- | --- |
| V1 | Unit tests of every analysis module against independently known values | done |
| V2 | End-to-end validation against simulated truth and published references in CI | done |
| V3 | Comparison with reference tools (FlowKit, flowCore, PeacoQC, FlowSOM, CytoNorm) on public data | done: ISAC's Gating-ML suite, FlowKit, FlowIO, FlowJo's saved counts, FACSDiva's spillover, and flowCore, PeacoQC, FlowSOM and CytoNorm in R |
| V4 | Accessible: keyboard operation, labeled controls, color maps safe for color-vision deficiency | done: color-vision-friendly colors (a setting); WCAG AA contrast in both themes; keyboard tree, list, dialogs and scroll regions; plots described in text; axe-core audit of every documentation scene (`capture.mjs --audit`) and validation `accessibility`. Not done: drawing gates without a pointer; testing by screen-reader users |
| V5 | Teaching mode on the examples | planned (wave 8) |
