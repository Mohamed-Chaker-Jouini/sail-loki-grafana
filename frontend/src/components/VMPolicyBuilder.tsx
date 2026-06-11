import { useState, useEffect, useCallback } from 'react'
import { showToast } from './Toast'

// ── types ──────────────────────────────────────────────────────────────────────
interface PortEntry { id: number; protocol: 'tcp' | 'udp' | 'any'; port: string }
interface SailPolicy { from_zone: string; to_zone: string; name: string; action: string }
interface IpOption { ip: string; zone: string; source: 'morpheus' | 'manual' }

// ── well-known port quick-add ──────────────────────────────────────────────────
const QUICK_PORTS = [
  { port: 22,   proto: 'tcp', label: 'SSH'     },
  { port: 80,   proto: 'tcp', label: 'HTTP'    },
  { port: 443,  proto: 'tcp', label: 'HTTPS'   },
  { port: 3306, proto: 'tcp', label: 'MySQL'   },
  { port: 5432, proto: 'tcp', label: 'PgSQL'   },
  { port: 3389, proto: 'tcp', label: 'RDP'     },
  { port: 8080, proto: 'tcp', label: 'Alt-HTTP'},
  { port: 53,   proto: 'udp', label: 'DNS'     },
]

let _pid = 0

// ── helpers ────────────────────────────────────────────────────────────────────
function SubHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 0', borderBottom: '2px solid var(--hpe-green-mid)', marginBottom: 16,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
        {title}
      </div>
      {action}
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4 }}>
      {children}
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────────
export default function VMPolicyBuilder() {
  const [zones,    setZones]    = useState<string[]>([])
  const [allIps,   setAllIps]   = useState<IpOption[]>([])
  const [policies, setPolicies] = useState<SailPolicy[]>([])
  const [loadingPol, setLoadingPol] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [deleting,   setDeleting]   = useState<string | null>(null)

  // ── form state ───────────────────────────────────────────────────────────────
  const [ruleName, setRuleName] = useState('')
  const [fromZone, setFromZone] = useState('')
  const [toZone,   setToZone]   = useState('')
  const [srcType,  setSrcType]  = useState<'any' | 'specific'>('any')
  const [srcIp,    setSrcIp]    = useState('')
  const [dstType,  setDstType]  = useState<'any' | 'specific'>('specific')
  const [dstIp,    setDstIp]    = useState('')
  const [ports,    setPorts]    = useState<PortEntry[]>([{ id: ++_pid, protocol: 'tcp', port: '443' }])
  const [ruleAction, setRuleAction] = useState<'permit' | 'deny'>('permit')

  // ── data fetching ─────────────────────────────────────────────────────────────
  const fetchBook = useCallback(async () => {
    try {
      const r = await fetch('/api/firewall/address-book/enriched')
      if (!r.ok) return
      const data = await r.json()
      const zSet = new Set<string>()
      const ips: IpOption[] = []
      for (const aset of data.address_sets ?? []) {
        const z = (aset.name as string).replace('SET_', '')
        zSet.add(z)
        for (const addr of aset.addresses ?? [])
          ips.push({ ip: addr.ip, zone: z, source: addr.source })
      }
      const zArr = Array.from(zSet)
      setZones(zArr)
      setAllIps(ips)
      if (zArr.length) { setFromZone(z => z || zArr[0]); setToZone(z => z || zArr[0]) }
    } catch { /* silent */ }
  }, [])

  const fetchPolicies = useCallback(async () => {
    setLoadingPol(true)
    try {
      const r = await fetch('/api/firewall/sail-policies')
      if (!r.ok) return
      const d = await r.json()
      setPolicies(d.policies ?? [])
    } catch { /* silent */ }
    finally { setLoadingPol(false) }
  }, [])

  useEffect(() => { fetchBook(); fetchPolicies() }, [fetchBook, fetchPolicies])

  // ── port list helpers ─────────────────────────────────────────────────────────
  const addPort = () => setPorts(p => [...p, { id: ++_pid, protocol: 'tcp', port: '' }])

  const rmPort = (id: number) => setPorts(p => p.filter(e => e.id !== id))

  const updPort = (id: number, f: 'protocol' | 'port', v: string) =>
    setPorts(p => p.map(e => e.id === id ? { ...e, [f]: v } : e))

  const quickAdd = (port: number, proto: string) =>
    setPorts(p => p.some(e => e.port === String(port) && e.protocol === proto)
      ? p
      : [...p, { id: ++_pid, protocol: proto as PortEntry['protocol'], port: String(port) }]
    )

  // ── derived: IPs filtered by chosen zone ─────────────────────────────────────
  const srcIps = allIps.filter(a => a.zone === fromZone)
  const dstIps = allIps.filter(a => a.zone === toZone)

  // ── submit ────────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!ruleName.trim())              { showToast('Rule name is required'); return }
    if (!fromZone || !toZone)          { showToast('Both zones are required'); return }
    if (srcType === 'specific' && !srcIp) { showToast('Select a source IP'); return }
    if (dstType === 'specific' && !dstIp) { showToast('Select a destination IP'); return }

    const portSpecs = ports
      .filter(p => p.protocol === 'any' || p.port.trim() !== '')
      .map(p => ({ protocol: p.protocol, port: p.protocol === 'any' ? null : parseInt(p.port, 10) }))

    const payload = {
      name: ruleName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      from_zone: fromZone,
      to_zone: toZone,
      source_addresses:      srcType === 'any' ? ['any'] : [srcIp],
      destination_addresses: dstType === 'any' ? ['any'] : [dstIp],
      ports: portSpecs,
      action: ruleAction,
    }

    setSubmitting(true)
    try {
      const r = await fetch('/api/firewall/sail-policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`✓ SAIL_${payload.name} created`)
      setRuleName('')
      setPorts([{ id: ++_pid, protocol: 'tcp', port: '' }])
      setSrcType('any'); setDstType('specific')
      fetchPolicies()
    } catch (e: any) {
      showToast('Error: ' + e.message)
    } finally { setSubmitting(false) }
  }

  // ── delete ────────────────────────────────────────────────────────────────────
  async function handleDelete(pol: SailPolicy) {
    if (!confirm(`Delete policy ${pol.name}? This will immediately change firewall state.`)) return
    const key = `${pol.from_zone}|${pol.to_zone}|${pol.name}`
    setDeleting(key)
    try {
      const r = await fetch('/api/firewall/sail-policies/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_zone: pol.from_zone, to_zone: pol.to_zone, name: pol.name }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`Deleted ${pol.name}`)
      fetchPolicies()
    } catch (e: any) {
      showToast('Error: ' + e.message)
    } finally { setDeleting(null) }
  }

  // ── styles ────────────────────────────────────────────────────────────────────
  const card: React.CSSProperties = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 3, padding: '16px 18px', marginBottom: 20,
  }
  const row: React.CSSProperties = { display: 'flex', gap: 10, marginBottom: 12 }
  const col = (flex: number): React.CSSProperties => ({ flex })

  const radioLabel: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 11, cursor: 'pointer', marginRight: 14,
  }

  const quickBtn: React.CSSProperties = {
    fontSize: 10, padding: '2px 7px', borderRadius: 2, cursor: 'pointer',
    border: '1px solid var(--hpe-green-mid)', background: 'var(--hpe-green-lt)',
    color: 'var(--hpe-green-dk)', fontWeight: 700, lineHeight: 1.6,
  }

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ marginTop: 32 }}>
      <SubHeader
        title="VM Connectivity Rules"
        action={
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            SAIL-managed — prefixed <code style={{ fontSize: 10 }}>SAIL_</code>, never touched by Ansible
          </span>
        }
      />

      {/* ── explainer ── */}
      <div style={{
        fontSize: 11, color: 'var(--muted)', lineHeight: 1.7,
        background: 'rgba(100,130,200,.05)', border: '1px solid rgba(100,130,200,.2)',
        borderRadius: 3, padding: '10px 14px', marginBottom: 20,
      }}>
        Define which zones can reach a VM and on which ports. Each rule creates a named SRX security
        policy. Rules prefixed <code style={{ fontSize: 10 }}>SAIL_</code> are owned by this UI —
        Ansible only manages zone address sets, so these policies survive reconciliation.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>

        {/* ── LEFT: rule builder ── */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 12 }}>
            New Rule
          </div>
          <div style={card}>

            {/* Rule name */}
            <div style={{ marginBottom: 12 }}>
              <FieldLabel>Rule Name</FieldLabel>
              <input
                value={ruleName}
                onChange={e => setRuleName(e.target.value)}
                placeholder="ALLOW_WEB_TO_DB_HTTPS"
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
              />
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>
                Will be saved as <code style={{ fontSize: 9 }}>SAIL_{ruleName.toUpperCase().replace(/[^A-Z0-9_]/g, '_') || '…'}</code>
              </div>
            </div>

            {/* Zone row */}
            <div style={row}>
              <div style={col(1)}>
                <FieldLabel>From Zone</FieldLabel>
                <select value={fromZone} onChange={e => { setFromZone(e.target.value); setSrcIp('') }} style={{ width: '100%', fontSize: 11 }}>
                  {zones.map(z => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 6, color: 'var(--muted)', fontSize: 13 }}>→</div>
              <div style={col(1)}>
                <FieldLabel>To Zone</FieldLabel>
                <select value={toZone} onChange={e => { setToZone(e.target.value); setDstIp('') }} style={{ width: '100%', fontSize: 11 }}>
                  {zones.map(z => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
            </div>

            {/* Source address */}
            <div style={{ marginBottom: 12 }}>
              <FieldLabel>Source Address</FieldLabel>
              <div style={{ marginBottom: 6 }}>
                <label style={radioLabel}><input type="radio" checked={srcType === 'any'} onChange={() => setSrcType('any')} /> Any</label>
                <label style={radioLabel}><input type="radio" checked={srcType === 'specific'} onChange={() => setSrcType('specific')} /> Specific IP</label>
              </div>
              {srcType === 'specific' && (
                <select value={srcIp} onChange={e => setSrcIp(e.target.value)} style={{ width: '100%', fontSize: 11, fontFamily: 'monospace' }}>
                  <option value="">— select source IP —</option>
                  {srcIps.map(a => (
                    <option key={a.ip} value={a.ip}>{a.ip} ({a.source})</option>
                  ))}
                </select>
              )}
            </div>

            {/* Destination address */}
            <div style={{ marginBottom: 12 }}>
              <FieldLabel>Destination Address</FieldLabel>
              <div style={{ marginBottom: 6 }}>
                <label style={radioLabel}><input type="radio" checked={dstType === 'any'} onChange={() => setDstType('any')} /> Any</label>
                <label style={radioLabel}><input type="radio" checked={dstType === 'specific'} onChange={() => setDstType('specific')} /> Specific VM</label>
              </div>
              {dstType === 'specific' && (
                <select value={dstIp} onChange={e => setDstIp(e.target.value)} style={{ width: '100%', fontSize: 11, fontFamily: 'monospace' }}>
                  <option value="">— select destination IP —</option>
                  {dstIps.map(a => (
                    <option key={a.ip} value={a.ip}>{a.ip} ({a.source})</option>
                  ))}
                </select>
              )}
            </div>

            {/* Port quick-add */}
            <div style={{ marginBottom: 8 }}>
              <FieldLabel>Quick-add common ports</FieldLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {QUICK_PORTS.map(q => (
                  <button key={q.label} style={quickBtn} onClick={() => quickAdd(q.port, q.proto)}>
                    {q.label} <span style={{ fontWeight: 400, opacity: .7 }}>{q.port}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Port list */}
            <div style={{ marginBottom: 12 }}>
              <FieldLabel>Ports / Applications</FieldLabel>
              {ports.map(p => (
                <div key={p.id} style={{ display: 'flex', gap: 6, marginBottom: 5, alignItems: 'center' }}>
                  <select
                    value={p.protocol}
                    onChange={e => updPort(p.id, 'protocol', e.target.value)}
                    style={{ fontSize: 11, width: 70 }}
                  >
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                    <option value="any">Any</option>
                  </select>
                  <input
                    type="number" min={1} max={65535}
                    value={p.port}
                    disabled={p.protocol === 'any'}
                    onChange={e => updPort(p.id, 'port', e.target.value)}
                    placeholder={p.protocol === 'any' ? 'all ports' : 'port'}
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <button onClick={() => rmPort(p.id)} style={{ padding: '0 8px', height: 28, color: 'var(--red)', fontWeight: 700 }}>×</button>
                </div>
              ))}
              <button onClick={addPort} style={{ fontSize: 11, marginTop: 4 }}>+ Port</button>
              {ports.length === 0 && (
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>No ports = application "any"</div>
              )}
            </div>

            {/* Action */}
            <div style={{ marginBottom: 16 }}>
              <FieldLabel>Action</FieldLabel>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['permit', 'deny'] as const).map(a => (
                  <button
                    key={a}
                    onClick={() => setRuleAction(a)}
                    style={{
                      fontSize: 11, padding: '4px 14px', fontWeight: 700,
                      border: ruleAction === a
                        ? `2px solid ${a === 'permit' ? 'var(--hpe-green)' : 'var(--red)'}`
                        : '2px solid var(--border)',
                      background: ruleAction === a
                        ? (a === 'permit' ? 'var(--hpe-green-lt)' : 'var(--red-lt)')
                        : 'transparent',
                      color: ruleAction === a
                        ? (a === 'permit' ? 'var(--hpe-green-dk)' : '#7A2020')
                        : 'var(--muted)',
                      borderRadius: 2,
                    }}
                  >
                    {a === 'permit' ? '✓ Permit' : '⊘ Deny'}
                  </button>
                ))}
              </div>
            </div>

            {/* Summary preview */}
            {ruleName && fromZone && toZone && (
              <div style={{
                background: 'rgba(0,0,0,.03)', border: '1px solid var(--border-lt)',
                borderRadius: 3, padding: '8px 12px', marginBottom: 14,
                fontSize: 10, fontFamily: 'monospace', color: 'var(--muted)', lineHeight: 1.8,
              }}>
                <strong style={{ color: 'var(--hpe-green-dk)' }}>Preview</strong><br />
                from-zone: {fromZone} → to-zone: {toZone}<br />
                src: {srcType === 'any' ? 'any' : srcIp || '?'} → dst: {dstType === 'any' ? 'any' : dstIp || '?'}<br />
                ports: {ports.filter(p => p.protocol === 'any' || p.port).map(p => p.protocol === 'any' ? 'any' : `${p.protocol}/${p.port}`).join(', ') || 'any'}<br />
                action: <strong style={{ color: ruleAction === 'permit' ? 'var(--hpe-green-dk)' : '#7A2020' }}>{ruleAction}</strong>
              </div>
            )}

            <button className="primary" onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Applying…' : '⊕ Create Rule'}
            </button>
          </div>
        </div>

        {/* ── RIGHT: existing SAIL policies ── */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
              Active SAIL Rules ({policies.length})
            </div>
            <button onClick={fetchPolicies} disabled={loadingPol} style={{ fontSize: 11 }}>
              {loadingPol ? '…' : '↻ Refresh'}
            </button>
          </div>

          {loadingPol && policies.length === 0 && (
            <div className="loading" style={{ fontSize: 12 }}>● Loading…</div>
          )}

          {!loadingPol && policies.length === 0 && (
            <div style={{
              border: '1px dashed var(--border)', borderRadius: 3,
              padding: 24, textAlign: 'center',
              fontSize: 12, color: 'var(--muted)',
            }}>
              No SAIL-managed rules yet.<br />
              <span style={{ fontSize: 11 }}>Rules you create here will appear in this list.</span>
            </div>
          )}

          {policies.map((pol, i) => {
            const key = `${pol.from_zone}|${pol.to_zone}|${pol.name}`
            const isDel = deleting === key
            return (
              <div key={i} style={{
                ...card,
                marginBottom: 10,
                borderLeft: `3px solid ${pol.action === 'permit' ? 'var(--hpe-green)' : 'var(--red)'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                      {pol.name}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', gap: 10 }}>
                      <span>
                        <span style={{ fontFamily: 'monospace' }}>{pol.from_zone}</span>
                        {' → '}
                        <span style={{ fontFamily: 'monospace' }}>{pol.to_zone}</span>
                      </span>
                      <span className={`badge ${pol.action === 'permit' ? 'b-permit' : 'b-deny'}`}>
                        {pol.action}
                      </span>
                    </div>
                  </div>
                  <button
                    className="danger"
                    onClick={() => handleDelete(pol)}
                    disabled={isDel}
                    style={{ fontSize: 10, padding: '3px 10px' }}
                  >
                    {isDel ? '…' : 'Delete'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}