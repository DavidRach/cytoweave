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

## 0.5.0: a sturdier reader, agents for the whole pipeline, reusable analyses (released 2026-10-04)

Wave 5 hardens the FCS reader with a fuzzer and files from 42 more instrument models, lets AI
agents run the whole pipeline as proposals, turns an analysis into a template applied by marker
(with the OMIP-101 and OMIP-090 strategies placed on the data and Cell Ontology terms for every
population), and adds titration and voltage walks for setting up a panel.

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
3. **Analysis templates, with OMIP strategies and Cell Ontology terms (I5, research N13): done.**
   A template (`templates.js`, `.cwt`, kept in the library) holds a gating tree or subtree with
   its scales, plots, tables, figure layouts and compensation choice; applied to another
   experiment, channels are matched by marker (same area/height/width suffix preferred; scatter
   and time by name; markers found in labels), with a preview to change matches and a report of
   what was left out and why. Gates on computed channels are not kept; a QC pass gate is lifted
   out with its children moved up. The same engine carries recipe gates (`recipes.js`) placed on a
   sample's events, and with them OMIP-101 (major leukocyte populations, 25 gates) and OMIP-090
   (Tregs, 5 gates), written from the articles' hierarchies with citations and the substitutions
   listed (`strategies.js`). OMIP-069 (40-color spectral) is not included: most of its populations
   could not be checked against the 14-color example, and its article is CC BY-NC-ND, so a
   version would have to be the hierarchy in our own words, nothing copied. Each population gets a
   suggested Cell Ontology term from its marker path and scatter class (`phenotype.js`,
   `ontology.js`; 89 curated terms of CL 2026-06-08, CC BY 4.0, generated by
   `validation/reference/generate_cell_ontology.mjs`): a specific term fitting on evidence its
   ancestor lacks ranks first, and a term may not contradict an ancestor's phenotype unless its
   own contradicts it (NK cells and the helper-ILC phenotype). Confirmed terms go into FlowJo
   exports (population annotation), Gating-ML, the methods and the Tables view. Agents have
   `save_template`, `list_templates`, `apply_template` (strategies too) and `suggest_cell_types`.
   - Recipes: lymphocyte and monocyte density peaks (debris peaks at the FSC edge left out);
     positive cells above the negative population as all events show it (an FMO-like reading:
     on the parent alone, HLA-DR+ cut between monocytes and DCs); negative cells below the valley
     under the brightest mode (keeping dim autofluorescent monocytes on viability); modes need a
     real valley (below 80% of the lower peak) and Silverman smoothing, after a noise mode split
     the monocytes on CD19; a level recipe judges CD25 among CD127-low cells; intermediate
     monocytes above the upper edge of the classical cells' CD16 (mode + 2 SD from its dim side).
   - Validation: `templates` (19 of 19 populations identical on a renamed and reordered panel;
     unnamed CD25/CD127 leave out Tregs only), `strategies` (median F1 0.96–0.99 for lineages,
     0.88–0.96 for memory subsets, NK and classical and non-classical monocytes, Tregs 0.91,
     intermediate monocytes 0.76; strategy terms agree with the data's suggestions, 21 of 22
     exact), `ontology` (40 of 40 expert-named populations in three public workspaces; unchanged
     with every gate renamed), agent session (17 checks).
   - Not done: CLR files keep populations' names only, as the CLR format has no field for a term;
     table CSVs keep one header row (the term is shown in the view). Clinical panels wait for
     wave 6's batch reports. Strategies place one gate per population on one sample; per-sample
     placement is adapt_gate's job.
