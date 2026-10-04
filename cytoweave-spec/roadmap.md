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

## 0.2.0: trust and scale (released 2026-10-02)

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

## 0.3.0: beyond a single tool (released 2026-10-03)

Wave 3 builds what no single tool combines, each part checked against a reference. It was
released as 0.3.0; wave 4 follows in 0.4.

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
   - Compatibility tested with FlowJo 11.2.0 (build 11.2.0.210156) during a trial (2026-10-03).
     The exports first crashed it; fixed in 0.4 (full Graph elements, every rectangle bound
     written, one-dimensional gates written as rectangles, logicle and arcsinh scales written as
     FlowJo biex, which FlowJo 11 alone reads correctly). Three exports then open with every
     population within 0.6 percentage points, most within 0.1 (`reference/flowjo11.json`).
     CytoML 2.24 reads every export (`reference/cytoml.json`). FlowJo 11 needs the files
     reconnected once and drops Boolean populations, on FlowJo 10's own workspaces too.
     **To do:** FlowJo 10 has not been tried.
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
     a new example has 30 daily bead runs with a PMT aging, a dirty flow cell and a weaker laser:
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

## 0.4.0: before, during and after acquisition (released 2026-10-03)

Wave 4 follows an experiment from panel design through acquisition to the robustness of its
conclusions, and makes the workbench accessible. It also fixed the FlowJo export for FlowJo 11,
after compatibility testing with FlowJo 11.2.0 (build 11.2.0.210156), and gave CytoWeave a new
logo.

### Wave 4

1. **Predicted spread for panel design (S6): done.** A dye at brightness ΔF reaching detector d
   adds photon noise c1_d·ΔF·s_id (c1 = 1/Q); unmixing or compensation (U) carries it into channel
   j. Real controls showed a second source the plan left out: each laser's intensity fluctuates
   independently of the others, so a dye excited by two lasers spreads by ΔF²·Σ_L cv_L²(Σ_{d∈L}
   U_dj s_id)², in proportion to its brightness (only the sum of the two lasers' variances is
   identifiable from such a dye, which is all a prediction needs). Both are fitted to the
   controls' variance differences (weighted by their standard errors, shrunk toward a common
   c1 where a detector gets too little light), kept per instrument in the library, or c1 comes
   from bead runs (Q5). Spectral → Panel design predicts the matrix, complexity and the spread
   each channel receives for an edited panel, or for one built from the library with no files.
   - Validation: on simulated controls the photon noise is recovered within 1%, each control is
     predicted from the other 24 within 2× for 98% of well-measured pairs, and a 15-dye panel is
     predicted from the 25-dye fit within 2× for all pairs. On a BD LSRFortessa's 15 bead
     controls (leave one out) 79% are within 2× (67% with photon noise alone).
   - No public spectral data set with single-stain controls was found: the BD FACSDiscover
     cell-line data on Zenodo (19221995) stain every tube with calcein and DRAQ5, have no
     unstained control, and BD's unmixing in them is not linear, so they could not separate
     noise from spectral error.
   - Found on the way: the compensation spreading matrix counted off-scale events (an entry of
     53 instead of 4 on a real control), and BD FACSDiscover detector names (`UV1 (375)-A`)
     were not recognized as spectral (both fixed).
2. **Acquisition-time QC (Q4): done.** The program polls a folder (`--watch`, or QC → Live) and
   hands over each FCS file once complete: size and modification time steady between two checks
   and the header's data end (or `$ENDDATA`) within the file. It never writes there; files already
   present wait to be asked for. The page adds each file (in a group named after the folder) and
   checks it at once, in any view: acquisition QC for samples and controls, Q and B for bead files,
   added to the instrument's record and checked against the Levey–Jennings rules. PeacoQC's
   per-channel work (88–100% of its time) runs on up to four workers on shared columns, identical
   to the serial run (×3.1 at 2 M events, 20 channels).
   - Validation: Go tests of slow and paused writers, coarse modification times, temporary names,
     renames, nested folders, large-file offsets and the API; parallel PeacoQC identical to serial
     on the simulated QC files and PeacoQC's own 7 files; the benchmark times both.
   - Found on the way: names with underscores ("Beads_…", "Comp_FITC") were not given their
     roles, so a watched bead file would have been QC'd as a sample (fixed).
   - Not done: an agent tool to start a watch, and system notifications outside the window.
