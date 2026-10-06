# Writes validation/reference/cytoml-diva.json: CytoML's counts (Bioconductor's FACSDiva reader,
# diva_to_gatingset) on the FACSDiva experiment PE_2 of the "diva" data set, tube _001
# (124500.fcs, the tube whose FCS file is published), which validation/run.mjs compares with
# CytoWeave's import and with Diva's own counts. R is needed only to regenerate the file, not to
# run the validation.
#
#   node validation/fetch.mjs diva
#   Rscript -e 'BiocManager::install("CytoML")'
#   Rscript validation/reference/generate_cytoml_diva.R

suppressPackageStartupMessages({
  library(CytoML)
  library(flowWorkspace)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = FALSE)
here <- dirname(normalizePath(sub("^--file=", "", args[grep("^--file=", args)])))
dir <- file.path(here, "..", "cache", "diva")

ws <- open_diva_xml(file.path(dir, "PE_2.xml"))
# Specimen 2 (PE), its first tube (_001, 124500.fcs). CytoML swaps the -H and -W parameters by
# default (needed for some instruments' exports); for this file that moves P1 to the wrong axes
# (10886 events instead of Diva's 17902), so the parameters are kept as named.
gs <- suppressMessages(diva_to_gatingset(ws, name = 2, subset = 1, swap_cols = FALSE, path = dir))
stats <- gh_pop_compare_stats(gs[[1]], path = "full")
populations <- lapply(seq_len(nrow(stats)), function(i) list(
  path = sub("^/", "", stats$node[i]),
  diva = stats$xml.count[i],
  cytoml = stats$openCyto.count[i]
))
out <- list(
  about = "CytoML's counts on the FACSDiva experiment PE_2 (flowWorkspaceData), tube _001 (124500.fcs), with Diva's own counts from the XML. Written by validation/reference/generate_cytoml_diva.R.",
  versions = list(CytoML = as.character(packageVersion("CytoML")), flowWorkspace = as.character(packageVersion("flowWorkspace"))),
  tube = "_001",
  file = "124500.fcs",
  populations = populations
)
write_json(out, file.path(here, "cytoml-diva.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
cat("wrote cytoml-diva.json:", length(populations), "populations\n")
