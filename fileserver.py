"""
fileserver.py
=============
Minimal HTTP server for topology.json.
Handles GET and PUT. Serves with CORS headers for Grafana.
Run from inside the container with: python3 /app/fileserver.py
"""

import http.server
import os

DATA_DIR = "/data"
PORT     = 80


class TopologyHandler(http.server.BaseHTTPRequestHandler):

    def _path(self):
        return os.path.join(DATA_DIR, self.path.lstrip("/") or "topology.json")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        p = self._path()
        try:
            data = open(p, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type",                "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_response(404)
            self.end_headers()

    def do_PUT(self):
        length = int(self.headers.get("Content-Length", 0))
        data   = self.rfile.read(length)
        open(self._path(), "wb").write(data)
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        # Suppress default Apache-style access log noise.
        pass


if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    seed = os.path.join(DATA_DIR, "topology.json")
    if not os.path.exists(seed):
        open(seed, "w").write('{"nodes":[],"edges":[]}')

    print(f"Serving {DATA_DIR} on port {PORT}", flush=True)
    http.server.HTTPServer(("", PORT), TopologyHandler).serve_forever()