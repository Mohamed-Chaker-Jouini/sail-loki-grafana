from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from ..services import credentials as cred_svc
from ..services import pyez_client as srx

router = APIRouter(prefix="/api/firewall", tags=["firewall"])

# ── helpers ────────────────────────────────────────────────────────────────────

def _creds():
    if not cred_svc.credentials_set():
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail="SRX credentials not configured. Go to Settings.",
        )
    return cred_svc.get_credentials()

def _srx_error(e: Exception):
    raise HTTPException(status_code=502, detail=str(e))

def _guard_error(e: PermissionError):
    """Converts pyez_client PermissionError into a clean 409 for the frontend."""
    raise HTTPException(status_code=409, detail=str(e))


# ── credentials endpoints ──────────────────────────────────────────────────────

class CredentialsPayload(BaseModel):
    host:     str
    username: str = "root"
    password: str
    port:     int = 830

@router.post("/credentials", status_code=204)
def save_credentials(payload: CredentialsPayload):
    cred_svc.set_credentials(
        host=payload.host,
        username=payload.username,
        password=payload.password,
        port=payload.port,
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
    """Raw address book — used by topology view. For the firewall management
    page, prefer /address-book/enriched which tags each IP with its source."""
    try:
        return srx.get_address_book(_creds(), book_name=book)
    except Exception as e:
        _srx_error(e)

@router.get("/address-book/enriched")
def get_enriched_address_book():
    """
    Returns MORPHEUS_MANAGED + MANUAL_ENTRIES merged, with each IP tagged:
      source: 'morpheus' | 'manual'
      quarantined: bool

    This is the primary endpoint for the firewall management page.
    """
    try:
        return srx.get_enriched_address_book(_creds())
    except Exception as e:
        _srx_error(e)

@router.get("/policies")
def get_policies():
    try:
        return {"policies": srx.get_policies(_creds())}
    except Exception as e:
        _srx_error(e)


# ── quarantine (emergency block — Morpheus-managed IPs only) ──────────────────

class QuarantinePayload(BaseModel):
    ip: str

@router.post("/quarantine", status_code=204)
def quarantine_ip(payload: QuarantinePayload):
    """
    Emergency block: adds an IP to SET_QUARANTINE inside MORPHEUS_MANAGED.
    A deny policy for SET_QUARANTINE must exist on the SRX with higher
    priority than zone permit policies. Ansible never touches SET_QUARANTINE,
    so this survives automation reconciliation runs.
    """
    try:
        srx.quarantine_ip(_creds(), payload.ip)
    except Exception as e:
        _srx_error(e)

@router.post("/quarantine/release", status_code=204)
def release_quarantine(payload: QuarantinePayload):
    """Releases an IP from quarantine, restoring normal policy evaluation."""
    try:
        srx.release_quarantine(_creds(), payload.ip)
    except Exception as e:
        _srx_error(e)


# ── manual entry write operations (MANUAL_ENTRIES book only) ──────────────────

class ManualIpPayload(BaseModel):
    zone: str
    ip:   str

@router.post("/manual/add-ip", status_code=204)
def add_manual_ip(payload: ManualIpPayload):
    """
    Adds an IP to MANUAL_ENTRIES (not MORPHEUS_MANAGED).
    Use this for physical servers, VPN endpoints, or any IP not managed
    by Morpheus automation. Ansible will never remove these.
    """
    try:
        srx.add_manual_ip(_creds(), payload.zone, payload.ip)
    except Exception as e:
        _srx_error(e)

@router.post("/manual/remove-ip", status_code=204)
def remove_manual_ip(payload: ManualIpPayload):
    """Removes an IP from a zone set in MANUAL_ENTRIES."""
    try:
        srx.remove_manual_ip(_creds(), payload.zone, payload.ip)
    except Exception as e:
        _srx_error(e)

class ManualDeletePayload(BaseModel):
    ip: str

@router.post("/manual/delete-address", status_code=204)
def delete_manual_address(payload: ManualDeletePayload):
    """Deletes a manual IP address object entirely from MANUAL_ENTRIES."""
    try:
        srx.delete_address(_creds(), payload.ip, book_name=srx.MANUAL_BOOK)
    except PermissionError as e:
        _guard_error(e)
    except Exception as e:
        _srx_error(e)


# ── blocked legacy endpoints (kept for clear error messages) ──────────────────
# These previously wrote to MORPHEUS_MANAGED. They now return 409 with
# a clear explanation rather than silently succeeding.

class _LegacyIpPayload(BaseModel):
    zone: str
    ip:   str
    book: str = "MORPHEUS_MANAGED"

@router.post("/address-book/add-ip", status_code=204)
def add_ip_legacy(payload: _LegacyIpPayload):
    """
    DEPRECATED — kept for backwards compatibility.
    Routes to add_manual_ip if book is not MORPHEUS_MANAGED,
    or raises 409 if someone tries to write to MORPHEUS_MANAGED directly.
    """
    if payload.book == srx.MORPHEUS_BOOK:
        raise HTTPException(
            status_code=409,
            detail=(
                "Direct writes to MORPHEUS_MANAGED are not allowed. "
                "Use POST /api/firewall/manual/add-ip to add a manually-managed IP, "
                "or assign an AppTier tag in Morpheus to let Ansible handle it."
            ),
        )
    try:
        srx.add_manual_ip(_creds(), payload.zone, payload.ip)
    except Exception as e:
        _srx_error(e)

@router.post("/address-book/remove-ip", status_code=204)
def remove_ip_legacy(payload: _LegacyIpPayload):
    """DEPRECATED — see add_ip_legacy."""
    if payload.book == srx.MORPHEUS_BOOK:
        raise HTTPException(
            status_code=409,
            detail=(
                "Direct writes to MORPHEUS_MANAGED are not allowed. "
                "To block a VM immediately, use POST /api/firewall/quarantine. "
                "To remove it permanently, remove the AppTier tag in Morpheus."
            ),
        )
    try:
        srx.remove_manual_ip(_creds(), payload.zone, payload.ip)
    except Exception as e:
        _srx_error(e)

@router.post("/address-book/delete-address", status_code=204)
def delete_address_legacy(payload: ManualDeletePayload):
    """DEPRECATED — see add_ip_legacy."""
    raise HTTPException(
        status_code=409,
        detail=(
            "Direct deletes from MORPHEUS_MANAGED are not allowed. "
            "Use POST /api/firewall/quarantine for emergency blocks, or "
            "POST /api/firewall/manual/delete-address for manual entries."
        ),
    )

# ══════════════════════════════════════════════════════════════════════════════
# SAIL-managed connectivity rules
# These endpoints are the operational layer: engineers use them to define
# per-VM port/zone access without touching the CLI. All policies created
# here are prefixed SAIL_ and are never managed by Ansible.
# ══════════════════════════════════════════════════════════════════════════════

class PortSpec(BaseModel):
    protocol: str = "tcp"   # tcp | udp | any
    port: int | None = None  # None = any port

@router.get("/zones")
def get_security_zones():
    """
    Returns the actual security zone names configured on the SRX
    (under security zones security-zone). These are the valid names
    for policy from-zone / to-zone — distinct from address book set names.
    """
    try:
        return {"zones": srx.get_security_zones(_creds())}
    except Exception as e:
        _srx_error(e)


class PolicyRulePayload(BaseModel):
    name: str
    from_zone: str
    to_zone: str
    source_addresses:      list[str] = ["any"]
    destination_addresses: list[str] = ["any"]
    ports:  list[PortSpec] = []
    action: str = "permit"   # permit | deny

class DeletePolicyPayload(BaseModel):
    from_zone: str
    to_zone:   str
    name:      str


@router.get("/sail-policies")
def get_sail_policies():
    """
    Returns all SAIL_-prefixed security policies — those created through
    this UI. Ansible-managed policies are excluded.
    """
    try:
        return {"policies": srx.get_sail_policies(_creds())}
    except Exception as e:
        _srx_error(e)


@router.post("/sail-policies", status_code=204)
def create_policy_rule(payload: PolicyRulePayload):
    """
    Creates a named SRX security policy for a specific zone-to-zone flow
    with port-level control. The policy is prefixed SAIL_ and is never
    touched by Ansible.

    Port resolution:
      - Well-known ports (22/SSH, 80/HTTP, 443/HTTPS, 3306/MySQL, etc.)
        map to Junos built-in application objects.
      - Custom ports get a SAIL_APP_TCP_<port> application object created
        automatically.
      - Empty ports list → application "any".

    Address resolution:
      - "any" is passed through as-is.
      - Specific IPs must exist in an address book on the SRX (MORPHEUS_MANAGED
        or MANUAL_ENTRIES) — the SRX will reject the commit otherwise.
    """
    try:
        srx.create_policy_rule(_creds(), payload.model_dump())
    except Exception as e:
        _srx_error(e)


@router.post("/sail-policies/delete", status_code=204)
def delete_policy_rule(payload: DeletePolicyPayload):
    """
    Deletes a SAIL-managed policy by name and zone context.
    Does not remove associated application objects (harmless if unused).
    """
    try:
        srx.delete_policy_rule(_creds(), payload.from_zone, payload.to_zone, payload.name)
    except Exception as e:
        _srx_error(e)