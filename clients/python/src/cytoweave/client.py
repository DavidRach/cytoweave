"""Remote control of a running CytoWeave from Python.

CytoWeave started with ``--remote-control`` accepts actions from programs on this computer: every
tool an AI agent has (open data, gate, tabulate, compare, export) is an action, sent as JSON to
``/api/remote/action`` and performed by the open CytoWeave window, which shows what happens. Changes
are proposals the user accepts or rejects in the window, as an agent's are.

>>> import cytoweave
>>> cw = cytoweave.connect()           # finds the running CytoWeave
>>> cw.open_example(id="pbmc-immunophenotyping")
>>> table = cw.statistics_table(statistic="freqParent").frame()
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from ._tools import Tools

DEFAULT_URL = "http://127.0.0.1:8770"
TOKEN_HEADER = "X-CytoWeave-Token"


class CytoWeaveError(Exception):
    """An action CytoWeave refused or could not perform, or a connection that failed.

    ``status`` is the HTTP status (0 when CytoWeave could not be reached); ``action`` the action.
    """

    def __init__(self, message: str, status: int = 0, action: str | None = None):
        super().__init__(message)
        self.status = status
        self.action = action


class Result:
    """CytoWeave's answer to an action: ``message`` (a sentence) and ``data`` (JSON values)."""

    def __init__(self, action: str, message: str, data: Any):
        self.action = action
        self.message = message
        self.data = data

    def __repr__(self) -> str:
        return f"<cytoweave.Result {self.action}: {self.message}>"

    def __getitem__(self, key):
        return self.data[key]

    def records(self, key: str | None = None) -> list[dict]:
        """A list of records in the data: ``data[key]``, or the first list of objects found."""
        if key is not None:
            value = self.data[key]
        elif isinstance(self.data, list):
            value = self.data
        else:
            value = next((v for v in (self.data or {}).values() if isinstance(v, list) and v and all(isinstance(x, dict) for x in v)), None)
            if value is None:
                raise KeyError(f"{self.action} returned no list of records; its data has {', '.join(self.data or {})}")
        return value

    def frame(self, key: str | None = None):
        """The records as a pandas DataFrame (pandas must be installed)."""
        try:
            import pandas
        except ImportError as error:
            raise ImportError("Result.frame() needs pandas; Result.records() gives the rows as dictionaries.") from error
        return pandas.DataFrame.from_records(self.records(key))

    def save_image(self, path: str | os.PathLike) -> Path:
        """Writes the image of a render_plot result to a PNG file; returns its path."""
        url = (self.data or {}).get("image", "")
        prefix = "data:image/png;base64,"
        if not url.startswith(prefix):
            raise CytoWeaveError(f"{self.action} returned no PNG image", action=self.action)
        path = Path(path)
        path.write_bytes(base64.b64decode(url[len(prefix):]))
        return path


def default_data_dir() -> Path:
    """CytoWeave's data folder when it is started without --data-dir (Go's os.UserConfigDir)."""
    home = Path.home()
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        return Path(base) / "CytoWeave" if base else home / ".cytoweave"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "CytoWeave"
    base = os.environ.get("XDG_CONFIG_HOME") or str(home / ".config")
    return Path(base) / "CytoWeave"


def find_connection(data_dir: str | os.PathLike | None = None) -> dict:
    """Where the running CytoWeave is: {"url", "token"}.

    From the environment (CYTOWEAVE_URL and CYTOWEAVE_TOKEN), else from the remote.json that
    CytoWeave writes to its data folder (``data_dir``, CYTOWEAVE_DATA_DIR or the default folder),
    else CytoWeave's default address without a token.
    """
    url = os.environ.get("CYTOWEAVE_URL")
    token = os.environ.get("CYTOWEAVE_TOKEN")
    if url:
        return {"url": url, "token": token}
    folder = Path(data_dir or os.environ.get("CYTOWEAVE_DATA_DIR") or default_data_dir())
    try:
        info = json.loads((folder / "remote.json").read_text(encoding="utf-8"))
        return {"url": info["url"], "token": token or info.get("token")}
    except (OSError, ValueError, KeyError):
        return {"url": DEFAULT_URL, "token": token}


class CytoWeave(Tools):
    """A connection to a running CytoWeave; each action is a method (see ``tools()``).

    url, token: CytoWeave's address and the token it printed at startup (needed to open and write
    files); found by ``find_connection`` when not given. client: the name CytoWeave shows with your
    proposals. timeout: seconds to wait for an action (analyses of many samples take a while).
    """

    def __init__(self, url: str | None = None, token: str | None = None, *, client: str = "Python", timeout: float = 3600, data_dir: str | os.PathLike | None = None):
        found = find_connection(data_dir) if url is None or token is None else {}
        self.url = (url or found.get("url") or DEFAULT_URL).rstrip("/")
        self.token = token if token is not None else found.get("token")
        self.client = client
        self.timeout = timeout

    def __repr__(self) -> str:
        return f"<cytoweave.CytoWeave {self.url}{'' if self.token else ' (no token)'}>"

    def _request(self, method: str, path: str, body: bytes | None = None, action: str | None = None) -> Any:
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers[TOKEN_HEADER] = self.token
        request = urllib.request.Request(self.url + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", "replace")
            try:
                message = json.loads(text).get("error") or text
            except ValueError:
                message = text or error.reason
            if error.code == 404 and path == "/api/remote/action":
                message = f"{self.url} does not accept actions: start CytoWeave with --remote-control."
            raise CytoWeaveError(message, error.code, action) from None
        except urllib.error.URLError as error:
            raise CytoWeaveError(f"CytoWeave is not running at {self.url} ({error.reason}). Start it with: cytoweave --remote-control", 0, action) from None

    def call(self, action: str, **args: Any) -> Result:
        """Performs any action by its name, with its arguments as CytoWeave names them (camelCase);
        arguments that are None are left out. Raises CytoWeaveError when the action fails."""
        body = json.dumps({"action": action, "args": {k: v for k, v in args.items() if v is not None}, "client": self.client}).encode("utf-8")
        answer = self._request("POST", "/api/remote/action", body, action)
        if not answer.get("ok"):
            raise CytoWeaveError(answer.get("message") or answer.get("error") or f"{action} failed", 200, action)
        return Result(action, answer.get("message", ""), answer.get("data"))

    def tools(self) -> list[dict]:
        """The actions this CytoWeave performs: name, title, description and argument schema."""
        return self._request("GET", "/api/remote/tools")["tools"]

    def version(self) -> str:
        """The version of the running CytoWeave."""
        return self._request("GET", "/api/remote/tools")["version"]


def connect(url: str | None = None, token: str | None = None, **options: Any) -> CytoWeave:
    """Connects to the running CytoWeave (see ``CytoWeave``) and checks that it answers."""
    cw = CytoWeave(url, token, **options)
    cw.version()
    return cw
