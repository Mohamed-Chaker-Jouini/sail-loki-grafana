import json, os, tempfile, time
from pathlib import Path
from fastapi import APIRouter, Request, Response, status
from fastapi.responses import JSONResponse

router   = APIRouter(tags=["history"])
DATA     = Path(os.getenv("DATA_DIR", "/data"))
HIST     = DATA / "history.json"
MAX_HIST = int(os.getenv("MAX_HISTORY_ENTRIES", "1000"))

def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        os.unlink(tmp)
        raise

def _read_history() -> list:
    if not HIST.exists():
        return []
    try:
        return json.loads(HIST.read_text())
    except Exception:
        return []

_CORS = {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store, no-cache"}

@router.get("/history")
def get_history():
    return JSONResponse(content=_read_history(), headers=_CORS)

@router.post("/history")
async def post_history(request: Request):
    body = await request.json()

    if not body.get("changed", False):
        return JSONResponse(
            content={"written": False, "history_entries": len(_read_history()),
                     "skipped_reason": "no changes detected"},
            headers=_CORS,
        )

    history = _read_history()
    history.append(body)
    if len(history) > MAX_HIST:
        history = history[-MAX_HIST:]

    _atomic_write(HIST, json.dumps(history, indent=2).encode())
    return JSONResponse(
        content={"written": True, "history_entries": len(history), "skipped_reason": None},
        headers=_CORS,
    )