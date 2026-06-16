import time
from contextlib import contextmanager
from jnpr.junos import Device
from jnpr.junos.utils.config import Config
from jnpr.junos.exception import ConnectError, RpcError
from lxml import etree
import ipaddress
from .credentials import SRXCredentials

# ── Book name constants ────────────────────────────────────────────────────────
# Ansible ONLY ever writes to MORPHEUS_MANAGED. The UI NEVER writes there.
# Manual entries (VPNs, physical servers, etc.) go into MANUAL_ENTRIES.
# Quarantine is a deny-precedence set inside MORPHEUS_MANAGED that Ansible
# does not touch (it only manages SET_<ZONE> sets, not SET_QUARANTINE).
MORPHEUS_BOOK  = "MORPHEUS_MANAGED"
MANUAL_BOOK    = "MANUAL_ENTRIES"
QUARANTINE_SET = "SET_QUARANTINE"
# ── real zone resolution (ground truth, not naming convention) ───────────────
# Figures out which security zone an IP actually lives in by combining
# `security zones security-zone <name> { interfaces { ... } }` with the
# subnet configured on each of those interfaces. This replaces guessing a
# zone from an address-set name (e.g. "SET_WEB" -> "WEB_ZONE"), which only
# works if that exact convention is followed on the box. Works for both
# Morpheus-managed and manual IPs since both sit in the same subnets either way.

def _zone_interfaces(creds: SRXCredentials) -> dict[str, list[str]]:
    filter_xml = """
    <configuration>
      <security>
        <zones/>
      </security>
    </configuration>
    """
    with _connected_dev(creds) as dev:
        config = dev.rpc.get_config(filter_xml=etree.fromstring(filter_xml))

    result: dict[str, list[str]] = {}
    for zone in config.iter("security-zone"):
        name_el = zone.find("name")
        if name_el is None or not name_el.text:
            continue
        zname = name_el.text.strip()
        ifaces = []
        iface_block = zone.find("interfaces")
        if iface_block is not None:
            for iface in iface_block.findall("name"):
                if iface.text:
                    ifaces.append(iface.text.strip())
        result[zname] = ifaces
    return result


def _interface_subnets(creds: SRXCredentials) -> dict[str, str]:
    filter_xml = """
    <configuration>
      <interfaces/>
    </configuration>
    """
    with _connected_dev(creds) as dev:
        config = dev.rpc.get_config(filter_xml=etree.fromstring(filter_xml))

    result: dict[str, str] = {}
    for iface in config.iter("interface"):
        ifname_el = iface.find("name")
        if ifname_el is None or not ifname_el.text:
            continue
        ifname = ifname_el.text.strip()
        for unit in iface.findall("unit"):
            unum_el = unit.find("name")
            unum = unum_el.text.strip() if unum_el is not None and unum_el.text else "0"
            family = unit.find("family")
            inet = family.find("inet") if family is not None else None
            if inet is None:
                continue
            for addr in inet.findall("address"):
                name_el = addr.find("name")
                if name_el is not None and name_el.text:
                    result[f"{ifname}.{unum}"] = name_el.text.strip()
    return result


def build_ip_zone_resolver(creds: SRXCredentials):
    """
    Returns a function resolve(ip) -> zone_name based on real interface/subnet
    config — not a naming guess. Returns "" if nothing configured matches.
    """
    zone_ifaces  = _zone_interfaces(creds)
    iface_subnet = _interface_subnets(creds)

    iface_to_zone: dict[str, str] = {}
    for zname, ifaces in zone_ifaces.items():
        for ifc in ifaces:
            iface_to_zone[ifc] = zname

    nets: list[tuple[ipaddress.IPv4Network, str]] = []
    for ifc, cidr in iface_subnet.items():
        zname = iface_to_zone.get(ifc)
        if not zname:
            continue
        try:
            nets.append((ipaddress.ip_network(cidr, strict=False), zname))
        except ValueError:
            continue
    nets.sort(key=lambda t: t[0].prefixlen, reverse=True)  # most specific subnet wins

    def resolve(ip: str) -> str:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return ""
        for net, zname in nets:
            if addr in net:
                return zname
        return ""

    return resolve

