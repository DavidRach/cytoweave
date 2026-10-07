# Using CytoWeave with AI agents (MCP)

`cytoweave mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. An AI
agent such as Claude Code can use it to open FCS files and example experiments, inspect the
gating tree, annotate samples, add gates (drawn from coordinates or proposed from the data's
density), run acquisition QC, unmix spectral files, cluster and map cells, compute statistics
across samples, render plots as images, review a gate across a cohort, compare groups of samples,
build figures, write a methods paragraph, watch an instrument's export folder, and export FlowJo
workspaces, de-identified FCS files, figures and tables to files.

The agent works in the CytoWeave window you see. Its changes are proposals that you accept or
reject (see [Proposals](#proposals)), and you can undo anything.

- [Requirements](#requirements)
- [Proposals](#proposals)
- [Claude Code](#claude-code)
- [Claude Desktop and other clients](#claude-desktop-and-other-clients)
- [Tools](#tools)
- [Coordinates](#coordinates)
- [Scripts without an agent](#scripts-without-an-agent)
- [Privacy and security](#privacy-and-security)
- [How it works](#how-it-works)

## Proposals

An agent's changes wait for your review:
- **New gates** appear at once, marked *proposed*: dotted on the plots and in italics in the
  population tree. Their counts are real, so you can judge them, and the agent can gate on them.
- **Computed results** (acquisition QC, unmixed channels, clusters and maps) and **figures** also
  appear at once, marked proposed, so their channels can be gated and plotted. Results for samples
  you have already checked or unmixed are left to you; QC of other samples joins your QC result
  when you accept.
- **Renaming or deleting** gates you have accepted, **compensation matrices**
  (`propose_compensation`), **sample annotations** (`annotate_samples`) and a **gate at the top
  of the tree** (`run_qc` with `addGate`) are held. The tree shows a held rename next to the name
  (→ new name) and strikes through a population the agent proposes to delete.

A strip above the population tree says who proposes how many changes. Click **Review** for the
list with each new population's frequency, then **Accept all** or **Reject all**. Rejecting
removes the proposed gates, results and figures, together with anything drawn under or on them
since; CytoWeave asks first in that case.

The change log records each decision: what was proposed, by which agent (the name its MCP
client gives, such as Claude Code), and that you accepted or rejected it. Accepted gates keep
this, and the inspector and the methods paragraph show it. The agent can ask for the outcome
with `proposals`.

## Requirements

- CytoWeave 0.1.0 or later (`cytoweave --version`); proposals and the `propose_compensation` and `proposals` tools need 0.2.0, `adapt_gate` 0.3.0, `check_robustness` 0.4.0, and `annotate_samples`, `run_qc`, `unmix`, `explore`, `build_figure`, `watch_folder`, the export tools, the template tools, `suggest_cell_types` and `titration` 0.5.0, and `compare_distributions`, `rare_events`, `add_formula_channel`, `calibrate_beads`, `export_report`, `export_events` and `differential_analysis` 0.6.0 (as do Excel and Prism files from `export_table` and CSV files of events in `open_files`), and `diagnose_unmixing`, `kinetics`, `plate`, `plate_layout`, `dose_response`, `bead_assay` and `export_workspace` 0.7.0, and `export_certificate`, `verify_certificate` and `export_review_report` 0.8.0.
- Chrome, Edge, Brave or Chromium for the window (any modern browser works if you open the
  printed address yourself).
- The full path to the program. Agents often start programs without your shell's `PATH`; the
  installers put CytoWeave in `~/.local/bin/cytoweave` (macOS and Linux) or
  `%LOCALAPPDATA%\Programs\CytoWeave\cytoweave.exe` (Windows).

## Claude Code

```bash
claude mcp add cytoweave -- ~/.local/bin/cytoweave mcp
```

Then ask, for example:

> Open the PBMC example, gate cells, singlets and live cells, then CD3+ T cells and their CD4
> and CD8 subsets, and tell me how the CD4:CD8 ratio differs between stimulated and
> unstimulated samples.

## Claude Desktop and other clients

Add the server to the client's configuration (for Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cytoweave": {
      "command": "/Users/you/.local/bin/cytoweave",
      "args": ["mcp"]
    }
  }
}
```

