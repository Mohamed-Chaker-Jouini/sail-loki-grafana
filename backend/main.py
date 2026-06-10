import os

from fastapi import FastAPI, Depends, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .routers import health, logs, firewall, ai
from .services.pyez_client import get_topology
from .routers.firewall import _creds

app = FastAPI(title="SAIL", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(logs.router)
app.include_router(firewall.router)
app.include_router(ai.router)

@app.options("/{rest:path}")
async def options_handler(rest: str):
    return Response(
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        },
    )

@app.get("/topology.json")
def serve_dynamic_topology(creds=Depends(_creds)):
    try:
        topology_data = get_topology(creds)
        return topology_data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to query vSRX topology: {str(e)}")

STATIC = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC):
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")