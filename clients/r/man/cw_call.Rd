\name{cw_call}
\alias{cw_call}
\title{Perform any CytoWeave action by its name}
\usage{
cw_call(action, ..., .args = list(), cw = cw_default())
}
\arguments{
\item{action}{The action's name, as \code{\link{cw_tools}} lists it (for example \code{"list_populations"}).}
\item{...}{The action's arguments, named as CytoWeave names them (camelCase, such as \code{groupBy}); \code{NULL} arguments are left out.}
\item{.args}{More arguments, as a named list.}
\item{cw}{A connection from \code{\link{cw_connect}} (default: the last one made).}
}
\value{
A \code{cytoweave_result}: the \code{action}, CytoWeave's \code{message} (a sentence) and its
\code{data} (lists of records become data frames). An action CytoWeave refuses or cannot perform is
an error of class \code{cytoweave_error}, with the HTTP \code{status} and the \code{action}.
}
\description{
Every \code{cw_*} action function calls \code{cw_call}; it is the way to reach an action this
version of the package does not know yet.
}
\seealso{\code{\link{cytoweave_result}}}
