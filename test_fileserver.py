"""
test_fileserver.py
==================
Pytest suite for fileserver.py

Spins up a real SAILHandler via http.server in a background thread,
uses a temp DATA_DIR so tests are fully isolated, and tears everything
down automatically after each test.
"""

import json
import os
import tempfile
import threading
import time
import http.server
import pytest
import requests

# ── Patch module-level globals before importing handler ──────────────────────
import fileserver  # noqa: E402  (must come after env setup)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    """Fresh temp DATA_DIR for every test; patches fileserver globals."""
    d = tmp_path / "data"
    d.mkdir()

    monkeypatch.setattr(fileserver, "DATA_DIR",      str(d))
    monkeypatch.setattr(fileserver, "TOPOLOGY_FILE", str(d / "topology.json"))
    monkeypatch.setattr(fileserver, "HISTORY_FILE",  str(d / "history.json"))
    monkeypatch.setattr(fileserver, "MAX_HISTORY",   5)  # small cap for rolling tests

    return d


@pytest.fixture()
def server(data_dir):
    """Start a live SAILHandler on an ephemeral port; yield base URL; stop after test."""
    httpd = http.server.HTTPServer(("127.0.0.1", 0), fileserver.SAILHandler)
    port  = httpd.server_address[1]
    t     = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    yield f"http://127.0.0.1:{port}"

    httpd.shutdown()
    t.join(timeout=3)


# ── /health ───────────────────────────────────────────────────────────────────