4. **Titration and voltage optimization (Q6): done.** QC → Titration (`titration.js`,
   `qc-titration.js`): a titration's amounts from file names ("125 ng", "1:200", "2.5 uL") or an
   amount annotation, a voltage walk's voltages from `$PnV` (now kept on each sample's channels;
   a voltage many files share is left out of the walk). Positive and negative cells found per
   step (valleys between the dimmest and brightest populations; overlapping steps take the
   series' shares). Stain index (Maecker 2004) and separation index (Bigos 2007), checked against
   the published formulas as Bonilla et al. 2024 give them. Titration: a saturation curve fitted
   to the stain index, the recommended amount the first tested at or above twice the 90%
   saturation amount (Bonilla et al. 2024). Voltage walk: the minimum where the negative cells'
   rSD reaches 2.5 × rSD_EN (BD technical bulletin, Meinelt et al. 2012; rSD_EN given or fitted as
   rSD² = rSD_EN² + a V^2n with n from the positive median), the maximum where the positive
   cells' 99th percentile reaches the linear range. A figure (SVG, PNG) and CSV for the panel's
   record; saved results go into the methods. Agent tool `titration` (34 tools). The simulator
   models PMT gain; a new example, "Antibody titration and a voltage walk".
   - Sources checked: Maecker & Trotter 2006 set the minimum at the inflection of the dim beads'
     CV against voltage, not at 2.5 × rSD_EN; the 2.5 × criterion is BD's (2012 bulletin), whose
     baseline reports also show PMT slopes of 7.3–7.5 and linearity maxima of 88–93% of the range.
   - Validation: `titration` (stain index within 4.4% of the true cells'; the binding's
     recommended amount; exponent 7.38 of 7.4; rSD_EN 25.1 of 25; voltages within 1 V of the
     truth; a walk too high to see the noise asks for it); agent session (18 checks).
   - FlowJo 11.2 on the same tubes (`reference/flowjo11-titration.json`): medians equal where the
     populations hold the same events; FlowJo's "Robust SD" is 1.4826 × MAD, not FACSDiva's
     percentile robust SD that CytoWeave uses (docs corrected: they had said FlowJo used it too).
   - Not done: titration plates with several antibodies in one file (by well) and the dim-bead
     CV method of the voltage walk are left for later.

## 0.6.0: the bench, batch by batch (released 2026-10-05)

Wave 6 adds what a lab does every week: comparisons with a control and rare-event limits,
formula channels, MEF units and absolute counts, batch reports with every number traced, Excel
and Prism, events in from CSV and out as concatenated FCS or AnnData, differential state equal to
diffcyt in R, and R and Python clients.

0.6.1 (2026-10-05) fixes Compute spillover on spectral files, whose reference controls name
fluorochromes rather than detectors: the Compensate view now points to unmixing.

### Wave 6: the bench, batch by batch

1. **Population comparisons and rare-event statistics (G10, G11): done.** Tables statistics
   against a control sample's population (chosen per column, the same population or another):
   % positive by SED and by Overton's cumulative subtraction, probability binning's T(χ) and
   excess %, and the K-S D (`stats.js`, `engine.js` `computeStatistic` with a context that finds
   the control's events), so Compare and agents have them too; histograms with overlaid samples
   show SED, Overton and T(χ) against each overlay. Rare events (`rare-events.js`): count and
   % of parent limits by exact Poisson (Garwood) and binomial (Clopper–Pearson) intervals, the
   counting CV and, in the inspector, the parent events a 10% CV needs; a column's detection
   limits (limit of blank, detection and quantification from chosen blank and low-level samples,
   CLSI EP17 / Armbruster & Pry 2008, parametric or nonparametric; each sample's LLOQ never below
   the (100/CV)² events Poisson counting needs) mark cells ND or < LLOQ and add a status column to
   CSVs. Methods sentences and references for all of it. Agent tools `compare_distributions` and
   `rare_events` (36 tools); `statistics_table`, `export_table` and `compare` take a control.
   - Sources: Overton's cumulative subtraction is the K-S Dmax and SED is FlowJo's name for
     Bagwell's enhanced normalized subtraction, both from Bagwell (1996), whose ENS formula is
     implemented exactly; probability binning gained flowStats' bins (split while a bin holds more
     than minEvents) and Baggerly's (2001) standardized statistic.
   - Validation: `comparisons` (probability binning equal to flowStats 4.24.0 in 36 cases to
     9e-15, bins included; K-S D equal to R, p to R's tolerance of 1e-6, CytoWeave's exact; SED
     within 2 points of the true fraction in six tubes, Overton 2–8 points under where populations
     overlap; Bagwell's simulation in his order, ENS −1.3% against his −0.85%; T(χ) > 4 in 0.5% of
     pairs of the same cells; exact intervals equal to R and covering ≥ 95%; EP17 limits giving
     4% false detections on new blanks and 98% detection at the LoD), agent session (19 checks).
   - FlowJo: 11.2 has no Population Comparison platform and no derived parameters (its platforms
     are t-SNE, UMAP, FlowSOM and X-Shift); both were FlowJo 10 features, so FlowJo 11 is no
     reference for this slice or for slice 2's formulas.
   - Not done: multivariate probability binning is in `compare_distributions` only, not in
     Tables.
2. **Formula channels, calibrated units and absolute counts (G12, G13): done.** Formula channels
   (`formula.js`: a parser and tree evaluator, no `eval`; channels by marker or detector in
   brackets, + − × ÷ ^, log, ln, exp, sqrt, abs, asinh, min, max) computed on compensated values
   as derived records the engine evaluates per event, with a dialog that checks the expression
   and previews it; they travel with templates (rebuilt from the matched channels), ratios go into
   Gating-ML as fratio, FlowJo exports report them as not written. Calibration (`calibration.js`,
   QC → Calibration) follows FlowCal: levels found together on chosen channels (logicle with
   W = 0), medians matched to the datasheet, levels within 2.5 SD of the range's ends left out,
   m·ln(x) + b = ln(MEF + MEF_beads) fitted by a local search from FlowCal's starting point (the
   global minimum is degenerate), and "<channel> <unit>" channels added to the samples acquired
   with the beads' settings (records with `samples`). Absolute counts from counting beads (bead
   population, beads in the tube, µL of sample) and a dilution factor (a number or an annotation)
   for them and for `$VOL` concentrations. Computed channels now appear in plot axis menus and
   agent tools. Methods sentences with FlowCal and Brando et al. 2000. Agent tools
   `add_formula_channel` and `calibrate_beads` (38 tools); `statistics_table` takes counting
   beads and a dilution.
   - Validation: `calibration` (the bead model on FlowCal's own selected levels: curves within
     1.5e-4, residuals no larger; simulated beads of known response with a saturated level: slope
     within 0.001, cells' MEFL within 0.2%; 7 formulas on 10 tubes against R, medians within
     5e-8, events within 2e-14; a ratio gate the same after Gating-ML and on renamed detectors
     through a template; counting beads in 40 tubes within 1%, scattered as Poisson predicts),
     `flowcal` (external data `flowcal-mef`: FlowCal's example end to end, the same levels left
     out, medians within one log-channel step, cells within 1.6% of FlowCal 1.3.1), agent session
     (21 checks).
   - Not done: FlowJo exports do not write formula channels as derived parameters (no open reader
     computes them to check against, and FlowJo 11 cannot create them); calibrated channels stay
     in CytoWeave (not written to exports).
