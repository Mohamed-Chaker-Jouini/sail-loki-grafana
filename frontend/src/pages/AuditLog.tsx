import { useState, useEffect, useCallback, useRef } from 'react'
import { showToast } from '../components/Toast'

// ── types ──────────────────────────────────────────────────────────────────────
interface DeltaZone { to_add: string[]; to_remove: string[] }
interface HistoryEntry {
  ts:        number
  run_id:    string
  vsrx_ip:   string
  changed:   boolean
  delta_map: Record<string, DeltaZone>
  new_zones: unknown
  duration_s:number
  _nz:       string[]
}

const PAGE_SIZES = [25, 50, 100]
const JUNK_IDS   = new Set(['all','ALL','none','null','undefined',''])

// ── helpers ────────────────────────────────────────────────────────────────────
function parseNewZones(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw !== 'string') return []
  const s = raw.trim()
  if (!s || s === '[]') return []
  try { return JSON.parse(s) } catch(_) {}
  try { return JSON.parse(s.replace(/'/g, '"')) } catch(_) {}
  return s.replace(/^\[|\]$/g, '').split(',')
          .map((t: string) => t.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
}

function rowKey(e: HistoryEntry) {
  return 'r-' + String(e.ts||'0') + '-' + String(e.run_id||'x').replace(/[^a-z0-9]/gi,'-')
}

function displayRunId(e: HistoryEntry): string {
  const rid = String(e.run_id ?? '').trim()
  if (!rid || JUNK_IDS.has(rid)) return e.ts ? 'RUN-' + e.ts.toString(16).toUpperCase() : '—'
  return rid
}

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── stats bar ─────────────────────────────────────────────────────────────────
function StatsBar({ entries, total, maxHistory }: {
  entries: HistoryEntry[]; total: number; maxHistory: number
}) {
  let drifts=0, added=0, removed=0, newZ=0
  for (const e of entries) {
    if (e.changed) drifts++
    for (const z of Object.values(e.delta_map||{})) {
      added   += (z.to_add   ||[]).length
      removed += (z.to_remove||[]).length
    }
    newZ += (e._nz||[]).length
  }
  const pct = (n: number) => entries.length ? ` (${Math.round(n/entries.length*100)}%)` : ''
  const stat = (label: string, value: React.ReactNode, sub: string, color?: string) => (
    <div style={{
      padding: '14px 22px', borderRight: '1px solid var(--hpe-green-mid)',
      minWidth: 120, flex: 1,
    }}>
      <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase',
                    fontWeight: 700, letterSpacing: '.1em' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4, lineHeight: 1,
                    color: color || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>{sub}</div>
    </div>
  )
  return (
    <div style={{
      display: 'flex', background: 'var(--stats-bg)',
      borderBottom: '2px solid var(--hpe-green-mid)',
    }}>
      {stat('Total Runs',    entries.length,    `of ${total} total`)}
      {stat('Drift Events',  drifts,            pct(drifts) + ' of shown',       'var(--red)')}
      {stat('IPs Added',     added,             added + ' IPs',                  'var(--hpe-green-dk)')}
      {stat('IPs Removed',   removed,           removed + ' IPs',                'var(--orange)')}
      {stat('New Zones',     newZ,              'discovered',                    'var(--purple)')}
      <div style={{ padding: '14px 22px', minWidth: 120, flex: 1 }}>
        <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase',
                      fontWeight: 700, letterSpacing: '.1em' }}>Retention</div>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4, paddingTop: 6,
                      lineHeight: 1, color: 'var(--muted)' }}>
          {total} / {maxHistory}
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>records kept</div>
      </div>
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────────
export default function AuditLog() {
  const [all,        setAll]        = useState<HistoryEntry[]>([])
  const [filtered,   setFiltered]   = useState<HistoryEntry[]>([])
  const [maxHistory, setMaxHistory] = useState(1000)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  const [lastRefresh,setLastRefresh]= useState('')
  const [autoOn,     setAutoOn]     = useState(false)

  const [search,     setSearch]     = useState('')
  const [fType,      setFType]      = useState('')
  const [fZone,      setFZone]      = useState('')
  const [fFrom,      setFFrom]      = useState('')
  const [fTo,        setFTo]        = useState('')
  const [zones,      setZones]      = useState<string[]>([])

  const [sortCol,    setSortCol]    = useState<keyof HistoryEntry>('ts')
  const [sortDir,    setSortDir]    = useState<1|-1>(-1)
  const [page,       setPage]       = useState(1)
  const [pageSize,   setPageSize]   = useState(25)
  const [openRows,   setOpenRows]   = useState<Set<string>>(new Set())

  const autoTimer = useRef<ReturnType<typeof setInterval>>()

  const loadHistory = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [hr, hlth] = await Promise.all([
        fetch('/history?t=' + Date.now()),
        fetch('/health?t='  + Date.now()),
      ])
      if (!hr.ok) throw new Error(`HTTP ${hr.status}`)
      const data: HistoryEntry[] = await hr.json()
      data.forEach(e => { e._nz = parseNewZones(e.new_zones) })
      const health = await hlth.json().catch(() => ({}))
      setMaxHistory(health.max_history || 1000)
      setAll(data)
      setError('')
      setLastRefresh('Updated: ' + new Date().toLocaleTimeString().toUpperCase())
      const z = new Set<string>()
      data.forEach(e => Object.keys(e.delta_map||{}).forEach(k => z.add(k)))
      setZones([...z].sort())
    } catch(e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory])

  // apply filters whenever state changes
  useEffect(() => {
    let f = [...all]
    if (fType === 'drift') f = f.filter(e => e.changed)
    if (fType === 'clean') f = f.filter(e => !e.changed)
    if (fZone) f = f.filter(e => Object.keys(e.delta_map||{}).includes(fZone))
    if (fFrom || fTo) {
      f = f.filter(e => {
        const d = new Date(e.ts*1000).toISOString().slice(0,10)
        if (fFrom && d < fFrom) return false
        if (fTo   && d > fTo  ) return false
        return true
      })
    }
    if (search) {
      const q = search.toLowerCase()
      f = f.filter(e => [
        e.run_id, e.vsrx_ip,
        new Date(e.ts*1000).toLocaleString(),
        JSON.stringify(e.delta_map),
        (e._nz||[]).join(' '),
      ].join(' ').toLowerCase().includes(q))
    }
    // sort
    f.sort((a, b) => {
      let av: any = sortCol === 'changed' ? (a.changed?1:0) : a[sortCol] ?? ''
      let bv: any = sortCol === 'changed' ? (b.changed?1:0) : b[sortCol] ?? ''
      if (typeof av === 'string') { av = av.toLowerCase(); bv = String(bv).toLowerCase() }
      return av < bv ? sortDir : av > bv ? -sortDir : 0
    })
    setFiltered(f)
    setPage(1)
  }, [all, fType, fZone, fFrom, fTo, search, sortCol, sortDir])

  function toggleAutoRefresh() {
    if (autoOn) {
      clearInterval(autoTimer.current)
      setAutoOn(false)
    } else {
      autoTimer.current = setInterval(() => loadHistory(true), 30000)
      setAutoOn(true)
      showToast('Auto-refresh every 30s enabled')
    }
  }

  function exportCSV() {
    const cols = ['timestamp','run_id','vsrx_ip','status','zones','ips_added','ips_removed','new_zones']
    const rows = [cols.join(',')]
    for (const e of filtered) {
      const dm   = e.delta_map||{}
      const add  = Object.values(dm).flatMap(d=>d.to_add   ||[]).join(';')
      const rem  = Object.values(dm).flatMap(d=>d.to_remove||[]).join(';')
      rows.push([
        new Date((e.ts||0)*1000).toISOString(),
        e.run_id||'', e.vsrx_ip||'',
        e.changed?'DRIFT':'CLEAN',
        Object.keys(dm).join(';'), add, rem,
        (e._nz||[]).join(';'),
      ].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','))
    }
    const blob = new Blob([rows.join('\r\n')], {type:'text/csv'})
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `sail-audit-${new Date().toISOString().slice(0,10)}.csv`
    a.click(); URL.revokeObjectURL(url)
    showToast('Exported ' + filtered.length + ' records')
  }

  function toggleRow(rk: string) {
    setOpenRows(prev => {
      const next = new Set(prev)
      next.has(rk) ? next.delete(rk) : next.add(rk)
      return next
    })
  }

  function sortBy(col: keyof HistoryEntry) {
    if (sortCol === col) setSortDir(d => d === -1 ? 1 : -1)
    else { setSortCol(col); setSortDir(-1) }
  }

  function SortArrow({ col }: { col: keyof HistoryEntry }) {
    if (sortCol !== col) return <span style={{ color: 'rgba(255,255,255,.5)', marginLeft: 5 }}>↕</span>
    return <span style={{ marginLeft: 5 }}>{sortDir === -1 ? '↓' : '↑'}</span>
  }

  const start  = (page - 1) * pageSize
  const paged  = filtered.slice(start, start + pageSize)
  const total  = Math.ceil(filtered.length / pageSize) || 1

  const thStyle: React.CSSProperties = {
    textAlign: 'left', padding: '11px 14px',
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '.08em', whiteSpace: 'nowrap', cursor: 'pointer',
    userSelect: 'none', color: '#fff',
    borderRight: '1px solid rgba(255,255,255,.2)',
  }

  const Pag = () => (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                  padding:'10px 28px 16px', flexWrap:'wrap', gap:8 }}>
      <button onClick={() => setPage(1)}       disabled={page<=1}>«</button>
      <button onClick={() => setPage(p=>p-1)}  disabled={page<=1}>‹ Prev</button>
      <span style={{ fontSize:11, fontWeight:700, color:'var(--muted)', letterSpacing:'.04em',
                     textTransform:'uppercase' }}>
        Page {page} of {total} — {filtered.length} records
      </span>
      <button onClick={() => setPage(p=>p+1)}  disabled={page>=total}>Next ›</button>
      <button onClick={() => setPage(total)}   disabled={page>=total}>»</button>
      <span style={{ fontSize:11, color:'var(--muted)', fontWeight:700, display:'flex',
                     alignItems:'center', gap:6, textTransform:'uppercase', letterSpacing:'.04em' }}>
        Show:&nbsp;
        {PAGE_SIZES.map(n => (
          <button
            key={n} onClick={() => { setPageSize(n); setPage(1) }}
            style={pageSize===n ? {
              borderColor: 'var(--hpe-green)', color: 'var(--hpe-green-dk)',
              background: 'var(--hpe-green-lt)', height:28, padding:'0 10px',
            } : { height:28, padding:'0 10px' }}
          >{n}</button>
        ))}
      </span>
    </div>
  )

  return (
    <div>
      {/* header actions */}
      <div style={{
        padding: '0 28px', display:'flex', alignItems:'center',
        justifyContent:'flex-end', gap:10, flexWrap:'wrap',
        minHeight:52, borderBottom:'1px solid var(--border-lt)',
        background:'var(--surface)',
      }}>
        {autoOn && (
          <span style={{
            fontSize:10, fontWeight:700, color:'var(--hpe-green)',
            border:'1px solid var(--hpe-green)', padding:'3px 10px',
            background:'var(--hpe-green-lt)', letterSpacing:'.06em',
            textTransform:'uppercase', borderRadius:2,
          }}>● Auto-Refresh 30s</span>
        )}
        {lastRefresh && (
          <span style={{ fontSize:10, fontWeight:700, color:'var(--muted)', letterSpacing:'.04em' }}>
            {lastRefresh}
          </span>
        )}
        <button onClick={toggleAutoRefresh}>
          {autoOn ? 'Disable Auto-Refresh' : 'Enable Auto-Refresh'}
        </button>
        <button onClick={() => loadHistory()}>↻ Refresh</button>
        <button className="primary" onClick={exportCSV}>⬇ Export CSV</button>
      </div>

      {/* error banner */}
      {error && (
        <div style={{
          background:'var(--red-lt)', borderBottom:'2px solid var(--red)',
          color:'#7A2020', padding:'10px 28px', fontSize:12, fontWeight:700,
        }}>
          ⚠ Could not reach the fileserver — {error}
        </div>
      )}

      <StatsBar entries={filtered} total={all.length} maxHistory={maxHistory} />

      {/* filter panel */}
      <div style={{
        background:'var(--surface)', borderBottom:'1px solid var(--border)',
        padding:'14px 28px', display:'flex', flexWrap:'wrap', gap:16, alignItems:'flex-end',
      }}>
        {[
          { label:'Search', el: (
            <input type="text" value={search} style={{width:240}}
              placeholder="IP address, zone, run ID…"
              onChange={e => setSearch(e.target.value)} />
          )},
          { label:'Status', el: (
            <select value={fType} onChange={e => setFType(e.target.value)}>
              <option value="">All statuses</option>
              <option value="drift">Drift only</option>
              <option value="clean">Clean only</option>
            </select>
          )},
          { label:'Zone', el: (
            <select value={fZone} onChange={e => setFZone(e.target.value)}>
              <option value="">All zones</option>
              {zones.map(z => <option key={z} value={z}>{z}</option>)}
            </select>
          )},
          { label:'Date Range', el: (
            <div style={{display:'flex',gap:6,alignItems:'center'}}>
              <input type="date" value={fFrom} onChange={e => setFFrom(e.target.value)} style={{width:140}} />
              <span style={{color:'var(--muted)',fontSize:12}}>→</span>
              <input type="date" value={fTo}   onChange={e => setFTo(e.target.value)}   style={{width:140}} />
            </div>
          )},
        ].map(({ label, el }) => (
          <div key={label} style={{ display:'flex', flexDirection:'column', gap:4 }}>
            <label style={{ fontSize:10, fontWeight:700, color:'var(--muted)',
                            textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</label>
            {el}
          </div>
        ))}
        <div style={{ display:'flex', gap:8, alignItems:'center', marginLeft:'auto' }}>
          {filtered.length !== all.length && (
            <span style={{
              fontSize:11, fontWeight:700, color:'var(--hpe-green-dk)',
              background:'var(--hpe-green-lt)', border:'1px solid var(--hpe-green)',
              padding:'4px 10px', borderRadius:2, whiteSpace:'nowrap',
            }}>
              {filtered.length} of {all.length} records
            </span>
          )}
          <button onClick={() => {
            setSearch(''); setFType(''); setFZone(''); setFFrom(''); setFTo('')
          }}>✕ Clear Filters</button>
        </div>
      </div>

      {loading && <div className="loading">● Loading audit records…</div>}

      <Pag />

      {/* table */}
      <div style={{ padding:'0 28px', overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', background:'var(--surface)',
                        border:'1px solid var(--border)', fontSize:12, borderRadius:3 }}>
          <thead>
            <tr style={{ background:'var(--hpe-green)' }}>
              {([
                ['ts','Timestamp'],['run_id','Run ID'],['vsrx_ip','vSRX IP'],
                ['status','Status'],
              ] as [keyof HistoryEntry, string][]).map(([col,label]) => (
                <th key={col} style={thStyle} onClick={() => sortBy(col)}>
                  {label} <SortArrow col={col} />
                </th>
              ))}
              <th style={{...thStyle, cursor:'default'}}>Zones</th>
              <th style={{...thStyle, cursor:'default'}}>Delta</th>
              <th style={{...thStyle, cursor:'default'}}>▸</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((e, i) => {
              const rk    = rowKey(e)
              const ts    = e.ts ? new Date(e.ts*1000).toLocaleString() : '—'
              const runId = displayRunId(e)
              const dmap  = e.delta_map || {}
              const nz    = e._nz || []
              const isOpen= openRows.has(rk)
              const rowBg = i%2===1 ? 'var(--row-even)' : 'var(--surface)'

              let deltaHtml = ''
              for (const [z,d] of Object.entries(dmap)) {
                const adds = d.to_add||[], rems = d.to_remove||[]
                if (!adds.length && !rems.length) continue
                deltaHtml += `<div style="margin-bottom:6px">
                  <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">${esc(z)}</div>
                  <div style="display:flex;flex-wrap:wrap;gap:3px">
                    ${adds.map(ip=>`<span style="font-size:11px;padding:2px 8px;font-family:monospace;font-weight:700;border-radius:2px;background:var(--hpe-green-lt);color:var(--hpe-green-dk);border:1px solid var(--hpe-green-mid)">+${esc(ip)}</span>`).join('')}
                    ${rems.map(ip=>`<span style="font-size:11px;padding:2px 8px;font-family:monospace;font-weight:700;border-radius:2px;background:var(--red-lt);color:#922020;border:1px solid #EDBBBA">−${esc(ip)}</span>`).join('')}
                  </div></div>`
              }
              if (nz.length) {
                deltaHtml += nz.map(z=>
                  `<span style="display:inline-block;margin-top:4px;padding:3px 8px;font-size:10px;font-weight:700;background:#FFF3E6;color:var(--orange);border:1px solid #F5CCB0;border-radius:2px">NEW ZONE: ${esc(z)}</span>`
                ).join(' ')
              }

              const ipAdded   = Object.values(dmap).flatMap(d=>d.to_add   ||[])
              const ipRemoved = Object.values(dmap).flatMap(d=>d.to_remove||[])
              const zoneKeys  = Object.keys(dmap)

              return (
                <>
                  <tr key={rk} style={{ background: rowBg }}>
                    <td style={{ padding:'10px 14px', whiteSpace:'nowrap',
                                 fontFamily:'monospace', fontSize:12 }}>{ts}</td>
                    <td style={{ padding:'10px 14px', fontFamily:'monospace',
                                 color:'var(--hpe-green)' }} title={e.run_id}>
                      {runId.slice(0,14)}
                    </td>
                    <td style={{ padding:'10px 14px', fontFamily:'monospace' }}>
                      {e.vsrx_ip||'—'}
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      <span className={`badge ${e.changed?'b-drift':'b-clean'}`}>
                        {e.changed?'DRIFT':'CLEAN'}
                      </span>
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      {zoneKeys.length
                        ? zoneKeys.map(z => (
                            <span key={z} className="badge b-zone" style={{marginRight:2}}>{z}</span>
                          ))
                        : <span style={{color:'var(--muted)'}}>—</span>}
                    </td>
                    <td style={{ padding:'10px 14px', verticalAlign:'top' }}
                        dangerouslySetInnerHTML={{ __html: deltaHtml || '<span style="color:var(--muted)">—</span>' }} />
                    <td style={{ padding:'10px 14px' }}>
                      <button
                        onClick={() => toggleRow(rk)}
                        style={{
                          background:'var(--surface)', border:'1px solid var(--border)',
                          color:'var(--hpe-green)', fontSize:12, padding:'4px 9px',
                          borderRadius:2,
                        }}
                      >{isOpen ? '▲' : '▼'}</button>
                    </td>
                  </tr>

                  {isOpen && (
                    <tr key={rk+'-det'}>
                      <td colSpan={7} style={{
                        padding:'20px 28px', background:'#F7FDFB',
                        borderBottom:'2px solid var(--border)',
                        borderTop:'2px solid var(--hpe-green-lt)',
                      }}>
                        <div style={{ display:'grid',
                                      gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',
                                      gap:12, marginBottom:16 }}>
                          {([
                            ['Full Run ID',       runId],
                            ['Unix Timestamp',    String(e.ts||'—')],
                            ['vSRX IP',           e.vsrx_ip||'—'],
                            ['Zones in Run',      zoneKeys.join(', ')||'none'],
                            ['New Zones',         nz.join(', ')||'none'],
                            [`IPs Added (${ipAdded.length})`,   ipAdded.join(', ')||'none'],
                            [`IPs Removed (${ipRemoved.length})`,ipRemoved.join(', ')||'none'],
                          ] as [string,string][]).map(([l,v]) => (
                            <div key={l}>
                              <label style={{ fontSize:10, fontWeight:700, color:'var(--muted)',
                                             textTransform:'uppercase', letterSpacing:'.06em',
                                             display:'block', marginBottom:4 }}>{l}</label>
                              <span style={{
                                fontSize:12, fontFamily:'monospace',
                                background:'#fff', padding:'3px 7px',
                                border:'1px solid var(--border)',
                                display:'inline-block', wordBreak:'break-all',
                                borderRadius:2,
                              }}>{v}</span>
                            </div>
                          ))}
                        </div>
                        <details>
                          <summary style={{
                            fontSize:11, color:'var(--hpe-green-dk)', cursor:'pointer',
                            fontWeight:700, textTransform:'uppercase', letterSpacing:'.04em',
                            userSelect:'none',
                          }}>
                            {'{ } View raw delta_map JSON'}
                          </summary>
                          <pre style={{
                            marginTop:8, background:'#fff', border:'1px solid var(--border)',
                            padding:12, fontSize:11, fontFamily:'monospace',
                            whiteSpace:'pre-wrap', wordBreak:'break-all',
                            maxHeight:220, overflowY:'auto', borderRadius:2,
                          }}>
                            {JSON.stringify(dmap, null, 2)}
                          </pre>
                        </details>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>

        {!loading && filtered.length === 0 && (
          <div className="empty">
            <div style={{ fontSize:40, marginBottom:12 }}>📋</div>
            <div>
              {all.length === 0
                ? 'No audit records yet. Waiting for the first Ansible run…'
                : 'No records match the current filters.'}
            </div>
          </div>
        )}
      </div>

      <Pag />
    </div>
  )
}