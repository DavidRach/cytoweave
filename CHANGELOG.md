# Changelog

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
