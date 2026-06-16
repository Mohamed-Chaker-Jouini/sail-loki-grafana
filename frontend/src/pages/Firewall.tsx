import { useState, useEffect, useCallback, useRef } from 'react'
import { showToast } from '../components/Toast'
import { loadCredentialsFromCookie } from './Settings'
import VMPolicyBuilder from '../components/VMPolicyBuilder'


// ── module-level cache (survives remounts, not page refresh) ──────────────────
const cache: {
  book:      EnrichedBook | null
  policies:  Policy[]
  abCooldownUntil:  number   // epoch ms when cooldown expires
  polCooldownUntil: number
} = {
  book:             null,
  policies:         [],
  abCooldownUntil:  0,
  polCooldownUntil: 0,
}

const COOLDOWN_SECS = 30

function remainingSecs(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000))
}

// ── cooldown helper ────────────────────────────────────────────────────────────
// Stores expiry epoch in the cache so it survives remounts, then ticks down
// local UI state. The setter/timerRef are purely for display.
function startCooldown(
  cacheKey: 'abCooldownUntil' | 'polCooldownUntil',
  setter: React.Dispatch<React.SetStateAction<number>>,
  timerRef: React.MutableRefObject<ReturnType<typeof setInterval> | undefined>,
  secs = COOLDOWN_SECS,
) {
  cache[cacheKey] = Date.now() + secs * 1000
  setter(secs)
  clearInterval(timerRef.current)
  timerRef.current = setInterval(() => {
    setter(prev => {
      if (prev <= 1) { clearInterval(timerRef.current); return 0 }
      return prev - 1
    })
  }, 1000)
}

// ── types ──────────────────────────────────────────────────────────────────────
interface EnrichedAddress {
  ip: string
  source: 'morpheus' | 'manual'
  quarantined: boolean
  zone?: string
}
interface EnrichedSet {
  name: string
  addresses: EnrichedAddress[]
}
interface EnrichedBook {
  book_name: string
  quarantined: string[]
  address_sets: EnrichedSet[]
}
interface Policy {
  from_zone: string
  to_zone: string
  name: string
  action: string
  source_addresses?: string[]
  destination_addresses?: string[]
  ports?: string[]
}

// ── sub-components ─────────────────────────────────────────────────────────────

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 0', borderBottom: '2px solid var(--hpe-green-mid)',
      marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '.08em',
      }}>
        {title}
      </div>
      {action}
    </div>
  )
}

function SourceBadge({ source }: { source: 'morpheus' | 'manual' }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '.06em',
      textTransform: 'uppercase', padding: '1px 5px', borderRadius: 2,
      background: source === 'morpheus' ? 'var(--hpe-green-lt)' : 'rgba(100,130,200,.13)',
      color:      source === 'morpheus' ? 'var(--hpe-green-dk)' : '#4a60a0',
      border:     source === 'morpheus' ? '1px solid var(--hpe-green-mid)' : '1px solid rgba(100,130,200,.35)',
    }}>
      {source === 'morpheus' ? '🤖 morpheus' : '✋ manual'}
    </span>
  )
}

function MorpheusGuardNote({ ip }: { ip: string }) {
  return (
    <div style={{
      background: 'rgba(255,200,50,.08)',
      border: '1px solid rgba(255,200,50,.35)',
      borderRadius: 3, padding: '10px 12px',
      fontSize: 11, color: 'var(--muted)',
      lineHeight: 1.6, marginTop: 8,
    }}>
      <strong style={{ color: '#9a7a00' }}>⚠ Automation-managed IP</strong>
      <br />
      <code style={{ fontSize: 10 }}>{ip}</code> is owned by Morpheus. Deleting it here
      would be overwritten on the next Ansible run. To permanently remove it,{' '}
      <strong>remove the AppTier tag in Morpheus</strong> and let the automation reconcile.
      <br />
      For an emergency block, use <strong>Quarantine</strong> instead.
    </div>
  )
}

