# SAIL Observability Stack
## Technical Documentation

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Repository Structure](#3-repository-structure)
4. [Docker Compose Reference](#4-docker-compose-reference)
5. [Fileserver Reference](#5-fileserver-reference)
6. [Audit UI Reference](#6-audit-ui-reference)
7. [Grafana Setup](#7-grafana-setup)
8. [Loki Setup](#8-loki-setup)
9. [Running the Stack](#9-running-the-stack)
10. [Troubleshooting](#10-troubleshooting)


## 1. Overview

The SAIL Observability Stack is a self-contained Docker Compose deployment that provides real-time visibility into the SAIL reconciliation system. It is the passive counterpart to the active SAIL Ansible playbook — it receives, persists, and visualises the data that the playbook produces after every run.

### What it provides

| Capability | Component | How |
|---|---|---|
| Drift audit log | Fileserver + Audit UI | Every run POSTs a history record; the UI renders it |
| Live topology view | Fileserver + Grafana node-graph | Playbook PUTs `topology.json`; Grafana polls it |
| Task-level log stream | Loki + Grafana | `loki_push.py` callback streams every Ansible task event |
| Compliance export | Audit UI | One-click CSV export of filtered records |

### What it does NOT do

- It does not trigger or schedule reconciliation runs — that is Morpheus's responsibility
- It does not store Grafana dashboards as code in this repo — dashboards are provisioned manually after first boot (see §7)
- It does not authenticate users — deploy behind a VPN or reverse proxy if the stack is reachable from untrusted networks

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  SAIL Ansible Playbook (external)                       │
│                                                         │
│  Phase 4  PUT  /topology.json  ──────────────────────┐  │
│           POST /history        ──────────────────┐   │  │
│  loki_push.py  POST :3100/loki/api/v1/push ───┐  │   │  │
└───────────────────────────────────────────────┼──┼───┼──┘
                                                │  │   │
          ┌─────────────────────────────────────┘  │   │
          │  ┌─────────────────────────────────────┘   │
          │  │  ┌──────────────────────────────────────┘
          ▼  ▼  ▼
┌─────────────────────────────────────────────────────────┐
│  Docker network (default bridge)                        │
│                                                         │
│  ┌──────────────────────┐   ┌──────────────────────┐    │
│  │  sail-fileserver     │   │  sail-loki           │    │
│  │  python:3.12-alpine  │   │  grafana/loki:3.7.1  │    │
│  │  port 8880→80        │   │  port 3100           │    │
│  │                      │   │                      │    │
│  │  GET  /topology.json │   │  POST /loki/api/     │    │
│  │  PUT  /topology.json │   │       v1/push        │    │
│  │  GET  /history       │   │  GET  /loki/api/     │    │
│  │  POST /history       │   │       v1/query_range │    │
│  │  GET  /audit         │   └──────────────────────┘    │
│  │  GET  /health        │             ▲                 │
│  └──────────────────────┘             │ datasource      │
│             ▲                         │                 │
│             │ JSON datasource         │                 │
│             │                ┌────────┴─────────────┐   │
│             └────────────────│  sail-grafana        │   │
│                              │  grafana/grafana:    │   │
│                              │  13.0.1              │   │
│                              │  port 3000           │   │
│                              └──────────────────────┘   │
└─────────────────────────────────────────────────────────┘
          │                    │
          ▼                    ▼
   ./topology/           ./loki-data/
   topology.json         (Loki chunks)
   history.json
```

### Data persistence

| Path (host) | Mounted into | Contains |
|---|---|---|
| `./topology/` | `sail-fileserver:/data` | `topology.json`, `history.json` |
| `./loki-data/` | `sail-loki:/loki` | Loki chunk store and index |
| `./grafana-data/` | `sail-grafana:/var/lib/grafana` | Dashboards, datasources, users |

All three directories are created automatically by Docker on first run. Back them up to preserve audit history and dashboard definitions.

---

## 3. Repository Structure

```
sail-observability/
├── docker-compose.yml      # Stack definition (this document's subject)
├── loki-config.yaml        # Loki single-binary configuration
├── fileserver.py           # Python HTTP server (see §5)
├── audit.html              # Audit UI single-page app (see §6)
├── topology/               # Auto-created; persists topology.json + history.json
├── loki-data/              # Auto-created; persists Loki chunk data
└── grafana-data/           # Auto-created; persists Grafana state
```

---

## 4. Docker Compose Reference

### Services at a glance

| Service | Image | Host port | Purpose |
|---|---|---|---|
| `fileserver` | `python:3.12-alpine` | `8880` | Topology + history REST API and audit UI |
| `loki` | `grafana/loki:3.7.1` | `3100` | Log aggregation backend |
| `grafana` | `grafana/grafana:13.0.1` | `3000` | Dashboards and log explorer |

---

### `fileserver`

```yaml
fileserver:
  image: python:3.12-alpine
  container_name: sail-fileserver
  volumes:
    - ./topology:/data:rw
    - ./fileserver.py:/app/fileserver.py:ro
    - ./audit.html:/app/audit.html:ro
  ports:
    - "8880:80"
  restart: unless-stopped
  entrypoint: ["python3", "/app/fileserver.py"]
```

The fileserver runs as a plain Python process (no Gunicorn, no nginx) directly inside the official `python:3.12-alpine` image. No custom image build is required — the two application files (`fileserver.py` and `audit.html`) are bind-mounted as read-only.

**Volume detail:**

| Mount | Mode | Purpose |
|---|---|---|
| `./topology:/data` | `rw` | Persisted data directory; fileserver reads and writes `topology.json` and `history.json` here |
| `./fileserver.py:/app/fileserver.py` | `ro` | Application code; read-only prevents accidental in-container writes |
| `./audit.html:/app/audit.html` | `ro` | Audit UI; served at `GET /audit` |

**Port:** Host port `8880` maps to container port `80` (the fileserver's default `PORT` env var). To change the host port, update `8880:80` — do not change the container-side port unless you also set `PORT=<n>` in the service environment.

**Environment variables** (all optional, set under `environment:` if needed):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `80` | Listening port inside the container |
| `DATA_DIR` | `/data` | Directory for `topology.json` and `history.json` |
| `MAX_HISTORY_ENTRIES` | `1000` | Rolling cap on history records |

---

### `loki`

```yaml
loki:
  image: grafana/loki:3.7.1
  container_name: sail-loki
  ports:
    - "3100:3100"
  volumes:
    - ./loki-config.yaml:/etc/loki/local-config.yaml
    - ./loki-data:/loki
  command: -config.file=/etc/loki/local-config.yaml
  restart: unless-stopped
```

Loki runs in single-binary mode (the default for `grafana/loki`) — all components (ingester, querier, distributor) run in one process. This is appropriate for the low log volume SAIL produces.

**`loki-config.yaml` — minimal working configuration:**

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory:  /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2020-10-24
      store:       tsdb
      object_store: filesystem
      schema:      v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 720h   # 30 days; requires compactor.retention_enabled: true

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
```

Loki exposes no web UI. It is accessed exclusively via the Grafana Loki datasource and, during development, directly via `curl`:

```bash
# Verify Loki is healthy
curl http://localhost:3100/ready

# Query recent SAIL logs
curl -G http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={job="ansible",project="SAIL"}' \
  --data-urlencode 'limit=20'
```

---

### `grafana`

```yaml
grafana:
  image: grafana/grafana:13.0.1
  container_name: sail-grafana
  ports:
    - "3000:3000"
  volumes:
    - ./grafana-data:/var/lib/grafana
  environment:
    - GF_SECURITY_ADMIN_PASSWORD=admin
    - GF_INSTALL_PLUGINS=marcusolsson-json-datasource
    - HTTP_PROXY=http://10.93.144.53:8080
    - HTTPS_PROXY=http://10.93.144.53:8080
    - NO_PROXY=localhost,127.0.0.1,loki,sail-loki,fileserver,sail-fileserver,10.202.52.0/24
  restart: unless-stopped
  depends_on:
    - loki
    - fileserver
```

**Why `marcusolsson-json-datasource`?**
Grafana's built-in Infinity datasource (available since Grafana 10) can query JSON endpoints, but the `marcusolsson-json-datasource` plugin provides a simpler path-based field extractor that works well with the flat `topology.json` schema. It is installed automatically on first boot via `GF_INSTALL_PLUGINS`.

**Proxy configuration:**
The environment injects a corporate HTTP proxy. The `NO_PROXY` list explicitly bypasses the other stack services by both container name and network alias — without this, Grafana's datasource queries for `topology.json` (via `http://fileserver/...`) and Loki queries would be routed through the proxy and fail.

> **Security note:** `GF_SECURITY_ADMIN_PASSWORD=admin` is a placeholder. Change this before exposing the stack outside a trusted network.

**`depends_on` behaviour:** Compose will start `loki` and `fileserver` before `grafana`, but does not wait for them to be healthy. In practice, Grafana's datasource retry logic handles the brief window where the other services are still initialising.

---

## 5. Fileserver Reference

`fileserver.py` is a single-file Python HTTP server built on `http.server.BaseHTTPRequestHandler`. It requires no third-party dependencies and runs directly on `python:3.12-alpine`.

### API endpoints

| Method | Path | Description | Request body | Success response |
|---|---|---|---|---|
| `GET` | `/topology.json` | Current topology snapshot | — | `200 application/json` |
| `GET` | `/` | Alias for `/topology.json` | — | `200 application/json` |
| `PUT` | `/topology.json` | Overwrite topology snapshot | Raw JSON bytes | `204 No Content` |
| `GET` | `/history` | Full history array | — | `200 application/json` |
| `POST` | `/history` | Append a drift event | JSON object | `200 application/json` |
| `GET` | `/audit` | Audit UI HTML page | — | `200 text/html` |
| `GET` | `/health` | Liveness check | — | `200 application/json` |
| `OPTIONS` | `*` | CORS preflight | — | `204 No Content` |

All JSON responses include `Cache-Control: no-store, no-cache` and `Access-Control-Allow-Origin: *` headers.

---

#### `POST /history` — request schema

The playbook sends this payload at the end of every run. The `changed` field controls whether the record is written.

```json
{
  "ts":         1716000000,
  "run_id":     "job-123456",
  "vsrx_ip":    "10.202.52.10",
  "changed":    true,
  "delta_map":  {
    "WEB": { "to_add": ["10.0.0.3"], "to_remove": [] }
  },
  "new_zones":  ["APP"],
  "duration_s": 14.2
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `changed` | bool | Yes | If `false`, the record is discarded and nothing is written |
| `ts` | int | Recommended | Unix timestamp of the run |
| `run_id` | string | Recommended | Morpheus job ID or Ansible run UUID |
| `vsrx_ip` | string | Recommended | Management IP of the target vSRX |
| `delta_map` | object | Recommended | Per-zone `to_add` / `to_remove` lists |
| `new_zones` | array | Optional | Zones seen for the first time in this run |
| `duration_s` | float | Optional | Playbook wall-clock duration in seconds |

#### `POST /history` — response schema

```json
{
  "written":         true,
  "history_entries": 42,
  "skipped_reason":  null
}
```

If `changed` was `false`, `written` is `false` and `skipped_reason` is `"no changes detected"`.

---

#### `GET /health` — response schema

```json
{
  "status":          "ok",
  "history_entries": 42,
  "max_history":     1000,
  "ts":              1716000000
}
```

Use this endpoint for Docker health checks or uptime monitoring.

---

### Atomic writes

All file writes go through `_atomic_write()`, which writes to a temp file in the same directory, calls `fsync`, then atomically renames it over the target. This guarantees that a reader never observes a half-written file, even if the process is killed mid-write.

### Rolling history cap

When the number of records in `history.json` exceeds `MAX_HISTORY_ENTRIES`, the oldest entries are dropped from the head of the array. The cap is enforced on every successful `POST /history` write.

---

## 6. Audit UI Reference

`audit.html` is a zero-dependency single-page application served at `GET /audit`. It is designed to be opened directly in a browser at `http://<host>:8880/audit` — no build step, no npm, no bundler.

### Features

| Feature | Description |
|---|---|
| **Live table** | Paginated, sortable table of all history records |
| **Statistics bar** | Totals for runs, drift events, IPs added/removed, new zones, and retention |
| **Filters** | Full-text search, status (Drift / Clean), zone, and date range |
| **Detail rows** | Expand any row to see full run metadata and raw `delta_map` JSON |
| **Auto-refresh** | Optional 30-second polling of `/history` |
| **CSV export** | Downloads the currently filtered set as a CSV file |
| **Hash navigation** | Deep-link to a specific row via URL fragment (e.g. `…/audit#r-1716000000-job-123`) |

### Statistics bar fields

| Stat | Description |
|---|---|
| Total Runs | Count of records matching current filters |
| Drift Events | Records where `changed === true` |
| IPs Added | Sum of all `to_add` array lengths across filtered records |
| IPs Removed | Sum of all `to_remove` array lengths across filtered records |
| New Zones | Sum of all `new_zones` array lengths across filtered records |
| Retention | `<filtered count> / <MAX_HISTORY_ENTRIES>` |

### Delta display

Each table row renders two types of change indicators in the Delta column:

- **Green `+` chips** — IPs in `to_add` for a zone
- **Red `−` chips** — IPs in `to_remove` for a zone
- **Orange `NEW ZONE` badge** — zones appearing for the first time

### Synthetic duration flag

If a record's `duration_s` is exactly `2.5`, a `SYNTH` badge is shown. This flags runs where the playbook hardcoded the duration rather than measuring it — useful for identifying test or dry-run records in production history.

### `new_zones` parsing

The UI's `parseNewZones()` function handles three formats that the playbook may produce depending on Ansible version and Jinja2 serialisation:

- Native JSON array: `["APP", "DB"]`
- Python repr string: `['APP', 'DB']`
- Already-parsed array (passed through from a previous processing step)

This normalisation happens once at load time, not on every render.

---

## 7. Grafana Setup

Grafana ships with no pre-configured datasources or dashboards. The following steps are required after first boot.

### First login

Navigate to `http://<host>:3000` and log in with `admin` / `admin` (or whatever password you set in `GF_SECURITY_ADMIN_PASSWORD`). Grafana will prompt you to change the password.

### Add the Loki datasource

1. **Connections → Data sources → Add new data source**
2. Select **Loki**
3. Set URL to `http://sail-loki:3100` (use the container name, not `localhost`)
4. Click **Save & test** — you should see "Data source connected and labels found"

### Add the JSON datasource (topology)

1. **Connections → Data sources → Add new data source**
2. Select **JSON API** (installed via `marcusolsson-json-datasource`)
3. Set URL to `http://sail-fileserver/topology.json`
4. Click **Save & test**

> Use `http://sail-fileserver/` (container name on port 80), not `http://localhost:8880/`. Grafana queries this URL from inside the Docker network.

### Node graph panel (topology)

Create a new dashboard panel, set the datasource to the JSON API source above, and select **Node Graph** as the visualisation type. Map fields as follows:

| Grafana field | JSON path |
|---|---|
| Node ID | `nodes[*].id` |
| Node title | `nodes[*].title` |
| Node subtitle | `nodes[*].subTitle` |
| Node main stat | `nodes[*].mainStat` |
| Node arc colour | `nodes[*].color` |
| Edge source | `edges[*].source` |
| Edge target | `edges[*].target` |

### Loki log panel (task stream)

Add a Logs panel with the Loki datasource and the following LogQL queries:

```logql
# All SAIL task events
{job="ansible", project="SAIL"}

# Drift runs only (changed tasks)
{job="ansible", project="SAIL", status="changed"}

# Failures
{job="ansible", project="SAIL", status="failed"}
```

---

## 8. Loki Setup

Loki requires a `loki-config.yaml` file on the host before the stack starts. Create it at `./loki-config.yaml` using the template in §4.

### Verifying Loki receives logs

After the first SAIL playbook run, query Loki directly:

```bash
curl -G 'http://localhost:3100/loki/api/v1/labels'
# Should return {"status":"success","data":["job","project","playbook","task","status",...]}
```

If the labels list is empty, the `loki_push.py` callback is not reaching Loki. Check:

1. `LOKI_URL` is set in `ansible.cfg` or the environment
2. The control node can reach port `3100` on the Docker host
3. The Loki canary log line (`[SAIL] loki_push loaded OK`) appears in `docker logs sail-loki`

### Log retention

The example config sets `retention_period: 720h` (30 days). Loki will compact and delete chunks older than this automatically. Adjust in `loki-config.yaml` and restart the container.

---

## 9. Running the Stack

### Prerequisites

- Docker Engine ≥ 24 with Compose V2 (`docker compose` not `docker-compose`)
- Ports `3000`, `3100`, and `8880` free on the host
- `loki-config.yaml` present in the same directory as `docker-compose.yml`

### Start

```bash
docker compose up -d
```

On first run, Docker will:
1. Pull the three images (~600 MB total)
2. Install the `marcusolsson-json-datasource` Grafana plugin (requires internet access or a plugin cache)
3. Create `./topology/`, `./loki-data/`, and `./grafana-data/` automatically

### Verify

```bash
# All three containers running
docker compose ps

# Fileserver health
curl http://localhost:8880/health

# Loki ready
curl http://localhost:3100/ready

# Audit UI
open http://localhost:8880/audit   # macOS
# or navigate to http://localhost:8880/audit in a browser
```

### Stop (preserve data)

```bash
docker compose down
```

### Stop and wipe all data

```bash
docker compose down -v
rm -rf ./topology ./loki-data ./grafana-data
```

### Update images

```bash
docker compose pull
docker compose up -d
```

### View logs

```bash
# All services
docker compose logs -f

# Fileserver only
docker compose logs -f fileserver

# Loki only
docker compose logs -f loki
```

---

## 10. Troubleshooting

### Audit UI shows "No audit records yet"

The fileserver is running but no playbook has POSTed to `/history` yet, or all records have `changed: false`. Verify with:

```bash
curl http://localhost:8880/history
```

If the array is empty, trigger a SAIL playbook run. If the run completes but the array is still empty, check the playbook's `fileserver_url` variable points to `http://<docker-host-ip>:8880`.

---

### Grafana node graph is empty / stale

The JSON datasource is polling `topology.json`. Check:

1. The datasource URL uses the container name (`http://sail-fileserver/topology.json`), not `localhost`
2. The fileserver has a topology file: `curl http://localhost:8880/topology.json`
3. The panel refresh interval is not set to "never" — set it to 1m or 5m

---

### Grafana cannot connect to Loki

Symptom: "Data source connected but no labels found" or timeout errors.

1. Confirm Loki is running: `docker compose ps sail-loki`
2. Test connectivity from inside the Grafana container:
   ```bash
   docker exec sail-grafana wget -qO- http://sail-loki:3100/ready
   ```
3. Ensure `NO_PROXY` includes `loki` and `sail-loki` (already set in the Compose file)

---

### `marcusolsson-json-datasource` plugin fails to install

Grafana downloads plugins from `grafana.com` at startup. If the host is behind a proxy without internet access:

1. Download the plugin zip from `https://grafana.com/grafana/plugins/marcusolsson-json-datasource/` on a machine with internet access
2. Place the extracted folder in `./grafana-data/plugins/marcusolsson-json-datasource/`
3. Remove `GF_INSTALL_PLUGINS` from the environment and restart Grafana

---

### `history.json` grows unexpectedly large

The default cap is `MAX_HISTORY_ENTRIES=1000`. If the playbook is running more frequently than expected, reduce it:

```yaml
# docker-compose.yml
fileserver:
  environment:
    - MAX_HISTORY_ENTRIES=200
```

Then restart: `docker compose up -d fileserver`.

---

### Fileserver returns 404 for `/audit`

`audit.html` is not present at the bind-mount source path. Verify:

```bash
ls -la ./audit.html
docker exec sail-fileserver ls /app/
```

Both `fileserver.py` and `audit.html` must exist in the same directory as `docker-compose.yml` before the stack starts.

---

### Port conflicts

If `3000`, `3100`, or `8880` are already in use, change only the host-side port in `docker-compose.yml`:

```yaml
ports:
  - "9000:3000"   # Grafana on 9000 instead of 3000
```

Do not change the container-side port. After changing the fileserver host port, update `fileserver_url` in the SAIL playbook accordingly.