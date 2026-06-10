import json
from typing import Any, Dict, Optional

from ..services.pyez_client import get_topology


def _count_items(value: Any, keys: tuple[str, ...]) -> int:
    count = 0

    def walk(obj: Any):
        nonlocal count
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k in keys and isinstance(v, list):
                    count += len(v)
                walk(v)
        elif isinstance(obj, list):
            for item in obj:
                walk(item)

    walk(value)
    return count


def _safe_json_size(obj: Any) -> int:
    try:
        return len(json.dumps(obj, default=str))
    except Exception:
        return 0


def summarize_topology(topology: Any) -> Dict[str, Any]:
    if topology is None:
        return {"available": False}

    return {
        "available": True,
        "node_count": _count_items(topology, ("nodes", "devices", "machines", "instances")),
        "edge_count": _count_items(topology, ("edges", "links", "connections")),
        "approx_json_size": _safe_json_size(topology),
        "raw": topology,
    }


def build_ai_context(
    *,
    creds: Any = None,
    extra_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    extra_context = extra_context or {}

    topology = None
    topology_error = None
    if creds is not None:
        try:
            topology = get_topology(creds)
        except Exception as e:
            topology_error = str(e)

    context = {
        "app": "SAIL",
        "page": extra_context.get("page", "ai_chat"),
        "incident_id": extra_context.get("incident_id"),
        "selected_entity_id": extra_context.get("selected_entity_id"),
        "time_range": extra_context.get("time_range"),
        "latest_drift": extra_context.get("latest_drift"),
        "recent_logs": extra_context.get("recent_logs"),
        "firewall_snapshot": extra_context.get("firewall_snapshot"),
        "topology": summarize_topology(topology),
        "topology_error": topology_error,
    }

    for key, value in extra_context.items():
        if key not in context:
            context[key] = value

    return context