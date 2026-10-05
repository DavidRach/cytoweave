\name{cw_connect}
\alias{cw_connect}
\alias{cw_default}
\title{Connect to a running CytoWeave}
\usage{
cw_connect(url = NULL, token = NULL, client = "R", timeout = 3600, data_dir = NULL)

cw_default()
}
\arguments{
\item{url}{CytoWeave's address, such as \code{"http://127.0.0.1:8770"}.}
\item{token}{The token CytoWeave printed when it started; opening files by path and writing files need it.}
\item{client}{The name CytoWeave shows with your proposals.}
\item{timeout}{Seconds to wait for an action (analyses of many samples take a while).}
\item{data_dir}{CytoWeave's data folder, when it was started with \code{--data-dir}.}
}
\value{
A \code{cytoweave} connection, which also becomes the default that every function uses.
}
\description{
CytoWeave started with \code{cytoweave --remote-control} accepts actions from programs on this
computer. Every tool an AI agent has in CytoWeave is an R function (\code{cw_open_example},
\code{cw_statistics_table}, \code{cw_differential_analysis}, \dots) that the open CytoWeave window
performs, so the analysis stays visible; changes are proposals the user accepts or rejects there.

Without \code{url} and \code{token}, the connection is found in the environment
(\code{CYTOWEAVE_URL} and \code{CYTOWEAVE_TOKEN}), else in the \code{remote.json} file CytoWeave
writes to its data folder (\code{data_dir}, \code{CYTOWEAVE_DATA_DIR} or the default folder), else
at CytoWeave's default address without a token. \code{cw_default()} returns the last connection made,
connecting first if there is none.
}
\examples{
\dontrun{
cw_connect()
cw_open_example("pbmc-immunophenotyping")
frequencies <- as.data.frame(cw_statistics_table(statistic = "freqParent"))
}
}
