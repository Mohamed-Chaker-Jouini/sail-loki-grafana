import os
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware

from .routers import topology, history, health, firewall, logs
from .services.pyez_client import get_topology
from .routers.firewall import _creds

app = FastAPI(title="SAIL", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── existing endpoints (Ansible playbook calls these — do not change URLs) ─────
app.include_router(history.router)
app.include_router(health.router)
app.include_router(logs.router)

# ── new firewall control API ───────────────────────────────────────────────────
app.include_router(firewall.router)

# ── OPTIONS passthrough for CORS preflights ────────────────────────────────────
@app.options("/{rest:path}")
async def options_handler(rest: str):
    return Response(status_code=204, headers={
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    })

@app.get("/topology.json")
def serve_dynamic_topology(creds = Depends(_creds)):
    """Intercepts the React app's static file request and serves live vSRX data."""
    try:
        topology_data = get_topology(creds)
        return topology_data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to query vSRX topology: {str(e)}")

# ── serve React build (must be last) ──────────────────────────────────────────
STATIC = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC):
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")