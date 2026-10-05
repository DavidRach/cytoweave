\name{cw_tools}
\alias{cw_tools}
\title{The actions a running CytoWeave performs}
\usage{
cw_tools(cw = cw_default())
}
\arguments{
\item{cw}{A connection from \code{\link{cw_connect}} (default: the last one made).}
}
\value{
A data frame of the actions' names, titles and descriptions.
}
\description{
The actions of the running CytoWeave (its agent tools), each also an R function named
\code{cw_<name>}.
}
