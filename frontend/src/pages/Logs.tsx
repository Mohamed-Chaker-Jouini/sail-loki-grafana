import { useState, useCallback, useRef, useEffect } from 'react'
import { showToast } from '../components/Toast'

// ── module-level cache (survives remounts, not page refresh) ──────────────────
const cache: {
  entries:          LogEntry[]
  lastFetch:        Date | null
  cooldownUntil:    number
  // persist filter state so the user comes back to where they left off
  status:           string
  search:           string
  range:            string
  limit:            number
} = {
  entries:       [],
  lastFetch:     null,
  cooldownUntil: 0,
  status:        '',
  search:        '',
  range:         '7d',   // default to a week so the page is rarely blank
  limit:         100,
}

function remainingSecs(until: number) {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000))
}

// ── types ─────────────────────────────────────────────────────────────────────
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

interface RunGroup {
  playbook: string
  startMs:  number
  endMs:    number
  entries:  LogEntry[]
  hasError: boolean
  changed:  number
}

// ── constants ─────────────────────────────────────────────────────────────────
const STATUS_META: Record<string, { bg: string; color: string; border: string; dot: string }> = {
  changed:     { bg: '#FFF3E6', color: '#CC4E00', border: '#F5CCB0', dot: '#F07820' },
  failed:      { bg: '#FDECEA', color: '#C54E4B', border: '#EDBBBA', dot: '#E24B4A' },
  unreachable: { bg: '#FDECEA', color: '#C54E4B', border: '#EDBBBA', dot: '#E24B4A' },
  ok:          { bg: 'var(--hpe-green-lt)', color: 'var(--hpe-green-dk)', border: 'var(--hpe-green-mid)', dot: '#1D9E75' },
  skipped:     { bg: '#F5F5F5', color: '#6B7775', border: '#D5DCD9', dot: '#888780' },
  started:     { bg: '#EEF2FF', color: '#534AB7', border: '#D4C5F9', dot: '#7F77DD' },
}

