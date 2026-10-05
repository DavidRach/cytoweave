# Writes validation/reference/flowcal.json: FlowCal's MEF calibration of its own example data
# (data set "flowcal-mef", validation/sources.json), which validation/run.mjs (suite calibration)
# compares with CytoWeave's. Python is needed only to regenerate the file, not to run the
# validation.
#
#   node validation/fetch.mjs flowcal-mef
#   uv run --python 3.12 --with flowcal==1.3.1 python validation/reference/generate_flowcal.py
#
# The steps follow FlowCal's examples/analyze_mef.py: each bead sample is gated (the first 250
# and last 100 events dropped, saturated scatter removed, the densest 85% on FSC/SSC kept with
# sigma 5), and FlowCal.mef.get_transform_fxn finds the 8 peaks on FL1 and FL3, takes each peak's
# median FL1, leaves out peaks near the ends of the range and fits the bead model
# m·log(RFI) + b = log(MEF_auto + MEF). Each cell sample is gated likewise (density 85%, default
# sigma) and its median FL1 kept in RFI and MEF. GMM labels are drawn from the responsibilities,
# so the random seed is fixed.

import json
import os

import numpy as np
import FlowCal

here = os.path.dirname(os.path.abspath(__file__))
folder = os.path.join(here, '..', 'cache', 'flowcal-mef')

BEADS = {
    'sample001.fcs': [0, 792, 2079, 6588, 16471, 47497, 137049, 271647],
    'min/sample001.fcs': [0, 771, 2106, 6262, 15183, 45292, 136258, 291042],
    'max/sample002.fcs': [0, 792, 2079, 6588, 16471, 47497, 137049, 271647],
}
CELLS = {
    'sample001.fcs': ['sample006.fcs', 'sample007.fcs', 'sample008.fcs', 'sample009.fcs', 'sample010.fcs', 'sample011.fcs', 'sample012.fcs', 'sample013.fcs', 'sample014.fcs', 'sample015.fcs'],
    'min/sample001.fcs': ['min/sample004.fcs'],
    'max/sample002.fcs': ['max/sample008.fcs'],
}
GRID = [1, 10, 30, 100, 300, 1000, 3000, 9000]


def gate_beads(path):
    s = FlowCal.transform.to_rfi(FlowCal.io.FCSData(path))
    s = FlowCal.gate.start_end(s, num_start=250, num_end=100)
    s = FlowCal.gate.high_low(s, channels=['FSC', 'SSC'])
    return FlowCal.gate.density2d(data=s, channels=['FSC', 'SSC'], gate_fraction=0.85, sigma=5.)


def gate_cells(path):
    s = FlowCal.transform.to_rfi(FlowCal.io.FCSData(path))
    ungated = s
    s = FlowCal.gate.start_end(s, num_start=250, num_end=100)
    s = FlowCal.gate.high_low(s, channels=['FSC', 'SSC', 'FL1'])
    return ungated, FlowCal.gate.density2d(data=s, channels=['FSC', 'SSC'], gate_fraction=0.85)


out = {'about': None, 'flowcal': FlowCal.__version__, 'beads': []}
for name, mef in BEADS.items():
    np.random.seed(0)
    gated = gate_beads(os.path.join(folder, name))
    result = FlowCal.mef.get_transform_fxn(gated, mef_channels='FL1', mef_values=np.array(mef), clustering_channels=['FL1', 'FL3'], full_output=True)
    m, b, auto = (float(v) for v in result.fitting['beads_params'][0])
    std_crv = result.fitting['std_crv'][0]
    cells = []
    for cell in CELLS[name]:
        ungated, cell_gated = gate_cells(os.path.join(folder, cell))
        rfi = float(np.median(cell_gated[:, 'FL1']))
        cells.append({
            'file': cell,
            'events': int(cell_gated.shape[0]),
            'medianRFI': rfi,
            'medianMEF': float(np.median(std_crv(np.asarray(cell_gated[:, 'FL1'], dtype=float)))),
            'ungatedMedianRFI': float(np.median(ungated[:, 'FL1'])),
        })
    out['beads'].append({
        'file': name,
        'mef': mef,
        'events': int(gated.shape[0]),
        'peakMedians': [float(v) for v in result.statistic['values'][0]],
        'selectedRFI': [float(v) for v in result.selection['rfi'][0]],
        'selectedMEF': [float(v) for v in result.selection['mef'][0]],
        'params': {'m': m, 'b': b, 'autofluorescence': auto},
        'curve': [{'rfi': x, 'mef': float(std_crv(np.array([float(x)]))[0])} for x in GRID],
        'cells': cells,
    })
out['about'] = (f"FlowCal {FlowCal.__version__} on its example data (validation/sources.json, flowcal-mef), following examples/analyze_mef.py: "
                "bead samples gated (start_end 250/100, high_low on FSC and SSC, density2d 85% with sigma 5) and calibrated on FL1 with clustering on FL1 and FL3; "
                "cell samples gated (start_end, high_low on FSC, SSC and FL1, density2d 85%) with their median FL1 in RFI and MEF; written by reference/generate_flowcal.py.")
with open(os.path.join(here, 'flowcal.json'), 'w') as f:
    json.dump(out, f, indent=1)
    f.write('\n')
print(f"wrote validation/reference/flowcal.json: {len(out['beads'])} bead samples")