3. **Batch reports and spreadsheet export (R7): done.** Batch reports (`reports.js`, Figures →
   Batch report…): a figure repeated by sample (the plots of the figure's followed sample redrawn
   on each sample, other samples' plots on every page) or by an annotation's values (each plot on
   the page's sample matching it on the annotations that tell the figure's samples apart, the one
   sharing most of its annotations among several; a missing tube left empty and reported, an
   undecided choice reported), text placeholders filled ({sample}, {subject}, {page}…), as a
   multi-page PDF or a PowerPoint deck (our own writer, `pptx.js`: pictures, text, arrows and
   native tables). A new figure item, statistics, shows a Tables table's columns for the page's
   samples (or all rows), with ND and < LLOQ. Every number printed is traced (each statistics cell
   to its table column, each gate label to its gate's % of parent) and the record goes into the
   file beside the plots' provenance. PDF figures became vector (`pdf.js` `PDFPage`: Helvetica
   text with Adobe's metrics, paths, event rasters as images; `plot.js` `sceneToPDF`). Excel
   workbooks (`xlsx.js`, `spreadsheets.js`): every table in full precision, with Columns, Samples
   (SHA-256), Populations and About (methods) sheets; Prism projects (`pzfx.js`): the table, and
   grouped by an annotation a column table per statistic. Plot scenes and the Tables
   computations moved to the library (`scene.js`, `tables.js`) so that reports and validation
   share them. Batch choices and statistics items travel with templates. Agent tool
   `export_report` (39 tools); `export_table` writes `.xlsx` and `.pzfx`.
   - Validation: `reports` (by sample and by subject, every plot where the rules put it; 124
     statistics cells and 47 gate labels traced and equal to their sources; the PDF read back
     prints every traced number and no untraced one; deck, workbook and Prism values exact;
     openpyxl 3.1.5, python-pptx 1.0.2, pypdf 5.4.0 and R pzfx 0.3.1 read the same documents,
     matched by content fingerprints), agent session (23 checks). The documents also open in
     LibreOffice 26.8 and Apple's Quick Look.
   - Not done: plots in PowerPoint are pictures (3×), not vector; PDF text is limited to
     WinAnsi characters (others written as their nearest ASCII); opening the files in Microsoft
     PowerPoint and Excel themselves is a manual check.
4. **Data in and out (I6): done.** CSV event import (`csv-events.js`, `events-io.js`): the
   delimiter and decimal mark found, FlowJo's `name :: marker` headers, every column checked
   (non-numbers with the first row, empty cells, short rows, constant columns, an event number
   left out, label columns that can split a file into samples), kinds and scales guessed
   (logicle, arcsinh cofactor 5 for mass counts, linear for scatter, time and already-transformed
   values) and adjustable; each file stored as an FCS file. Events out (`events.js`): a
   population's events in chosen samples, every event or downsampled (count or share, seeded per
   sample from its checksum), as one concatenated FCS file (common channels, raw with the shared
   spillover or compensated, `SampleID` and `SourceEvent`, the samples named and checksummed in
   keywords), one FCS file per sample, or AnnData (`anndata.js`: X arcsinh or compensated; obs
   sample, annotations, event, populations as True/False columns and the deepest as a category,
   clusters, QC, scatter and time; var; obsm maps; uns provenance; encodings readable by anndata
   0.8 and later) through our own HDF5 writer (`hdf5.js`: superblock 0, version 1 object headers,
   symbol-table groups, contiguous datasets, enum booleans, variable-length UTF-8 strings in global
   heaps). Agent tool `export_events` (40 tools); `open_files` opens CSV events.
   - Validation: `events` (downsampling exact, reproducible, independent and uniform; every event
     of a concatenated file its source's and every population counted alike per SampleID; CSV
     round trips exact, a damaged file's faults reported; anndata 0.13.4 and 0.10.9, h5py 3.16
     with HDF5 2.0, pyfive 1.2.1, fcsparser 0.2.8 and FlowIO 1.4.0 read the files' values exactly),
     agent session (25 checks).
   - Not done: AnnData files are written uncompressed (a group holds at most 256 members); sparse
     layers and other AnnData readers (R's anndata, Julia) are not tested; a concatenated file
     keeps each sample's time values as they were.
5. **Differential state and R and Python clients (H6, M5): done.** diffcyt-DS-limma
   (`differential.js`, `limma.js`; Compare → Screen marker states): per sample the median of
   arcsinh(x / cofactor) of each marker in each cluster (or chosen population), clusters with at
   least 3 cells in half the samples, a linear model per cluster and marker weighted by the cells
   (pairing and covariates as fixed effects), limma's moderated t with a mean-variance trend, BH
   across every test; the markers a clustering used left out by default; methods sentence and
   references. limma written in JavaScript from its R and C sources (weighted least squares with
   LINPACK's pivoting, natural-spline trend for equal residual df, weighted lowess and the prior df
   by maximum likelihood for unequal df, as limma 3.68 chooses). Agent tool
   `differential_analysis` (41 tools): state or abundance of clusters, or the state of
   populations. R and Python clients (`clients/`): a function per action generated from
   `clients/tools.json` (kept equal to `mcp.go` by a Go test) by `clients/generate.mjs`, with help
   pages, data frames, PNG plots and errors with CytoWeave's reason; with `--remote-control`
   CytoWeave writes `remote.json` (address and token, mode 0600, removed on exit) to its data
   folder, where the clients find it; `GET /api/remote/tools` lists the actions. The clients'
   versions are `main.go`'s (checked at release).
   - Validation: `differential` (the limma port within 4e-11 of limma 3.68.5 on 11 synthetic
     cases across its paths; diffcyt 1.32.1 in R on the cytof cohort and the barcoded plate by
     well: counts and medians identical, 1,150 tests within 3e-11; no call where no marker
     differs, the strong activation changes all called with 3 of 53 calls false), agent session
     (27 checks), the clients' tests in CI against a running CytoWeave (each client's results
     equal the HTTP API's; R CMD check clean).
   - Fixed on the way: agent tools could read derived channels before they were restored after a
     reload; isotope-only mass channel labels were taken as markers; Compare's cluster names.
   - Not done: diffcyt's random-effect options (block_id, diffcyt-DS-LMM) and limma's robust
     moderation; publishing the clients to CRAN or PyPI (a separate decision); the B-statistic.

Left for later: kinetics, plates and titration plates stay in wave 7; drawing a gate from the
keyboard (V4) stays open.

## Next (0.7–0.8)

The order of waves 5–8 (wave 5 released as 0.5.0, wave 6 as 0.6.0) comes from `research.md` §8
and a parity and differentiation study (October 2026) of FlowJo 10 and 11, FCS Express, OMIQ,
Cytobank, Kaluza, SpectroFlo, CellEngine, Floreada and the open-source tools, and of what users
asked for in 2024–2026. Within each wave: trust first, then the daily workbench, then what no
single tool combines. Waves 7–8 are a plan, to be revised as each wave lands.

Revised after a comparison with FlowJo, FCS Express, OMIQ and Cytobank (2026-10-05,
`product_research/feature-comparison.html`):
- **Agents are no longer distinctive; agents proven right are.** Dotmatics' Luma Agent, Ozette,
  Conspecta and flow-atlas now offer agents or MCP servers, so wave 8 adds a public agent benchmark
  and WebMCP in place of the on-device assistant.
- **Users before features.** CytoWeave's gaps come down to adoption: no institutional users yet,
  and validation mostly on simulated truth. Core-facility studies move from Later to run beside
  wave 7, with validation on real expert-gated data.
- **The FlowJo 11 transition is an opening that closes as FlowJo 11 matures**, so migration stays
  first in wave 7; the unmixing doctor moves ahead of plates (unmixing, controls and panels are
  where most users struggle, and HoneyChrome is now a free rival on spectral depth); kinetics,
  small once formula channels exist, is split out of "Curves" to land early.
- **Collaboration without a cloud:** a self-contained review report covers most sharing (a PI or
  reviewer reading an analysis) before any multi-user work.
- **Automation for cores:** headless runs of a template on a folder, and the clients published.

### Beside wave 7: core-facility studies and real data

- **Design studies with one or two core facilities** (moved from Later): their files, panels and
  routines; what blocks daily use; the first institutional users. Findings reorder the waves.
- **Validation on real expert-gated data (V7):** public studies with expert gates or published
  counts (FlowCAP, FlowRepository studies such as the ALS cytokine workspaces already used),
  beside the simulated truth.
- **Tutorials** built on public FlowRepository studies.

### Wave 7: migration, the spectral doctor, plates and runs

1. **Migration from acquisition software (I7):** FACSDiva experiments, FACSChorus and S8 files'
   embedded gates, SpectroFlo reference controls, and FlowJo 11 `.flowjo` workspaces, each with a
   fidelity report like the `.wsp` import's.
   - Validation: counts against the source software's saved statistics; independent readers
     (CyFj11 for `.flowjo`) where they exist.
   - Done (slice 1): FlowJo 11 workbenches, checked against twelve workbenches FlowJo 11.2 saved
     (FlowJo 11's display-grid evaluation found and reproduced: every count equal, quadrants
     drawn in FlowJo 11 within 3 events), and FACSDiva experiments, checked against Diva's and
     CytoML's counts. CyFj11's example workbench turned out inconsistent (stale per-sample gates)
     and is not used.
   - Done (slice 2): FACSChorus gates from S8/A8 FCS files (a real A8 record read exactly; no counts
     in the files), and SpectroFlo experiments' reference controls, matched to their raw files
     (the spectra SpectroFlo stores turned out not to match the controls' events, so CytoWeave
     computes them; its spectra peak where SpectroFlo gated). FACSChorus `.cef` files are not read
     (no public file to check against).
2. **The unmixing doctor (S8):** names the likely cause of a poor unmixing (a missing or wrong
   reference, a degraded tandem, a bead control for a cell stain, autofluorescence that differs
   between controls and sample) from the residuals, the library and the control checks, and
   proposes the fix.
   - Validation: each fault planted in the simulator, named first; AutoSpectral's bead and cell
     controls.
   - Done (slice 3): the Spectral view's Diagnose tab and agents' `diagnose_unmixing`. Six faults
     planted in the spectral example are each named first on its seed and a held-out one, with
     nothing on clean samples, and each tried fix moves the unmixed values toward the truth (a
     held-out sweep of three more seeds named 20 of 21; the miss, a 6 nm bead shift, changed no
     dye's accuracy). On real data, AutoSpectral's bead and cell controls showed that the large
     bead–cell differences are autofluorescence carried by cell controls of markers on
     autofluorescent cells (CD11b, Siglec F, F4/80), not the dyes emitting differently on beads, so
     the doctor checks cell controls for it; it names the example's PFA-fixed spleen as
     autofluorescence the unstained control lacks. A degraded tandem leaves no residual (its donor
     is in the panel) and is found from its donor's population lining up with it.
3. **Kinetics (A4):** a signal or ratio (Indo-1 violet/blue) against time, smoothed per time bin,
   with baseline, peak, time to peak, area under the curve and the responding fraction, and
   samples overlaid; moved here from wave 5 and split from the curves below.
   - Validation: simulated calcium flux with known parameters.
4. **Plates (A5):** wells as samples, plate layouts from CSV or keywords, and heat maps of any
   statistic across the plate.
5. **Curves (A6):** dose-response (4PL/5PL, EC50/IC50) and Z′ for screens; standard curves and
   concentrations for bead-based immunoassays (LEGENDplex, CBA).
   - Validation: simulated plates with known parameters; R `drc` and beadplexr as oracles.
6. **Headless runs (M8):** `cytoweave run` applies a template to a folder of files without a
   window (a headless browser) and writes its tables, reports and exports, for cores' nightly
   runs, pipelines and CI.
   - Validation: the same files run headless and in the window give identical outputs.
7. **The clients published (M9):** the R package on r-universe and the Python package on PyPI,
   released with each version (CRAN later).

### Wave 8: designed, explained, certified

1. **Reproducibility certificate (R8):** a bundle (workspace, file checksums, versions, seeds)
   that re-runs itself to confirm every reported number, ready for Zenodo or a journal, with
   MIFlowCyt filled in. It carries a tamper-evident (hash-chained) change log, the first step of
   the audit trail (R6).
   - Validation: certificates of every example re-run bit for bit; a changed file, gate or log
     entry detected.
2. **A review report (R9):** one self-contained HTML file of an analysis (plots, gates, tables,
   every number traced to its source) that a PI, collaborator or reviewer opens without
   CytoWeave.
   - Validation: every number in the report equal to the workspace's; the file makes no network
     requests.
3. **A virtual FMO (C4):** where each population's negative would fall without a given dye,
   predicted from the spread model of wave 4, drawn on the plot as a guide for gating. No tool
   offers it.
   - Validation: two public data sets with real FMO controls (Zenodo 22808501 and 20644656).
4. **A panel optimizer (S9):** assigns fluorochromes to markers by expression level and
   co-expression, using the user's own instrument model and library, warns of pairs prone to
   energy transfer, and is checked against the panel's result once run.
   - Validation: simulated panels with known best assignments; the predicted spread against the
     run's unmixed controls.
5. **A public agent benchmark (V6):** graded tasks on the examples (gate a population, find a
   compensation error, test a difference, export a report), each scored against the simulated
   truth, with published results per agent and model. It extends the validation suite to
   agents, where users' distrust is greatest.
6. **WebMCP (M7):** the same tools exposed to agents in the browser through WebMCP (Chrome origin
   trial, 2026), beside the MCP server; it replaces the on-device assistant (M6, now an idea).
7. **Teaching mode (V5):** guided exercises on the examples, with the truth revealed afterward.

## Toward 1.0 (0.9–1.0)

### 1.0 means

- Stable workspace and template formats, with a promise that later versions open them.
- A stable, versioned MCP and HTTP API, covered by the clients' tests.
- Validation on real expert-gated data as well as simulated truth (V7).
- At least two core facilities using CytoWeave in production.
- Documented support, security and release policies.

### Wave 9: shared and audited

The scope of this wave depends on an open decision: whether CytoWeave pursues regulated (GxP)
labs. 21 CFR Part 11 needs user identities, e-signatures and a validation package with support
commitments, which sit uneasily with a free, local tool. Without GxP, the wave keeps the shared
library and signed approvals and drops e-signatures.
1. **A shared library for a core's server:** the program serving a lab's or core's workspaces to
   several users, with roles, instead of one person's library.
2. **Audit trail and electronic signatures (R6):** users, an append-only audit trail and
   signatures on approvals, building on the wave-8 change log.
3. **Signed approval of checkpoints**, building on the semantic diff.

### Wave 10: images and extensions

1. **Imaging flow cytometry (A7):** image galleries for FACSDiscover CellView and Amnis files,
   then image features (size, texture, nuclear overlap) to gate on.
2. **A tool contract for external algorithms (M10):** declared inputs and outputs, parameters and
   a pinned runtime (a WASM module, or a container run by the host without network). Results are
   imported as ordinary derived channels, so a tool cannot change a workspace invisibly. This
   would replace the plugin approach of other tools, which depends on the user's own R or Python
   installation, and brings in the embeddings and batch corrections where OMIQ is ahead (PaCMAP,
   PHATE, cyCombine).

## Ideas (unscheduled)

- Robustness to analysis choices for designs of more than two groups and for cluster
  abundances.
- Branches of an analysis and three-way merge of non-conflicting edits, building on the semantic
  diff.
- Real-time co-annotation of one workspace by several people.
- An optional on-device assistant (M6), if local models become good enough to add to the
  external agents.

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
| Licensing of ported code | limma and statmod are GPL; the moderated t-statistics follow their sources closely, in an Apache-2.0 project | Provenance recorded in the code, README and Science page; a decision is open: accept, seek the authors' permission, or reimplement independently from the publications |
| One developer | Competitors have teams; users and institutions judge whether a project will last | Validation and documentation that let others check and continue the work; core-facility studies to find co-maintainers and users |
| Competitors' AI moves fast | Luma Agent, Ozette and others narrow the agent lead | Agents proven right rather than merely present: the public agent benchmark (wave 8) |
