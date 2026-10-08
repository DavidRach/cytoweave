# The CytoWeave agent benchmark

Graded analysis tasks for AI agents that work through CytoWeave's MCP tools, scored against the
simulated truth of each experiment. The website's [Agent benchmark](https://robert-mcdermott.github.io/cytoweave/benchmark.html)
page shows the results and the method.

## Running it

Needs Node 22, Go (CytoWeave is built from this checkout), Chrome (or Chromium, Edge, Brave;
`CHROME=path`) and, for Claude models, [Claude Code](https://claude.com/claude-code) installed and
logged in.

```bash
node benchmark/run.mjs --agent claude-code --model sonnet --repeat 3
```

| Option | Meaning |
| --- | --- |
| `--agent` | `claude-code`, `expert` (the reference solutions, scripted through the same MCP tools, no model) or `none` (answers nothing) |
| `--model`, `--effort` | Passed to the agent (`claude --model`, `--effort`), and recorded |
| `--repeat` | Runs of each task (agents vary between runs) |
| `--tasks` | Only these task ids, comma-separated |
| `--max-turns`, `--timeout-min` | Limits of one run (default 60 turns, 20 minutes) |
| `--out` | The results file (default `benchmark/results/<date>-<agent>-<model>.json`) |
| `--transcripts` | A folder for each run's whole session (every message and tool call, JSON lines) |
| `--check` | With `expert`: fail unless every task scores at least 0.9; with `none`: unless every task scores 0 |

Runs go one at a time; each takes from seconds to a few minutes. With a Claude subscription, each
run uses the plan's usage like any other Claude Code session; the results record Claude Code's own
estimate of the API cost.

## How a run is isolated

- CytoWeave is started by the harness ("cytoweave mcp", an empty library), its window opened in a
  headless Chrome, and the task's example generated with the task's seed and prepared there. The
  example's title, the simulator's per-cell truth channel and annotations that name a planted fault
  are removed before the agent starts.
- The agent is a program of its own whose only MCP server is `mcp-relay.mjs`, relaying to the
  harness's CytoWeave. Claude Code runs in an empty folder with `--tools ""` (no files, shell or
  web), `--strict-mcp-config`, `--setting-sources project` (not the user's hooks, plugins or
  defaults), `--disable-slash-commands` and `--no-session-persistence`.
- Every prompt starts with the same sentence (`OPEN_DATA`): the data are already open in CytoWeave,
  in the workspace "Experiment". A run that opens other data anyway (an example, files) is
  recorded as `replacedWorkspace` and scores what its answer about the task's data is worth.
- Grading reads the window's state, the task's output folder and the reply's `ANSWER:` line.
  It is code (`tasks.mjs`), not a model.

## Files

| File | |
| --- | --- |
| `tasks.mjs` | The tasks: example and seed, prompt, truth, grader, reference solution |
| `tasks.test.mjs` | The graders' partial credit on wrong answers, and answer parsing (`node --test benchmark/tasks.test.mjs`) |
| `harness.mjs` | CytoWeave and its window, the relay, the agents' adapters and the scripted MCP client |
| `mcp-relay.mjs` | The agent's MCP server: relays to the harness's CytoWeave |
| `run.mjs` | Runs tasks and writes results |
| `report.mjs` | The results as the website shows them |
| `results/` | Results files, one per agent, model and date |

## Adding an agent

An adapter in `harness.mjs` (`AGENTS`) turns a run's settings into a command (the prompt, the model,
the MCP configuration file, which points at the relay) and parses the program's output into the
reply, tool calls, tokens and cost. Any agent that speaks MCP over stdio can be added this way.

## Submitting results

Open a pull request with the results file. It records the benchmark's version, the agent's program
and model, the CytoWeave version and commit, and every run's score with its rubric, tool calls,
tokens, time and reply. Results from a modified benchmark or CytoWeave (`dirty` in the file) are not
published.

## Adding a task

A task needs an example and a seed of its own, a prompt worded as a user would ask (without naming
tools) that ends with the answer line, the truth from the simulator's record, a grader with partial
credit, and a reference solution through the MCP tools. `node benchmark/run.mjs --agent expert
--check` and `--agent none --check` must pass, and `tasks.test.mjs` should give the grader wrong
answers. Changing tasks changes the benchmark's version (`BENCHMARK_VERSION`).
