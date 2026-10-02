# Writes validation/reference/r.json: results of the Bioconductor packages flowCore, PeacoQC,
# FlowSOM and CytoNorm on public data (validation/sources.json), which validation/run.mjs compares
# with CytoWeave's. R is needed only to regenerate the file, not to run the validation.
#
#   node validation/fetch.mjs rpackages zenodo-skull flowkit
#   node validation/reference/write_simulated.mjs
#   Rscript validation/reference/generate_r.R
#
# Each analysis follows its package's vignette; every parameter it uses (logicle widths,
# channels, seeds) is written out, so CytoWeave can be given exactly the same input.

suppressPackageStartupMessages({
  library(flowCore)
  library(PeacoQC)
  library(FlowSOM)
  library(CytoNorm)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", args[grep("^--file=", args)])))
cache <- file.path(here, "..", "cache")
path <- function(...) file.path(cache, ...)

# Per-channel summaries: sum, extremes and a few events by index (0-based in the output).
summarize <- function(m) {
  n <- nrow(m)
  picks <- sort(unique(c(1, 2, 3, n %/% 3, n %/% 2, n)))
  list(
    events = n,
    picks = picks - 1,
    channels = lapply(unname(colnames(m)), function(ch) list(
      name = ch,
      sum = sum(as.numeric(m[, ch])),
      min = min(m[, ch]),
      max = max(m[, ch]),
      values = unname(m[picks, ch])
    ))
  )
}

read <- function(file) read.FCS(file, transformation = "linearize-with-PnG-scaling", truncate_max_range = FALSE, emptyValue = FALSE)
spillOf <- function(ff) {
  s <- tryCatch(spillover(ff), error = function(e) list())
  s <- s[!vapply(s, is.null, logical(1))]
  if (length(s)) s[[1]] else NULL
}
# Run-length encoding of the removed events as 0-based [start, end] pairs.
runs <- function(removed) {
  idx <- which(removed) - 1
  if (!length(idx)) return(list())
  breaks <- c(0, which(diff(idx) != 1), length(idx))
  lapply(seq_len(length(breaks) - 1), function(i) c(idx[breaks[i] + 1], idx[breaks[i + 1]]))
}
logicleParams <- function(tl) lapply(tl@transforms, function(t) {
  f <- t@f
  e <- environment(f)
  list(T = e$t, W = e$w, M = e$m, A = e$a)
})

out <- list(
  about = "Results of flowCore, PeacoQC, FlowSOM and CytoNorm on public data; written by validation/reference/generate_r.R.",
  versions = list(
    R = paste(R.version$major, R.version$minor, sep = "."),
    flowCore = as.character(packageVersion("flowCore")),
    PeacoQC = as.character(packageVersion("PeacoQC")),
    FlowSOM = as.character(packageVersion("FlowSOM")),
    CytoNorm = as.character(packageVersion("CytoNorm"))
  )
)

# --- flowCore -------------------------------------------------------------------------------------

files <- c(
  "rpackages/111.fcs" = path("rpackages", "PeacoQC", "111.fcs"),
  "rpackages/68983.fcs" = path("rpackages", "FlowSOM", "68983.fcs"),
  "rpackages/Gates_PTLG021_Unstim_Control_1.fcs" = path("rpackages", "CytoNorm", "Gates_PTLG021_Unstim_Control_1.fcs"),
  "zenodo-skull/Skull BM Broad_Tube_017.fcs" = path("zenodo-skull", "Skull BM Broad_Tube_017.fcs"),
  "flowkit/101_DEN084Y5_15_E01_008_clean.fcs" = path("flowkit", "8_color_data_set", "fcs_files", "101_DEN084Y5_15_E01_008_clean.fcs")
)
flowcore <- list()
for (key in names(files)) {
  ff <- read(files[[key]])
  entry <- list(file = key, read = summarize(exprs(ff)))
  spill <- spillOf(ff)
  if (!is.null(spill)) {
    comp <- compensate(ff, spill)
    fluor <- colnames(spill)
    entry$compensated <- summarize(exprs(comp)[, fluor, drop = FALSE])
    tl <- estimateLogicle(comp, fluor)
    entry$logicle <- logicleParams(tl)
  }
  flowcore[[key]] <- entry
}
grid <- c(-50000, -5000, -1000, -100, -10, -1, 0, 1, 10, 100, 1000, 5000, 10000, 50000, 100000, 262143)
transforms <- list()
for (p in list(c(262144, 0.5, 4.5, 0), c(262144, 1, 4.5, 0.5), c(10000, 0.3, 4, 0))) {
  lt <- logicleTransform(t = p[1], w = p[2], m = p[3], a = p[4])
  il <- inverseLogicleTransform(trans = lt)
  scales <- c(0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1)
  # flowCore's logicle runs from 0 to M (decades); CytoWeave's scale from 0 to 1.
  transforms[[length(transforms) + 1]] <- list(T = p[1], W = p[2], M = p[3], A = p[4], values = grid, forward = lt(grid) / p[3], scales = scales, inverse = il(scales * p[3]))
}
out$flowCore <- list(files = unname(flowcore), logicle = transforms)

# --- PeacoQC --------------------------------------------------------------------------------------

# Also CytoWeave's simulated QC wells (clogs, bubbles, drift), written to the cache by
# write_simulated.mjs: with 160 bins each, they exercise the isolation tree.
simulated <- sprintf("simulated/A0%d.fcs", 1:4)
peaco_files <- c(files[c("rpackages/111.fcs", "zenodo-skull/Skull BM Broad_Tube_017.fcs", "flowkit/101_DEN084Y5_15_E01_008_clean.fcs")], setNames(path(simulated), simulated))
peaco <- list()
for (key in names(peaco_files)) {
  ff <- read(peaco_files[[key]])
  spill <- spillOf(ff)
  ff <- compensate(ff, spill)
  fluor <- colnames(spill)
  tl <- estimateLogicle(ff, fluor)
  ff <- transform(ff, tl)
  scatter <- grep("^(FSC|SSC)-A$", colnames(ff), value = TRUE)
  channels <- c(scatter, fluor)
  res <- PeacoQC(ff, channels, determine_good_cells = "all", save_fcs = FALSE, plot = FALSE, report = FALSE, output_directory = tempdir())
  peaco[[key]] <- list(
    file = key, channels = channels, logicle = logicleParams(tl),
    events = nrow(ff), removed = runs(!res$GoodCells), percentageRemoved = res$PercentageRemoved,
    eventsPerBin = res$EventsPerBin, itPercentage = res$ITPercentage, madPercentage = res$MADPercentage
  )
}
out$PeacoQC <- unname(peaco)

# --- FlowSOM --------------------------------------------------------------------------------------

ff <- read(files[["rpackages/68983.fcs"]])
spill <- spillOf(ff)
ff <- compensate(ff, spill)
tl <- estimateLogicle(ff, colnames(spill))
ff <- transform(ff, tl)
cols <- colnames(ff)[c(9, 12, 14:18)]
data <- exprs(ff)[, cols]
runs_ <- list()
labels <- list()
for (seed in 1:3) {
  fs <- FlowSOM(ff, colsToUse = cols, nClus = 10, seed = seed, silent = TRUE)
  labels[[seed]] <- as.integer(GetMetaclusters(fs))
  if (seed == 1) {
    codes <- fs$map$codes
    mapping <- GetClusters(fs) - 1
    tree <- hclust(dist(codes), method = "average")
    runs_ <- list(codes = unname(as.vector(t(codes))), nodes = nrow(codes), mapping = mapping, hclustAverage10 = as.integer(cutree(tree, 10)) - 1)
  }
}
ari <- function(a, b) {
  tab <- table(a, b)
  comb <- function(x) sum(choose(x, 2))
  index <- comb(tab)
  expected <- comb(rowSums(tab)) * comb(colSums(tab)) / choose(length(a), 2)
  maximum <- (comb(rowSums(tab)) + comb(colSums(tab))) / 2
  (index - expected) / (maximum - expected)
}
rr <- c(ari(labels[[1]], labels[[2]]), ari(labels[[1]], labels[[3]]), ari(labels[[2]], labels[[3]]))
out$FlowSOM <- c(list(
  file = "rpackages/68983.fcs", channels = cols, logicle = logicleParams(tl), events = nrow(data),
  labels = lapply(labels, function(l) paste(l - 1, collapse = "")), ariBetweenSeeds = rr
), runs_)

# --- CytoNorm -------------------------------------------------------------------------------------

cn_files <- path("rpackages", "CytoNorm", sprintf("Gates_PTLG0%s_Unstim_Control_%d.fcs", rep(c("21", "28", "34"), each = 2), rep(1:2, 3)))
batch <- rep(c("PTLG021", "PTLG028", "PTLG034"), each = 2)
ff1 <- read(cn_files[1])
cn_channels <- grep("Di$", colnames(ff1), value = TRUE)
cn_channels <- cn_channels[!grepl("^(Time|Event_length|Cell_length)", cn_channels)]
tf <- transformList(cn_channels, cytofTransform)
tf_rev <- transformList(cn_channels, cytofTransform.reverse)
outdir <- file.path(tempdir(), "cytonorm")
dir.create(outdir, showWarnings = FALSE)
# As CytoNorm's README: volunteer 1 of each batch (Control_1) trains, volunteer 2 validates.
train <- grepl("Control_1", cn_files)
normalizedFiles <- function(prefix, labelsOf = NULL) lapply(seq_along(cn_files), function(i) {
  nf <- read(file.path(outdir, paste0(prefix, basename(cn_files[i]))))
  entry <- c(list(file = basename(cn_files[i]), batch = batch[i], training = train[i]), summarize(exprs(nf)[, cn_channels, drop = FALSE]))
  if (!is.null(labelsOf)) entry$clusters <- paste(labelsOf(cn_files[i]), collapse = "")
  entry
})
# Without clustering (QuantileNorm), with CytoNorm 2.x's default of 99 quantiles.
model <- QuantileNorm.train(files = cn_files[train], labels = batch[train], channels = cn_channels, transformList = tf, nQ = 99, goal = "mean", plot = FALSE)
QuantileNorm.normalize(model = model, files = cn_files, labels = batch, transformList = tf, transformList.reverse = tf_rev, outputDir = outdir, prefix = "Norm_")
quantileNorm <- list(method = "QuantileNorm (one cluster)", nQ = 99, files = normalizedFiles("Norm_"))
# CytoNorm with its own FlowSOM clustering (a small map for 1000-cell files); each event's
# metacluster is written out, so CytoWeave can be given the same clusters.
cn_model <- CytoNorm.train(files = cn_files[train], labels = batch[train], channels = cn_channels, transformList = tf, outputDir = file.path(tempdir(), "cytonorm_train"),
                           FlowSOM.params = list(nCells = 1e6, xdim = 5, ydim = 5, nClus = 4, scale = FALSE), normParams = list(nQ = 99, goal = "mean"), seed = 1, verbose = FALSE)
CytoNorm.normalize(model = cn_model, files = cn_files, labels = batch, transformList = tf, transformList.reverse = tf_rev, outputDir = outdir, prefix = "CytoNorm_", verbose = FALSE)
clustersOf <- function(file) as.integer(FlowSOM::GetMetaclusters(FlowSOM::NewData(cn_model$fsom, transform(read.FCS(file), tf)))) - 1
cytoNorm <- list(method = "CytoNorm (FlowSOM 5 x 5, 4 metaclusters, seed 1)", nQ = 99, minCells = 50, files = normalizedFiles("CytoNorm_", clustersOf))
out$CytoNorm <- list(channels = cn_channels, cofactor = 5, goal = "mean", quantileNorm = quantileNorm, cytoNorm = cytoNorm)

write(toJSON(out, auto_unbox = TRUE, digits = NA, null = "null", na = "null", pretty = 1), file.path(here, "r.json"))
cat("wrote", file.path(here, "r.json"), "\n")