const RANGE_OPTIONS = [
  { value: '30m', label: 'Last 30 min' },
  { value: '1h',  label: 'Last 1 hour' },
  { value: '6h',  label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d',  label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]
const LIMIT_OPTIONS    = [50, 100, 200, 500]
const AUTO_INTERVAL_S  = 30
const COOLDOWN_S       = 10

// ── helpers ───────────────────────────────────────────────────────────────────
function groupByRun(entries: LogEntry[]): RunGroup[] {
  if (!entries.length) return []
  const sorted = [...entries].sort((a, b) => a.ts_ms - b.ts_ms)
  const groups: RunGroup[] = []
  let current: LogEntry[] = []

  for (const e of sorted) {
    if (e.status === 'started' && current.length > 0) {
      const g = current
      groups.push({
        playbook: g[0].playbook || 'ansible',
        startMs:  g[0].ts_ms,
        endMs:    g[g.length - 1].ts_ms,
        entries:  g,
        hasError: g.some(x => x.status === 'failed' || x.status === 'unreachable'),
        changed:  g.filter(x => x.status === 'changed').length,
      })
      current = []
    }
    current.push(e)
  }
  if (current.length) {
    groups.push({
      playbook: current[0].playbook || 'ansible',
      startMs:  current[0].ts_ms,
      endMs:    current[current.length - 1].ts_ms,
      entries:  current,
      hasError: current.some(x => x.status === 'failed' || x.status === 'unreachable'),
      changed:  current.filter(x => x.status === 'changed').length,
    })
  }
  return groups.reverse()
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

// ── sub-components ────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const s = STATUS_META[status] ?? STATUS_META['ok']
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '.06em',
      borderRadius: 2, whiteSpace: 'nowrap',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
      {status || '—'}
    </span>
  )
}

function StatCard({ label, value, sub, color }: {
  label: string; value: React.ReactNode; sub?: string; color?: string
}) {
  return (
    <div style={{
      padding: '12px 20px', borderRight: '1px solid var(--hpe-green-mid)',
      minWidth: 110, flex: 1,
    }}>
      <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase',
                    fontWeight: 700, letterSpacing: '.1em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 3, lineHeight: 1,
                    color: color || 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────
export default function Logs() {
  // Initialise all state from cache so remounts are seamless
  const [entries,   setEntries]   = useState<LogEntry[]>(() => cache.entries)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [lastFetch, setLastFetch] = useState<Date | null>(() => cache.lastFetch)
  const [cooldown,  setCooldown]  = useState(() => remainingSecs(cache.cooldownUntil))
  const [autoOn,    setAutoOn]    = useState(false)
  const [countdown, setCountdown] = useState(AUTO_INTERVAL_S)

  // Filters also restored from cache
  const [status, setStatus] = useState(() => cache.status)
  const [search, setSearch] = useState(() => cache.search)
  const [range,  setRange]  = useState(() => cache.range)
  const [limit,  setLimit]  = useState(() => cache.limit)

  const [view,         setView]         = useState<'table' | 'runs'>('runs')
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set([0]))

  const cooldownRef  = useRef<ReturnType<typeof setInterval>>()
  const autoRef      = useRef<ReturnType<typeof setInterval>>()
  const countRef     = useRef<ReturnType<typeof setInterval>>()
  const filterTimer  = useRef<ReturnType<typeof setTimeout>>()

  // Refs so fetchLogs doesn't need to close over filter state or cooldown.
  // Without this, every filter change recreates fetchLogs, which re-triggers
  // the initial-load effect and the filter-debounce effect simultaneously.
  const statusRef   = useRef(status)
  const searchRef   = useRef(search)
  const rangeRef    = useRef(range)
  const limitRef    = useRef(limit)
  const cooldownStateRef = useRef(cooldown)

  useEffect(() => { statusRef.current        = status;   cache.status  = status  }, [status])
  useEffect(() => { searchRef.current        = search;   cache.search  = search  }, [search])
  useEffect(() => { rangeRef.current         = range;    cache.range   = range   }, [range])
  useEffect(() => { limitRef.current         = limit;    cache.limit   = limit   }, [limit])
  useEffect(() => { cooldownStateRef.current = cooldown                           }, [cooldown])

  // ── cooldown ticker ────────────────────────────────────────────────────────
  function startCooldown() {
    cache.cooldownUntil = Date.now() + COOLDOWN_S * 1000
    setCooldown(COOLDOWN_S)
    clearInterval(cooldownRef.current)
    cooldownRef.current = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) { clearInterval(cooldownRef.current); return 0 }
        return prev - 1
      })
    }, 1000)
  }

  // Resume any in-progress cooldown ticker after remount
  useEffect(() => {
    const remaining = remainingSecs(cache.cooldownUntil)
    if (remaining > 0) {
      setCooldown(remaining)
      cooldownRef.current = setInterval(() => {
        setCooldown(prev => {
          if (prev <= 1) { clearInterval(cooldownRef.current); return 0 }
          return prev - 1
        })
      }, 1000)
    }
    return () => {
      clearInterval(cooldownRef.current)
      clearInterval(autoRef.current)
      clearInterval(countRef.current)
      clearTimeout(filterTimer.current)
    }
  }, []) // intentional: run once on mount only

  // ── fetch ──────────────────────────────────────────────────────────────────
  // Reads all filters from refs — no filter/cooldown values in dep array.
  // This makes fetchLogs stable for the lifetime of the component.
  const fetchLogs = useCallback(async (silent = false) => {
    if (!silent && cooldownStateRef.current > 0) return
    if (!silent) setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({
        status: statusRef.current,
        search: searchRef.current,
        range:  rangeRef.current,
        limit:  String(limitRef.current),
      })
      const r = await fetch(`/api/logs?${params}`)
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.detail || r.statusText)
      }
      const data = await r.json()
      cache.entries   = data.entries ?? []
      cache.lastFetch = new Date()
      setEntries(cache.entries)
      setLastFetch(cache.lastFetch)
      if (!silent) startCooldown()
    } catch (e: any) {
      setError(e.message)
      if (!silent) showToast('Logs error: ' + e.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, []) // stable — all inputs read from refs

  // Initial load: skip if we have recent cached data
  useEffect(() => {
    if (cache.entries.length === 0) fetchLogs(true)
  }, [fetchLogs]) // fetchLogs is stable so this runs exactly once

  // Re-fetch on filter change (debounced 400ms); always silent
  useEffect(() => {
    clearTimeout(filterTimer.current)
    filterTimer.current = setTimeout(() => fetchLogs(true), 400)
    return () => clearTimeout(filterTimer.current)
  }, [status, search, range, limit, fetchLogs])

  // ── auto-refresh ───────────────────────────────────────────────────────────
  function toggleAuto() {
    if (autoOn) {
      clearInterval(autoRef.current)
      clearInterval(countRef.current)
      setAutoOn(false)
      setCountdown(AUTO_INTERVAL_S)
    } else {
      setAutoOn(true)
      setCountdown(AUTO_INTERVAL_S)
      autoRef.current = setInterval(() => {
        fetchLogs(true)
        setCountdown(AUTO_INTERVAL_S)
      }, AUTO_INTERVAL_S * 1000)
      countRef.current = setInterval(() => {
        setCountdown(prev => (prev <= 1 ? AUTO_INTERVAL_S : prev - 1))
      }, 1000)
      showToast(`Auto-refresh every ${AUTO_INTERVAL_S}s enabled`)
    }
  }

  // ── row/run expansion ──────────────────────────────────────────────────────
  function toggleRow(i: number) {
    setExpandedRows(prev => {
      const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n
    })
  }
  function toggleRun(i: number) {
    setExpandedRuns(prev => {
      const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n
    })
  }

  // ── derived ────────────────────────────────────────────────────────────────
  const runs      = groupByRun(entries)
  const errCount  = entries.filter(e => e.status === 'failed' || e.status === 'unreachable').length
  const chgCount  = entries.filter(e => e.status === 'changed').length
  const okCount   = entries.filter(e => e.status === 'ok').length
  const skipCount = entries.filter(e => e.status === 'skipped').length

  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: 'var(--muted)',
    textTransform: 'uppercase', letterSpacing: '.07em',
    marginBottom: 4, display: 'block',
  }
  const thStyle: React.CSSProperties = {
    textAlign: 'left', padding: '10px 12px',
    fontSize: 10, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '.07em',
    color: '#fff', borderRight: '1px solid rgba(255,255,255,.2)',
    whiteSpace: 'nowrap',
  }

  return (
    <div>
      {/* ── top toolbar ── */}
      <div style={{
        padding: '10px 28px',
        display: 'flex', alignItems: 'center',
        justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap',
        minHeight: 48, borderBottom: '1px solid var(--border-lt)',
        background: 'var(--surface)',
      }}>
        {autoOn && (
          <span style={{
            fontSize: 10, fontWeight: 700, color: 'var(--hpe-green)',
            border: '1px solid var(--hpe-green)', padding: '3px 10px',
            background: 'var(--hpe-green-lt)', letterSpacing: '.06em',
            textTransform: 'uppercase', borderRadius: 2,
          }}>
            ● Auto {countdown}s
          </span>
        )}
        {lastFetch && (
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em' }}>
            {lastFetch.toLocaleTimeString()}
          </span>
        )}
        <button onClick={toggleAuto}>
          {autoOn ? 'Disable Auto-Refresh' : 'Enable Auto-Refresh'}
        </button>
        <button onClick={() => fetchLogs()} disabled={loading || cooldown > 0}>
          {loading ? '● Loading…' : cooldown > 0 ? `↻ (${cooldown}s)` : '↻ Refresh'}
        </button>

        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 2,
                      overflow: 'hidden', marginLeft: 8 }}>
          {(['runs', 'table'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                borderRadius: 0, border: 'none',
                borderRight: v === 'runs' ? '1px solid var(--border)' : 'none',
                background: view === v ? 'var(--hpe-green)' : 'var(--surface)',
                color:      view === v ? '#fff' : 'var(--text)',
                padding: '0 14px', height: 30, fontSize: 11, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '.04em', cursor: 'pointer',
              }}
            >
              {v === 'runs' ? '⬛ Runs' : '≡ Table'}
            </button>
          ))}
        </div>
      </div>

      {/* ── filter bar ── */}
      <div style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        padding: '12px 28px',
        display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)} style={{ minWidth: 140 }}>
            <option value="">All statuses</option>
            <option value="ok">OK</option>
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
            placeholder="task, host, log line…"
            style={{ width: 220 }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Time Range</label>
          <select value={range} onChange={e => setRange(e.target.value)}>
            {RANGE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Limit</label>
          <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
            {LIMIT_OPTIONS.map(n => (
              <option key={n} value={n}>{n} entries</option>
            ))}
          </select>
        </div>

        {(status || search) && (
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button onClick={() => { setStatus(''); setSearch('') }}>✕ Clear</button>
          </div>
        )}
      </div>

      {/* ── stats strip ── */}
      {entries.length > 0 && (
        <div style={{
          display: 'flex', background: 'var(--stats-bg)',
          borderBottom: '2px solid var(--hpe-green-mid)',
        }}>
          <StatCard label="Events"  value={entries.length} sub={`${runs.length} run${runs.length !== 1 ? 's' : ''}`} />
          <StatCard label="Changed" value={chgCount}  color={chgCount ? '#CC4E00'            : undefined} sub="tasks with changes" />
          <StatCard label="Errors"  value={errCount}  color={errCount ? 'var(--red)'         : undefined} sub="failed / unreachable" />
          <StatCard label="OK"      value={okCount}   color="var(--hpe-green-dk)"                         sub="successful tasks" />
          <StatCard label="Skipped" value={skipCount} color="var(--muted)"                                sub="skipped tasks" />
        </div>
      )}

      {/* ── error ── */}
      {error && (
        <div style={{
          background: 'var(--red-lt)', borderBottom: '2px solid var(--red)',
          color: '#7A2020', padding: '10px 28px', fontSize: 12, fontWeight: 700,
        }}>
          ⚠ {error}
        </div>
      )}

      {/* Show spinner only when there's nothing to display yet */}
      {loading && entries.length === 0 && <div className="loading">● Querying Loki…</div>}

      {/* ── empty ── */}
      {!loading && entries.length === 0 && !error && (
        <div className="empty">
          <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>No log entries found</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Try a wider time range or clear the status filter
          </div>
        </div>
      )}

      {/* ══ RUNS VIEW ══════════════════════════════════════════════════════ */}
      {entries.length > 0 && view === 'runs' && (
        <div style={{ padding: '16px 28px 28px' }}>
          {runs.map((run, ri) => {
            const isOpen = expandedRuns.has(ri)
            const dur    = run.endMs - run.startMs
            const runOk  = !run.hasError
            const accentColor = run.hasError ? 'var(--red)' : run.changed > 0 ? '#F07820' : 'var(--hpe-green)'

            return (
              <div key={ri} style={{
                marginBottom: 10,
                border: `1px solid var(--border)`,
                borderLeft: `3px solid ${accentColor}`,
                borderRadius: 3, background: 'var(--surface)', overflow: 'hidden',
              }}>
                <div
                  onClick={() => toggleRun(ri)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 16px', cursor: 'pointer',
                    background: isOpen ? 'var(--hpe-green-lt)' : 'transparent',
                    borderBottom: isOpen ? '1px solid var(--border-lt)' : 'none',
                    userSelect: 'none',
                  }}
                >
                  <span style={{ fontSize: 14, color: accentColor, width: 16, flexShrink: 0 }}>
                    {isOpen ? '▼' : '▶'}
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--hpe-green)', fontWeight: 700, minWidth: 200 }}>
                    {run.playbook.split('/').pop() || run.playbook}
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)', minWidth: 160 }}>
                    {new Date(run.startMs).toLocaleString()}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', minWidth: 60 }}>
                    {dur > 0 ? fmtDuration(dur) : '—'}
                  </span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {run.hasError && <StatusBadge status="failed" />}
                    {run.changed > 0 && (
                      <span style={{
                        display: 'inline-block', padding: '2px 8px',
                        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '.06em', borderRadius: 2,
                        background: '#FFF3E6', color: '#CC4E00', border: '1px solid #F5CCB0',
                      }}>
                        {run.changed} changed
                      </span>
                    )}
                    {runOk && !run.changed && <StatusBadge status="ok" />}
                  </div>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>
                    {run.entries.length} events
                  </span>
                </div>

                {isOpen && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr>
                        {['Time', 'Status', 'Play', 'Task', 'Host', 'Message'].map(h => (
                          <th key={h} style={{ ...thStyle, background: 'var(--hpe-green)', fontSize: 9, padding: '7px 10px' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {run.entries.map((e, ei) => {
                        const rowKey = ri * 10000 + ei
                        const rowOpen = expandedRows.has(rowKey)
                        return (
                          <>
                            <tr
                              key={rowKey}
                              style={{
                                borderBottom: '1px solid var(--border-lt)',
                                background: ei % 2 === 1 ? 'var(--row-even)' : 'var(--surface)',
                                cursor: e.line.length > 80 ? 'pointer' : 'default',
                              }}
                              onClick={() => e.line.length > 80 && toggleRow(rowKey)}
                            >
                              <td style={{ padding: '7px 10px', fontFamily: 'monospace', whiteSpace: 'nowrap', color: 'var(--muted)', fontSize: 10 }}>
                                {new Date(e.ts_ms).toLocaleTimeString()}
                              </td>
                              <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                                <StatusBadge status={e.status} />
                              </td>
                              <td style={{ padding: '7px 10px', color: 'var(--muted)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.play}>
                                {e.play || '—'}
                              </td>
                              <td style={{ padding: '7px 10px', fontFamily: 'monospace', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }} title={e.task}>
                                {e.task || '—'}
                              </td>
                              <td style={{ padding: '7px 10px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                                {e.host || '—'}
                              </td>
                              <td style={{ padding: '7px 10px', fontFamily: 'monospace', color: 'var(--text-2)', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {e.line}
                                {e.line.length > 80 && (
                                  <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--hpe-green)', fontWeight: 700, textTransform: 'uppercase' }}>
                                    {rowOpen ? '▲' : '▼'}
                                  </span>
                                )}
                              </td>
                            </tr>
                            {rowOpen && (
                              <tr key={rowKey + '-exp'}>
                                <td colSpan={6} style={{ padding: '10px 16px 14px 40px', background: '#F7FDFB', borderBottom: '2px solid var(--hpe-green-lt)' }}>
                                  <div style={{
                                    fontFamily: 'monospace', fontSize: 11,
                                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                    color: 'var(--text)', lineHeight: 1.6,
                                    background: '#fff', padding: '10px 14px',
                                    border: '1px solid var(--border)', borderRadius: 2,
                                  }}>
                                    {e.line}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ══ TABLE VIEW ══════════════════════════════════════════════════════ */}
      {entries.length > 0 && view === 'table' && (
        <div style={{ padding: '16px 28px 28px', overflowX: 'auto' }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse',
            background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12,
          }}>
            <thead>
              <tr style={{ background: 'var(--hpe-green)' }}>
                {['Timestamp', 'Status', 'Task', 'Play', 'Host', 'Log Line', ''].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const isOpen = expandedRows.has(i)
                return (
                  <>
                    <tr
                      key={e.ts_ns + '-' + i}
                      style={{
                        borderBottom: '1px solid var(--border-lt)',
                        background: i % 2 === 1 ? 'var(--row-even)' : 'var(--surface)',
                      }}
                    >
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'nowrap', color: 'var(--muted)' }}>
                        {new Date(e.ts_ms).toLocaleString()}
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                        <StatusBadge status={e.status} />
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.task}>
                        {e.task || '—'}
                      </td>
                      <td style={{ padding: '8px 12px', fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {e.play || '—'}
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'nowrap' }}>
                        {e.host || '—'}
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-2)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.line}
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => toggleRow(i)}
                          style={{
                            background: 'var(--surface)', border: '1px solid var(--border)',
                            color: 'var(--hpe-green)', fontSize: 11,
                            padding: '3px 8px', borderRadius: 2, cursor: 'pointer',
                          }}
                        >
                          {isOpen ? '▲' : '▼'}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={e.ts_ns + '-' + i + '-exp'}>
                        <td colSpan={7} style={{ padding: '12px 20px 16px', background: '#F7FDFB', borderBottom: '2px solid var(--hpe-green-lt)' }}>
                          <pre style={{
                            margin: 0, fontFamily: 'monospace', fontSize: 11,
                            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                            background: '#fff', padding: '10px 14px',
                            border: '1px solid var(--border)', borderRadius: 2,
                            maxHeight: 220, overflowY: 'auto', lineHeight: 1.6,
                          }}>
                            {e.line}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}