function IpChip({
  entry,
  onQuarantine,
  onRelease,
  onDelete,
}: {
  entry: EnrichedAddress
  onQuarantine: (ip: string) => void
  onRelease: (ip: string) => void
  onDelete: (ip: string) => void
}) {
  const [showGuard, setShowGuard] = useState(false)

  const chipStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    borderRadius: 2, padding: '3px 8px',
    fontFamily: 'monospace', fontSize: 11,
    border: entry.quarantined
      ? '1px solid var(--red)'
      : entry.source === 'morpheus'
        ? '1px solid var(--hpe-green-mid)'
        : '1px solid rgba(100,130,200,.4)',
    background: entry.quarantined
      ? 'var(--red-lt)'
      : entry.source === 'morpheus'
        ? 'var(--hpe-green-lt)'
        : 'rgba(100,130,200,.08)',
    color: entry.quarantined
      ? '#7A2020'
      : entry.source === 'morpheus'
        ? 'var(--hpe-green-dk)'
        : '#3a50a0',
  }

  const btnBase: React.CSSProperties = {
    border: 'none', background: 'none',
    cursor: 'pointer', padding: '0 2px',
    fontSize: 11, lineHeight: 1, fontWeight: 700,
    textTransform: 'none', letterSpacing: 0,
  }

  return (
    <div style={{ display: 'inline-block' }}>
      <span style={chipStyle} title={`Zone: ${entry.zone || 'unknown'}`}>
        {entry.ip}
        {entry.quarantined && (
          <span style={{ fontSize: 9, fontWeight: 700, color: '#7A2020' }}>BLOCKED</span>
        )}
        {entry.source === 'morpheus' && !entry.quarantined && (
          <button
            onClick={() => onQuarantine(entry.ip)}
            title="Quarantine — emergency block without breaking automation"
            style={{ ...btnBase, color: '#cc8800', fontSize: 13 }}
          >⊘</button>
        )}
        {entry.quarantined && (
          <button
            onClick={() => onRelease(entry.ip)}
            title="Release from quarantine"
            style={{ ...btnBase, color: 'var(--hpe-green-dk)' }}
          >✓</button>
        )}
        {entry.source === 'manual' && !entry.quarantined && (
          <button
            onClick={() => onDelete(entry.ip)}
            title={`Delete manual entry ${entry.ip}`}
            style={{ ...btnBase, color: 'var(--red)' }}
          >×</button>
        )}
        {entry.source === 'morpheus' && !entry.quarantined && (
          <button
            onClick={() => setShowGuard(g => !g)}
            title="Why can't I delete this?"
            style={{ ...btnBase, color: 'var(--muted)', fontSize: 12 }}
          >?</button>
        )}
      </span>
      {showGuard && <MorpheusGuardNote ip={entry.ip} />}
    </div>
  )
}