3. **Counterfactual preprocessing: done.** Compare → Robustness to analysis choices repeats a
   two-group comparison with each gate on the path moved 1% and 2% of the axis, the gates adapted
   to each sample (as autogating would put them, confident or not; one gate per subject when
   paired) or without per-sample adjustments, without the QC gate or with QC re-run (MAD 4 and
   8), with other compensation matrices, and with the rank test when it can reach significance
   (with 3 + 3 samples or 4 pairs it cannot, and is left out). Each alternative is tried alone,
   then in seeded random combinations (64 analyses). The verdict comes from the conclusion
   (holds ≥ 90%, mostly ≥ 70%, fragile); single changes that alter it are named, and so are those
   that keep a significant difference but move it outside its confidence interval. Scales are not
   varied (a hand-drawn gate follows its population on any scale). The agent tool
   `check_robustness` runs the same check.
   - What the validation changed: boundary moves alone cannot reveal a detector gain that differs
     between groups (a shared gate moves equally in both), so adapted gates had to be a choice;
     a stale matrix's effect showed that agreement on the conclusion can hide a 75-fold change
     in the difference, hence the effect-size check; and an outward monocyte gate in stimulated
     samples takes in activated T-cell blasts, a real fragility the check reports.
   - Validation: real effect holds 64/64; gain, clog and compensation artifacts each named; under
     the null 6% significant by chance, half of them robust; on the cytokine study every PMA
     comparison holds and one IL-4 peptide response is fragile.
   - Not done: designs of more than two groups, and cluster abundances (re-clustering each
     variant).
4. **Accessibility (V4): done.** Color-vision-friendly colors are a setting (Appearance menu),
   not a change to the defaults: populations, groups and clusters take a palette chosen for
   protanopia, deuteranopia and tritanopia (Okabe–Ito, then greedily the color farthest in
   CIEDE2000 from those chosen, in all four visions simulated per Machado et al. 2009, chroma ≥ 30,
   visible on light and dark plots), in the gating tree's order whatever colors they were given;
   rainbow heat maps are drawn as viridis; status colors become blue, orange and magenta. The
   workspace is not changed. The default palette fails (two of its first eight colors are 0.8
   apart with deuteranopia); the friendly one keeps ≥ 11 (first eight) and ≥ 7 (twenty).
   - Contrast fixes were shown before and after and approved: muted text, badge text and the
     dark theme's primary buttons now reach 4.5:1 on every surface, in both themes, setting on
     or off (validation `accessibility`, from the CSS tokens).
   - Keyboard: the population tree (WAI-ARIA tree pattern), the sample list as one stop, focus
     kept in dialogs and given back, focus rings for keyboard use only, scroll regions focusable.
     Screen readers: plots described in text, statuses in words, labeled icon buttons and menus.
   - axe-core 4.13 runs in every documentation scene (`capture.mjs --audit`; fetched, not
     shipped).
   - Not done: drawing a new gate without a pointer, exploring a plot's events without one, and
     testing by people who use screen readers (a walkthrough is in the docs).

## Next (0.5)

The order of waves 5–8 comes from `research.md` §8 and a parity and differentiation study
(October 2026) of FlowJo 10 and 11, FCS Express, OMIQ, Cytobank, Kaluza, SpectroFlo, CellEngine,
Floreada and the open-source tools, and of what users asked for in 2024–2026. Within each wave:
trust first, then the daily workbench, then what no single tool combines. Waves 6–8 are a plan,
to be revised as each wave lands.

### Wave 5

