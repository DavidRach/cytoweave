# Writes validation/reference/diffcyt.json: limma's moderated t-statistics on the synthetic cases
# of differential-cases.mjs (lmFit with weights, contrasts.fit, eBayes with and without a trend,
# topTable with BH), and diffcyt-DS-limma end to end on the two mass cytometry experiments
# (prepareData, transformData with cofactor 5, calcCounts, calcMedians, createDesignMatrix,
# createContrast and testDS_limma with its defaults), which validation/run.mjs (suite
# differential) compares with CytoWeave's. R is needed only to regenerate the file.
#
#   node validation/reference/write_differential.mjs
#   Rscript -e 'BiocManager::install("diffcyt")'
#   Rscript validation/reference/generate_diffcyt.R

suppressPackageStartupMessages({
  library(diffcyt)
  library(limma)
  library(flowCore)
  library(SummarizedExperiment)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", args[grep("^--file=", args)])))
folder <- file.path(here, "..", "cache", "differential")
num <- function(v) if (is.null(v)) NA_real_ else as.numeric(v)

# --- limma on the synthetic cases ------------------------------------------------------------------

cases <- fromJSON(file.path(folder, "limma-cases.json"), simplifyVector = FALSE)
limma_cases <- lapply(cases, function(k) {
  y <- do.call(rbind, lapply(k$y, function(r) vapply(r, num, 0)))
  design <- do.call(rbind, lapply(k$design, unlist))
  w <- if (is.null(k$weights)) NULL else do.call(rbind, lapply(k$weights, unlist))
  fit <- suppressWarnings(lmFit(y, design, weights = w))
  contrast <- matrix(0, ncol(design), 1)
  contrast[k$coefficient + 1, 1] <- 1
  fit <- contrasts.fit(fit, contrast)
  e <- suppressWarnings(eBayes(fit, trend = k$trend))
  top <- topTable(e, coef = 1, number = Inf, adjust.method = "BH", sort.by = "none")
  # 12 significant digits: the validation's tolerances are 1e-9.
  list(name = k$name, logFC = signif(top$logFC, 12), t = signif(top$t, 12), p = signif(top$P.Value, 12), padj = signif(top$adj.P.Val, 12),
       df_residual = as.numeric(e$df.residual), sigma = signif(as.numeric(e$sigma), 12), df_prior = signif(e$df.prior, 12))
})

# --- diffcyt-DS-limma on the experiments ---------------------------------------------------------

experiment <- function(name) {
  dir <- file.path(folder, name)
  info <- read.csv(file.path(dir, "experiment_info.csv"), stringsAsFactors = FALSE)
  markers <- read.csv(file.path(dir, "marker_info.csv"), stringsAsFactors = FALSE)
  spec <- fromJSON(file.path(dir, "design.json"))
  info$group_id <- factor(info$group_id, levels = spec$levels)
  info$subject_id <- factor(info$subject_id, levels = unique(info$subject_id))
  info$batch_id <- factor(info$batch_id, levels = unique(info$batch_id))
  info$sample_id <- factor(info$sample_id, levels = info$sample_id)
  frames <- lapply(info$file, function(f) read.FCS(file.path(dir, f), transformation = FALSE, truncate_max_range = FALSE))
  d_se <- prepareData(frames, info[, c("sample_id", "group_id", "subject_id", "batch_id")], markers)
  d_se <- transformData(d_se, cofactor = 5)
  clusters <- unlist(lapply(frames, function(f) exprs(f)[, "cluster"]))
  rowData(d_se)$cluster_id <- factor(clusters, levels = seq_len(spec$clusters))
  d_counts <- calcCounts(d_se)
  d_medians <- calcMedians(d_se)
  design <- createDesignMatrix(info, cols_design = c("group_id", spec$design))
  contrast <- createContrast(c(0, 1, rep(0, ncol(design) - 2)))
  res <- testDS_limma(d_counts, d_medians, design, contrast)
  rows <- as.data.frame(rowData(res))
  rows <- rows[!is.na(rows$p_val), ]
  state <- markers$marker_name[markers$marker_class == "state"]
  list(
    name = name,
    design = colnames(design),
    samples = as.character(info$sample_id),
    counts = unname(assay(d_counts)),
    medians = setNames(lapply(state, function(m) unname(assays(d_medians)[[m]])), state),
    rows = list(cluster = as.integer(as.character(rows$cluster_id)), marker = as.character(rows$marker_id),
                logFC = rows$logFC, AveExpr = rows$AveExpr, t = rows$t, p = rows$p_val, padj = rows$p_adj)
  )
}

out <- list(
  generated = list(R = R.version.string, limma = as.character(packageVersion("limma")), diffcyt = as.character(packageVersion("diffcyt")), statmod = as.character(packageVersion("statmod"))),
  limma = limma_cases,
  experiments = lapply(c("cohort", "plate"), experiment)
)
writeLines(toJSON(out, digits = NA, na = "null", auto_unbox = TRUE), file.path(here, "diffcyt.json"))
cat("wrote validation/reference/diffcyt.json\n")
