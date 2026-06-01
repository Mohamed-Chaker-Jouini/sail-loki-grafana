import json, os, time
from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router   = APIRouter(tags=["health"])
DATA     = Path(os.getenv("DATA_DIR", "/data"))
HIST     = DATA / "history.json"
MAX_HIST = int(os.getenv("MAX_HISTORY_ENTRIES", "1000"))
_CORS    = {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store, no-cache"}

@router.get("/health")
def health():
    try:
        entries = len(json.loads(HIST.read_text())) if HIST.exists() else 0
    except Exception:
        entries = 0
    return JSONResponse(
        content={"status": "ok", "history_entries": entries,
                 "max_history": MAX_HIST, "ts": int(time.time())},
        headers=_CORS,
    )