def get_topology(creds: SRXCredentials) -> dict:
    """Queries the vSRX and builds a real-time React Flow topology map."""
    book = get_address_book(creds)
    manual_book = get_address_book(creds, book_name=MANUAL_BOOK)
    quarantined = get_quarantined_ips(creds)

    nodes_map = {}
    edges = []

    nodes_map["srx"] = {
        "id": "srx",
        "title": "vSRX",
        "subTitle": creds.host,
        "mainStat": "Firewall",
        "color": "orange"
    }

    assigned_ips = set()

    for aset in book.get("address_sets", []):
        set_name = aset["name"]
        if set_name == QUARANTINE_SET:
            continue  # rendered separately
        zone_id = f"zone_{set_name.replace('SET_', '').lower()}"
        color = "purple" if "WEB" in set_name.upper() else "blue"
        nodes_map[zone_id] = {
            "id": zone_id,
            "title": set_name,
            "subTitle": f"{set_name.replace('SET_', '')} Tier",
            "mainStat": f"{len(aset['addresses'])} VMs",
            "color": color
        }
        edges.append({"id": f"srx-{zone_id}", "source": "srx", "target": zone_id})

        for ip in aset.get("addresses", []):
            assigned_ips.add(ip)
            is_quarantined = ip in quarantined
            if ip not in nodes_map:
                nodes_map[ip] = {
                    "id": ip,
                    "title": ip,
                    "subTitle": f"{set_name.replace('SET_', '')} VM",
                    "mainStat": "QUARANTINED" if is_quarantined else "LIVE",
                    "color": "red" if is_quarantined else "green",
                    "source": "morpheus",
                }
            edges.append({"id": f"{zone_id}-{ip}", "source": zone_id, "target": ip})

    # Manual entries
    for aset in manual_book.get("address_sets", []):
        set_name = aset["name"]
        zone_id = f"zone_manual_{set_name.replace('SET_', '').lower()}"
        nodes_map[zone_id] = {
            "id": zone_id,
            "title": f"{set_name} (Manual)",
            "subTitle": "Manually managed",
            "mainStat": f"{len(aset['addresses'])} IPs",
            "color": "semi-dark-blue"
        }
        edges.append({"id": f"srx-{zone_id}", "source": "srx", "target": zone_id})
        for ip in aset.get("addresses", []):
            assigned_ips.add(ip)
            if ip not in nodes_map:
                nodes_map[ip] = {
                    "id": ip,
                    "title": ip,
                    "subTitle": "Manual Entry",
                    "mainStat": "MANUAL",
                    "color": "blue",
                    "source": "manual",
                }
            edges.append({"id": f"{zone_id}-{ip}", "source": zone_id, "target": ip})

    for addr in book.get("addresses", []):
        ip = addr["name"]
        if ip not in assigned_ips and ip not in nodes_map:
            nodes_map[ip] = {
                "id": ip,
                "title": ip,
                "subTitle": "Orphaned",
                "mainStat": "NO ZONE",
                "color": "red"
            }

    return {"nodes": list(nodes_map.values()), "edges": edges}


# ── helpers ────────────────────────────────────────────────────────────────────

@contextmanager
def _connected_dev(creds: SRXCredentials, max_retries: int = 3, delay: int = 2):
    dev = Device(
        host=creds.host,
        user=creds.username,
        password=creds.password,
        port=creds.port,
        gather_facts=False,
    )
    connected = False
    for attempt in range(max_retries):
        try:
            dev.open()
            connected = True
            break
        except ConnectError as e:
            if attempt == max_retries - 1:
                raise RuntimeError(
                    f"Failed to connect to vSRX at {creds.host} after {max_retries} attempts: {e}"
                )
            time.sleep(delay)
    try:
        yield dev
    finally:
        if connected:
            dev.close()


