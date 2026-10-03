# Using CytoWeave with AI agents (MCP)

`cytoweave mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. An AI
agent such as Claude Code can use it to open FCS files and example experiments, inspect the
gating tree, add gates (drawn from coordinates or proposed from the data's density), compute
statistics across samples, render plots as images, review a gate across a cohort, compare groups
of samples and write a methods paragraph.

The agent works in the CytoWeave window you see. Its changes are proposals that you accept or
reject (see [Proposals](#proposals)), and you can undo anything.

- [Requirements](#requirements)
- [Proposals](#proposals)
- [Claude Code](#claude-code)
- [Claude Desktop and other clients](#claude-desktop-and-other-clients)
- [Tools](#tools)
- [Coordinates](#coordinates)
- [Scripts without an agent](#scripts-without-an-agent)
- [Privacy and security](#privacy-and-security)
- [How it works](#how-it-works)

## Proposals

An agent's changes wait for your review:
- **New gates** appear at once, marked *proposed*: dotted on the plots and in italics in the
  population tree. Their counts are real, so you can judge them, and the agent can gate on them.
- **Renaming or deleting** gates you have accepted, and **compensation matrices**
  (`propose_compensation`), are held. The tree shows a held rename next to the name (→ new
  name) and strikes through a population the agent proposes to delete.

A strip above the population tree says who proposes how many changes. Click **Review** for the
list with each new population's frequency, then **Accept all** or **Reject all**. Rejecting
removes the proposed gates, together with anything drawn under them since; CytoWeave asks first
in that case.

The change log records each decision: what was proposed, by which agent (the name its MCP
client gives, such as Claude Code), and that you accepted or rejected it. Accepted gates keep
this, and the inspector and the methods paragraph show it. The agent can ask for the outcome
with `proposals`.

## Requirements

- CytoWeave 0.1.0 or later (`cytoweave --version`); proposals and the `propose_compensation` and `proposals` tools need 0.2.0.
- Chrome, Edge, Brave or Chromium for the window (any modern browser works if you open the
  printed address yourself).
- The full path to the program. Agents often start programs without your shell's `PATH`; the
  installers put CytoWeave in `~/.local/bin/cytoweave` (macOS and Linux) or
  `%LOCALAPPDATA%\Programs\CytoWeave\cytoweave.exe` (Windows).

## Claude Code

```bash
claude mcp add cytoweave -- ~/.local/bin/cytoweave mcp
```

Then ask, for example:

> Open the PBMC example, gate cells, singlets and live cells, then CD3+ T cells and their CD4
> and CD8 subsets, and tell me how the CD4:CD8 ratio differs between stimulated and
> unstimulated samples.

## Claude Desktop and other clients

Add the server to the client's configuration (for Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cytoweave": {
      "command": "/Users/you/.local/bin/cytoweave",
      "args": ["mcp"]
    }
  }
}
```

Options go after `mcp`: `--port` (default 8770, the next free one is used), `--data-dir` (the
workspace library), `--window app|browser|none` (how the window opens when a tool needs it).

## Tools

| Tool | What it does |
| --- | --- |
| `workspace_summary` | Samples (events, role, metadata, channels and markers), groups, the gating tree of the current sample with counts, compensation, derived results, and what the window shows. |
| `open_files` | Opens FCS files, folders (each becomes a group), CytoWeave workspaces, FlowJo workspaces or Gating-ML, by absolute path. |
| `open_example` | Generates and opens a simulated example experiment. |
| `select` | Shows a sample, population and/or view in the window. |
| `list_populations` | Every population's path, gate, count, % of parent and % of total for a sample. |
| `population_statistics` | Count, frequencies and per-channel statistics (median, mean, geometric mean, SD, robust SD, CV, robust CV, percentiles) of a population. |
| `statistics_table` | A statistic of populations across samples (or a group). |
| `render_plot` | A PNG of a plot (pseudocolor, dot, density, contour, zebra or histogram) with its gates. |
| `create_gate` | Proposes a rectangle, polygon, ellipse, range, quadrant or split gate from data coordinates. |
| `auto_gate` | Proposes a gate found from the data: the density basin around a point ("magic wand"), singlets on area versus height, or the valley between two modes. |
| `edit_gate` | Renames, recolors or deletes a population (held for review unless the agent proposed it). |
| `propose_compensation` | Computes a spillover matrix from the workspace's single-stain controls and proposes it for the samples. |
| `proposals` | The agent's open proposal and your recent decisions. |
| `review_gate` | A gate's frequency on every sample with a robust z-score and its boundary robustness, outliers first. |
| `compare` | Tests a statistic between groups of samples defined by metadata, optionally paired. |
| `methods` | A methods paragraph with numbered references. |
| `export_gating_ml` | The gating strategy as Gating-ML 2.0. |

Populations are named by name (when unique), by path (`Cells/Single cells/CD3+`) or by id.
Channels are named by detector (`FITC-A`) or marker (`CD3`).

## Coordinates

Gate coordinates are data values, as on the plot axes: the scale (linear, logicle, arcsinh) is
the workspace's scale for each channel, and CytoWeave converts the coordinates into it. A
rectangle on FSC-A and SSC-A from 40,000 to 120,000 is
`{"xMin": 40000, "xMax": 120000, "yMin": 10000, "yMax": 80000}`; a range gate on CD3 above 1,000
is `{"min": 1000}`. Ellipse semi-axes are fractions of the axes (0.1 is a tenth of the axis).

## Scripts without an agent

`cytoweave --remote-control` accepts the same actions from programs on this computer:

```python
import requests
url = "http://127.0.0.1:8770/api/remote/action"
print(requests.post(url, json={"action": "list_populations"}).json())
print(requests.post(url, json={"action": "statistics_table", "args": {"statistic": "freqParent"}}).json())
```

A script's changes are proposals too, shown under the name it gives in `"client"` (for
example `{"action": "create_gate", "client": "Plate pipeline", "args": {…}}`).

`open_files` also needs the `X-CytoWeave-Token` header with the token CytoWeave prints when it
starts, because it makes the program read files.

## Privacy and security

- Everything runs on this computer: the server only accepts requests from this computer, and
  the data never leave it.
- Agents act through the same window you use; nothing happens out of sight. Their changes are
  proposals you accept or reject, and every change can be undone.
- Opening files by path is limited to the agent connected over stdio (MCP) or to scripts that
  hold the token printed at startup.

## How it works

`cytoweave mcp` starts CytoWeave with remote control on and speaks JSON-RPC on stdin and stdout.
A tool call becomes an action that the server forwards to the open window over Server-Sent
Events; the window performs it with the same code as the user interface and posts the result
back. Actions reach the window one at a time.
