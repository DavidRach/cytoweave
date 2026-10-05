# cytoweave (Python)

Remote control of a running [CytoWeave](https://github.com/robert-mcdermott/cytoweave), the flow,
spectral and mass cytometry analysis workbench, from Python: every action an AI agent can take in
CytoWeave is a method, performed by the open CytoWeave window.

```bash
pip install "git+https://github.com/robert-mcdermott/cytoweave#subdirectory=clients/python"
cytoweave --remote-control        # CytoWeave itself, in another terminal
```

```python
import cytoweave

cw = cytoweave.connect()          # finds the running CytoWeave
cw.open_example(id="pbmc-immunophenotyping")
print(cw.list_populations().message)
table = cw.statistics_table(statistic="freqParent").frame()   # needs pandas
states = cw.differential_analysis("condition", groups=["Unstimulated", "Stimulated"],
                                  pair_by="subject", populations=["T cells"])
```

`help(cw.differential_analysis)` describes each action's arguments. See
[clients/README.md](https://github.com/robert-mcdermott/cytoweave/tree/main/clients) for how the
connection is found, results and errors.