def _xml_text(element, path: str) -> str:
    el = element.find(path)
    return el.text.strip() if el is not None and el.text else ""

def _xml_list(element, tag: str) -> list[str]:
    if element is None:
        return []
    return [el.text.strip() for el in element.findall(tag) if el.text]


# ── address book ───────────────────────────────────────────────────────────────

def get_address_book(creds: SRXCredentials, book_name: str = MORPHEUS_BOOK) -> dict:
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
    with _connected_dev(creds) as dev:
        config = dev.rpc.get_config(filter_xml=etree.fromstring(filter_xml))

    ns = {"j": "http://xml.juniper.net/xnm/1.1/xnm"}
    book = config.find(".//address-book", ns)
    if book is None:
        book = config.find(".//address-book")

    addresses = []
    address_sets = []

    if book is not None:
        for addr in book.findall("address"):
            name   = _xml_text(addr, "name")
            prefix = _xml_text(addr, "ip-prefix")
            if name:
                addresses.append({"name": name, "prefix": prefix})

        for aset in book.findall("address-set"):
            set_name  = _xml_text(aset, "name")
            set_addrs = [
                _xml_text(a, "name")
                for a in aset.findall("address")
                if _xml_text(a, "name")
            ]
            if set_name:
                address_sets.append({"name": set_name, "addresses": set_addrs})

    return {
        "book_name":    book_name,
        "addresses":    addresses,
        "address_sets": address_sets,
    }


def get_enriched_address_book(creds: SRXCredentials) -> dict:
    morpheus_book = get_address_book(creds, MORPHEUS_BOOK)
    manual_book   = get_address_book(creds, MANUAL_BOOK)
    quarantined   = set(get_quarantined_ips(creds))
    resolve_zone  = build_ip_zone_resolver(creds)          # ← new line

    manual_by_set: dict[str, set[str]] = {}
    for aset in manual_book.get("address_sets", []):
        manual_by_set[aset["name"]] = set(aset["addresses"])

    enriched_sets = []
    for aset in morpheus_book.get("address_sets", []):
        if aset["name"] == QUARANTINE_SET:
            continue
        manual_ips = manual_by_set.get(aset["name"], set())
        all_ips = list(dict.fromkeys(aset["addresses"] + list(manual_ips)))
        enriched_sets.append({
            "name": aset["name"],
            "addresses": [
                {
                    "ip": ip,
                    "source": "manual" if ip in manual_ips else "morpheus",
                    "quarantined": ip in quarantined,
                    "zone": resolve_zone(ip),               # ← new key
                }
                for ip in all_ips
            ]
        })

    morpheus_set_names = {s["name"] for s in morpheus_book.get("address_sets", [])}
    for aset in manual_book.get("address_sets", []):
        if aset["name"] not in morpheus_set_names:
            enriched_sets.append({
                "name": aset["name"],
                "addresses": [
                    {
                        "ip": ip,
                        "source": "manual",
                        "quarantined": ip in quarantined,
                        "zone": resolve_zone(ip),            # ← new key
                    }
                    for ip in aset["addresses"]
                ]
            })

    return {
        "book_name":   MORPHEUS_BOOK,
        "quarantined": list(quarantined),
        "address_sets": enriched_sets,
    }

# ── quarantine ─────────────────────────────────────────────────────────────────

def get_quarantined_ips(creds: SRXCredentials) -> list[str]:
    """Returns IPs currently in SET_QUARANTINE."""
    book = get_address_book(creds, MORPHEUS_BOOK)
    for aset in book.get("address_sets", []):
        if aset["name"] == QUARANTINE_SET:
            return aset["addresses"]
    return []


