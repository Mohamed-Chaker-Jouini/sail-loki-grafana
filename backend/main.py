import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .routers import topology, history, health, firewall, logs

app = FastAPI(title="SAIL", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── existing endpoints (Ansible playbook calls these — do not change URLs) ─────
app.include_router(topology.router)
app.include_router(history.router)
app.include_router(health.router)
app.include_router(logs.router)

# ── new firewall control API ───────────────────────────────────────────────────
app.include_router(firewall.router)

# ── OPTIONS passthrough for CORS preflights ────────────────────────────────────
from fastapi import Request
from fastapi.responses import Response

@app.options("/{rest:path}")
async def options_handler(rest: str):
    return Response(status_code=204, headers={
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    })

# ── serve React build (must be last) ──────────────────────────────────────────
STATIC = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC):
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")