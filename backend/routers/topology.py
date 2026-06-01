import json, os, tempfile
from pathlib import Path
from fastapi import APIRouter, Request, Response, status

router  = APIRouter(tags=["topology"])
DATA    = Path(os.getenv("DATA_DIR", "/data"))
TOPO    = DATA / "topology.json"

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

@router.get("/topology.json")
def get_topology():
    if not TOPO.exists():
        return Response(content=b"{}", media_type="application/json",
                        headers={"Cache-Control": "no-store, no-cache",
                                 "Access-Control-Allow-Origin": "*"})
    content = TOPO.read_bytes()
    return Response(content=content, media_type="application/json",
                    headers={"Cache-Control": "no-store, no-cache",
                             "Access-Control-Allow-Origin": "*"})

@router.put("/topology.json", status_code=status.HTTP_204_NO_CONTENT)
async def put_topology(request: Request):
    body = await request.body()
    _atomic_write(TOPO, body)
    return Response(status_code=204,
                    headers={"Access-Control-Allow-Origin": "*"})