def quarantine_ip(creds: SRXCredentials, ip: str) -> None:
    """
    Adds the IP to SET_QUARANTINE inside MORPHEUS_MANAGED.
    The address object already exists (Ansible created it); we just add it
    to the quarantine set. A deny policy for SET_QUARANTINE must exist
    (see setup instructions in README). Ansible's reconciliation loop only
    manages SET_<ZONE> sets, so this set is UI-owned and safe from being
    wiped by automation.
    """
    commands = [
        f"set security address-book {MORPHEUS_BOOK} address-set {QUARANTINE_SET} address {ip}",
    ]
    _apply_commands(creds, commands)


def release_quarantine(creds: SRXCredentials, ip: str) -> None:
    """Removes an IP from SET_QUARANTINE, restoring normal policy evaluation."""
    commands = [
        f"delete security address-book {MORPHEUS_BOOK} address-set {QUARANTINE_SET} address {ip}",
    ]
    _apply_commands(creds, commands)


# ── manual entries (MANUAL_ENTRIES book) ──────────────────────────────────────

def add_manual_ip(creds: SRXCredentials, zone: str, ip: str) -> None:
    """
    Adds an IP to MANUAL_ENTRIES book. This book is entirely UI-owned;
    Ansible never touches it. Zone set name convention mirrors Morpheus:
    SET_<ZONE> so policies can reference the same zone sets if needed.
    """
    set_name = f"SET_{zone.upper()}"
    prefix   = ip if "/" in ip else f"{ip}/32"
    commands = [
        f"set security address-book {MANUAL_BOOK} address {ip} {prefix}",
        f"set security address-book {MANUAL_BOOK} address-set {set_name} address {ip}",
    ]
    _apply_commands(creds, commands)


def remove_manual_ip(creds: SRXCredentials, zone: str, ip: str) -> None:
    """Removes a manual IP from its zone set in MANUAL_ENTRIES."""
    set_name = f"SET_{zone.upper()}"
    commands = [
        f"delete security address-book {MANUAL_BOOK} address-set {set_name} address {ip}",
        f"delete security address-book {MANUAL_BOOK} address {ip}",
    ]
    _apply_commands(creds, commands)


# ── Morpheus-managed write guard ───────────────────────────────────────────────
# These are kept for backwards compatibility but now raise if called on
# MORPHEUS_MANAGED. The router layer enforces this too, but defence-in-depth.

def add_ip_to_zone(creds: SRXCredentials, zone: str, ip: str,
                   book_name: str = MORPHEUS_BOOK) -> None:
    if book_name == MORPHEUS_BOOK:
        raise PermissionError(
            f"Direct writes to {MORPHEUS_BOOK} are blocked. "
            "Use add_manual_ip() or let Ansible manage this book."
        )
    add_manual_ip(creds, zone, ip)


def remove_ip_from_zone(creds: SRXCredentials, zone: str, ip: str,
                        book_name: str = MORPHEUS_BOOK) -> None:
    if book_name == MORPHEUS_BOOK:
        raise PermissionError(
            f"Direct writes to {MORPHEUS_BOOK} are blocked. "
            "Use remove_manual_ip() or quarantine_ip() instead."
        )
    remove_manual_ip(creds, zone, ip)


def delete_address(creds: SRXCredentials, ip: str,
                   book_name: str = MORPHEUS_BOOK) -> None:
    if book_name == MORPHEUS_BOOK:
        raise PermissionError(
            f"Direct deletes from {MORPHEUS_BOOK} are blocked. "
            "Use quarantine_ip() for emergency blocks, or remove the AppTier "
            "tag in Morpheus and let Ansible reconcile."
        )
    # For manual book, removing from all sets and deleting the object
    manual_book = get_address_book(creds, MANUAL_BOOK)
    commands = []
    for aset in manual_book.get("address_sets", []):
        if ip in aset["addresses"]:
            commands.append(
                f"delete security address-book {MANUAL_BOOK} "
                f"address-set {aset['name']} address {ip}"
            )
    commands.append(f"delete security address-book {MANUAL_BOOK} address {ip}")
    _apply_commands(creds, commands)


