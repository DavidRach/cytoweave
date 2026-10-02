# Writes validation/reference/flowkit.json: FlowKit's results on the files of the "flowkit" data
# set (validation/sources.json), which validation/run.mjs compares with CytoWeave's. Python is
# needed only to regenerate the file, not to run the validation.
#
#   node validation/fetch.mjs flowkit fcsparser
#   uv run --python 3.12 --with flowkit==1.3.2 python validation/reference/generate_flowkit.py

import json
import math
import os
import warnings

import flowio
import flowkit as fk
import flowutils
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'cache', 'flowkit')
warnings.simplefilter('ignore')


def summary(events, labels):
    """Per-channel summaries: sum, minimum, maximum and a few events by index."""
    n = events.shape[0]
    picks = sorted({0, 1, 2, n // 3, n // 2, n - 1})
    return {
        'events': int(n),
        'picks': picks,
        'channels': [
            {
                'name': label,
                'sum': float(np.sum(events[:, i], dtype=np.float64)),
                'min': float(np.min(events[:, i])),
                'max': float(np.max(events[:, i])),
                'values': [float(events[k, i]) for k in picks],
            }
            for i, label in enumerate(labels)
        ],
    }


def sample(path, **options):
    return fk.Sample(os.path.join(DATA, path), ignore_offset_error=True, **options)


# FCS decoding: FlowKit's "raw" events (data values with $PnE log amplification undone and $PnG
# gain applied as FlowKit does).
FCS = [
    '8_color_data_set/fcs_files/101_DEN084Y5_15_E01_008_clean.fcs',
    '100715.fcs',
    '109567.fcs',
    '113548.fcs',
    'test_comp_example.fcs',
    'test_data_2d_01.fcs',
    'index_sorted/index_sorted_example.fcs',
    'simple_diamond_example/test_data_diamond_01.fcs',
    'simple_line_example/data_set_simple_line_100.fcs',
]
fcs = {}
for path in FCS:
    s = sample(path)
    fcs[path] = summary(s.get_events(source='raw'), s.pnn_labels)

# Multiple data sets in one file (FlowIO reads them all).
datasets = flowio.read_multiple_data_sets(os.path.join(DATA, 'multi_dataset_fcs/coulter.lmd'), ignore_offset_error=True)
fcs['multi_dataset_fcs/coulter.lmd'] = [
    summary(d.as_array(preprocess=True), d.pnn_labels)
    for d in datasets
]

# The fcsparser corpus (validation/sources.json "fcsparser"): FlowIO's events for every data set,
# or the error FlowIO raises.
CORPUS = os.path.join(HERE, '..', 'cache', 'fcsparser')
corpus = {}
for root, _, names in sorted(os.walk(CORPUS)):
    for name in sorted(names):
        if not name.lower().endswith(('.fcs', '.lmd')):
            continue
        full = os.path.join(root, name)
        rel = os.path.relpath(full, CORPUS)
        try:
            sets = flowio.read_multiple_data_sets(full, ignore_offset_error=True)
            corpus[rel] = [summary(d.as_array(preprocess=True), d.pnn_labels) for d in sets]
        except Exception as error:
            corpus[rel] = {'error': f'{type(error).__name__}: {error}'}

# Compensation with the file's own spillover matrix.
s = sample('test_comp_example.fcs')
s.apply_compensation(s.metadata['spill'])
compensation = {'file': 'test_comp_example.fcs', **summary(s.get_events(source='comp'), s.pnn_labels)}

# Spectral unmixing (ordinary least squares) of FlowKit's spectral test events. The detector
# lists are those of FlowKit's tests (tests/test_config.py): the matrix rows are the first 33
# detectors, its columns all 48, and the events' columns follow the sample's labels.
SPECTRAL_DETECTORS = [
    'B510-A', 'B537-A', 'B602-A', 'B660-A', 'B675-A', 'B710-A', 'B750-A', 'B810-A',
    'R675-A', 'R710-A', 'R780-A', 'UV379-A', 'UV446-A', 'UV515-A', 'UV585-A', 'UV610-A',
    'UV660-A', 'UV736-A', 'UV809-A', 'V427-A', 'V450-A', 'V510-A', 'V540-A', 'V576-A', 'V595-A',
    'V660-A', 'V710-A', 'V750-A', 'V785-A', 'YG585-A', 'YG602-A', 'YG730-A', 'YG780-A', 'B576-A',
    'R660-A', 'R680-A', 'R730-A', 'UV540-A', 'UV695-A', 'V470-A', 'V615-A', 'V680-A',
    'V845-A', 'YG660-A', 'YG670-A', 'YG695-A', 'YG750-A', 'YG825-A',
]
SPECTRAL_LABELS = [
    'Time', 'FSC-A', 'FSC-W', 'FSC-H', 'SSC-A', 'SSC-W', 'SSC-H',
    'UV379-A', 'UV446-A', 'UV515-A', 'UV540-A', 'UV585-A', 'UV610-A', 'UV660-A', 'UV695-A',
    'UV736-A', 'UV809-A', 'V427-A', 'V450-A', 'V470-A', 'V510-A', 'V540-A', 'V576-A',
    'V595-A', 'V615-A', 'V660-A', 'V680-A', 'V710-A', 'V750-A', 'V785-A', 'V845-A',
    'B510-A', 'B537-A', 'B576-A', 'B602-A', 'B660-A', 'B675-A', 'B710-A', 'B750-A',
    'B810-A', 'YG585-A', 'YG602-A', 'YG660-A', 'YG670-A', 'YG695-A', 'YG730-A', 'YG750-A',
    'YG780-A', 'YG825-A', 'R660-A', 'R675-A', 'R680-A', 'R710-A', 'R730-A', 'R780-A',
]
spectral_matrix = np.load(os.path.join(DATA, 'spectral_data/spectral_comp_matrix.npy'))
spectral_columns = [SPECTRAL_LABELS.index(d) for d in SPECTRAL_DETECTORS]
spectral_events = np.load(os.path.join(DATA, 'spectral_data/spectral_raw_events.npy'))
spectral_truth = np.load(os.path.join(DATA, 'spectral_data/truth/spectral_comp_events.npy'))
unmixed = flowutils.compensate.compensate_spectral_ols(spectral_events, spectral_matrix, spectral_columns)
spectral = {
    'labels': SPECTRAL_LABELS,
    'detectors': SPECTRAL_DETECTORS,
    'detectorColumns': spectral_columns,
    'unmixed': spectral_matrix.shape[0],
    # FlowKit's stored result (spectral_data/truth) and a fresh FlowUtils run agree to:
    'truthAgreement': float(np.abs(unmixed - spectral_truth).max()),
}

# Transforms on a grid of data values (forward) and of scale values (inverse).
values = [-50000, -5000, -1000, -100, -10, -1, 0, 1, 10, 100, 1000, 5000, 10000, 50000, 100000, 262144]
scales = [-0.1, 0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0]
column = np.array(values, dtype=np.float64).reshape(-1, 1)
scale_column = np.array(scales, dtype=np.float64).reshape(-1, 1)
transforms = []


def record(name, spec, xform, channels=1.0):
    # channels: FlowKit's scale units per unit of CytoWeave's 0–1 scale (4096 for FlowJo biex).
    entry = {'name': name, 'cytoweave': spec, 'values': values, 'forward': [float(v) / channels for v in xform.apply(column).ravel()]}
    entry['scales'] = scales
    entry['inverse'] = [float(v) for v in xform.inverse(scale_column * channels).ravel()]
    transforms.append(entry)


for T, W, M, A in [(262144, 0.5, 4.5, 0), (262144, 1, 4.5, 0.5), (10000, 0.3, 4, 0)]:
    record(f'logicle T={T} W={W} M={M} A={A}', {'type': 'logicle', 'T': T, 'W': W, 'M': M, 'A': A}, fk.transforms.LogicleTransform(T, W, M, A))
    record(f'hyperlog T={T} W={W} M={M} A={A}', {'type': 'hyperlog', 'T': T, 'W': W, 'M': M, 'A': A}, fk.transforms.HyperlogTransform(T, W, M, A))
for T, M, A in [(262144, 4.5, 0), (262144, 5, 1)]:
    record(f'asinh T={T} M={M} A={A}', {'type': 'fasinh', 'T': T, 'M': M, 'A': A}, fk.transforms.AsinhTransform(T, M, A))
for width, neg, pos in [(-10, 0, 4.418540), (-100, 0.5, 4.418540), (-1000, 1, 4.418540)]:
    xform = fk.transforms.WSPBiexTransform(negative=neg, width=width, positive=pos, max_value=262144.000029)
    record(f'FlowJo biex width={width} neg={neg}', {'type': 'biex', 'maxValue': 262144.000029, 'widthBasis': width, 'positiveDecades': pos, 'extraNegativeDecades': neg}, xform, channels=4096.0)

# FlowJo workspaces: FlowKit's count for every population of every sample.
WORKSPACES = [
    ('8_color_data_set/8_color_ICS.wsp', '8_color_data_set/fcs_files'),
    ('8_color_data_set/8_color_ICS_simple.wsp', '8_color_data_set/fcs_files'),
    ('8_color_data_set/8_color_ICS_with_ellipse.wsp', '8_color_data_set/fcs_files'),
    ('8_color_data_set/8_color_ICS_boolean_gate_testing.wsp', '8_color_data_set/fcs_files'),
    ('8_color_data_set/8_color_ICS_dot_gate_name.wsp', '8_color_data_set/fcs_files'),
    ('8_color_data_set/reused_quad_gate_with_child.wsp', '8_color_data_set/fcs_files'),
    ('simple_diamond_example/simple_diamond_example_quad_gate.wsp', 'simple_diamond_example'),
    ('simple_diamond_example/test_data_diamond_biex_rect.wsp', 'simple_diamond_example'),
    ('simple_diamond_example/test_data_diamond_asinh_rect.wsp', 'simple_diamond_example'),
    ('simple_diamond_example/test_data_diamond_asinh_rect2.wsp', 'simple_diamond_example'),
    ('simple_line_example/simple_poly_and_rect.wsp', 'simple_line_example'),
    ('simple_line_example/simple_poly_and_rect_v2_poly50.wsp', 'simple_line_example'),
    ('simple_line_example/single_ellipse_51_events.wsp', 'simple_line_example'),
]
workspaces = {}
for wsp_path, fcs_dir in WORKSPACES:
    try:
        wsp = fk.Workspace(os.path.join(DATA, wsp_path), fcs_samples=os.path.join(DATA, fcs_dir))
        wsp.analyze_samples(group_name='All Samples', use_mp=False)
        report = wsp.get_analysis_report()
        workspaces[wsp_path] = {
            'populations': [
                {'sample': row.sample_id, 'path': [p for p in row.gate_path if p != 'root'] + [row.gate_name], 'count': int(row['count'])}
                for _, row in report.iterrows()
            ],
        }
    except Exception as error:  # FlowKit does not read every workspace; record why.
        workspaces[wsp_path] = {'error': f'{type(error).__name__}: {error}'}

out = {
    'about': 'FlowKit results on the "flowkit" data set; written by validation/reference/generate_flowkit.py.',
    'versions': {'flowkit': fk.__version__, 'flowio': flowio.__version__, 'flowutils': flowutils.__version__, 'numpy': np.__version__},
    'fcs': fcs,
    'corpus': corpus,
    'compensation': compensation,
    'spectral': spectral,
    'transforms': transforms,
    'workspaces': workspaces,
}


def clean(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


with open(os.path.join(HERE, 'flowkit.json'), 'w') as f:
    json.dump(clean(out), f, indent=1)
    f.write('\n')
print('wrote', os.path.join(HERE, 'flowkit.json'))
