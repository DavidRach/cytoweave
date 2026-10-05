"""The Python client against a running CytoWeave: its results equal the HTTP API's for the same
actions, it finds CytoWeave through the connection file, and exports, images and errors work.

clients/test-clients.mjs starts CytoWeave with remote control and a browser page showing the PBMC
example with its suggested gates, then runs these tests with CYTOWEAVE_TEST_URL, CYTOWEAVE_TEST_TOKEN,
CYTOWEAVE_TEST_DIR and CYTOWEAVE_DATA_DIR set. Without them the tests are skipped.

    PYTHONPATH=clients/python/src python3 -m unittest discover -s clients/python/tests -v
"""

import json
import os
import unittest
import urllib.request
from pathlib import Path

import cytoweave

URL = os.environ.get("CYTOWEAVE_TEST_URL")
TOKEN = os.environ.get("CYTOWEAVE_TEST_TOKEN")
OUT = Path(os.environ.get("CYTOWEAVE_TEST_DIR", "."))


def http(action, args=None):
    """The same action sent to the HTTP API directly, as docs/MCP.md shows."""
    body = json.dumps({"action": action, "args": args or {}, "client": "Python"}).encode("utf-8")
    request = urllib.request.Request(URL + "/api/remote/action", data=body, headers={"Content-Type": "application/json", "X-CytoWeave-Token": TOKEN})
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.loads(response.read().decode("utf-8"))


