# Writes validation/reference/flowstats.json: probability binning by the Bioconductor package
# flowStats (proBin, binByRef, calcPBChiSquare) and R's two-sample Kolmogorov-Smirnov test on the
# comparison tubes, and R's exact Poisson and binomial intervals, which validation/run.mjs (suite
# comparisons) compares with CytoWeave's. R is needed only to regenerate the file, not to run the
# validation.
#
#   node validation/reference/write_comparisons.mjs
#   Rscript validation/reference/generate_flowstats.R
#
# Every test tube is compared with Control: on FITC-A alone, and on FITC-A and PE-A together,
# with proBin's minEvents of 500 and 250.

suppressPackageStartupMessages({
  library(flowCore)
  library(flowStats)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", args[grep("^--file=", args)])))
folder <- file.path(here, "..", "cache", "comparisons")
read <- function(name) read.FCS(file.path(folder, name), transformation = FALSE, truncate_max_range = FALSE)

control <- read("Control.fcs")
tests <- setdiff(sort(list.files(folder, pattern = "\\.fcs$")), "Control.fcs")
cases <- list()
for (name in tests) {
  test <- read(name)
  for (channels in list("FITC-A", c("FITC-A", "PE-A"))) {
    for (minEvents in c(500, 250)) {
      ctrl <- control[, channels]
      samp <- test[, channels]
      bins <- proBin(ctrl, minEvents = minEvents, channels = channels)
      binned <- binByRef(bins, samp)
      result <- calcPBChiSquare(bins, binned, nrow(ctrl), nrow(samp))
      cases[[length(cases) + 1]] <- list(
        test = name,
        channels = channels,
        minEvents = minEvents,
        bins = length(result$chiSq),
        chiSquare = sum(result$chiSq),
        pbStat = result$pbStat
      )
    }
  }
}
ks <- lapply(tests, function(name) {
  k <- suppressWarnings(ks.test(exprs(control)[, "FITC-A"], exprs(read(name))[, "FITC-A"], exact = FALSE))
  list(test = name, D = unname(k$statistic), p = k$p.value)
})

# Exact 95% intervals: poisson.test (Garwood) and binom.test (Clopper-Pearson).
poissonIntervals <- lapply(c(0, 1, 2, 5, 10, 25, 100, 1000, 10000), function(n) list(count = n, interval = as.numeric(poisson.test(n)$conf.int)))
binomialIntervals <- lapply(list(c(0, 50), c(1, 1000), c(3, 100000), c(17, 40), c(250, 1000000), c(40, 40)), function(xn) list(x = xn[1], n = xn[2], interval = as.numeric(binom.test(xn[1], xn[2])$conf.int)))

out <- list(
  about = paste0("flowStats ", packageVersion("flowStats"), " (proBin, binByRef, calcPBChiSquare) and R ", getRversion(),
                 " ks.test(exact = FALSE) on the comparison tubes (validation/comparison-cases.mjs), each test compared with Control.fcs, and R's poisson.test and binom.test intervals; written by reference/generate_flowstats.R."),
  flowStats = as.character(packageVersion("flowStats")),
  R = as.character(getRversion()),
  probabilityBinning = cases,
  ks = ks,
  poissonIntervals = poissonIntervals,
  binomialIntervals = binomialIntervals
)
writeLines(toJSON(out, auto_unbox = TRUE, digits = NA, pretty = TRUE), file.path(here, "flowstats.json"))
cat("wrote validation/reference/flowstats.json:", length(cases), "probability binning cases\n")
