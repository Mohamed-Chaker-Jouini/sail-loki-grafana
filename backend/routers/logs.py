import os
import time
import urllib.request
import urllib.parse
import json
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

router   = APIRouter(prefix="/api/logs", tags=["logs"])
LOKI_URL = os.getenv("LOKI_URL", "http://sail-loki:3100")
_CORS    = {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store, no-cache"}

RANGE_SECONDS = {
    "1h":  3600,
    "6h":  21600,
    "24h": 86400,
    "7d":  604800,
}

@router.get("")
def query_logs(
    status: str  = Query(default="",    description="ok|changed|failed|skipped|unreachable"),
    search: str  = Query(default="",    description="free text filter on log line"),
    range:  str  = Query(default="1h",  description="1h|6h|24h|7d"),
    limit:  int  = Query(default=100,   ge=10, le=500),
):
    # build LogQL query
    selectors = ['{job="ansible",project="SAIL"}']
    if status:
        selectors = [f'{{job="ansible",project="SAIL",status="{status}"}}']

    logql = selectors[0]
    if search:
        # case-insensitive line filter
        safe = search.replace('"', '\\"')
        logql = f'{logql} |~ `(?i){safe}`'

    seconds = RANGE_SECONDS.get(range, 3600)
    now_ns  = int(time.time() * 1e9)
    start_ns= now_ns - int(seconds * 1e9)

    params = urllib.parse.urlencode({
        "query": logql,
        "start": str(start_ns),
        "end":   str(now_ns),
        "limit": str(limit),
        "direction": "backward",
    })

    url = f"{LOKI_URL}/loki/api/v1/query_range?{params}"

    try:
        req = urllib.request.Request(url)

        # Disable Proxies
        proxy_handler = urllib.request.ProxyHandler({})
        opener = urllib.request.build_opener(proxy_handler) 

        with opener.open(req, timeout=10) as resp:
            raw = json.loads(resp.read())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Loki unreachable: {e}")

    # flatten Loki streams into a simple list of log entries
    entries = []
    for stream in raw.get("data", {}).get("result", []):
        labels = stream.get("stream", {})
        for ts_ns, line in stream.get("values", []):
            entries.append({
                "ts_ns":    int(ts_ns),
                "ts_ms":    int(ts_ns) // 1_000_000,
                "line":     line,
                "task":     labels.get("task",     ""),
                "status":   labels.get("status",   ""),
                "play":     labels.get("play",      ""),
                "host":     labels.get("host",      ""),
                "playbook": labels.get("playbook",  ""),
            })

    # already backward from Loki but sort to be sure
    entries.sort(key=lambda x: x["ts_ns"], reverse=True)

    return JSONResponse(
        content={"entries": entries, "count": len(entries), "query": logql},
        headers=_CORS,
    )