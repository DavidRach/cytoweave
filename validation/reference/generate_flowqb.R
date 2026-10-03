# Writes validation/reference/flowqb.json: flowQB's Q, B and CV0 fits (Parks et al. 2017) on its
# own example data (flowqbdata in validation/sources.json), which validation/run.mjs compares with
# CytoWeave's. R is needed only to regenerate the file, not to run the validation.
#
#   node validation/fetch.mjs flowqbdata
#   Rscript validation/reference/generate_flowqb.R
#
# flowQB was deprecated in Bioconductor 3.10; install its last release from source:
#   git clone https://git.bioconductor.org/packages/flowQB
#   (add "zzz.R" to the Collate field of flowQB/DESCRIPTION, which omits it)
#   Rscript -e 'install.packages("extremevalues")'; R CMD INSTALL --no-build-vignettes flowQB
#
# The analyses follow flowQB's vignette: fit_led on the LED series, fit_spherotech and
# fit_thermo_fisher on the bead files, with its ignore list, bounds and "Area" signal type.

suppressPackageStartupMessages({
  library(flowCore)
  library(flowQB)
  library(jsonlite)
})

# flowQB builds its peak tables with list columns, which order() rejects since R 4.0: unlist
# them before sorting (the one change; everything else is flowQB as released).
src <- deparse(flowQB:::get_peak_statistics, width.cutoff = 500L)
at <- grep("results[order(results$M), ]", src, fixed = TRUE)
stopifnot(length(at) == 1)
src[at] <- sub("results.list[[fluorescence]] <- results[order(results$M), ]",
  "results <- as.data.frame(lapply(results, unlist), row.names = row.names(results)); results.list[[fluorescence]] <- results[order(results$M), ]",
  src[at], fixed = TRUE)
patched <- eval(parse(text = src))
environment(patched) <- asNamespace("flowQB")
assignInNamespace("get_peak_statistics", patched, "flowQB")

args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", args[grep("^--file=", args)])))
cache <- file.path(here, "..", "cache", "flowqbdata")

ignore <- c("Time", "FSC-A", "FSC-W", "FSC-H", "SSC-A", "SSC-W", "SSC-H")
bounds <- list(minimum = -100, maximum = 100000)

# One channel's peaks and fits.
channel_result <- function(peaks, fits, iterated, fluorescence, names) {
  p <- peaks[[fluorescence]]
  coef <- function(f, rows) unname(sapply(rows, function(r) f[[fluorescence]][[which(rownames(f) == r)]]))
  out <- list(
    peaks = lapply(seq_len(nrow(p)), function(i) list(
      peak = names[[i]], n = p$N[[i]], mean = p$M[[i]], sd = p$SD[[i]], omit = isTRUE(p$Omit[[i]]))),
    quadratic = list(c = coef(fits, c("c0", "c1", "c2")), se = coef(fits, c("c0 SE", "c1 SE", "c2 SE"))),
    iterated = list(c = coef(iterated, c("c0", "c1", "c2")), se = coef(iterated, c("c0 SE", "c1 SE", "c2 SE")))
  )
  if ("c0'" %in% rownames(iterated)) {
    out$linear <- list(c = coef(fits, c("c0'", "c1'")), se = coef(fits, c("c0' SE", "c1' SE")))
    out$iteratedLinear <- list(c = coef(iterated, c("c0'", "c1'")), se = coef(iterated, c("c0' SE", "c1' SE")))
  }
  out
}

# LED pulser: one peak per file.
led_files <- sort(list.files(file.path(cache, "LED_Series"), "\\.fcs$", full.names = TRUE))
led_channels <- setdiff(colnames(read.FCS(led_files[[1]])), ignore)
# (dyes and detectors only label flowQB's per-dye tables; each channel is its own here)
led <- fit_led(led_files, ignore, led_channels, led_channels, "Area", "LSRII", bounds = bounds,
  minimum_useful_peaks = 3, max_iterations = 10)
led_out <- list(
  files = basename(led_files),
  channels = setNames(lapply(led_channels, function(fl) channel_result(
    led$peak_stats, led$fits, led$iterated_fits, fl, rownames(led$peak_stats[[fl]]))), led_channels)
)

# Multi-level beads: k-means on the logicle-scaled fluorescence channels after a scatter gate.
beads <- function(file, peaks) {
  set.seed(1)
  path <- file.path(cache, "Other_Tests", file)
  channels <- setdiff(colnames(read.FCS(path)), ignore)
  r <- fit_beads(path, c("FSC-A", "SSC-A"), ignore, peaks, channels, channels, bounds, "Area", "LSRII",
    minimum_useful_peaks = 3, max_iterations = 10, logicle_width = 1.0)
  list(file = file, peaks = peaks,
    channels = setNames(lapply(channels, function(fl) channel_result(
      r$peak_stats, r$fits, r$iterated_fits, fl, rownames(r$peak_stats[[fl]]))), channels))
}

result <- list(
  generated = format(Sys.time(), "%Y-%m-%d"),
  versions = list(R = R.version.string, flowQB = as.character(packageVersion("flowQB")),
    flowCore = as.character(packageVersion("flowCore")),
    extremevalues = as.character(packageVersion("extremevalues"))),
  settings = list(ignore = ignore, bounds = bounds, signalType = "Area", maxIterations = 10, logicleWidth = 1),
  led = led_out,
  beads = list(beads("933745.fcs", 8), beads("933747.fcs", 6))
)

write_json(result, file.path(here, "flowqb.json"), auto_unbox = TRUE, digits = NA, pretty = FALSE)
cat("Wrote", file.path(here, "flowqb.json"), "\n")