1. **A harder FCS reader (D8): done.** A fuzzer mutates files in every layout the reader decodes
   and real instruments' files (HEADER offsets, keyword values, deleted and duplicated keywords,
   delimiters, flipped bytes, the version line, truncation); each case must open with consistent
   data or be refused with an `FCSError`, in a worker with a timeout so that a hang fails rather
   than stalls the run. 47 public files from 42 more instrument models were added, compared with
   FlowIO and fcsparser.
   - Found by fuzzing: two hangs (a `$PnB` of 10^15 in packed data, a `$PAR` of 10^15), internal
     errors on negative `$TOT` and negative or reversed offsets, ASCII and packed data allocating
     what `$TOT` claimed rather than what the file held, messages saying "NaN"; a broken later data
     set hid the earlier ones; long TEXT parsed slowly.
   - Found on real files: stale `$BEGINDATA` (Accuri C6, CyAn) read every event shifted, as FlowIO
     still does; supplemental TEXT split on its own first byte (Bio-Rad S3: 192 junk keywords);
     empty values merging keywords (NanoFCM). The reference readers are wrong on four files in
     ways the suite checks (offsets, FCS 3.2 integer channels, float log channels stored as
     decades, `$PnG` on log channels).
   - Validation: `fuzz` (21 seed layouts exact; 20,000 cases), `fuzz-corpus` (10,000 cases over 73
     instrument files), `instruments` (47 files within 3.7e-7 of FlowIO and fcsparser);
     `fuzz.mjs` for longer runs (0 failures in 310,000 cases) and replay.
   - Not done: the ZE5 writes a `$PnR` (2^31 − 1) below what its time word and event-information
     bits use, so masking as the standard describes (and as FlowIO and fcsparser do) changes them;
     no ASCII, double or 64-bit integer files from instruments were found (the generated seeds
     cover those layouts); Sony ID7000 files exist only under a non-commercial license.
2. **Agents across the whole pipeline (M4): done.** Eleven new tools: `annotate_samples`, `run_qc`,
   `unmix`, `explore`, `build_figure`, `watch_folder`, and `export_flowjo`, `export_fcs`,
   `export_figure` and `export_table`, which write to an absolute path the agent gives (Go checks
   it before the page is asked; the page uploads the bytes to a one-time slot, written through a
   temporary file and renamed; no file is replaced unless the call says overwrite; scripts need
   the startup token). Proposals gained computed results and figures (added at once, marked) and
   held annotations and root gates; rejecting removes the results, the populations on them and
   their channels; QC of more samples joins the user's result on accepting; an agent never
   replaces a result the user made.
   - To share code with the views, the spectral workflow (`spectral-run.js`), clustering and maps
     (`explore-run.js`), figure building and export (`lib/figures.js`, `figure-export.js`) and the
     FlowJo and de-identified exports (`app.buildFlowJoExport`, `app.buildDeidentified`) left the
     views' closures; the documentation scenes that exercise them run unchanged.
   - Validation: `validation/agent-session.mjs` (CI job `agents`) drives every tool in the program
     and headless Chrome, 15 checks: agent QC equal to the QC view's on every event of three
     samples, agent clusters equal to a direct run on 120,000 T cells (adjusted Rand index 0.39
     against the true types), agent unmixing equal on every channel, the FlowJo export's counts,
     exports read back, and proposals held, accepted and rejected. Go tests of the output path.
   - Not done: drawing a gate from the keyboard (V4) stays open; agents create gates from
     coordinates, but a keyboard path for people needs its own design.
3. **Analysis templates, with OMIP strategies and Cell Ontology terms (I5, research N13):** one
   template format for a saved analysis (gates, scales, compensation choice, tables, figure
   layouts) applied to a new experiment by matching markers, not channel names, with a report of
   what matched and what did not. The same engine carries a few OMIP gating strategies and, later,
   clinical panels. Each population gets a suggested Cell Ontology term from the markers along
   its path, for the user to confirm; the terms go into the exports, CLR, tables and methods.
   Cell Ontology is CC-BY 4.0; each OMIP's terms are checked before it is bundled. This is the
   base for batch reports in wave 6.
   - Validation: a template saved from the PBMC example and applied to a reshuffled panel
     reproduces the hand-built tree's counts; suggested terms against expert-labeled populations
     in public workspaces.
4. **Titration and voltage optimization (Q6):** a titration series or voltage walk read from file
   names or keywords; stain index, separation index and spread of the negative per step;
   the recommended titer (or voltage) with the reason; a figure for the panel's record. Asked
   about far more often than kinetics in user forums, and it serves core facilities.
   - Validation: a simulated titration and voltage walk with known saturation and noise; stain
     index computed as published (Maecker) and against FlowJo 11 on the same files while the
     trial lasts.

## Then (0.6–0.8)

### Wave 6: the bench, batch by batch

1. **Statistics users already expect (G10, G11):** the population comparisons FlowJo users rely
   on (probability binning with T(χ), Overton subtraction, SED, Kolmogorov–Smirnov; already
   implemented and tested in `distribution.js`, not yet in any view) and rare-event statistics:
   Poisson intervals on counts, a limit of detection and quantification against a negative
   reference, and events needed for a target precision.
   - Validation: flowStats and published worked examples; exact formulas.
