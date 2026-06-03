import time
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(tags=["health"])
_CORS  = {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store, no-cache"}

@router.get("/health")
def health():
    return JSONResponse(
        content={"status": "ok", "ts": int(time.time())},
        headers=_CORS,
    )