def get_policies(creds: SRXCredentials) -> list[dict]:
    filter_xml = """
    <configuration>
      <security>
        <policies/>
      </security>
    </configuration>
    """
    with _connected_dev(creds) as dev:
        config = dev.rpc.get_config(filter_xml=etree.fromstring(filter_xml))

    policies = []
    for ctx in config.iter("policy"):
        from_zone = ""
        to_zone   = ""
        parent = ctx.getparent()
        if parent is not None:
            fz = parent.find("from-zone-name")
            tz = parent.find("to-zone-name")
            from_zone = fz.text.strip() if fz is not None and fz.text else ""
            to_zone   = tz.text.strip() if tz is not None and tz.text else ""

        name_el     = ctx.find("name")
        policy_name = name_el.text.strip() if name_el is not None and name_el.text else ""
        action      = "unknown"
        then        = ctx.find("then")
        if then is not None:
            for a in ("permit", "deny", "reject"):
                if then.find(a) is not None:
                    action = a
                    break

        match = ctx.find("match")
        source_addresses = _xml_list(match, "source-address")
        destination_addresses = _xml_list(match, "destination-address")
        ports = [_humanize_application(a) for a in _xml_list(match, "application")]

        if policy_name:
            policies.append({
                "from_zone": from_zone,
                "to_zone": to_zone,
                "name": policy_name,
                "action": action,
                "source_addresses": source_addresses,
                "destination_addresses": destination_addresses,
                "ports": ports,
            })

    return policies


# ── internal ───────────────────────────────────────────────────────────────────

def _apply_commands(creds: SRXCredentials, commands: list[str]) -> None:
    with _connected_dev(creds) as dev:
        with Config(dev, mode="exclusive") as cu:
            for cmd in commands:
                cu.load(cmd, format="set")
            cu.pdiff()
            cu.commit(comment="SAIL control panel", timeout=30)


# ══════════════════════════════════════════════════════════════════════════════
# SAIL-managed policy rules
# Convention: all policies and application objects created here are prefixed
# SAIL_ so they're distinguishable from Ansible-managed rules.
# Ansible only manages zone address-sets — it never touches policies — so
# SAIL_ policies survive reconciliation runs without conflict.
# ══════════════════════════════════════════════════════════════════════════════

def get_security_zones(creds: SRXCredentials) -> list[str]:
    """
    Returns the names of all configured security zones from
    `security zones security-zone`. These are the valid zone names
    for policy from-zone / to-zone — NOT the address book set names
    (SET_WEB etc.), which are a separate config tree.
    """
    filter_xml = """
    <configuration>
      <security>
        <zones/>
      </security>
    </configuration>
    """
    with _connected_dev(creds) as dev:
        config = dev.rpc.get_config(filter_xml=etree.fromstring(filter_xml))

    zones = []
    for zone in config.iter("security-zone"):
        name_el = zone.find("name")
        if name_el is not None and name_el.text:
            zones.append(name_el.text.strip())
    return zones


SAIL_POLICY_PREFIX = "SAIL_"
SAIL_APP_PREFIX    = "SAIL_APP_"

# Junos built-in application objects so we don't create redundant custom objects
_JUNOS_BUILTIN: dict[tuple[int, str], str] = {
    (20,   "tcp"): "junos-ftp",
    (21,   "tcp"): "junos-ftp",
    (22,   "tcp"): "junos-ssh",
    (23,   "tcp"): "junos-telnet",
    (25,   "tcp"): "junos-smtp",
    (53,   "udp"): "junos-dns-udp",
    (53,   "tcp"): "junos-dns-tcp",
    (80,   "tcp"): "junos-http",
    (110,  "tcp"): "junos-pop3",
    (143,  "tcp"): "junos-imap",
    (443,  "tcp"): "junos-https",
    (3306, "tcp"): "junos-mysql",
    (3389, "tcp"): "junos-rdp",
}
_BUILTIN_TO_PORT = {v: f"{proto}/{port}" for (port, proto), v in _JUNOS_BUILTIN.items()}

