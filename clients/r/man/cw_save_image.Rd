\name{cw_save_image}
\alias{cw_save_image}
\title{Save a plot as a PNG file}
\usage{
cw_save_image(result, file)
}
\arguments{
\item{result}{The result of \code{\link{cw_render_plot}}.}
\item{file}{The path of the PNG file to write.}
}
\value{
\code{file}, invisibly.
}
\description{
Writes the image a \code{render_plot} result carries to a PNG file. \code{cw_render_plot(file = )}
does the same.
}
