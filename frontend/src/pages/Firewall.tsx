import { useState, useEffect, useCallback } from 'react'
import { showToast } from '../components/Toast'
import { loadCredentialsFromCookie } from './Settings'

const [cooldownAB, setCooldownAB] = useState(0)
const [cooldownPol, setCooldownPol] = useState(0)
const abTimer = useRef<ReturnType<typeof setInterval>>()
const polTimer = useRef<ReturnType<typeof setInterval>>()

function startCooldown(
  setter: React.Dispatch<React.SetStateAction<number>>,
  timerRef: React.MutableRefObject<ReturnType<typeof setInterval> | undefined>,
  secs = 30
) {
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
interface AddressEntry { name: string; prefix: string }
interface AddressSet { name: string; addresses: string[] }
interface AddressBook {
  book_name: string
  addresses: AddressEntry[]
  address_sets: AddressSet[]
}
interface Policy {
  from_zone: string
  to_zone: string
  name: string
  action: string
}

// ── section header ─────────────────────────────────────────────────────────────
function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 0', borderBottom: '2px solid var(--hpe-green-mid)',
      marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '.08em'
      }}>
        {title}
      </div>
      {action}
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────────
export default function Firewall() {
  const [book, setBook] = useState<AddressBook | null>(null)
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loadingAB, setLoadingAB] = useState(false)
  const [loadingPol, setLoadingPol] = useState(false)
  const [error, setError] = useState('')

  // add-ip form
  const [addZone, setAddZone] = useState('')
  const [addIp, setAddIp] = useState('')
  const [adding, setAdding] = useState(false)

  // remove-ip form
  const [remZone, setRemZone] = useState('')
  const [remIp, setRemIp] = useState('')
  const [removing, setRemoving] = useState(false)

  const configured = !!loadCredentialsFromCookie()

  const fetchBook = useCallback(async () => {
    if (cooldownAB > 0) return
    setLoadingAB(true); setError('')
    try {
      const r = await fetch('/api/firewall/address-book')
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || r.statusText) }
      setBook(await r.json())
      startCooldown(setCooldownAB, abTimer)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingAB(false)
    }
  }, [cooldownAB])

  const fetchPolicies = useCallback(async () => {
    if (cooldownPol > 0) return
    setLoadingPol(true)
    try {
      const r = await fetch('/api/firewall/policies')
      if (!r.ok) return
      const d = await r.json()
      setPolicies(d.policies)
      startCooldown(setCooldownPol, polTimer)
    } catch { /* silent */ }
    finally { setLoadingPol(false) }
  }, [cooldownPol])

  useEffect(() => {
    if (configured) { fetchBook(); fetchPolicies() }
  }, [configured, fetchBook, fetchPolicies])

  async function handleAddIp() {
    if (!addZone || !addIp) { showToast('Zone and IP are required'); return }
    setAdding(true)
    try {
      const r = await fetch('/api/firewall/address-book/add-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone: addZone, ip: addIp }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`Added ${addIp} to ${addZone}`)
      setAddIp('')
      fetchBook()
    } catch (e: any) {
      showToast('Error: ' + e.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleRemoveIp() {
    if (!remZone || !remIp) { showToast('Zone and IP are required'); return }
    setRemoving(true)
    try {
      const r = await fetch('/api/firewall/address-book/remove-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone: remZone, ip: remIp }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`Removed ${remIp} from ${remZone}`)
      setRemIp('')
      fetchBook()
    } catch (e: any) {
      showToast('Error: ' + e.message)
    } finally {
      setRemoving(false)
    }
  }

  async function handleDeleteAddress(ip: string) {
    if (!confirm(`Delete address object ${ip} entirely?`)) return
    try {
      const r = await fetch('/api/firewall/address-book/delete-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`Deleted ${ip}`)
      fetchBook()
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

  return (
    <div style={{ padding: 28 }}>
      {/* error banner */}
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>

        {/* ── left column ── */}
        <div>
          {/* address book */}
          <SectionHeader
            title={`Address Book${book ? ` — ${book.book_name}` : ''}`}
            action={
              <button onClick={fetchBook} disabled={loadingAB || cooldownAB > 0}>
                {loadingAB ? '…' : cooldownAB > 0 ? `↻ (${cooldownAB}s)` : '↻ Refresh'}
              </button>
            }
          />

          {loadingAB && <div className="loading">● Loading address book…</div>}

          {book && !loadingAB && (
            <>
              {/* zone sets */}
              {book.address_sets.map(set => (
                <div key={set.name} style={{ marginBottom: 16 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, color: 'var(--hpe-green-dk)',
                    textTransform: 'uppercase', letterSpacing: '.08em',
                    marginBottom: 6,
                  }}>
                    {set.name.replace('SET_', '')} zone
                    <span style={{ color: 'var(--muted)', marginLeft: 8, fontWeight: 400 }}>
                      ({set.addresses.length} IPs)
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {set.addresses.map(ip => (
                      <span
                        key={ip}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          background: 'var(--hpe-green-lt)',
                          border: '1px solid var(--hpe-green-mid)',
                          borderRadius: 2, padding: '2px 8px',
                          fontFamily: 'monospace', fontSize: 11,
                          color: 'var(--hpe-green-dk)',
                        }}
                      >
                        {ip}
                        <button
                          onClick={() => handleDeleteAddress(ip)}
                          title={`Delete ${ip}`}
                          style={{
                            border: 'none', background: 'none',
                            color: 'var(--red)', cursor: 'pointer',
                            padding: '0 2px', fontSize: 11, lineHeight: 1,
                            fontWeight: 700, textTransform: 'none',
                            letterSpacing: 0,
                          }}
                        >×</button>
                      </span>
                    ))}
                    {set.addresses.length === 0 && (
                      <span style={{ color: 'var(--muted)', fontSize: 11 }}>empty</span>
                    )}
                  </div>
                </div>
              ))}

              {book.address_sets.length === 0 && (
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                  No address sets found in {book.book_name}.
                </div>
              )}
            </>
          )}
        </div>

        {/* ── right column ── */}
        <div>
          {/* add IP */}
          <SectionHeader title="Add IP to Zone" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
            <div style={{ display: 'flex', gap: 8 }}>
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
            <button className="primary" onClick={handleAddIp} disabled={adding}>
              {adding ? 'Adding…' : '+ Add IP'}
            </button>
          </div>

          {/* remove IP */}
          <SectionHeader title="Remove IP from Zone" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: 'var(--muted)',
                  textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4,
                }}>Zone</div>
                <input
                  type="text" value={remZone}
                  onChange={e => setRemZone(e.target.value.toUpperCase())}
                  placeholder="WEB" style={{ width: '100%' }}
                />
              </div>
              <div style={{ flex: 2 }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: 'var(--muted)',
                  textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4,
                }}>IP Address</div>
                <input
                  type="text" value={remIp}
                  onChange={e => setRemIp(e.target.value)}
                  placeholder="10.0.0.1" style={{ width: '100%' }}
                />
              </div>
            </div>
            <button className="danger" onClick={handleRemoveIp} disabled={removing}>
              {removing ? 'Removing…' : '− Remove IP'}
            </button>
          </div>

          {/* policies */}
          <SectionHeader
            title="Security Policies"
            action={
              <button onClick={fetchPolicies} disabled={loadingPol || cooldownPol > 0}>
                {loadingPol ? '…' : cooldownPol > 0 ? `↻ (${cooldownPol}s)` : '↻ Refresh'}
              </button>
            }
          />
          {loadingPol && <div className="loading">● Loading policies…</div>}
          {!loadingPol && policies.length > 0 && (
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              fontSize: 11, background: 'var(--surface)',
              border: '1px solid var(--border)',
            }}>
              <thead>
                <tr style={{ background: 'var(--hpe-green)' }}>
                  {['From Zone', 'To Zone', 'Policy Name', 'Action'].map(h => (
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
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{p.from_zone}</td>
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{p.to_zone}</td>
                    <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 10 }}>{p.name}</td>
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
    </div>
  )
}