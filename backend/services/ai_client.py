import os
from typing import Any, Dict

import httpx


AI_SERVICE_URL = os.getenv("AI_SERVICE_URL", "http://192.168.1.20:8000")
AI_SERVICE_TIMEOUT = float(os.getenv("AI_SERVICE_TIMEOUT", "300"))


async def chat_with_ai(payload: Dict[str, Any]) -> Dict[str, Any]:
    url = f"{AI_SERVICE_URL.rstrip('/')}/api/ai/chat"

    async with httpx.AsyncClient(timeout=AI_SERVICE_TIMEOUT) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()


async def ai_health() -> Dict[str, Any]:
    url = f"{AI_SERVICE_URL.rstrip('/')}/api/ai/health"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.json()