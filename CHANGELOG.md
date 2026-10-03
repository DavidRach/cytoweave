# Changelog

## Unreleased

### Added

- **FlowJo workspace export.** Workspace → Export → FlowJo workspace writes a FlowJo 10 workspace: one gating tree per sample, with its own adjustments and group scopes, its compensation, the scales, the sample groups and, optionally, CytoWeave's population counts and the FCS files in a ZIP. A report lists every population as exact, traced (a gate drawn on another scale than the one written, with enough vertices to follow its outline) or not exported (category gates, gates on channels CytoWeave computed, gates of three or more dimensions).
- **De-identified FCS files.** Workspace → Export → De-identified FCS files writes the files (a ZIP, or an ACS archive with the workspace) keeping only technical keywords: operator, specimen and patient fields, free-text comments, file names, dates (unless kept), serial numbers and vendor keywords are removed and listed. The events are copied byte for byte. Population exports and the FlowJo export can de-identify too.

- **Figures carry their analysis.** Exported figures and plots (SVG, PNG and PDF) embed the samples (with their files' SHA-256 checksums), the gates, scales and compensation behind every plot, and each plot's event count. Opening an exported figure in CytoWeave shows where it came from and, plot by plot, what has changed since; it can rebuild the figure in a new workspace from the same files (found in the library by checksum) or add it back to the open one. "Embed the analysis" in the Figures view turns it off.
- `cytoweave figure.svg` (or .png, .pdf) opens an exported figure from the command line.
- **Adapt a gate to each sample.** A gate's menu → Adapt to each sample… carries a shared gate from the samples it is known to be right on (where it was drawn, adjusted or confirmed) to every other sample, by registering the density landmarks of its parent population along its axes. Each sample gets a confidence and a status: the gate already fits, a confident adjustment (ticked, applied in one undoable step), or uncertain and listed first for review, with the reason. A gate is moved only where it cuts into a population and the adaptation finds sparser events, since populations also move for biological reasons. "Keep one gate per" a metadata field (a donor, a subject) adapts each group's samples together, as assays with stimulated and unstimulated wells need; a sample unlike the rest of its group goes to review. "Looks right" teaches CytoWeave a sample, and per-event membership probabilities export as CLR files. The methods paragraph describes the adaptation.
- Agents can adapt gates too (`adapt_gate`): confident adjustments wait in a proposal for the user, and uncertain samples are listed for the user to check.
- **Q, B and Levey–Jennings.** QC → Instrument measures every fluorescence detector's efficiency Q, optical background B and the beads' intrinsic CV from multi-level beads or an LED pulser series, with Parks et al.'s weighted quadratic fit as flowQB computes it, with standard errors and a plot of peak variance against mean. Runs are saved to the instrument's record in the library and followed across experiments on Levey–Jennings charts flagged by the Westgard rules. The methods paragraph describes them.
- **Spectral library.** The Spectral view's Library tab keeps reference spectra across experiments, per instrument, flags a control whose spectrum differs from the library's (a degraded tandem, a new lot), and adds a library spectrum for a fluorochrome without a control. The methods paragraph says which spectra came from the library.
- A new example, **Daily bead QC**: 30 runs of 8-peak beads with every detector's true Q and B, a PMT that ages, a flow cell that gets dirty and a laser that weakens.
- The library keeps records besides workspaces and files (`/api/library/records/{kind}/{id}`; in the browser, IndexedDB).

### Validation

- A 60-plot figure is read back intact from SVG, PNG and PDF, rebuilt with every plot drawn from the same events, and a moved gate flags exactly the plots it affects (new `figures` suite).
- Each FlowJo export is imported back with every count unchanged: the bundled example, ten FlowKit test workspaces and a workspace built in CytoWeave. FlowKit reads every export and counts what CytoWeave counts, and its counts on an export equal those on the original workspace or come closer to FlowJo's saved counts.
- De-identified copies of every example and corpus FCS file hold the same events, bit for bit.
- Autogating on a simulated cohort with instrument shifts (gains up to fivefold) raises every shifted gate's accuracy against the true cell types (T cells F1 0.954 → 0.994) without lowering any population's, sends the 4 least accurate of 66 gate-sample pairs to review, and sends nothing to review when nothing shifted (`autogating` suite).
- Q and B of 18 simulated detectors over 30 runs within 2% (Q) and 6% (B) of the truth; every planted instrument problem is flagged on the Levey–Jennings charts at once, and nothing in the baseline runs (new `instrument` suite).
- On flowQB's own LSR II data (an LED series, 8-peak and 6-peak beads), CytoWeave finds the same peaks and the same Q, B and standard errors as flowQB in all 36 detectors, within 6e-9 (new `flowqb` suite, external data `flowqbdata`).
- The spectral library flags a PE-Cy7 that lost 5% of its emission to PE and nothing else, matches a second experiment's independent controls, and a library spectrum unmixes as accurately as the dye's own control (`spectral` suite).
- Against an expert's own per-donor gates in four FlowJo workspaces of a real intracellular cytokine study (48 wells), adapting with one gate per donor leaves agreement with the expert unchanged (F1 0.9876 → 0.9877) with no adjustment lowering it, and sends wells the expert gated differently to review three times as often as the others (new `experts` suite, external data `als-ics`).

### Fixed

- **FlowJo import.** FlowJo writes some characters of parameter names as "_" ("LIVE/DEAD Aqua-A" becomes "LIVE_DEAD Aqua-A"); such channels were not found and every population gated on them was missing. They are now mapped back to the file's names.

## 0.2.0 (2026-10-02)

### Fixed

- **FlowJo import.** Comparing with the counts FlowJo saved in real workspaces found these, now fixed:
  - Time gates were read in the wrong units (FlowJo uses seconds) and could keep almost no events.
  - FlowJo's linear axis gains were ignored.
  - Ellipses were read in data units; FlowJo stores them in its display space.
  - Values beyond the ends of FlowJo's biexponential scale now sit on its edges, as in FlowJo, so saturated events fall inside gates drawn to the edge.
  - FCS files named on the command line are opened before a FlowJo workspace named with them, so its samples match.
- **Gating-ML import.** Running ISAC's compliance suite found these, now fixed:
  - Transformation bounds (`boundMin`, `boundMax`) were ignored.
  - Gates of three or more dimensions, and quadrant gates with three dividers, were skipped.
  - Ratio dimensions were imported but never computed.
  - A gate's dimensions now keep the compensation the file names for them, rather than the sample's.
  - Events on a polygon's edge are inside it.
- **Gate boundaries** are decided in double precision, so an event within rounding distance of a boundary falls on the same side as in reference tools.
- **FCS files:** Guava Muse log channels (log10 values stored as floating point) are read correctly, and a file cut off before its data now says so instead of failing.
- **Spillover from controls** leaves saturated events (at the top of a detector's range) out of the positives; their clipped values pulled spillover values down. A control with more than 1% of them gets a warning. On a real 15-colour panel the matrix is now within 0.015 of FACSDiva's. Each detector's own range ($PnR) decides what is saturated, rather than 262,144 for every instrument.
- **Logicle width estimates** take the 5th percentile of the negative values, as flowCore's `estimateLogicle` does, rather than of all values, and are no longer held at 0.25 or more when the data have negative values.
- **Workers on large samples.** Analyses in workers (QC, normalization, clustering) read the sample's events in shared memory instead of a copy. At ten million events the copy failed and the job waited forever; a job whose data cannot be handed over now fails with a message.
- **Methods.** A result with both a clustering and an embedding (for example FlowSOM and UMAP) now describes both; before, only the clustering was described.
- **Memory.** A sample larger than most of the memory budget (1.6 GB) could be dropped from memory as soon as it had loaded. The sample in use is now never dropped, and on machines with 8 GB or more the budget is 3 GB.
- **PeacoQC classic** is now an exact port of PeacoQC 1.22 (its density estimate, peak tracking, isolation tree and `smooth.spline` MAD test) and removes the same events as PeacoQC in R. The default refined mode is unchanged.

### Changed

- **Large samples.** Samples of ten million events open and respond quickly:
  - Files are read in parts, from a dropped file or from the program's library, without ever being held whole. The desktop program stores and hashes files itself.
  - Populations are kept as bitsets when large (20× less memory), and caches are limited by size.
  - Channels are compensated when first needed, so a large file shows its first plots sooner.
  - Statistics are exact selections rather than sorts, and the inspector fills its table a channel at a time, pausing while a gate is dragged.
  - Polygon gates are tested through a cell grid; at ten million events, moving the top gate re-evaluates everything in about 0.4 s instead of 1.6 s.
  - While a gate on a large population is dragged, its label is an estimate (≈ …%) from a sample of the events; dropping it gives the exact value.
- **CytoNorm** follows CytoNorm 2.x: 99 quantiles at 1/100 … 99/100 by default (was 101, including 0.001 and 0.999), and a batch with 50 or fewer cells in a cluster is left unchanged in that cluster and out of its goal, instead of being normalized from a handful of cells. Results of normalizations differ slightly from 0.1.

### Added

- **Proposals from AI agents.** An agent's gates arrive as proposals: shown at once, marked as proposed, with real counts. Its renames, deletions and compensation matrices wait for review. A strip above the population tree reviews each agent's proposal, to accept or reject as a group. The change log records which agent proposed what (its MCP client's name) and who decided; accepted gates keep it, and the methods paragraph reports it. New agent tools: `propose_compensation` (a matrix from the single-stain controls) and `proposals` (what is open, what was decided).
- **Boolean populations** from the population menu: all of, any of or none of chosen populations, with a live count, editable later.
- **Index-sort plate view.** An index-sorted sample shows its plate (96, 384 or other wells) below the plots. Wells come from BD's INDEX SORTING LOCATIONS or from well parameters, are colored by population or channel, and mark their cells on every plot. They export as CSV.
- **Explore** offers Louvain and k-means clustering, and places samples left out of a UMAP on the finished map.
- Gating-ML spectral unmixing matrices (more detectors than fluorochromes) import as unmixed channels.
- Gates of three or more dimensions are evaluated in all of them; the inspector shows their axes and any compensation a gate keeps.
- The migration report explains differences of a few events as boundary events.

### Documentation

- A website with a user guide, https://robert-mcdermott.github.io/cytoweave/: getting started, every view, the common tasks step by step, AI agents, scripting and troubleshooting. Its source is in `docs/site`.
- Screenshots in the light and dark themes. The README and the website show the one that matches the reader's theme. `docs/capture` captures them from the example experiments, so they can be redone for each release.

### Validation

- New suites against public data, which `node validation/fetch.mjs` downloads and checksums:
  - ISAC's Gating-ML 2.0 compliance suite: all 190 gates match on every event.
  - FlowKit 1.3.2 and FlowIO: FCS decoding, compensation, spectral unmixing and transforms agree; on FlowJo workspaces CytoWeave reproduces FlowJo's saved counts at least as often as FlowKit.
  - FCS files from several instruments and malformed files.
  - flowCore, PeacoQC, FlowSOM and CytoNorm, run in R on public data (results committed in `validation/reference/r.json`, so the checks need no R): reading, compensation and logicle agree to 1e-7; PeacoQC removes the same events; FlowSOM maps every event alike; CytoNorm agrees to 1e-5.
  - BD FACSDiva's spillover matrix, computed from 15 real single-stain controls of a public LSRFortessa panel.
- A check that the bundled FlowJo example reproduces all 56 of its counts.

## 0.1.0 (2026-10-02)

CytoWeave is a free, open-source (Apache 2.0) workbench for flow cytometry analysis: conventional, spectral and mass cytometry. It runs on your own computer as one self-contained program, with no licence server, account, Python or R. Files are analyzed in the browser and never leave your machine.

This is the first release.

### Install

**macOS and Linux**

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.ps1 | iex
```

The installers check the download against `SHA256SUMS` and verify its version before installing. They need no administrator rights. Then run `cytoweave`: it opens in its own window.

To download a file by hand instead:

| Computer | File |
| --- | --- |
| Mac with Apple silicon (M1 or later) | `cytoweave-darwin-arm64` |
| Mac with Intel | `cytoweave-darwin-amd64` |
| Linux, x64 / ARM64 | `cytoweave-linux-amd64` / `cytoweave-linux-arm64` |
| Windows, x64 / ARM64 | `cytoweave-windows-amd64.exe` / `cytoweave-windows-arm64.exe` |

The binaries are not code-signed, so a file downloaded with a browser triggers a macOS Gatekeeper or Windows SmartScreen warning; the installers avoid this. See [Installing CytoWeave](https://github.com/robert-mcdermott/cytoweave/blob/v0.1.0/docs/INSTALLING.md) for manual installation, checksums, upgrading and uninstalling.

### Try it

Open **Workspace → Example experiments** and pick one of nine simulated experiments. Each is generated in the app with the true identity of every event, so you can check your results against the truth:
- PBMC immunophenotyping with a deliberate compensation error to find;
- a FlowJo workspace to migrate;
- a 25-colour spectral panel;
- cell cycle and proliferation;
- a two-batch mass cytometry cohort and a barcoded plate;
- an index sort and a QC plate.

### Highlights

- **Gating** with shared gates and per-sample adjustments, a magic wand, backgating, and review of any gate across all samples, with how sensitive each result is to where the gate was drawn.
- **Compensation** computed from single-stain controls, and a check of any matrix against its controls that finds a wrong value and suggests the correction.
- **Spectral unmixing** with several autofluorescence signatures or per-event autofluorescence, panel quality metrics, and a side-by-side comparison of unmixing models on your own sample.
- **Acquisition QC** (PeacoQC with refinements that leave clean files alone, flow rate, margins, drift), CytoNorm batch normalization, bead normalization, and debarcoding with a split into one sample per barcode.
- **Clustering and maps** (FlowSOM, Leiden, UMAP, t-SNE, PCA) that report how faithful each map is.
- **Statistics:** batch tables, and group comparisons that choose the test from the design, with effect sizes, confidence intervals and multiple-testing correction.
- **Cell cycle** and **proliferation** models.
- **Figures** as SVG, PNG and PDF; a **methods paragraph** with references written from your analysis; a MIFlowCyt checklist; and checkpoints that show what changed between two versions of an analysis.
- **Moving from FlowJo:** imports FlowJo 10 workspaces, reports how faithfully each population converts, and compares every population count with FlowJo's. FlowJo's biexponential scale is reproduced exactly.
- **Standards:** FCS 2.0–3.2, Gating-ML 2.0 in and out, CLR and ACS.
- **AI agents:** `cytoweave mcp` lets agents such as Claude Code work in the window you are watching; every change can be undone. See [Using CytoWeave with AI agents](https://github.com/robert-mcdermott/cytoweave/blob/v0.1.0/docs/MCP.md).
- **Validated:** the analyses are checked against known answers and against R on every change ([validation](https://github.com/robert-mcdermott/cytoweave/blob/v0.1.0/validation/README.md)).

### Known limitations

- Validation so far uses simulated data with known answers and published reference values. Comparisons with reference tools on public datasets are planned.
- Developed and tested on macOS in Chrome, Edge and Brave. Linux and Windows builds are provided but have had less testing.
- FlowJo 9 workspaces and FlowJo 11's `.flowjo` format are not read; export a `.wsp` file from FlowJo 10 or 11.
- Spectral unmixing needs the raw detector channels.
- Imaging flow cytometry is not supported.

More detail is in the [README](https://github.com/robert-mcdermott/cytoweave/blob/v0.1.0/README.md#limitations).

CytoWeave is research software. It is not a medical device and must not be used for diagnosis.

### Feedback

Please report problems and ideas in [Issues](https://github.com/robert-mcdermott/cytoweave/issues). Problems reading an FCS file are especially useful, along with the instrument and software that wrote it.