@unittest.skipUnless(URL, "needs a running CytoWeave (node clients/test-clients.mjs)")
class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # No address or token given: found in remote.json in CYTOWEAVE_DATA_DIR.
        cls.cw = cytoweave.connect(client="Python")

    def test_connects_through_the_connection_file(self):
        self.assertEqual(self.cw.url, URL)
        self.assertEqual(self.cw.token, TOKEN)
        self.assertEqual(self.cw.version(), cytoweave.__version__, "the client's version is the program's")

    def test_every_action_is_a_method(self):
        names = [tool["name"] for tool in self.cw.tools()]
        missing = [name for name in names if not callable(getattr(self.cw, name, None))]
        self.assertGreater(len(names), 30)
        self.assertEqual(missing, [])
        self.assertIn("diffcyt-DS-limma", self.cw.differential_analysis.__doc__)

    def test_results_equal_the_http_api(self):
        cw = self.cw
        cases = [
            (lambda: cw.workspace_summary(), "workspace_summary", {}),
            (lambda: cw.list_populations(sample="D01_Stim"), "list_populations", {"sample": "D01_Stim"}),
            (lambda: cw.statistics_table(statistic="freqParent", populations=["T cells", "Monocytes"]), "statistics_table", {"statistic": "freqParent", "populations": ["T cells", "Monocytes"]}),
            (lambda: cw.compare("T cells", "condition", pair_by="subject"), "compare", {"population": "T cells", "groupBy": "condition", "pairBy": "subject"}),
            (lambda: cw.differential_analysis("condition", groups=["Unstimulated", "Stimulated"], pair_by="subject", populations=["T cells", "Monocytes"], min_cells=5), "differential_analysis", {"groupBy": "condition", "groups": ["Unstimulated", "Stimulated"], "pairBy": "subject", "populations": ["T cells", "Monocytes"], "minCells": 5}),
            (lambda: cw.call("population_statistics", population="T cells", sample="D02_Unstim"), "population_statistics", {"population": "T cells", "sample": "D02_Unstim"}),
        ]
        for method, action, args in cases:
            with self.subTest(action=action):
                mine = method()
                theirs = http(action, args)
                self.assertTrue(theirs["ok"], theirs.get("message"))
                self.assertEqual(mine.message, theirs["message"])
                self.assertEqual(mine.data, theirs["data"])

    def test_records_and_frames(self):
        result = self.cw.differential_analysis("condition", groups=["Unstimulated", "Stimulated"], pair_by="subject", populations=["T cells"], limit=500)
        rows = result.records()
        self.assertEqual(rows, result["rows"])
        found = {row["marker"]: row for row in rows}
        self.assertGreater(found["CD25"]["logFC"], 0)
        self.assertLess(found["CD25"]["padj"], 0.05)
        try:
            import pandas  # noqa: F401
        except ImportError:
            self.skipTest("pandas is not installed")
        frame = result.frame()
        self.assertEqual(len(frame), len(rows))
        self.assertIn("padj", frame.columns)

    def test_exports_need_the_token_and_never_replace_a_file(self):
        path = OUT / "python-table.csv"
        path.unlink(missing_ok=True)
        result = self.cw.export_table(str(path), statistic="freqParent")
        self.assertTrue(path.exists(), result.message)
        with self.assertRaises(cytoweave.CytoWeaveError) as again:
            self.cw.export_table(str(path), statistic="freqParent")
        self.assertIn("exists", str(again.exception))
        self.cw.export_table(str(path), statistic="freqParent", overwrite=True)
        without = cytoweave.CytoWeave(URL, "")
        with self.assertRaises(cytoweave.CytoWeaveError) as refused:
            without.export_table(str(OUT / "python-other.csv"))
        self.assertEqual(refused.exception.status, 401)

    def test_a_plot_saved_as_png(self):
        path = OUT / "python-plot.png"
        self.cw.render_plot("CD3", population="T cells", sample="D01_Stim", file=str(path))
        self.assertEqual(path.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")

    def test_errors_carry_the_reason(self):
        with self.assertRaises(cytoweave.CytoWeaveError) as unknown:
            self.cw.call("no_such_action")
        self.assertIn("Unknown action", str(unknown.exception))
        with self.assertRaises(cytoweave.CytoWeaveError) as wrong:
            self.cw.differential_analysis("no_such_field")
        self.assertIn("no_such_field", str(wrong.exception))
        with self.assertRaises(cytoweave.CytoWeaveError) as gone:
            cytoweave.connect("http://127.0.0.1:9", "")
        self.assertEqual(gone.exception.status, 0)


class OfflineTest(unittest.TestCase):
    """What the client does without a CytoWeave."""

    def test_the_connection_file_and_the_environment(self):
        import tempfile

        saved = {k: os.environ.pop(k, None) for k in ("CYTOWEAVE_URL", "CYTOWEAVE_TOKEN", "CYTOWEAVE_DATA_DIR")}
        try:
            with tempfile.TemporaryDirectory() as folder:
                self.assertEqual(cytoweave.find_connection(folder), {"url": "http://127.0.0.1:8770", "token": None})
                Path(folder, "remote.json").write_text(json.dumps({"url": "http://127.0.0.1:8799", "token": "abc", "version": "x", "pid": 1}))
                self.assertEqual(cytoweave.find_connection(folder), {"url": "http://127.0.0.1:8799", "token": "abc"})
                os.environ["CYTOWEAVE_URL"] = "http://127.0.0.1:8800"
                self.assertEqual(cytoweave.find_connection(folder)["url"], "http://127.0.0.1:8800")
        finally:
            for key, value in saved.items():
                os.environ.pop(key, None)
                if value is not None:
                    os.environ[key] = value

    def test_snake_case_arguments_become_the_api_names(self):
        sent = {}

        class Recorder(cytoweave.CytoWeave):
            def call(self, action, **args):
                sent[action] = args
                return cytoweave.Result(action, "", {})

        Recorder("http://127.0.0.1:1", "").differential_analysis("condition", pair_by="subject", min_cells=5)
        self.assertEqual(sent["differential_analysis"]["groupBy"], "condition")
        self.assertEqual(sent["differential_analysis"]["pairBy"], "subject")
        self.assertEqual(sent["differential_analysis"]["minCells"], 5)


if __name__ == "__main__":
    unittest.main()