def _humanize_application(app: str) -> str:
    """Turns a Junos application/object name back into a readable port string."""
    if app == "any":
        return "any"
    if app in _BUILTIN_TO_PORT:
        return _BUILTIN_TO_PORT[app]
    if app.startswith(SAIL_APP_PREFIX):
        rest = app[len(SAIL_APP_PREFIX):]
        parts = rest.split("_")
        if len(parts) == 2:
            proto, port = parts
            return f"{proto.lower()}/{port}"
    return app


def get_sail_policies(creds: SRXCredentials) -> list[dict]:
    """Returns only SAIL_-prefixed policies — UI-owned, Ansible never creates these."""
    return [p for p in get_policies(creds) if p["name"].startswith(SAIL_POLICY_PREFIX)]


def create_policy_rule(creds: SRXCredentials, rule: dict) -> None:
    """
    Creates an SRX security policy from a rule dict:

        {
          "name": "WEB_TO_DB_MYSQL",           # will become SAIL_WEB_TO_DB_MYSQL
          "from_zone": "WEB",
          "to_zone": "DB",
          "source_addresses": ["any"],          # or ["10.0.0.1"]
          "destination_addresses": ["10.0.1.5"],
          "ports": [
              {"protocol": "tcp", "port": 3306},
              {"protocol": "tcp", "port": 443},
              {"protocol": "any", "port": null}, # matches any port
          ],
          "action": "permit"                    # or "deny"
        }

    For well-known ports Junos built-in app objects are used (junos-ssh, etc.).
    Custom ports get a SAIL_APP_TCP_<port> object created automatically.
    Empty ports list → application "any".
    """
    commands: list[str] = []
    app_names: list[str] = []

    ports = rule.get("ports") or []
    if not ports:
        app_names = ["any"]
    else:
        for ps in ports:
            proto = (ps.get("protocol") or "tcp").lower()
            port  = ps.get("port")

            if proto == "any" or port is None:
                if "any" not in app_names:
                    app_names.append("any")
                continue

            port_int = int(port)
            builtin  = _JUNOS_BUILTIN.get((port_int, proto))
            if builtin:
                if builtin not in app_names:
                    app_names.append(builtin)
            else:
                obj = f"{SAIL_APP_PREFIX}{proto.upper()}_{port_int}"
                # Idempotent — SRX silently ignores re-creating an existing app
                commands.append(
                    f"set applications application {obj} "
                    f"protocol {proto} destination-port {port_int}"
                )
                if obj not in app_names:
                    app_names.append(obj)

    policy_name = f"{SAIL_POLICY_PREFIX}{rule['name']}"
    fz, tz = rule["from_zone"], rule["to_zone"]
    match_base = (
        f"set security policies from-zone {fz} to-zone {tz} "
        f"policy {policy_name} match"
    )

    for src in rule.get("source_addresses") or ["any"]:
        commands.append(f"{match_base} source-address {src}")
    for dst in rule.get("destination_addresses") or ["any"]:
        commands.append(f"{match_base} destination-address {dst}")
    for app in app_names:
        commands.append(f"{match_base} application {app}")

    action = rule.get("action", "permit")
    commands.append(
        f"set security policies from-zone {fz} to-zone {tz} "
        f"policy {policy_name} then {action}"
    )

    _apply_commands(creds, commands)


def delete_policy_rule(creds: SRXCredentials, from_zone: str, to_zone: str, name: str) -> None:
    """
    Deletes a SAIL-managed policy. Accepts the name with or without the SAIL_ prefix.
    Does NOT remove application objects — they're harmless if unused and may be
    shared across rules. Remove manually from the SRX if you need to clean them up.
    """
    policy_name = (
        name if name.startswith(SAIL_POLICY_PREFIX)
        else f"{SAIL_POLICY_PREFIX}{name}"
    )
    _apply_commands(creds, [
        f"delete security policies from-zone {from_zone} to-zone {to_zone} "
        f"policy {policy_name}"
    ])