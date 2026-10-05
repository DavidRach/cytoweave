# cytoweave (R)

Remote control of a running [CytoWeave](https://github.com/robert-mcdermott/cytoweave), the flow,
spectral and mass cytometry analysis workbench, from R: every action an AI agent can take in
CytoWeave is an R function, performed by the open CytoWeave window.

```r
remotes::install_github("robert-mcdermott/cytoweave", subdir = "clients/r")
```

Start CytoWeave with `cytoweave --remote-control`, then:

```r
library(cytoweave)
cw_connect()                       # finds the running CytoWeave
cw_open_example("pbmc-immunophenotyping")
frequencies <- as.data.frame(cw_statistics_table(statistic = "freqParent"))
states <- cw_differential_analysis("condition", groups = c("Unstimulated", "Stimulated"),
                                   pair_by = "subject", populations = "T cells")
```

`?cw_differential_analysis` describes each action's arguments. See
[clients/README.md](https://github.com/robert-mcdermott/cytoweave/tree/main/clients) for how the
connection is found, results and errors.
