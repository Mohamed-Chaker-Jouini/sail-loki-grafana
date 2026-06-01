from jnpr.junos import Device
from jnpr.junos.utils.config import Config
from jnpr.junos.exception import ConnectError, RpcError
from lxml import etree
from typing import Any
from .credentials import SRXCredentials

# ── helpers ────────────────────────────────────────────────────────────────────

def _dev(creds: SRXCredentials):
    return Device(
        host     = creds.host,
        user     = creds.username,
        password = creds.password,
        port     = creds.port,
        gather_facts = False,
    )

def _xml_text(element, path: str) -> str:
    el = element.find(path)
    return el.text.strip() if el is not None and el.text else ""

# ── address book ───────────────────────────────────────────────────────────────

def get_address_book(creds: SRXCredentials, book_name: str = "MORPHEUS_MANAGED") -> dict:
    """
    Returns the full address book as:
    {
      "book_name": "MORPHEUS_MANAGED",
      "addresses": [{"name": "10.0.0.1", "prefix": "10.0.0.1/32"}, ...],
      "address_sets": [{"name": "SET_WEB", "addresses": ["10.0.0.1", ...]}, ...]
    }
    """
    filter_xml = f"""
    <configuration>
      <security>
        <address-book>
          <name>{book_name}</name>
        </address-book>
      </security>
    </configuration>
    """
    with _dev(creds) as dev:
        config = dev.rpc.get_config(filter_xml=etree.fromstring(filter_xml))

    ns   = {"j": "http://xml.juniper.net/xnm/1.1/xnm"}
    book = config.find(".//address-book", ns) or config.find(".//address-book")

    addresses = []
    address_sets = []

    if book is not None:
        for addr in book.findall("address"):
            name   = _xml_text(addr, "name")
            prefix = _xml_text(addr, "ip-prefix")
            if name:
                addresses.append({"name": name, "prefix": prefix})

        for aset in book.findall("address-set"):
            set_name   = _xml_text(aset, "name")
            set_addrs  = [_xml_text(a, "name") for a in aset.findall("address") if _xml_text(a, "name")]
            if set_name:
                address_sets.append({"name": set_name, "addresses": set_addrs})

    return {
        "book_name":    book_name,
        "addresses":    addresses,
        "address_sets": address_sets,
    }


def add_ip_to_zone(creds: SRXCredentials, zone: str, ip: str,
                   book_name: str = "MORPHEUS_MANAGED") -> None:
    """Add an IP to an address book and its zone set."""
    set_name = f"SET_{zone.upper()}"
    prefix   = ip if "/" in ip else f"{ip}/32"
    commands = [
        f"set security address-book {book_name} address {ip} {prefix}",
        f"set security address-book {book_name} address-set {set_name} address {ip}",
    ]
    _apply_commands(creds, commands)


def remove_ip_from_zone(creds: SRXCredentials, zone: str, ip: str,
                        book_name: str = "MORPHEUS_MANAGED") -> None:
    """Remove an IP from its zone set (does not delete the base address object)."""
    set_name = f"SET_{zone.upper()}"
    commands = [
        f"delete security address-book {book_name} address-set {set_name} address {ip}",
    ]
    _apply_commands(creds, commands)


def delete_address(creds: SRXCredentials, ip: str,
                   book_name: str = "MORPHEUS_MANAGED") -> None:
    """Delete the base address object entirely."""
    commands = [
        f"delete security address-book {book_name} address {ip}",
    ]
    _apply_commands(creds, commands)


def get_policies(creds: SRXCredentials) -> list[dict]:
    """
    Returns security policies as a flat list:
    [{"from_zone": "WEB_ZONE", "to_zone": "untrust",
      "name": "DENY_ALL_OUT_WEB", "action": "deny"}, ...]
    """
    filter_xml = """
    <configuration>
      <security>
        <policies/>
      </security>
    </configuration>
    """
    with _dev(creds) as dev:
        config = dev.rpc.get_config(filter_xml=etree.fromstring(filter_xml))

    policies = []
    for ctx in config.iter("policy"):
        from_zone = ""
        to_zone   = ""
        # context block has from-zone-name / to-zone-name siblings
        parent = ctx.getparent()
        if parent is not None:
            fz = parent.find("from-zone-name")
            tz = parent.find("to-zone-name")
            from_zone = fz.text.strip() if fz is not None and fz.text else ""
            to_zone   = tz.text.strip() if tz is not None and tz.text else ""

        name_el   = ctx.find("name")
        policy_name = name_el.text.strip() if name_el is not None and name_el.text else ""

        action = "unknown"
        then   = ctx.find("then")
        if then is not None:
            for a in ("permit", "deny", "reject"):
                if then.find(a) is not None:
                    action = a
                    break

        if policy_name:
            policies.append({
                "from_zone": from_zone,
                "to_zone":   to_zone,
                "name":      policy_name,
                "action":    action,
            })

    return policies


# ── internal ───────────────────────────────────────────────────────────────────

def _apply_commands(creds: SRXCredentials, commands: list[str]) -> None:
    with _dev(creds) as dev:
        with Config(dev, mode="exclusive") as cu:
            for cmd in commands:
                cu.load(cmd, format="set")
            cu.pdiff()
            cu.commit(comment="SAIL control panel", timeout=30)