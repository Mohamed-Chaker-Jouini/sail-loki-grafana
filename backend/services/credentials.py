from dataclasses import dataclass, field
from typing import Optional

@dataclass
class SRXCredentials:
    host: str = ""
    username: str = "root"
    password: str = ""
    port: int = 830

_store: SRXCredentials = SRXCredentials()

def get_credentials() -> SRXCredentials:
    return _store

def set_credentials(host: str, username: str, password: str, port: int) -> None:
    global _store
    _store.host     = host.strip()
    _store.username = username.strip()
    _store.password = password
    _store.port     = int(port)

def clear_credentials() -> None:
    global _store
    _store = SRXCredentials()

def credentials_set() -> bool:
    return bool(_store.host and _store.password)