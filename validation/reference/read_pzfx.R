# Writes validation/reference/pzfx.json: CytoWeave's Prism project (validation/cache/reports/
# activation.pzfx, written by reference/write_reports.mjs) read back by the R package pzfx, which
# validation/run.mjs (suite reports) checks against CytoWeave's values. R is needed only to
# regenerate the file, not to run the validation.
#
#   node validation/reference/write_reports.mjs
#   Rscript validation/reference/read_pzfx.R

suppressPackageStartupMessages({
  library(pzfx)
  library(jsonlite)
  library(digest)
})

args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", args[grep("^--file=", args)])))
folder <- file.path(here, "..", "cache", "reports")
manifest <- fromJSON(file.path(folder, "manifest.json"))
file <- file.path(folder, "activation.pzfx")
stopifnot(digest(file = file, algo = "sha256") == manifest[["activation.pzfx"]]$sha256)

tables <- pzfx_tables(file)
out <- list(
  about = paste0("CytoWeave's Prism project read back by pzfx ", packageVersion("pzfx"), " (R ", getRversion(), "); written by reference/read_pzfx.R."),
  pzfx = as.character(packageVersion("pzfx")),
  fingerprint = manifest[["activation.pzfx"]]$fingerprint,
  tables = lapply(seq_along(tables), function(i) {
    df <- read_pzfx(file, i)
    list(title = tables[[i]], columns = names(df), values = lapply(df, function(col) if (is.numeric(col)) col else as.character(col)))
  })
)
writeLines(toJSON(out, auto_unbox = TRUE, digits = I(17), pretty = TRUE, na = "null"), file.path(here, "pzfx.json"))
cat("wrote validation/reference/pzfx.json:", length(tables), "tables\n")
