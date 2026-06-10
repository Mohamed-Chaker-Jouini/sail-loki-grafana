from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..routers.firewall import _creds
from ..services.ai_client import ai_health, chat_with_ai
from ..services.ai_context import build_ai_context

router = APIRouter(prefix="/api/ai", tags=["ai"])


Role = Literal["system", "user", "assistant"]


class ChatMessageIn(BaseModel):
    role: Role
    content: str


class ChatRequest(BaseModel):
    conversation_id: Optional[str] = None
    messages: List[ChatMessageIn]
    stream: bool = False
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_output_tokens: int = Field(default=600, ge=1, le=8192)
    top_p: float = Field(default=1.0, ge=0.0, le=1.0)
    context: Dict[str, Any] = {}


@router.get("/health")
async def health():
    try:
        upstream = await ai_health()
        return {"status": "ok", "upstream": upstream}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI service unavailable: {str(e)}")


@router.post("/chat")
async def chat(req: ChatRequest, creds=Depends(_creds)):
    if not req.messages:
        raise HTTPException(status_code=400, detail="messages is required")

    conversation_id = req.conversation_id or f"sail-{int(datetime.now(timezone.utc).timestamp())}"

    sail_context = build_ai_context(
        creds=creds,
        extra_context=req.context,
    )

    payload = {
        "conversation_id": conversation_id,
        "messages": [m.model_dump() for m in req.messages],
        "stream": req.stream,
        "temperature": req.temperature,
        "max_output_tokens": req.max_output_tokens,
        "top_p": req.top_p,
        "context": sail_context,
    }

    try:
        result = await chat_with_ai(payload)
        return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI service error: {str(e)}")