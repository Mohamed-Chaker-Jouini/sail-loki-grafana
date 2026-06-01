// Grafana panels embedded in kiosk mode.
// Replace GRAFANA_HOST if your host differs.
// Replace TOPOLOGY_PANEL_ID and LOGS_PANEL_ID with the actual
// panel IDs from your Grafana dashboard URL.

const GRAFANA = `http://${window.location.hostname}:3000`

// After you set up your Grafana dashboard, get the panel IDs from
// the panel's "share" URL and replace these:
const TOPOLOGY_PANEL_URL =
  `${GRAFANA}/d-solo/advl29k/topology?orgId=1&panelId=1&kiosk`
const LOGS_PANEL_URL =
  `${GRAFANA}/d-solo/ad77p5h/sail?orgId=1&panelId=1&kiosk`
  
export default function Topology() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 115px)' }}>
      <div style={{ flex: '0 0 55%', borderBottom: '2px solid var(--border)' }}>
        <div style={{
          padding: '8px 16px',
          fontSize: 10, fontWeight: 700,
          color: 'var(--muted)', letterSpacing: '.08em',
          textTransform: 'uppercase',
          background: 'var(--stats-bg)',
          borderBottom: '1px solid var(--hpe-green-mid)',
        }}>
          Live Network Topology
        </div>
        <iframe
          src={TOPOLOGY_PANEL_URL}
          style={{ width: '100%', height: 'calc(100% - 33px)', border: 'none' }}
          title="Topology"
        />
      </div>
      <div style={{ flex: '0 0 45%' }}>
        <div style={{
          padding: '8px 16px',
          fontSize: 10, fontWeight: 700,
          color: 'var(--muted)', letterSpacing: '.08em',
          textTransform: 'uppercase',
          background: 'var(--stats-bg)',
          borderBottom: '1px solid var(--hpe-green-mid)',
        }}>
          Ansible Task Log Stream
        </div>
        <iframe
          src={LOGS_PANEL_URL}
          style={{ width: '100%', height: 'calc(100% - 33px)', border: 'none' }}
          title="Logs"
        />
      </div>
    </div>
  )
}