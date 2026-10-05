# Writes validation/reference/events.json: CytoWeave's events documents (validation/cache/events/,
# written by reference/write_events.mjs) read back by other readers: the AnnData files by anndata
# (each version this script runs with adds its own entry), h5py (libhdf5) and pyfive (a pure-Python
# HDF5 reader); the FCS files by fcsparser and FlowIO. For each array, a SHA-256 of its values as
# read (little-endian, row by row), which validation/run.mjs (suite events) compares with
# CytoWeave's own. Python is needed only to regenerate the file, not to run the validation.
#
#   node validation/reference/write_events.mjs
#   uv run --python 3.12 --with anndata==0.13.4 --with h5py==3.16.0 --with pyfive==1.2.1 python validation/reference/read_events.py --anndata --hdf5
#   uv run --python 3.12 --with anndata==0.10.9 --with "numpy<2" python validation/reference/read_events.py --anndata
#   uv run --python 3.12 --with fcsparser==0.2.8 --with flowio==1.4.0 python validation/reference/read_events.py --fcs
#
# (fcsparser needs numpy 1, anndata 0.13 numpy 2: each part runs on its own and adds to the file.)

import hashlib
import io
import json
import sys
import zipfile
from importlib.metadata import version
from pathlib import Path

import numpy as np

here = Path(__file__).resolve().parent
folder = here.parent / "cache" / "events"
manifest = json.loads((folder / "manifest.json").read_text())
target = here / "events.json"
out = json.loads(target.read_text()) if target.exists() else {"about": "", "files": {}}
out["about"] = "CytoWeave's events documents read back by anndata, h5py, pyfive, fcsparser and FlowIO; written by reference/read_events.py."
parts = {a.lstrip("-") for a in sys.argv[1:]} or {"anndata", "hdf5", "fcs"}


def sha(array):
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def text_sha(values):
    return hashlib.sha256("\n".join(str(v) for v in values).encode()).hexdigest()


def checked(name):
    data = (folder / name).read_bytes()
    assert hashlib.sha256(data).hexdigest() == manifest[name]["sha256"], f"{name} is not the file the manifest lists"
    return manifest[name]["sha256"]


def entry(name):
    return out["files"].setdefault(name, {})


def read_anndata(name):
    import anndata as ad

    a = ad.read_h5ad(folder / name)
    obs = {}
    for col in a.obs.columns:
        s = a.obs[col]
        if str(s.dtype) == "category":
            obs[col] = {"kind": "category", "categories": [str(c) for c in s.cat.categories], "codes": sha(np.asarray(s.cat.codes, dtype="<i4"))}
        elif s.dtype == bool:
            obs[col] = {"kind": "bool", "values": sha(np.asarray(s, dtype="u1"))}
        elif np.issubdtype(s.dtype, np.integer):
            obs[col] = {"kind": "int", "values": sha(np.asarray(s, dtype="<i4"))}
        else:
            obs[col] = {"kind": "float", "values": sha(np.asarray(s, dtype="<f4"))}
    uns = {k: (v.tolist() if hasattr(v, "tolist") else v) for k, v in a.uns["cytoweave"].items()}
    entry(name)[f"anndata {version('anndata')}"] = {
        "sha256": checked(name),
        "shape": list(a.shape),
        "X": sha(np.asarray(a.X, dtype="<f4")),
        "obs_names": text_sha(a.obs_names),
        "var_names": [str(v) for v in a.var_names],
        "var": {c: [str(v) for v in a.var[c]] for c in a.var.columns},
        "obs": obs,
        "obsm": {k: sha(np.asarray(v, dtype="<f4")) for k, v in a.obsm.items()},
        "uns": uns,
    }


def read_hdf5(name):
    import h5py
    import pyfive

    with h5py.File(folder / name, "r") as f:
        objects = []
        f.visititems(lambda n, o: objects.append([n, "group" if isinstance(o, h5py.Group) else str(o.dtype), str(o.attrs.get("encoding-type", ""))]))
        entry(name)[f"h5py {h5py.__version__} (HDF5 {h5py.version.hdf5_version})"] = {"sha256": checked(name), "objects": objects, "X": sha(f["X"][:].astype("<f4")), "obs_names": text_sha(f["obs/_index"].asstr()[:])}
    p = pyfive.File(str(folder / name))
    names = [v.decode() if isinstance(v, bytes) else str(v) for v in p["obs"]["_index"][:]]
    entry(name)[f"pyfive {version('pyfive')}"] = {"sha256": checked(name), "X": sha(np.asarray(p["X"][:], dtype="<f4")), "obs_names": text_sha(names), "groups": sorted(p.keys())}


def read_fcs(name):
    import fcsparser
    import flowio

    if name.endswith(".zip"):
        with zipfile.ZipFile(folder / name) as z:
            members = [(n, z.read(n)) for n in sorted(z.namelist())]
    else:
        members = [(name, (folder / name).read_bytes())]
    files = {}
    for member, data in members:
        tmp = folder / f"_{Path(member).name}"
        tmp.write_bytes(data)
        meta, df = fcsparser.parse(str(tmp), reformat_meta=False)
        fd = flowio.FlowData(str(tmp))
        events = np.reshape(np.asarray(fd.events, dtype="<f4"), (fd.event_count, fd.channel_count))
        files[member] = {
            "fcsparser": {"shape": list(df.shape), "channels": list(df.columns), "data": sha(df.to_numpy(dtype="<f4")), "spillover": meta.get("$SPILLOVER"), "sample1": meta.get("CYTOWEAVE_SAMPLE_1")},
            "flowio": {"events": fd.event_count, "channels": fd.channel_count, "data": sha(events)},
        }
        tmp.unlink()
    entry(name).update({"sha256": checked(name), "fcsparser": version("fcsparser"), "flowio": version("flowio"), "files": files})


for name in manifest:
    if name.endswith(".h5ad"):
        if "anndata" in parts:
            read_anndata(name)
        if "hdf5" in parts:
            read_hdf5(name)
    elif "fcs" in parts:
        read_fcs(name)

target.write_text(json.dumps(out, indent=1) + "\n")
print(f"wrote validation/reference/events.json ({', '.join(sorted(parts))})")
