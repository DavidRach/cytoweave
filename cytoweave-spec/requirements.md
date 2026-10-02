# CytoWeave requirements

What CytoWeave must do, and the status of each requirement in 0.1.0.
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
| P1 | One self-contained program for macOS, Linux and Windows (x64 and ARM64); a one-line install; no licence server, account, Python, R or plugins | done |
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
| D6 | Large data: 10 million events per sample at interactive speed | partial: samples of a few million events work; streaming from disk and bitset populations are planned for larger ones |
| D7 | FCS de-identification on export | planned |

## Gating and statistics

| # | Requirement | Status |
| --- | --- | --- |
| G1 | Rectangle, polygon, freehand, ellipse, quadrant, range, split, Boolean and category gates with Gating-ML semantics; imported gates of three or more dimensions; a gate dimension may keep its own compensation | done (all 190 gates of ISAC's Gating-ML compliance suite match on every event; Boolean gates come from imports; drawing them is planned) |
| G2 | Shared gates with per-sample overrides and group scopes | done |
| G3 | Plot types: pseudocolor, dot, density, contour, zebra, histogram, cumulative; backgating; overlays | done |
| G4 | Scales: linear, log, logicle (reference), arcsinh, FlowJo biexponential (exact), fasinh and hyperlog (import); Gating-ML bounds | done (FlowJo's counts follow the reference logicle, not BD's published logicle tables: `validation/README.md`) |
| G5 | Magic-wand gating: density basins and histogram valleys | done |
| G6 | Statistics of FlowJo's set plus confidence intervals for frequencies | done |
| G7 | Batch tables, CSV/TSV export, heat maps | done |
| G8 | Review a gate across samples; boundary robustness | done |
| G9 | Learned per-sample gate adjustment with abstention (uncertainty-aware autogating) | planned |

## Compensation and spectral

| # | Requirement | Status |
| --- | --- | --- |
| C1 | Spillover from single-stain controls (median difference, robust regression); manual editing with undo | done |
| C2 | Check a matrix against its controls and suggest corrections; recognize autofluorescent positives | done |
| C3 | Spillover spreading matrix; N×N pair plots | done |
| S1 | Reference spectra from controls with automatic gating; control quality metrics | done |
| S2 | Several autofluorescence signatures; per-event autofluorescence | done |
| S3 | OLS, WLS (fixed and per-event weights) and NNLS unmixing; residual channel | done |
| S4 | Complexity index, similarity and spreading matrices | done |
| S5 | Comparison of unmixing models on the user's own sample | done |
| S6 | Predicted spread for panel design from the user's own references | planned |
| S7 | Spectral reference library across experiments | planned |

## Quality control and normalization

| # | Requirement | Status |
| --- | --- | --- |
| Q1 | PeacoQC (classic and refined), flow rate, margins, drift; a reversible "QC pass" channel | done |
| Q2 | Cohort QC overview with scores | done |
| Q3 | CytoNorm with a confounding check; bead normalization; debarcoding | done |
| Q4 | QC of files as they are acquired (folder watching) | planned |
| Q5 | Instrument characterization (Q and B, Levey–Jennings) | planned |

## High-dimensional analysis

| # | Requirement | Status |
| --- | --- | --- |
| H1 | FlowSOM and Leiden clustering; UMAP, t-SNE and PCA across samples with equal sampling | done (k-means and Louvain exist in the library but are not offered in the view) |
| H2 | Cluster naming from marker enrichment; clusters as populations | done |
| H3 | Embedding faithfulness: trustworthiness, continuity, kNN preservation, mixing, seed stability, unreliable regions | done |
| H4 | Differential abundance of clusters across groups | done (quasi-binomial, diffcyt-like) |
| H5 | Placing new samples on an existing map | partial: in the library (UMAP transform), not in the view |

## Specialized analyses

| # | Requirement | Status |
| --- | --- | --- |
| A1 | Cell cycle: Dean–Jett–Fox and Watson | done |
| A2 | Proliferation: generation fitting and Roederer's indices | done |
| A3 | Index sorting: well-to-event links | partial: the parameters are read and plotted; a plate view is planned |
| A4 | Kinetics and ratiometric (calcium) analysis | planned |

## Comparison and statistics

| # | Requirement | Status |
| --- | --- | --- |
| T1 | Group comparisons with tests chosen from the design, nonparametric counterparts, effect sizes and confidence intervals | done |
| T2 | Screens of every population or cluster with multiple-testing correction | done |
| T3 | Numbers agree with R | done (validation `reference`) |

## Output, provenance and reporting

| # | Requirement | Status |
| --- | --- | --- |
| R1 | Undo and redo of every edit; a change log | done |
| R2 | Checkpoints with a semantic diff and the effect on frequencies | done |
| R3 | Methods paragraph with references, from what the workspace did; MIFlowCyt checklist | done |
| R4 | Publication figures (SVG, PNG, PDF) that stay live until export | done |
| R5 | Figures with embedded provenance (gates, scales, matrices, file checksums) | planned |
| R6 | Audit trail and electronic signatures (21 CFR Part 11 style) | planned |

## Interchange

| # | Requirement | Status |
| --- | --- | --- |
| I1 | FlowJo 10 workspaces imported with a per-population fidelity report and count comparison | done (on real workspaces, FlowJo's saved counts reproduced at least as often as FlowKit does; FlowJo's display-resolution gating moves 0.1–0.3% of large populations) |
| I2 | Gating-ML 2.0 import and export, including spectrum (unmixing) matrices, ratio dimensions and per-dimension compensation | done |
| I3 | CLR export; ACS containers | done |
| I4 | FlowJo workspace export | planned |

## Automation

| # | Requirement | Status |
| --- | --- | --- |
| M1 | MCP server for AI agents, acting in the visible window, every change undoable | done |
| M2 | Remote control for local scripts | done |
| M3 | Agent changes arrive as proposals to accept or reject | partial: they are marked and undoable; a review queue is planned |

## Quality

| # | Requirement | Status |
| --- | --- | --- |
| V1 | Unit tests of every analysis module against independently known values | done |
| V2 | End-to-end validation against simulated truth and published references in CI | done |
| V3 | Comparison with reference tools (FlowKit, flowCore, PeacoQC, FlowSOM, CytoNorm) on public data | done: ISAC's Gating-ML suite, FlowKit, FlowIO, FlowJo's saved counts, FACSDiva's spillover, and flowCore, PeacoQC, FlowSOM and CytoNorm in R |
| V4 | Accessible: keyboard operation, labelled controls, colour maps safe for colour-vision deficiency | partial |