// ── main component ─────────────────────────────────────────────────────────────
export default function Firewall() {
  // Initialise cooldown display from cached expiry so ticking survives remounts
  const [cooldownAB,  setCooldownAB]  = useState(() => remainingSecs(cache.abCooldownUntil))
  const [cooldownPol, setCooldownPol] = useState(() => remainingSecs(cache.polCooldownUntil))
  const abTimer  = useRef<ReturnType<typeof setInterval>>()
  const polTimer = useRef<ReturnType<typeof setInterval>>()

  const [book,       setBook]       = useState<EnrichedBook | null>(() => cache.book)
  const [policies,   setPolicies]   = useState<Policy[]>(() => cache.policies)
  const [loadingAB,  setLoadingAB]  = useState(false)
  const [loadingPol, setLoadingPol] = useState(false)
  const [error,      setError]      = useState('')

  const [addZone, setAddZone] = useState('')
  const [addIp,   setAddIp]   = useState('')
  const [adding,  setAdding]  = useState(false)

  const [quarantineTarget, setQuarantineTarget] = useState<string | null>(null)
  const [quarantining,     setQuarantining]     = useState(false)

  const configured = !!loadCredentialsFromCookie()

  // Resume any in-progress cooldown tickers that were running before remount
  useEffect(() => {
    if (cooldownAB > 0) {
      clearInterval(abTimer.current)
      abTimer.current = setInterval(() => {
        setCooldownAB(prev => {
          if (prev <= 1) { clearInterval(abTimer.current); return 0 }
          return prev - 1
        })
      }, 1000)
    }
    if (cooldownPol > 0) {
      clearInterval(polTimer.current)
      polTimer.current = setInterval(() => {
        setCooldownPol(prev => {
          if (prev <= 1) { clearInterval(polTimer.current); return 0 }
          return prev - 1
        })
      }, 1000)
    }
    return () => {
      clearInterval(abTimer.current)
      clearInterval(polTimer.current)
    }
  }, []) // run once on mount — intentional

  // ── Refs so fetchBook / fetchPolicies don't close over stale cooldown state ─
  // This breaks the dependency cycle: cooldown no longer forces useCallback to
  // recreate fetchBook, which no longer restarts the initial-load useEffect.
  const cooldownABRef  = useRef(cooldownAB)
  const cooldownPolRef = useRef(cooldownPol)
  useEffect(() => { cooldownABRef.current  = cooldownAB  }, [cooldownAB])
  useEffect(() => { cooldownPolRef.current = cooldownPol }, [cooldownPol])

  const fetchBook = useCallback(async (force = false) => {
    if (!force && cooldownABRef.current > 0) return
    setLoadingAB(true); setError('')
    try {
      const r = await fetch('/api/firewall/address-book/enriched')
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || r.statusText) }
      const data = await r.json()
      cache.book = data
      setBook(data)
      startCooldown('abCooldownUntil', setCooldownAB, abTimer)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingAB(false)
    }
  }, []) // stable — reads cooldown from ref, not state

  const fetchPolicies = useCallback(async (force = false) => {
    if (!force && cooldownPolRef.current > 0) return
    setLoadingPol(true)
    try {
      const r = await fetch('/api/firewall/policies')
      if (!r.ok) return
      const d = await r.json()
      cache.policies = d.policies
      setPolicies(d.policies)
      startCooldown('polCooldownUntil', setCooldownPol, polTimer)
    } catch { /* silent */ }
    finally { setLoadingPol(false) }
  }, []) // stable — reads cooldown from ref, not state

  // Initial load: skip fetch if we already have cached data AND cooldown is
  // still active (i.e. a recent fetch happened before remount)
  useEffect(() => {
    if (!configured) return
    if (!cache.book)                       fetchBook()
    if (cache.policies.length === 0)       fetchPolicies()
  }, [configured, fetchBook, fetchPolicies])
  // fetchBook / fetchPolicies are now stable so this effect runs exactly once

  async function handleAddManualIp() {
    if (!addZone || !addIp) { showToast('Zone and IP are required'); return }
    setAdding(true)
    try {
      const r = await fetch('/api/firewall/manual/add-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone: addZone, ip: addIp }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`Added ${addIp} to ${addZone} (manual entry)`)
      setAddIp('')
      fetchBook(true) // force past cooldown after a mutation
    } catch (e: any) {
      showToast('Error: ' + e.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleDeleteManual(ip: string) {
    if (!confirm(`Delete manual entry ${ip}? This cannot be undone.`)) return
    try {
      const r = await fetch('/api/firewall/manual/delete-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`Deleted manual entry ${ip}`)
      fetchBook(true)
    } catch (e: any) {
      showToast('Error: ' + e.message)
    }
  }

  async function confirmQuarantine() {
    if (!quarantineTarget) return
    setQuarantining(true)
    try {
      const r = await fetch('/api/firewall/quarantine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: quarantineTarget }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`⊘ ${quarantineTarget} quarantined — traffic blocked`)
      setQuarantineTarget(null)
      fetchBook(true)
    } catch (e: any) {
      showToast('Error: ' + e.message)
    } finally {
      setQuarantining(false)
    }
  }

  async function handleRelease(ip: string) {
    if (!confirm(`Release ${ip} from quarantine? Traffic will resume.`)) return
    try {
      const r = await fetch('/api/firewall/quarantine/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`✓ ${ip} released from quarantine`)
      fetchBook(true)
    } catch (e: any) {
      showToast('Error: ' + e.message)
    }
  }

  if (!configured) {
    return (
      <div className="empty" style={{ margin: 28 }}>
        <div style={{ fontSize: 28, marginBottom: 12 }}>🔒</div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>No credentials configured</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Go to the Settings tab to enter your vSRX connection details.
        </div>
      </div>
    )
  }

  const morpheusCount   = book?.address_sets.flatMap(s => s.addresses).filter(a => a.source === 'morpheus').length ?? 0
  const manualCount     = book?.address_sets.flatMap(s => s.addresses).filter(a => a.source === 'manual').length ?? 0
  const quarantineCount = book?.quarantined.length ?? 0

  return (
    <div style={{ padding: 28 }}>

      {/* ── quarantine confirmation modal ── */}
      {quarantineTarget && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 4, padding: 28, maxWidth: 420, width: '90%',
            boxShadow: '0 8px 32px rgba(0,0,0,.3)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
              ⊘ Quarantine IP
            </div>
            <div style={{
              background: 'var(--red-lt)', border: '1px solid var(--red)',
              borderRadius: 3, padding: '10px 14px',
              fontSize: 12, color: '#7A2020', marginBottom: 16,
            }}>
              <strong>{quarantineTarget}</strong> will be added to{' '}
              <code>SET_QUARANTINE</code>, which has a deny-all policy.
              All traffic to/from this IP will be blocked immediately.
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.6 }}>
              The IP remains in its original zone set — Ansible won't fight you.
              Release quarantine from this page when the incident is resolved.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setQuarantineTarget(null)} disabled={quarantining}>
                Cancel
              </button>
              <button
                className="danger"
                onClick={confirmQuarantine}
                disabled={quarantining}
              >
                {quarantining ? 'Quarantining…' : '⊘ Confirm Quarantine'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── error banner ── */}
      {error && (
        <div style={{
          background: 'var(--red-lt)', border: '1px solid var(--red)',
          color: '#7A2020', padding: '10px 14px',
          fontSize: 12, fontWeight: 700, marginBottom: 20, borderRadius: 2,
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>⚠ {error}</span>
          <button onClick={() => setError('')} style={{ padding: '0 8px', height: 24 }}>✕</button>
        </div>
      )}

      {/* ── legend / ownership notice ── */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 3, padding: '10px 16px', marginBottom: 24,
        display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap',
        fontSize: 11,
      }}>
        <span style={{ color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em' }}>
          Address book ownership
        </span>
        <span>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: 'var(--hpe-green)', marginRight: 6,
          }} />
          <strong>{morpheusCount}</strong> Morpheus-managed — read-only, modified via AppTier tags
        </span>
        <span>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: '#4a60a0', marginRight: 6,
          }} />
          <strong>{manualCount}</strong> Manual entries — editable here
        </span>
        {quarantineCount > 0 && (
          <span>
            <span style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              background: 'var(--red)', marginRight: 6,
            }} />
            <strong>{quarantineCount}</strong> Quarantined — traffic blocked
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>

        {/* ── left column: address book ── */}
        <div>
          <SectionHeader
            title={`Address Book${book ? ` — ${book.book_name}` : ''}`}
            action={
              <button onClick={() => fetchBook(true)} disabled={loadingAB || cooldownAB > 0}>
                {loadingAB ? '…' : cooldownAB > 0 ? `↻ (${cooldownAB}s)` : '↻ Refresh'}
              </button>
            }
          />

          {loadingAB && !book && <div className="loading">● Loading address book…</div>}

          {book && (
            <>
              {book.address_sets.map(set => (
                <div key={set.name} style={{ marginBottom: 20 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, color: 'var(--hpe-green-dk)',
                    textTransform: 'uppercase', letterSpacing: '.08em',
                    marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    {set.name.replace('SET_', '')} zone
                    <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
                      ({set.addresses.length} IPs —{' '}
                      {set.addresses.filter(a => a.source === 'morpheus').length} managed,{' '}
                      {set.addresses.filter(a => a.source === 'manual').length} manual)
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {set.addresses.map(entry => (
                      <IpChip
                        key={entry.ip}
                        entry={entry}
                        onQuarantine={setQuarantineTarget}
                        onRelease={handleRelease}
                        onDelete={handleDeleteManual}
                      />
                    ))}
                    {set.addresses.length === 0 && (
                      <span style={{ color: 'var(--muted)', fontSize: 11 }}>empty</span>
                    )}
                  </div>
                </div>
              ))}
              {book.address_sets.length === 0 && (
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>No address sets found.</div>
              )}
            </>
          )}
        </div>

        {/* ── right column: forms + policies ── */}
        <div>

          {/* Add Manual IP */}
          <SectionHeader title="Add Manual IP to Zone" />
          <div style={{
            background: 'rgba(100,130,200,.06)',
            border: '1px solid rgba(100,130,200,.25)',
            borderRadius: 3, padding: '14px 16px', marginBottom: 28,
          }}>
            <div style={{ fontSize: 11, color: '#4a60a0', marginBottom: 12, lineHeight: 1.6 }}>
              For IPs <strong>not managed by Morpheus</strong> — physical servers, VPN
              endpoints, static infrastructure. These are stored in{' '}
              <code style={{ fontSize: 10 }}>MANUAL_ENTRIES</code> and will never be
              touched by Ansible.
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: 'var(--muted)',
                  textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4,
                }}>Zone</div>
                <input
                  type="text" value={addZone}
                  onChange={e => setAddZone(e.target.value.toUpperCase())}
                  placeholder="WEB" style={{ width: '100%' }}
                />
              </div>
              <div style={{ flex: 2 }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: 'var(--muted)',
                  textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4,
                }}>IP Address</div>
                <input
                  type="text" value={addIp}
                  onChange={e => setAddIp(e.target.value)}
                  placeholder="10.0.0.1" style={{ width: '100%' }}
                />
              </div>
            </div>
            <button className="primary" onClick={handleAddManualIp} disabled={adding}>
              {adding ? 'Adding…' : '+ Add Manual IP'}
            </button>
          </div>

          {/* Morpheus notice */}
          <SectionHeader title="Morpheus-managed IPs" />
          <div style={{
            background: 'var(--hpe-green-lt)',
            border: '1px solid var(--hpe-green-mid)',
            borderRadius: 3, padding: '14px 16px', marginBottom: 28,
            fontSize: 11, color: 'var(--hpe-green-dk)', lineHeight: 1.8,
          }}>
            <strong>IPs labelled 🤖 morpheus are managed exclusively by Ansible.</strong>
            <br />
            To add one: assign an <code>AppTier</code> tag to the VM in Morpheus.
            <br />
            To remove one: remove the <code>AppTier</code> tag — the next reconciliation
            run will clean it up automatically.
            <br />
            For an emergency block without breaking automation: use the{' '}
            <strong>⊘ quarantine button</strong> on the IP chip.
          </div>

          {/* Security Policies */}
          <SectionHeader
            title="Security Policies"
            action={
              <button onClick={() => fetchPolicies(true)} disabled={loadingPol || cooldownPol > 0}>
                {loadingPol ? '…' : cooldownPol > 0 ? `↻ (${cooldownPol}s)` : '↻ Refresh'}
              </button>
            }
          />
          {loadingPol && policies.length === 0 && <div className="loading">● Loading policies…</div>}
          {policies.length > 0 && (
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              fontSize: 11, background: 'var(--surface)',
              border: '1px solid var(--border)',
            }}>
              <thead>
                <tr style={{ background: 'var(--hpe-green)' }}>
                  {['Policy Name', 'Source', 'Destination', 'Ports', 'Zones', 'Action'].map(h => (
                    <th key={h} style={{
                      textAlign: 'left', padding: '8px 10px',
                      fontSize: 10, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '.07em',
                      color: '#fff', borderRight: '1px solid rgba(255,255,255,.2)',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {policies.map((p, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-lt)' }}>
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 10 }}>{p.name}</td>
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>
                      {p.source_addresses?.length ? p.source_addresses.join(', ') : 'any'}
                    </td>
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>
                      {p.destination_addresses?.length ? p.destination_addresses.join(', ') : 'any'}
                    </td>
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>
                      {p.ports?.length ? p.ports.join(', ') : 'all'}
                    </td>
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 10, opacity: .7 }}>
                      {p.from_zone} → {p.to_zone}
                    </td>
                    <td style={{ padding: '7px 10px' }}>
                      <span className={`badge ${p.action === 'permit' ? 'b-permit' : 'b-deny'}`}>
                        {p.action}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!loadingPol && policies.length === 0 && !error && (
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>No policies found.</div>
          )}
        </div>
      </div>
      <VMPolicyBuilder />
    </div>
  )
}