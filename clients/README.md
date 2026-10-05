# R and Python clients

CytoWeave started with `cytoweave --remote-control` accepts actions from programs on this
computer: every tool an AI agent has (open data, gate, tabulate, compare groups, test differential
abundance and state, export files) is an action that the open CytoWeave window performs, so you
watch the script work. Changes are proposals you accept or reject in the window.

These packages make each action a function, with its arguments and help:

| | R | Python |
| --- | --- | --- |
| Package | [`r/`](r/) (`cytoweave`, needs curl and jsonlite) | [`python/`](python/) (`cytoweave`, the standard library only; pandas for data frames) |
| Install | `remotes::install_github("robert-mcdermott/cytoweave", subdir = "clients/r")` | `pip install "git+https://github.com/robert-mcdermott/cytoweave#subdirectory=clients/python"` |
| Connect | `cw_connect()` | `cw = cytoweave.connect()` |
| An action | `cw_statistics_table(statistic = "freqParent")` | `cw.statistics_table(statistic="freqParent")` |
| A table | `as.data.frame(result)` | `result.frame()` (or `result.records()`) |
| Any action by name | `cw_call("list_populations")` | `cw.call("list_populations")` |
| The actions | `cw_tools()` | `cw.tools()` |

They are not on CRAN or PyPI. Their version is CytoWeave's; use the clients of the CytoWeave
release you run.

```r
library(cytoweave)
cw_connect()
cw_open_example("pbmc-immunophenotyping")
frequencies <- as.data.frame(cw_statistics_table(statistic = "freqParent"))
states <- cw_differential_analysis("condition", groups = c("Unstimulated", "Stimulated"),
                                   pair_by = "subject", populations = c("T cells", "Monocytes"))
as.data.frame(states)
```

```python
import cytoweave

cw = cytoweave.connect()
cw.open_example(id="pbmc-immunophenotyping")
frequencies = cw.statistics_table(statistic="freqParent").frame()
cw.render_plot("CD3", population="T cells", file="t-cells.png")
cw.export_table("/tmp/frequencies.xlsx", statistic="freqParent")
```

## Connecting

With `--remote-control`, CytoWeave writes `remote.json` to its data folder: its address and the
token that opening and writing files need, readable by you only, removed when CytoWeave stops.
`cw_connect()` and `cytoweave.connect()` read it. Otherwise they use, in order: the `url` and
`token` you give; `CYTOWEAVE_URL` and `CYTOWEAVE_TOKEN`; `remote.json` in `CYTOWEAVE_DATA_DIR` (for
CytoWeave started with `--data-dir`) or the default data folder; `http://127.0.0.1:8770` without a
token.

## Arguments and results

Arguments are those of the agent tools ([docs/MCP.md](../docs/MCP.md)) in snake case: `groupBy`
is `group_by`. The required ones come first and can be given by position. Every result has the
action's `message` (a sentence) and `data`. An action CytoWeave refuses is an error carrying its
reason, the HTTP status and the action (`cytoweave_error` in R, `CytoWeaveError` in Python).

## For developers

The functions are generated from [`tools.json`](tools.json), the program's tool definitions, which
a Go test keeps equal to `mcp.go`. After changing a tool:

```bash
go test -run TestTheClientsToolListIsCurrent -update
node clients/generate.mjs
```

`generate.mjs` also sets both packages' versions to `main.go`'s; `--check` fails when anything is
out of date (CI runs it). The tests compare each client's results with the HTTP API's for the
same actions, against CytoWeave in headless Chrome:

```bash
node clients/test-clients.mjs            # both; --python or --r for one
```

They need Go, Chrome (`CHROME=path`), Python 3 and R with curl, jsonlite and testthat. The R
package also passes `R CMD check`.
