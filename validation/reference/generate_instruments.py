# Writes validation/reference/instruments.json: what FlowIO and fcsparser, two independent FCS
# readers, decode from the instrument files of the "cytoflow-instruments", "flowio", "flowcal",
# "zenodo-instruments", "zenodo-nanofcm" and "rosettax" data sets (validation/sources.json), which
# the `instruments` suite of validation/run.mjs compares with CytoWeave. Python is needed only to
# regenerate the file, not to run the validation.
#
#   node validation/fetch.mjs cytoflow-instruments flowio flowcal zenodo-instruments zenodo-nanofcm rosettax
#   uv run --python 3.12 --with flowio==1.4.0 --with fcsparser==0.2.8 --with numpy python validation/reference/generate_instruments.py
#
# FlowIO: every data set's events as stored (as_array(preprocess=False)), and with $PnE and $PnG
# applied (preprocess=True). fcsparser: the first data set's events as stored (reformat_meta,
# data_set=0). For each, a few events by index and per-channel sums, or the error raised.

import json
import os
import warnings

import fcsparser
import flowio
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '..', 'cache')
DATASETS = ['cytoflow-instruments', 'flowio', 'flowcal', 'zenodo-instruments', 'zenodo-nanofcm', 'rosettax']
warnings.simplefilter('ignore')


def summary(events, labels):
    events = np.asarray(events, dtype=np.float64)
    n = events.shape[0]
    picks = sorted({0, 1, 2, n // 3, n // 2, n - 1}) if n else []
    return {
        'events': int(n),
        'picks': picks,
        'channels': [
            {
                'name': label,
                'sum': float(np.sum(events[:, i])) if n else 0.0,
                'values': [float(events[k, i]) for k in picks],
            }
            for i, label in enumerate(labels)
        ],
    }


with open(os.path.join(HERE, '..', 'sources.json')) as f:
    sources = json.load(f)['datasets']

files = {}
for dataset in DATASETS:
    for entry in sources[dataset]['files']:
        full = os.path.join(CACHE, dataset, entry['path'])
        key = f"{dataset}/{entry['path']}"
        result = {}
        try:
            sets = flowio.read_multiple_data_sets(full, ignore_offset_error=True, ignore_offset_discrepancy=True)
            result['flowio'] = [
                {'raw': summary(d.as_array(preprocess=False), d.pnn_labels), 'scaled': summary(d.as_array(preprocess=True), d.pnn_labels)}
                for d in sets
            ]
        except Exception as error:
            result['flowio'] = {'error': f'{type(error).__name__}: {error}'}
        try:
            meta, data = fcsparser.parse(full, reformat_meta=True, data_set=0)
            result['fcsparser'] = summary(data.to_numpy(), list(data.columns))
        except Exception as error:
            result['fcsparser'] = {'error': f'{type(error).__name__}: {error}'}
        files[key] = result

out = {
    'about': 'FlowIO and fcsparser on the instrument data sets; written by validation/reference/generate_instruments.py.',
    'versions': {'flowio': flowio.__version__, 'fcsparser': fcsparser.__version__, 'numpy': np.__version__},
    'files': files,
}
with open(os.path.join(HERE, 'instruments.json'), 'w') as f:
    json.dump(out, f, separators=(',', ':'))
    f.write('\n')
print(f'{len(files)} files')
