import time
import json
import urllib.request
import urllib.parse
import os
from typing import Any, Dict, List, Optional

from .pyez_client import (
    get_address_book,
    get_enriched_address_book,
    get_quarantined_ips,
    get_policies,
    MORPHEUS_BOOK,
    QUARANTINE_SET,
)
from .credentials import SRXCredentials

LOKI_URL = os.getenv("LOKI_URL", "http://sail-loki:3100")


# ── Loki helpers ───────────────────────────────────────────────────────────────

def _loki_query(logql: str, seconds: int = 3600, limit: int = 50) -> List[Dict]:
    """Runs a Loki query and returns a flat list of log entry dicts."""
    now_ns   = int(time.time() * 1e9)
    start_ns = now_ns - int(seconds * 1e9)

    params = urllib.parse.urlencode({
        "query":     logql,
        "start":     str(start_ns),
        "end":       str(now_ns),
        "limit":     str(limit),
        "direction": "backward",
    })

    url = f"{LOKI_URL}/loki/api/v1/query_range?{params}"

    try:
        proxy_handler = urllib.request.ProxyHandler({})
        opener        = urllib.request.build_opener(proxy_handler)
        req           = urllib.request.Request(url)
        with opener.open(req, timeout=10) as resp:
            raw = json.loads(resp.read())
    except Exception:
        return []

    entries = []
    for stream in raw.get("data", {}).get("result", []):
        labels = stream.get("stream", {})
        for ts_ns, line in stream.get("values", []):
            entries.append({
                "ts_ms":    int(ts_ns) // 1_000_000,
                "line":     line,
                "task":     labels.get("task",     ""),
                "status":   labels.get("status",   ""),
                "play":     labels.get("play",      ""),
                "host":     labels.get("host",      ""),
                "playbook": labels.get("playbook",  ""),
            })

    entries.sort(key=lambda x: x["ts_ms"], reverse=True)
    return entries


def get_recent_logs(limit: int = 50, seconds: int = 3600) -> List[Dict]:
    """All SAIL Ansible logs from the last hour."""
    return _loki_query('{job="ansible",project="SAIL"}', seconds=seconds, limit=limit)


def get_drift_logs(limit: int = 30) -> List[Dict]:
    """Logs tagged changed or failed — the most operationally relevant."""
    return _loki_query(
        '{job="ansible",project="SAIL"} |~ `(?i)(drift|changed|failed|mismatch|orphan)`',
        seconds=86400,
        limit=limit,
    )


def get_failed_logs(limit: int = 20) -> List[Dict]:
    return _loki_query('{job="ansible",project="SAIL",status="failed"}', seconds=86400, limit=limit)


# ── SRX helpers ────────────────────────────────────────────────────────────────

def _get_firewall_snapshot(creds: SRXCredentials) -> Dict[str, Any]:
    """
    Returns a concise firewall snapshot:
    - enriched address book (morpheus + manual IPs, per zone, quarantine status)
    - policies
    - quarantined IPs
    - orphaned addresses (in book but not in any set)
    """
    enriched    = get_enriched_address_book(creds)
    policies    = get_policies(creds)
    quarantined = enriched.get("quarantined", [])

    # Detect orphaned: in MORPHEUS_MANAGED addresses but not in any set
    morpheus_book = get_address_book(creds, MORPHEUS_BOOK)
    all_in_sets   = set()
    for aset in morpheus_book.get("address_sets", []):
        if aset["name"] != QUARANTINE_SET:
            all_in_sets.update(aset["addresses"])

    orphaned = [
        addr["name"]
        for addr in morpheus_book.get("addresses", [])
        if addr["name"] not in all_in_sets and addr["name"] not in quarantined
    ]

    # Zone summary: {zone_name: {total, quarantined, manual, morpheus}}
    zone_summary = []
    for aset in enriched.get("address_sets", []):
        addrs = aset.get("addresses", [])
        zone_summary.append({
            "zone":       aset["name"],
            "total":      len(addrs),
            "morpheus":   sum(1 for a in addrs if a["source"] == "morpheus"),
            "manual":     sum(1 for a in addrs if a["source"] == "manual"),
            "quarantined": sum(1 for a in addrs if a["quarantined"]),
            "addresses":  addrs,
        })

    return {
        "zone_summary":  zone_summary,
        "policies":      policies,
        "quarantined":   quarantined,
        "orphaned":      orphaned,
        "orphaned_count": len(orphaned),
        "quarantine_count": len(quarantined),
    }


# ── Main context builder ───────────────────────────────────────────────────────

def build_ai_context(
    *,
    creds: Optional[SRXCredentials] = None,
    extra_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    extra_context = extra_context or {}

    # ── Loki data (never raises — returns empty lists on failure) ──────────────
    recent_logs = get_recent_logs(limit=50, seconds=3600)
    drift_logs  = get_drift_logs(limit=30)
    failed_logs = get_failed_logs(limit=20)

    latest_drift = drift_logs[0] if drift_logs else None

    # ── SRX / firewall data ────────────────────────────────────────────────────
    firewall_snapshot = None
    firewall_error    = None
    if creds is not None:
        try:
            firewall_snapshot = _get_firewall_snapshot(creds)
        except Exception as e:
            firewall_error = str(e)

    context: Dict[str, Any] = {
        "app":  "SAIL",
        "page": extra_context.get("page", "ai_chat"),

        # IDs / filters passed from the frontend (may be None)
        "incident_id":         extra_context.get("incident_id"),
        "selected_entity_id":  extra_context.get("selected_entity_id"),
        "time_range":          extra_context.get("time_range"),

        # Live Loki data
        "latest_drift":  latest_drift,
        "drift_logs":    drift_logs,       # changed/failed/mismatch/orphan events, last 24 h
        "failed_logs":   failed_logs,      # failed tasks only, last 24 h
        "recent_logs":   recent_logs,      # all SAIL logs, last 1 h

        # Live SRX data
        "firewall_snapshot": firewall_snapshot,
        "firewall_error":    firewall_error,
    }

    # Merge any extra keys the frontend or caller passed in
    for key, value in extra_context.items():
        if key not in context:
            context[key] = value

    return context