# Writes validation/reference/cytoml.json: CytoML's counts (Bioconductor's FlowJo workspace reader,
# via flowWorkspace) on CytoWeave's FlowJo exports of the validation cases, and on the original
# FlowKit test workspaces they came from, which validation/run.mjs compares with CytoWeave's. R is
# needed only to regenerate the file, not to run the validation.
#
#   node validation/fetch.mjs flowkit
#   node validation/reference/write_flowjo_exports.mjs
#   Rscript -e 'BiocManager::install("CytoML")'
#   Rscript validation/reference/generate_cytoml.R

suppressPackageStartupMessages({
  library(CytoML)
  library(flowWorkspace)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", args[grep("^--file=", args)])))
cache <- file.path(here, "..", "cache")

# Every population's count in every sample of a workspace, or the error CytoML reports.
counts_of <- function(wsp, fcs_dir) {
  tryCatch({
    ws <- open_flowjo_xml(wsp)
    gs <- suppressMessages(flowjo_to_gatingset(ws, name = "All Samples", path = fcs_dir))
    # Sample by sample: samples of one workspace can have different trees (group scopes).
    stats <- do.call(rbind, lapply(sampleNames(gs), function(s) gs_pop_get_count_fast(gs[s], statistic = "count", format = "long", path = "full")))
    list(populations = lapply(seq_len(nrow(stats)), function(i) list(
      sample = stats$name[i],
      path = sub("^/", "", stats$Population[i]),
      count = stats$Count[i]
    )))
  }, error = function(e) list(error = conditionMessage(e)))
}

exports <- list()
manifest <- file.path(cache, "exports", "manifest.json")
if (file.exists(manifest)) {
  for (case in fromJSON(manifest, simplifyVector = FALSE)) {
    dir <- file.path(cache, "exports", case$dir)
    exports[[case$name]] <- c(counts_of(file.path(dir, "export.wsp"), dir), list(source = case$source))
  }
}

# FlowKit's test workspaces keep no $FIL keyword, which CytoML matches files by: a copy gets each
# sample's file name from its DataSet (the gates are untouched).
with_fil <- function(wsp) {
  xml <- paste(readLines(wsp, warn = FALSE), collapse = "\n")
  samples <- regmatches(xml, gregexpr("(?s)<Sample>.*?</Sample>", xml, perl = TRUE))[[1]]
  for (s in samples) {
    if (grepl('name="\\$FIL"', s)) next
    file <- basename(sub('(?s).*<DataSet[^>]*uri="([^"]*)".*', "\\1", s, perl = TRUE))
    fixed <- sub("<Keywords>", sprintf('<Keywords><Keyword name="$FIL" value="%s"/>', file), s, fixed = TRUE)
    xml <- sub(s, fixed, xml, fixed = TRUE)
  }
  out <- tempfile(fileext = ".wsp")
  writeLines(xml, out)
  out
}

originals <- list()
for (case in exports) {
  if (is.null(case$source) || !is.null(originals[[case$source]])) next
  wsp <- file.path(cache, "flowkit", case$source)
  # The FCS files of the 8-color set sit in a folder beside the workspaces.
  fcs_dir <- if (grepl("^8_color_data_set/", case$source)) file.path(dirname(wsp), "fcs_files") else dirname(wsp)
  originals[[case$source]] <- counts_of(with_fil(wsp), fcs_dir)
}

out <- list(
  versions = list(
    R = paste(R.version$major, R.version$minor, sep = "."),
    CytoML = as.character(packageVersion("CytoML")),
    flowWorkspace = as.character(packageVersion("flowWorkspace"))
  ),
  exports = exports,
  originals = originals
)
write(toJSON(out, auto_unbox = TRUE, pretty = 1, digits = NA), file.path(here, "cytoml.json"))
cat("wrote", file.path(here, "cytoml.json"), "\n")
