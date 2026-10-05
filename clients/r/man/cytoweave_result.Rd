\name{cytoweave_result}
\alias{cytoweave_result}
\alias{print.cytoweave_result}
\alias{as.data.frame.cytoweave_result}
\alias{print.cytoweave}
\title{CytoWeave's answer to an action}
\usage{
\method{print}{cytoweave_result}(x, ...)

\method{as.data.frame}{cytoweave_result}(x, row.names = NULL, optional = FALSE, key = NULL, ...)

\method{print}{cytoweave}(x, ...)
}
\arguments{
\item{x}{A \code{cytoweave_result}, or a \code{cytoweave} connection.}
\item{row.names, optional}{As for \code{\link{as.data.frame}}.}
\item{key}{The element of the result's data to convert (default: the first data frame in it).}
\item{...}{Passed on to \code{\link{as.data.frame}}.}
}
\value{
\code{print} returns \code{x} invisibly; \code{as.data.frame} a data frame.
}
\description{
Every action returns a \code{cytoweave_result}, a list of the \code{action}, CytoWeave's
\code{message} and its \code{data}. Printing shows the message; \code{as.data.frame} gives a table in
the data, such as the rows of \code{\link{cw_statistics_table}} or of
\code{\link{cw_differential_analysis}}.
}
