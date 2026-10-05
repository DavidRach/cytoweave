# Writes validation/reference/formulas.json: formula channels computed by R on the comparison
# tubes (validation/comparison-cases.mjs), which validation/run.mjs (suite calibration) compares
# with CytoWeave's formula channels. R is needed only to regenerate the file, not to run the
# validation.
#
#   node validation/reference/write_comparisons.mjs
#   Rscript validation/reference/generate_formulas.R
#
# Each formula is written once in CytoWeave's syntax and once as the R expression it means; R
# evaluates it on flowCore's values in double precision. For each tube: the median of the finite
# values, the number of non-finite ones, and the values of a few events.

suppressPackageStartupMessages({
  library(flowCore)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", args[grep("^--file=", args)])))
folder <- file.path(here, "..", "cache", "comparisons")

FORMULAS <- list(
  list(cytoweave = "[CD25] / [CD69]", r = function(x) x[, "FITC-A"] / x[, "PE-A"]),
  list(cytoweave = "log([FITC-A] / [PE-A])", r = function(x) log10(x[, "FITC-A"] / x[, "PE-A"])),
  list(cytoweave = "2 * ([CD25] - 100) / ([CD69] + 50)", r = function(x) 2 * (x[, "FITC-A"] - 100) / (x[, "PE-A"] + 50)),
  list(cytoweave = "asinh([CD25] / 150) - asinh([CD69] / 150)", r = function(x) asinh(x[, "FITC-A"] / 150) - asinh(x[, "PE-A"] / 150)),
  list(cytoweave = "sqrt(abs([FITC-A])) + [SSC-A] ^ 0.5", r = function(x) sqrt(abs(x[, "FITC-A"])) + x[, "SSC-A"]^0.5),
  list(cytoweave = "max([CD25], [CD69], 200) - min([CD25], [CD69])", r = function(x) pmax(x[, "FITC-A"], x[, "PE-A"], 200) - pmin(x[, "FITC-A"], x[, "PE-A"])),
  list(cytoweave = "ln([FSC-A]) * exp(-[SSC-A] / 100000)", r = function(x) log(x[, "FSC-A"]) * exp(-x[, "SSC-A"] / 100000))
)
PICKS <- c(1, 2, 3, 100, 1000, 2500)

tubes <- sort(list.files(folder, pattern = "\\.fcs$"))
results <- lapply(tubes, function(name) {
  x <- exprs(read.FCS(file.path(folder, name), transformation = FALSE, truncate_max_range = FALSE))
  list(tube = name, formulas = lapply(FORMULAS, function(f) {
    v <- f$r(x)
    finite <- v[is.finite(v)]
    list(formula = f$cytoweave, median = median(finite), nonFinite = sum(!is.finite(v)), picks = PICKS - 1, values = unname(v[PICKS]))
  }))
})
out <- list(
  about = paste0("R ", getRversion(), " evaluating formulas on flowCore ", packageVersion("flowCore"), "'s values of the comparison tubes (validation/comparison-cases.mjs); written by reference/generate_formulas.R."),
  R = as.character(getRversion()),
  tubes = results
)
writeLines(toJSON(out, auto_unbox = TRUE, digits = NA, pretty = TRUE, na = "string"), file.path(here, "formulas.json"))
cat("wrote validation/reference/formulas.json:", length(results), "tubes,", length(FORMULAS), "formulas\n")