class TestHealth:
    def test_returns_ok(self, server):
        r = requests.get(f"{server}/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"

    def test_includes_expected_keys(self, server):
        body = requests.get(f"{server}/health").json()
        for key in ("status", "history_entries", "max_history", "ts"):
            assert key in body

    def test_ts_is_recent(self, server):
        body = requests.get(f"{server}/health").json()
        assert abs(body["ts"] - int(time.time())) < 5

    def test_max_history_matches_fixture(self, server):
        body = requests.get(f"{server}/health").json()
        assert body["max_history"] == 5


# ── /topology.json ────────────────────────────────────────────────────────────

class TestTopology:
    def test_get_404_when_missing(self, server, data_dir):
        r = requests.get(f"{server}/topology.json")
        assert r.status_code == 404

    def test_put_creates_file(self, server, data_dir):
        payload = {"nodes": [{"id": "A"}], "edges": []}
        r = requests.put(f"{server}/topology.json", json=payload)
        assert r.status_code == 204
        assert (data_dir / "topology.json").exists()

    def test_get_returns_put_content(self, server):
        payload = {"nodes": [{"id": "X"}], "edges": [{"src": "X", "dst": "Y"}]}
        requests.put(f"{server}/topology.json", json=payload)
        r = requests.get(f"{server}/topology.json")
        assert r.status_code == 200
        assert r.json() == payload

    def test_put_overwrites_existing(self, server):
        requests.put(f"{server}/topology.json", json={"nodes": ["old"], "edges": []})
        new = {"nodes": ["new"], "edges": []}
        requests.put(f"{server}/topology.json", json=new)
        assert requests.get(f"{server}/topology.json").json() == new

    def test_get_root_alias(self, server):
        """GET / should behave the same as GET /topology.json"""
        payload = {"nodes": [], "edges": []}
        requests.put(f"{server}/topology.json", json=payload)
        r = requests.get(f"{server}/")
        assert r.status_code == 200
        assert r.json() == payload

    def test_content_type_is_json(self, server):
        requests.put(f"{server}/topology.json", json={})
        r = requests.get(f"{server}/topology.json")
        assert "application/json" in r.headers["Content-Type"]

    def test_put_unknown_route_404(self, server):
        r = requests.put(f"{server}/unknown")
        assert r.status_code == 404


# ── /history ──────────────────────────────────────────────────────────────────

class TestHistory:
    def _post(self, server, payload):
        return requests.post(f"{server}/history", json=payload)

    def test_get_empty_initially(self, server):
        r = requests.get(f"{server}/history")
        assert r.status_code == 200
        assert r.json() == []

    def test_post_with_changed_true_writes(self, server):
        r = self._post(server, {"changed": True, "ts": 1})
        assert r.status_code == 200
        assert r.json()["written"] is True

    def test_post_with_changed_false_skips(self, server):
        r = self._post(server, {"changed": False, "ts": 1})
        assert r.json()["written"] is False
        assert r.json()["skipped_reason"] == "no changes detected"

    def test_post_without_changed_key_skips(self, server):
        r = self._post(server, {"ts": 1, "info": "no changed key"})
        assert r.json()["written"] is False

    def test_history_grows_after_write(self, server):
        for i in range(3):
            self._post(server, {"changed": True, "ts": i})
        assert len(requests.get(f"{server}/history").json()) == 3

    def test_rolling_cap_enforced(self, server):
        """MAX_HISTORY is set to 5 in fixture; post 8 entries."""
        for i in range(8):
            self._post(server, {"changed": True, "ts": i})
        history = requests.get(f"{server}/history").json()
        assert len(history) == 5
        # Oldest entries are dropped; last entry should be ts=7
        assert history[-1]["ts"] == 7

    def test_history_entries_count_in_response(self, server):
        self._post(server, {"changed": True, "ts": 0})
        self._post(server, {"changed": True, "ts": 1})
        r = self._post(server, {"changed": True, "ts": 2})
        assert r.json()["history_entries"] == 3

    def test_invalid_json_returns_400(self, server):
        r = requests.post(
            f"{server}/history",
            data=b"not json at all",
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 400
        assert "invalid JSON" in r.json()["error"]

    def test_post_unknown_route_404(self, server):
        r = requests.post(f"{server}/unknown", json={})
        assert r.status_code == 404


# ── /audit ────────────────────────────────────────────────────────────────────

class TestAudit:
    def test_404_when_html_missing(self, server, monkeypatch):
        monkeypatch.setattr(fileserver, "AUDIT_HTML", "/nonexistent/audit.html")
        r = requests.get(f"{server}/audit")
        assert r.status_code == 404

    def test_200_when_html_present(self, server, monkeypatch, tmp_path):
        html_file = tmp_path / "audit.html"
        html_file.write_bytes(b"<html><body>audit</body></html>")
        monkeypatch.setattr(fileserver, "AUDIT_HTML", str(html_file))
        r = requests.get(f"{server}/audit")
        assert r.status_code == 200
        assert b"audit" in r.content

    def test_content_type_is_html(self, server, monkeypatch, tmp_path):
        html_file = tmp_path / "audit.html"
        html_file.write_bytes(b"<html></html>")
        monkeypatch.setattr(fileserver, "AUDIT_HTML", str(html_file))
        r = requests.get(f"{server}/audit")
        assert "text/html" in r.headers["Content-Type"]


# ── CORS headers ──────────────────────────────────────────────────────────────

class TestCORS:
    def test_options_preflight_204(self, server):
        r = requests.options(f"{server}/topology.json")
        assert r.status_code == 204

    def test_cors_header_present_on_get(self, server):
        requests.put(f"{server}/topology.json", json={})
        r = requests.get(f"{server}/topology.json")
        assert r.headers.get("Access-Control-Allow-Origin") == "*"

    def test_cors_header_present_on_post(self, server):
        r = requests.post(f"{server}/history", json={"changed": True})
        assert r.headers.get("Access-Control-Allow-Origin") == "*"


# ── Unknown routes ────────────────────────────────────────────────────────────

class TestUnknownRoutes:
    def test_get_unknown_404(self, server):
        r = requests.get(f"{server}/doesnotexist")
        assert r.status_code == 404
        assert "unknown route" in r.json()["error"]


# ── _atomic_write (unit) ──────────────────────────────────────────────────────

class TestAtomicWrite:
    def test_writes_correct_content(self, tmp_path):
        p = str(tmp_path / "out.json")
        fileserver._atomic_write(p, b'{"ok":true}')
        assert open(p, "rb").read() == b'{"ok":true}'

    def test_overwrites_existing(self, tmp_path):
        p = str(tmp_path / "out.json")
        fileserver._atomic_write(p, b"first")
        fileserver._atomic_write(p, b"second")
        assert open(p, "rb").read() == b"second"

    def test_no_temp_file_left_on_success(self, tmp_path):
        p = str(tmp_path / "out.json")
        fileserver._atomic_write(p, b"data")
        files = list(tmp_path.iterdir())
        assert len(files) == 1  # only the target file


# ── _append_history (unit) ────────────────────────────────────────────────────

class TestAppendHistory:
    def test_returns_false_when_not_changed(self, data_dir):
        assert fileserver._append_history({"changed": False}) is False

    def test_returns_true_when_changed(self, data_dir):
        assert fileserver._append_history({"changed": True}) is True

    def test_entry_persisted(self, data_dir):
        fileserver._append_history({"changed": True, "x": 1})
        assert fileserver._load_history()[0]["x"] == 1

    def test_rolling_cap_unit(self, data_dir):
        for i in range(7):
            fileserver._append_history({"changed": True, "i": i})
        h = fileserver._load_history()
        assert len(h) == 5
        assert h[0]["i"] == 2  # oldest two dropped