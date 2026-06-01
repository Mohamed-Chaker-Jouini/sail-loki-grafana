from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from ..services import credentials as cred_svc
from ..services import pyez_client as srx

router = APIRouter(prefix="/api/firewall", tags=["firewall"])

# ── helpers ────────────────────────────────────────────────────────────────────

def _creds():
    if not cred_svc.credentials_set():
        raise HTTPException(
            status_code  = status.HTTP_424_FAILED_DEPENDENCY,
            detail       = "SRX credentials not configured. Go to Settings.",
        )
    return cred_svc.get_credentials()

def _srx_error(e: Exception):
    raise HTTPException(status_code=502, detail=str(e))

# ── settings endpoints ─────────────────────────────────────────────────────────

class CredentialsPayload(BaseModel):
    host:     str
    username: str = "root"
    password: str
    port:     int = 830

@router.post("/credentials", status_code=204)
def save_credentials(payload: CredentialsPayload):
    cred_svc.set_credentials(
        host     = payload.host,
        username = payload.username,
        password = payload.password,
        port     = payload.port,
    )

@router.delete("/credentials", status_code=204)
def clear_credentials():
    cred_svc.clear_credentials()

@router.get("/credentials/status")
def credentials_status():
    c = cred_svc.get_credentials()
    return {
        "configured": cred_svc.credentials_set(),
        "host":       c.host if cred_svc.credentials_set() else "",
        "username":   c.username if cred_svc.credentials_set() else "",
        "port":       c.port,
    }

# ── read operations ────────────────────────────────────────────────────────────

@router.get("/address-book")
def get_address_book(book: str = "MORPHEUS_MANAGED"):
    try:
        return srx.get_address_book(_creds(), book_name=book)
    except Exception as e:
        _srx_error(e)

@router.get("/policies")
def get_policies():
    try:
        return {"policies": srx.get_policies(_creds())}
    except Exception as e:
        _srx_error(e)

# ── write operations ───────────────────────────────────────────────────────────

class AddIpPayload(BaseModel):
    zone: str
    ip:   str
    book: str = "MORPHEUS_MANAGED"

@router.post("/address-book/add-ip", status_code=204)
def add_ip(payload: AddIpPayload):
    try:
        srx.add_ip_to_zone(_creds(), payload.zone, payload.ip, payload.book)
    except Exception as e:
        _srx_error(e)

class RemoveIpPayload(BaseModel):
    zone: str
    ip:   str
    book: str = "MORPHEUS_MANAGED"

@router.post("/address-book/remove-ip", status_code=204)
def remove_ip(payload: RemoveIpPayload):
    try:
        srx.remove_ip_from_zone(_creds(), payload.zone, payload.ip, payload.book)
    except Exception as e:
        _srx_error(e)

class DeleteAddressPayload(BaseModel):
    ip:   str
    book: str = "MORPHEUS_MANAGED"

@router.post("/address-book/delete-address", status_code=204)
def delete_address(payload: DeleteAddressPayload):
    try:
        srx.delete_address(_creds(), payload.ip, payload.book)
    except Exception as e:
        _srx_error(e)