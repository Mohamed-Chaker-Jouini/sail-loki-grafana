"""
fileserver.py
=============
Minimal HTTP server for SAIL topology and audit history.

Routes
------
GET  /topology.json          Current topology snapshot
PUT  /topology.json          Overwrite current topology snapshot

POST /history                Append a drift event (only if payload contains changed=true)
GET  /history                Return full history array as JSON

GET  /audit                  Serve the audit UI (audit.html)

GET  /health                 Simple liveness check

Configuration (environment variables)
--------------------------------------
MAX_HISTORY_ENTRIES   Max snapshots to retain in history.json  (default: 1000)
DATA_DIR              Directory for persisted files             (default: /data)
PORT                  Listening port                            (default: 80)
"""

import http.server
import json
import os
import tempfile
import time

DATA_DIR          = os.environ.get("DATA_DIR", "/data")
PORT              = int(os.environ.get("PORT", 80))
MAX_HISTORY       = int(os.environ.get("MAX_HISTORY_ENTRIES", 1000))
AUDIT_HTML        = os.path.join(os.path.dirname(__file__), "audit.html")
TOPOLOGY_FILE     = os.path.join(DATA_DIR, "topology.json")
HISTORY_FILE      = os.path.join(DATA_DIR, "history.json")


# ── Atomic file write ─────────────────────────────────────────────────────────

def _atomic_write(path: str, data: bytes) -> None:
    """Write data atomically using a temp file + rename.
    Prevents corrupted reads if the process is killed mid-write.
    """
    dir_ = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=dir_)
    try:
        os.write(fd, data)
        os.fsync(fd)
        os.close(fd)
        os.replace(tmp, path)
    except Exception:
        os.close(fd)
        os.unlink(tmp)
        raise


# ── History helpers ───────────────────────────────────────────────────────────

def _load_history() -> list:
    try:
        with open(HISTORY_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_history(entries: list) -> None:
    data = json.dumps(entries, indent=2).encode("utf-8")
    _atomic_write(HISTORY_FILE, data)


def _append_history(snapshot: dict) -> bool:
    """
    Append a snapshot only when it signals a real change.
    Enforces the MAX_HISTORY rolling cap.
    Returns True if the snapshot was written, False if skipped.
    """
    if not snapshot.get("changed", False):
        return False

    entries = _load_history()
    entries.append(snapshot)

    # Rolling cap — drop oldest entries first
    if len(entries) > MAX_HISTORY:
        entries = entries[-MAX_HISTORY:]

    _save_history(entries)
    return True


# ── Request handler ───────────────────────────────────────────────────────────

class SAILHandler(http.server.BaseHTTPRequestHandler):

    # ── Shared helpers ────────────────────────────────────────────────────────

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, code: int, obj) -> None:
        body = json.dumps(obj, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Cache-Control",  "no-store, no-cache, must-revalidate")
        self.send_header("Pragma",         "no-cache")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, code: int, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type",  "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _clean_path(self) -> str:
        return self.path.split("?")[0].lstrip("/")

    # ── OPTIONS (CORS preflight) ───────────────────────────────────────────────

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    # ── GET ───────────────────────────────────────────────────────────────────

    def do_GET(self) -> None:
        p = self._clean_path()

        if p in ("topology.json", ""):
            try:
                data = open(TOPOLOGY_FILE, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type",  "application/json")
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
                self.send_header("Pragma",        "no-cache")
                self._cors()
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError:
                self._send_json(404, {"error": "topology.json not found"})

        elif p == "history":
            self._send_json(200, _load_history())

        elif p == "audit":
            try:
                print(f"[DEBUG] Trying to look for audit file at: {AUDIT_HTML}", flush=True)
                body = open(AUDIT_HTML, "rb").read()
                self._send_html(200, body)
            except FileNotFoundError:
                print(f"[ERROR] Failed to find audit file at: {AUDIT_HTML}", flush=True)
                self._send_html(404, b"<h1>audit.html not found</h1>")
        
        elif p.endswith(".js"):
            # js file in same dir as py fileserver
            js_file_path = os.path.join(os.path.dirname(__file__),p)
            try:
                body = open(js_file_path, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self._cors()
                self.end_headers()
                self.wfile.write(body)
            except:
                self._send_json(404, {"error": f"{p} not found"})
        elif p == "health":
            self._send_json(200, {
                "status":          "ok",
                "history_entries": len(_load_history()),
                "max_history":     MAX_HISTORY,
                "ts":              int(time.time()),
            })

        else:
            self._send_json(404, {"error": f"unknown route: /{p}"})

    # ── PUT ───────────────────────────────────────────────────────────────────

    def do_PUT(self) -> None:
        p = self._clean_path()

        if p in ("topology.json", ""):
            data = self._read_body()
            _atomic_write(TOPOLOGY_FILE, data)
            self.send_response(204)
            self._cors()
            self.end_headers()
        else:
            self._send_json(404, {"error": f"unknown PUT route: /{p}"})

    # ── POST ──────────────────────────────────────────────────────────────────

    def do_POST(self) -> None:
        p = self._clean_path()

        if p == "history":
            raw = self._read_body()
            try:
                snapshot = json.loads(raw)
            except json.JSONDecodeError as e:
                self._send_json(400, {"error": f"invalid JSON: {e}"})
                return

            written = _append_history(snapshot)
            self._send_json(200, {
                "written":         written,
                "history_entries": len(_load_history()),
                "skipped_reason":  None if written else "no changes detected",
            })
        else:
            self._send_json(404, {"error": f"unknown POST route: /{p}"})

    # ── Suppress access log noise ─────────────────────────────────────────────

    def log_message(self, fmt, *args) -> None:
        print(f"[LOG] {self.address_string()} - {fmt%args}", flush=True)


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)

    if not os.path.exists(TOPOLOGY_FILE):
        _atomic_write(TOPOLOGY_FILE, b'{"nodes":[],"edges":[]}')

    if not os.path.exists(HISTORY_FILE):
        _atomic_write(HISTORY_FILE, b"[]")

    print(f"SAIL fileserver | port={PORT} | data={DATA_DIR} | max_history={MAX_HISTORY}", flush=True)
    http.server.HTTPServer(("", PORT), SAILHandler).serve_forever()