Options go after `mcp`: `--port` (default 8770, the next free one is used), `--data-dir` (the
workspace library), `--window app|browser|none` (how the window opens when a tool needs it).

## Tools

| Tool | What it does |
| --- | --- |
| `workspace_summary` | Samples (events, role, metadata, channels and markers), groups, the gating tree of the current sample with counts, compensation, derived results, and what the window shows. |
| `open_files` | Opens FCS files, folders (each becomes a group), CytoWeave workspaces, FlowJo workspaces, Gating-ML, or CSV files of events (each a sample; the columns' kinds, scales and checks reported), by absolute path. |
| `open_example` | Generates and opens a simulated example experiment. |
| `select` | Shows a sample, population and/or view in the window. |
| `list_populations` | Every population's path, gate, count, % of parent and % of total for a sample. |
| `population_statistics` | Count, frequencies and per-channel statistics (median, mean, geometric mean, SD, robust SD, CV, robust CV, percentiles) of a population. |
| `statistics_table` | A statistic of populations across samples (or a group). |
| `render_plot` | A PNG of a plot (pseudocolor, dot, density, contour, zebra or histogram) with its gates. |
| `create_gate` | Proposes a rectangle, polygon, ellipse, range, quadrant or split gate from data coordinates. |
| `auto_gate` | Proposes a gate found from the data: the density basin around a point ("magic wand"), singlets on area versus height, or the valley between two modes. |
| `edit_gate` | Renames, recolors or deletes a population (held for review unless the agent proposed it). |
| `propose_compensation` | Computes a spillover matrix from the workspace's single-stain controls and proposes it for the samples. |
| `proposals` | The agent's open proposal and your recent decisions. |
| `review_gate` | A gate's frequency on every sample with a robust z-score and its boundary robustness, outliers first. |
| `adapt_gate` | Adapts a gate to every sample (density landmark registration) with a confidence for each: confident adjustments are proposed, uncertain samples listed for you to check. `groupBy` keeps one gate per donor or subject. |
| `compare` | Tests a statistic between groups of samples defined by metadata, optionally paired. |
| `differential_analysis` | Tests every cluster (or chosen populations) between groups of samples: differential state, each marker's median by diffcyt-DS-limma, or differential abundance, each cluster's share of the parent; with pairing and covariates in the model. |
| `check_robustness` | Repeats a two-group comparison under other reasonable analysis choices (gate boundaries, adapted gates, QC, compensation, test) and reports whether the conclusion holds, mostly holds or is fragile, and which choices change it. |
| `annotate_samples` | Sets samples' metadata fields, roles and stained channels (held for review). |
| `run_qc` | Acquisition QC (refined or classic PeacoQC, flow rate, margins, drift): each sample's score, events removed and findings; the "QC pass" channel is proposed, and with `addGate` a "QC pass" gate at the top of the tree. |
| `unmix` | Spectral unmixing with reference spectra from the single-stain controls and autofluorescence from the unstained control (a reference library is computed and proposed when there is none); the unmixed channels are proposed. |
| `explore` | Clustering (FlowSOM, Leiden, Louvain, k-means) and a map (UMAP, t-SNE, PCA) of a population across samples, with cluster names, abundances and the map's faithfulness; `populations` proposes the clusters as populations. |
| `build_figure` | Proposes a figure: the gating strategy of a population, or the same plots across samples. |
| `watch_folder` | Watches an instrument's export folder: each finished FCS file is added and checked (QC, or Q and B for beads); `status` lists the results. |
| `save_template` | Saves the analysis (or a population and those under it) as a template in the library: gates, scales, plots, tables, figures and which compensation the samples used. |
| `list_templates` | The templates in the library, and the published gating strategies (OMIP-101 major leukocyte populations, OMIP-090 regulatory T cells) with their citations and where they depart from the articles. |
| `apply_template` | Applies a template (from the library, or a template file's contents as `templateJSON`) or a strategy (`omip-101`) to the open samples: channels matched by marker (scatter and time by name), with how each matched and what could not be applied. A strategy's gates are placed on one sample's events (`sample`), each from its parent population, with suggested Cell Ontology terms. The gates and figures are proposed. |
| `suggest_cell_types` | A Cell Ontology term for each population from its marker phenotype and scatter, never its name, with a confidence and the markers it rests on; `propose` proposes the top terms for you to confirm. |
| `titration` | Analyzes an antibody titration (amounts from the file names or an "amount" annotation) or a detector voltage walk (voltages from `$PnV`) on one channel within a population: each step's stain and separation index, and the recommended amount (twice the amount giving 90% of saturation) or voltage range (the negative cells' rSD at 2.5 × the electronic noise; the positive cells within the linear range). `save` proposes the result for the workspace. |
| `diagnose_unmixing` | Names the likely causes of a poor spectral unmixing of a sample, most likely first, each with its evidence and a fix tried on the sample's events: a dye without a reference, a reference that does not match the dye (a wrong control, a bead control for a stain on cells), a degraded tandem, a cell control carrying autofluorescence, or autofluorescence the unstained control lacks. |
| `kinetics` | A population's signal or the ratio of two channels (Indo-1 violet/blue) against acquisition time, as in a calcium flux: baseline, peak, time to peak, half-max time, area and the share of responding events, the stimulus found where acquisition paused. One row per sample. |
| `plate` | The plates (wells from keywords, names or a "well" annotation) with their layout fields; with a statistic, its value in every well as a grid and Z′ from the control wells. |
| `plate_layout` | Annotates a plate's wells from CSV text (a "well" column and one per field, or plate maps as R's plater writes them), held for review. |
| `dose_response` | Four- or five-parameter log-logistic curves per compound (drc's parameterization) of a statistic against dose: EC50 or IC50 with its 95% CI, Hill slope, bottom, top, R² and flags (no dose-response, EC50 beyond the doses or not determined); raw, % of controls or % inhibition; with the plate's Z′. |
| `bead_assay` | A bead immunoassay (LEGENDplex, CBA): each bead group's analytes by their classification level, a standard curve per analyte from the standard wells, and each sample's concentrations with the quantifiable range (FDA 2018 recovery and CV limits), the limit of detection and flags. |
| `add_formula_channel` | Proposes a channel computed from others for every event (compensated values): channels in brackets by marker or detector, + - * / ^, log, ln, exp, sqrt, abs, asinh, min, max; for example a ratio `[CD4] / [CD8]`. Usable at once in gates, plots and statistics. |
| `calibrate_beads` | Fits a standard curve from a multi-level bead sample, as FlowCal does (levels found, medians matched to the datasheet's MEF values, levels near the ends of the range left out), and with `applyTo` proposes "<channel> <unit>" channels (FITC-A MEFL) for the samples acquired with the beads' settings. |
| `compare_distributions` | Compares a population's distribution on a channel in each sample with a control sample's (an FMO, an unstimulated sample): % positive by SED (Bagwell's enhanced normalized subtraction) and Overton's cumulative subtraction, probability binning's T(χ) (above 4 for p < 0.01) with Baggerly's statistic and the excess %, and the Kolmogorov–Smirnov D and p; with several channels, multivariate probability binning. |
| `rare_events` | A rare population's count with an exact Poisson 95% interval, its % of parent with an exact binomial one, the counting CV and the parent events for a target CV; given blank (and low-level) samples, the limits of blank, detection and quantification (CLSI EP17) and each sample's status. |
| `export_workspace` | Writes the workspace as a CytoWeave workspace file (.cwz), which opens again beside the FCS files. |
| `export_review_report` | Writes a review report (.html): the analysis as one self-contained HTML file (samples with checksums, gating, every sample's gates drawn unless `plots: "none"`, figures, tables, saved comparisons, methods, MIFlowCyt, change log), every number traced to its source. |
| `export_certificate` | Writes a reproducibility certificate (.acs): the workspace, the FCS files (or with `includeData: false` only their checksums), stored channels, Gating-ML, methods and certificate.json with every count, table cell and saved comparison. Returns the fingerprint to quote. |
| `verify_certificate` | Verifies a certificate: checksums, the workspace, the change log and the fingerprint checked, every number computed again from the files and compared. `data` supplies the FCS files of a certificate made without them (a folder or paths). Returns the verdict (confirmed, incomplete, differs) and what differs. |
| `export_flowjo` | Writes a FlowJo workspace (.wsp, or .zip with the FCS files), optionally de-identified, with the populations not written exactly. |
| `export_fcs` | Writes de-identified FCS files (.zip) or the workspace with them (.acs). |
| `export_figure` | Writes a figure as SVG, PNG or PDF, carrying the analysis behind it. |
| `export_events` | Writes a population's events in several samples, optionally downsampled with a seed: one concatenated FCS file (`SampleID` and `SourceEvent` channels; raw values with the shared spillover, or compensated), a ZIP of FCS files, or AnnData (`.h5ad`: X arcsinh or compensated values of the chosen channels; obs with sample, annotations, populations, clusters, scatter; obsm maps). |
| `export_report` | Writes a figure repeated page after page as a PDF or a PowerPoint deck: `by` sample (the plots of the figure's main sample redrawn on each; a control's plots on every page) or by an annotation such as `subject` (each plot on that subject's matching sample). Placeholders such as `{subject}` are filled, `table` lists a Tables table's columns for each page's samples, and every number printed is recorded with its source in the file. Returns the pages and notes (a missing tube, replicates). |
| `export_table` | Writes statistics: a statistic of populations across samples as CSV or TSV; an Excel workbook (a Tables table by `table`, a statistic, or every table) with sheets describing the columns, the samples and their checksums, the gating and the methods; or a Prism project (`.pzfx`), grouped into column tables by an annotation with `groupBy`. |
| `methods` | A methods paragraph with numbered references. |
| `export_gating_ml` | The gating strategy as Gating-ML 2.0. |

The export tools write to the absolute path the agent gives, in an existing folder, and never
replace a file unless the call passes `overwrite: true`.

Populations are named by name (when unique), by path (`Cells/Single cells/CD3+`) or by id.
Channels are named by detector (`FITC-A`) or marker (`CD3`).

## Coordinates

Gate coordinates are data values, as on the plot axes: the scale (linear, logicle, arcsinh) is
the workspace's scale for each channel, and CytoWeave converts the coordinates into it. A
rectangle on FSC-A and SSC-A from 40,000 to 120,000 is
`{"xMin": 40000, "xMax": 120000, "yMin": 10000, "yMax": 80000}`; a range gate on CD3 above 1,000
is `{"min": 1000}`. Ellipse semi-axes are fractions of the axes (0.1 is a tenth of the axis).

## Scripts without an agent

`cytoweave --remote-control` accepts the same actions from programs on this computer. The R and
Python clients in [`clients/`](../clients/) make each action a function, found with no setup:

```python
import cytoweave
cw = cytoweave.connect()
cw.statistics_table(statistic="freqParent").frame()
```

```r
library(cytoweave)
cw_connect()
as.data.frame(cw_statistics_table(statistic = "freqParent"))
```

From any other language, post JSON to `/api/remote/action`:

```python
import requests
url = "http://127.0.0.1:8770/api/remote/action"
print(requests.post(url, json={"action": "list_populations"}).json())
print(requests.post(url, json={"action": "statistics_table", "args": {"statistic": "freqParent"}}).json())
```

A script's changes are proposals too, shown under the name it gives in `"client"` (for
example `{"action": "create_gate", "client": "Plate pipeline", "args": {…}}`).

`open_files` and the export tools also need the `X-CytoWeave-Token` header with the token
CytoWeave prints when it starts, because they make the program read or write files. CytoWeave
also writes the address and token to `remote.json` in its data folder (readable by you only, and
removed when it stops), where the clients find them; `GET /api/remote/tools` lists the actions with
their arguments.

## Privacy and security

- Everything runs on this computer: the server only accepts requests from this computer, and
  the data never leave it.
- Agents act through the same window you use; nothing happens out of sight. Their changes are
  proposals you accept or reject, and every change can be undone.
- Opening and writing files by path is limited to the agent connected over stdio (MCP) or to
  scripts that hold the token printed at startup (and written to `remote.json` in the data
  folder, readable by you only). Exports go only to the path given, in a folder
  that exists, through a temporary file renamed into place, and never replace a file unless asked.

## How it works

`cytoweave mcp` starts CytoWeave with remote control on and speaks JSON-RPC on stdin and stdout.
A tool call becomes an action that the server forwards to the open window over Server-Sent
Events; the window performs it with the same code as the user interface and posts the result
back. Actions reach the window one at a time.