2. **Batch reports and spreadsheet export (R7):** a page layout iterated over samples or groups,
   multi-page PDF and PowerPoint, Excel workbooks and GraphPad Prism (`.pzfx`) tables, built on
   the template engine.
   - Validation: every number in a report traced to the table it came from; files read back by
     their own formats' readers.
3. **Derived parameters, calibrated units and absolute counts (G12, G13):** a formula editor for
   new channels (written to Gating-ML where it can express them); MEF/ERF units from calibration
   beads; concentrations from counting beads with the dilution factor.
   - Validation: FlowCal's bead files and results; simulated counting beads of known
     concentration.
4. **Computational users (H6, I6, M5):** differential state per cluster or population (as
   diffcyt), concatenated and downsampled FCS export, CSV event import, AnnData export, and R and
   Python clients for remote control (users who outgrow GUIs move to R first).
   - Validation: diffcyt-DS in R on the mass cytometry example; AnnData read back by `anndata`;
     the clients' calls against the HTTP API's tests.

### Wave 7: plates, migration and the spectral doctor

1. **Migration from acquisition software (I7):** FACSDiva experiments, FACSChorus and S8 files'
   embedded gates, SpectroFlo reference controls, and FlowJo 11 `.flowjo` workspaces, each with a
   fidelity report like the `.wsp` import's.
   - Validation: counts against the source software's saved statistics; independent readers
     (CyFj11 for `.flowjo`) where they exist.
2. **Plates (A5):** wells as samples, plate layouts from CSV or keywords, and heat maps of any
   statistic across the plate.
3. **Curves (A6, A4):** dose-response (4PL/5PL, EC50/IC50) and Z′ for screens; standard curves
   and concentrations for bead-based immunoassays (LEGENDplex, CBA); kinetics and calcium flux
   (baseline, peak, time to peak, area under the curve, responding fraction), moved here from
   wave 5.
   - Validation: simulated plates and kinetics with known parameters; R `drc` and beadplexr as
     oracles.
4. **The unmixing doctor (S8):** names the likely cause of a poor unmixing (a missing or wrong
   reference, a degraded tandem, a bead control for a cell stain, autofluorescence that differs
   between controls and sample) from the residuals, the library and the control checks, and
   proposes the fix.
   - Validation: each fault planted in the simulator, named first; AutoSpectral's bead and cell
     controls.

### Wave 8: designed, explained, certified

1. **Reproducibility certificate (R8):** a bundle (workspace, file checksums, versions, seeds)
   that re-runs itself to confirm every reported number, ready for Zenodo or a journal, with
   MIFlowCyt filled in.
   - Validation: certificates of every example re-run bit for bit; a changed file or gate
     detected.
2. **A virtual FMO (C4):** where each population's negative would fall without a given dye,
   predicted from the spread model of wave 4, drawn on the plot as a guide for gating. No tool
   offers it.
   - Validation: two public data sets with real FMO controls (Zenodo 22808501 and 20644656).
3. **A panel optimizer (S9):** assigns fluorochromes to markers by expression level and
   co-expression, using the user's own instrument model and library, warns of pairs prone to
   energy transfer, and is checked against the panel's result once run.
   - Validation: simulated panels with known best assignments; the predicted spread against the
     run's unmixed controls.
4. **An on-device assistant (M6):** an optional local model (in the browser, no network) that
   answers questions about the workspace through the same tools as external agents.
5. **Teaching mode (V5):** guided exercises on the examples, with the truth revealed afterward.

## Later
- Branches of an analysis, three-way merge of non-conflicting edits, and
  signed approval of checkpoints, building on the semantic diff.
- A tool contract for external algorithms: declared inputs and outputs,
  parameters and a pinned runtime (a WASM module, or a container run by the
  host without network). Results are imported as ordinary derived channels,
  so a tool cannot change a workspace invisibly. This would replace the
  plugin approach of other tools, which depends on the user's own R or Python
  installation.
- Robustness to analysis choices for designs of more than two groups and for
  cluster abundances.
- Design studies with one or two core facilities, and tutorials built on
  public FlowRepository studies.

- Imaging flow cytometry: image galleries for FACSDiscover CellView and Amnis
  files.
- Audit trail and electronic signatures for regulated labs (R6).
- Real-time co-annotation of one workspace by several people.

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
