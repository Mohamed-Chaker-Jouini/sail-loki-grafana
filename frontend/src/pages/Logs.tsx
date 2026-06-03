import { useState, useCallback, useRef } from 'react'
import { showToast } from '../components/Toast'

interface LogEntry {
  ts_ns:    number
  ts_ms:    number
  line:     string
  task:     string
  status:   string
  play:     string
  host:     string
  playbook: string
}

const STATUS_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  changed:     { bg: '#FFF3E6', color: '#CC4E00', border: '#F5CCB0' },
  failed:      { bg: '#FDECEA', color: '#C54E4B', border: '#EDBBBA' },
  unreachable: { bg: '#FDECEA', color: '#C54E4B', border: '#EDBBBA' },
  ok:          { bg: 'var(--hpe-green-lt)', color: 'var(--hpe-green-dk)', border: 'var(--hpe-green-mid)' },
  skipped:     { bg: '#F5F5F5', color: '#6B7775', border: '#D5DCD9' },
  started:     { bg: '#EEF2FF', color: '#6B40A8', border: '#D4C5F9' },
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_COLORS[status] ?? STATUS_COLORS['ok']
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '.04em',
      borderRadius: 2, whiteSpace: 'nowrap',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
    }}>
      {status || '—'}
    </span>
  )
}

const COOLDOWN_SECS = 15

export default function Logs() {
  const [entries,   setEntries]   = useState<LogEntry[]>([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [lastFetch, setLastFetch] = useState<Date | null>(null)
  const [cooldown,  setCooldown]  = useState(0)
  const [queried,   setQueried]   = useState(false)

  // filters
  const [status,  setStatus]  = useState('')
  const [search,  setSearch]  = useState('')
  const [range,   setRange]   = useState('1h')
  const [limit,   setLimit]   = useState(100)

  const cooldownTimer = useRef<ReturnType<typeof setInterval>>()

  const startCooldown = useCallback(() => {
    setCooldown(COOLDOWN_SECS)
    clearInterval(cooldownTimer.current)
    cooldownTimer.current = setInterval(() => {
      setCooldown((prev: number) => {
        if (prev <= 1) { clearInterval(cooldownTimer.current); return 0 }
        return prev - 1
      })
    }, 1000)
  }, [])

  const fetchLogs = useCallback(async () => {
    if (cooldown > 0) return
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({
        status, search, range, limit: String(limit),
      })
      const r = await fetch(`/api/logs?${params}`)
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.detail || r.statusText)
      }
      const data = await r.json()
      setEntries(data.entries)
      setLastFetch(new Date())
      setQueried(true)
      startCooldown()
      if (data.entries.length === 0) showToast('No log entries found for this query')
    } catch (e: any) {
      setError(e.message)
      showToast('Logs error: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [cooldown, status, search, range, limit, startCooldown])

  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: 'var(--muted)',
    textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4,
    display: 'block',
  }

  return (
    <div>
      {/* filter bar */}
      <div style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        padding: '14px 28px',
        display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)} style={{ minWidth: 140 }}>
            <option value="">All statuses</option>
            <option value="ok">Ok</option>
            <option value="changed">Changed</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
            <option value="unreachable">Unreachable</option>
            <option value="started">Started</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Search</label>
          <input
            type="text" value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchLogs()}
            placeholder="task name, log line…"
            style={{ width: 240 }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Time Range</label>
          <select value={range} onChange={e => setRange(e.target.value)}>
            <option value="1h">Last 1 hour</option>
            <option value="6h">Last 6 hours</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Limit</label>
          <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          {lastFetch && (
            <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700,
                           letterSpacing: '.04em', paddingBottom: 7 }}>
              Fetched: {lastFetch.toLocaleTimeString()}
            </span>
          )}
          <button
            className="primary"
            onClick={fetchLogs}
            disabled={loading || cooldown > 0}
            style={{ height: 32, padding: '0 18px' }}
          >
            {loading
              ? '● Loading…'
              : cooldown > 0
                ? `Search (${cooldown}s)`
                : '● Search Logs'}
          </button>
        </div>
      </div>

      {/* stats strip */}
      {queried && (
        <div style={{
          background: 'var(--stats-bg)',
          borderBottom: '2px solid var(--hpe-green-mid)',
          padding: '10px 28px',
          display: 'flex', gap: 24, alignItems: 'center',
        }}>
          <div>
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)',
                           textTransform: 'uppercase', letterSpacing: '.1em' }}>
              Results&nbsp;
            </span>
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
              {entries.length}
            </span>
          </div>
          {(['changed','failed','ok','skipped'] as const).map(s => {
            const count = entries.filter(e => e.status === s).length
            if (!count) return null
            return (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <StatusBadge status={s} />
                <span style={{ fontSize: 13, fontWeight: 700 }}>{count}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* error */}
      {error && (
        <div style={{
          background: 'var(--red-lt)', borderBottom: '2px solid var(--red)',
          color: '#7A2020', padding: '10px 28px', fontSize: 12, fontWeight: 700,
        }}>
          ⚠ {error}
        </div>
      )}

      {/* log entries */}
      <div style={{ padding: '0 28px 28px' }}>
        {!queried && !loading && (
          <div className="empty" style={{ marginTop: 28 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Set filters and click Search Logs
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Queries Loki for Ansible task events from the SAIL playbook
            </div>
          </div>
        )}

        {loading && <div className="loading" style={{ marginTop: 28 }}>● Querying Loki…</div>}

        {!loading && queried && entries.length === 0 && (
          <div className="empty" style={{ marginTop: 28 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📭</div>
            <div>No log entries found. Try a wider time range or different filters.</div>
          </div>
        )}

        {!loading && entries.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              background: 'var(--surface)',
              border: '1px solid var(--border)', fontSize: 12,
            }}>
              <thead>
                <tr style={{ background: 'var(--hpe-green)' }}>
                  {['Timestamp','Status','Task','Play','Host','Log Line'].map(h => (
                    <th key={h} style={{
                      textAlign: 'left', padding: '10px 12px',
                      fontSize: 10, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '.07em',
                      color: '#fff', borderRight: '1px solid rgba(255,255,255,.2)',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr
                    key={e.ts_ns + '-' + i}
                    style={{
                      borderBottom: '1px solid var(--border-lt)',
                      background: i % 2 === 1 ? 'var(--row-even)' : 'var(--surface)',
                    }}
                  >
                    <td style={{
                      padding: '8px 12px', fontFamily: 'monospace',
                      fontSize: 11, whiteSpace: 'nowrap', color: 'var(--muted)',
                    }}>
                      {new Date(e.ts_ms).toLocaleString()}
                    </td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      <StatusBadge status={e.status} />
                    </td>
                    <td style={{
                      padding: '8px 12px', fontFamily: 'monospace',
                      fontSize: 11, maxWidth: 200,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={e.task}>
                      {e.task || '—'}
                    </td>
                    <td style={{
                      padding: '8px 12px', fontSize: 11,
                      color: 'var(--muted)', whiteSpace: 'nowrap',
                    }}>
                      {e.play || '—'}
                    </td>
                    <td style={{
                      padding: '8px 12px', fontFamily: 'monospace',
                      fontSize: 11, whiteSpace: 'nowrap',
                    }}>
                      {e.host || '—'}
                    </td>
                    <td style={{
                      padding: '8px 12px', fontFamily: 'monospace',
                      fontSize: 11, color: 'var(--text-2)',
                      maxWidth: 400, wordBreak: 'break-word',
                    }}>
                      {e.line}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}