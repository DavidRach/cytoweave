# Changelog

## Unreleased

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
- **Spillover from controls** leaves saturated events (at the top of a detector's range) out of the positives; their clipped values pulled spillover values down. A control with more than 1% of them gets a warning. On a real 15-colour panel the matrix is now within 0.015 of FACSDiva's.
- **Logicle width estimates** take the 5th percentile of the negative values, as flowCore's `estimateLogicle` does, rather than of all values, and are no longer held at 0.25 or more when the data have negative values.
- **PeacoQC classic** is now an exact port of PeacoQC 1.22 (its density estimate, peak tracking, isolation tree and `smooth.spline` MAD test) and removes the same events as PeacoQC in R. The default refined mode is unchanged.

### Changed

- **CytoNorm** follows CytoNorm 2.x: 99 quantiles at 1/100 … 99/100 by default (was 101, including 0.001 and 0.999), and a batch with 50 or fewer cells in a cluster is left unchanged in that cluster and out of its goal, instead of being normalized from a handful of cells. Results of normalizations differ slightly from 0.1.

### Added

- Gating-ML spectral unmixing matrices (more detectors than fluorochromes) import as unmixed channels.
- Gates of three or more dimensions are evaluated in all of them; the inspector shows their axes and any compensation a gate keeps.
- The migration report explains differences of a few events as boundary events.

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
