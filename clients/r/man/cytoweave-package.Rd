\name{cytoweave-package}
\alias{cytoweave-package}
\alias{cytoweave}
\docType{package}
\title{Remote control of a running CytoWeave}
\description{
CytoWeave is a flow, spectral and mass cytometry analysis workbench that runs on this computer.
Started with \code{cytoweave --remote-control}, it performs actions sent by programs on the same
computer in its open window. This package makes each action an R function: \code{\link{cw_connect}}
finds the running CytoWeave, and \code{cw_open_files}, \code{cw_create_gate},
\code{cw_statistics_table}, \code{cw_compare}, \code{cw_differential_analysis},
\code{cw_export_events} and the others do what their names say. \code{\link{cw_tools}} lists them,
and \code{\link{cw_call}} sends any action by its name.
}
\seealso{\url{https://github.com/robert-mcdermott/cytoweave}}
