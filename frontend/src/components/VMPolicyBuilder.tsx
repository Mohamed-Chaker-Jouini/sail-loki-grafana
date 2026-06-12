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

// ── zone-guessing helpers ────────────────────────────────────────────────────
// Address-book sets are named SET_<TIER> (e.g. SET_WEB). By convention this
// playbook's reconciliation creates security zones named <TIER>_ZONE for
// brand-new tiers (see sail_sync.yml Phase 3 "deny-all" policy names).
// We use that convention to guess the real SRX security zone for a given
// address-set "tier" name, falling back to an exact-name match, then giving
// up (caller should fall back to Advanced mode / manual entry).
function guessZoneForTier(tier: string, zones: string[]): string {
  const candidates = [`${tier}_ZONE`, tier]
  for (const c of candidates) {
    const match = zones.find(z => z.toLowerCase() === c.toLowerCase())
    if (match) return match
  }
  return ''
}

// "Anyone / anything" generally maps to the internet-facing zone, which by
// Juniper convention is named "untrust".
function guessUntrustZone(zones: string[]): string {
  return zones.find(z => /untrust/i.test(z)) || ''
}

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

  // ── mode ─────────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple')

  // ── shared form state (ports / action / name) ─────────────────────────────────
  const [ports, setPorts] = useState<PortEntry[]>([{ id: ++_pid, protocol: 'tcp', port: '443' }])
  const [ruleAction, setRuleAction] = useState<'permit' | 'deny'>('permit')
  const [ruleName, setRuleName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)

  // ── simple-mode state ───────────────────────────────────────────────────────
  const [subjectIp, setSubjectIp]   = useState('')
  const [direction, setDirection]   = useState<'inbound' | 'outbound'>('inbound')
  const [otherType, setOtherType]   = useState<'any' | 'specific'>('any')
  const [otherIp,   setOtherIp]     = useState('')

  // ── advanced-mode state ─────────────────────────────────────────────────────
  const [fromZone, setFromZone] = useState('')
  const [toZone,   setToZone]   = useState('')
  const [srcType,  setSrcType]  = useState<'any' | 'specific'>('any')
  const [srcIp,    setSrcIp]    = useState('')
  const [dstType,  setDstType]  = useState<'any' | 'specific'>('specific')
  const [dstIp,    setDstIp]    = useState('')

  // ── data fetching ─────────────────────────────────────────────────────────────
  const fetchBook = useCallback(async () => {
    try {
      const [zoneRes, bookRes] = await Promise.all([
        fetch('/api/firewall/zones'),
        fetch('/api/firewall/address-book/enriched'),
      ])
      if (zoneRes.ok) {
        const { zones: zArr } = await zoneRes.json()
        setZones(zArr ?? [])
        if (zArr?.length) {
          setFromZone(z => z || zArr[0])
          setToZone(z => z || zArr[0])
        }
      }
      if (bookRes.ok) {
        const data = await bookRes.json()
        const ips: IpOption[] = []
        for (const aset of data.address_sets ?? []) {
          const z = (aset.name as string).replace('SET_', '')
          for (const addr of aset.addresses ?? [])
            ips.push({ ip: addr.ip, zone: z, source: addr.source })
        }
        setAllIps(ips)
      }
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

  function portSpecs() {
    return ports
      .filter(p => p.protocol === 'any' || p.port.trim() !== '')
      .map(p => ({ protocol: p.protocol, port: p.protocol === 'any' ? null : parseInt(p.port, 10) }))
  }

  function portsSummary() {
    const specs = ports.filter(p => p.protocol === 'any' || p.port)
    if (specs.length === 0) return 'all ports'
    return specs.map(p => p.protocol === 'any' ? 'any' : `${p.protocol}/${p.port}`).join(', ')
  }

  // ── derived: IPs grouped by address-book set for <optgroup> display ──────────
  const ipsBySet = allIps.reduce<Record<string, IpOption[]>>((acc, a) => {
    ;(acc[a.zone] ??= []).push(a)
    return acc
  }, {})

  // ── simple-mode derived zone resolution ───────────────────────────────────────
  const subject = allIps.find(a => a.ip === subjectIp) || null
  const other   = otherType === 'specific' ? (allIps.find(a => a.ip === otherIp) || null) : null

  const subjectZone = subject ? guessZoneForTier(subject.zone, zones) : ''
  const otherZone   = otherType === 'any'
    ? guessUntrustZone(zones)
    : (other ? guessZoneForTier(other.zone, zones) : '')

  const simpleZonesResolved = !!subjectIp && !!subjectZone && (otherType === 'any' ? !!otherZone : (!!otherIp && !!otherZone))

  function autoRuleName(): string {
    if (!subjectIp) return ''
    const verb = direction === 'inbound' ? 'ALLOW_IN' : 'ALLOW_OUT'
    const otherPart = otherType === 'any' ? 'ANY' : (otherIp || 'OTHER')
    const specs = ports.filter(p => p.protocol === 'any' || p.port)
    const portPart = specs.length
      ? specs.map(p => p.protocol === 'any' ? 'ANY' : p.port).join('_')
      : 'ANY'
    return `${verb}_${subjectIp.replace(/\./g, '_')}_${otherPart.replace(/\./g, '_')}_${portPart}`
  }

  const displayName = (nameTouched ? ruleName : autoRuleName())

  // ── submit ────────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    let payload: any

    if (mode === 'simple') {
      if (!subjectIp) { showToast('Select which VM this rule is for'); return }
      if (otherType === 'specific' && !otherIp) { showToast('Select the other VM'); return }
      if (!simpleZonesResolved) {
        showToast("Couldn't auto-detect the security zones — use Advanced mode")
        return
      }

      const from_zone = direction === 'inbound' ? otherZone : subjectZone
      const to_zone   = direction === 'inbound' ? subjectZone : otherZone
      const source_addresses = direction === 'inbound'
        ? (otherType === 'any' ? ['any'] : [otherIp])
        : [subjectIp]
      const destination_addresses = direction === 'inbound'
        ? [subjectIp]
        : (otherType === 'any' ? ['any'] : [otherIp])

      payload = {
        name: displayName.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
        from_zone, to_zone, source_addresses, destination_addresses,
        ports: portSpecs(), action: ruleAction,
      }
    } else {
      if (!ruleName.trim())              { showToast('Rule name is required'); return }
      if (!fromZone || !toZone)          { showToast('Both zones are required'); return }
      if (srcType === 'specific' && !srcIp) { showToast('Select a source IP'); return }
      if (dstType === 'specific' && !dstIp) { showToast('Select a destination IP'); return }

      payload = {
        name: ruleName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
        from_zone: fromZone,
        to_zone: toZone,
        source_addresses:      srcType === 'any' ? ['any'] : [srcIp],
        destination_addresses: dstType === 'any' ? ['any'] : [dstIp],
        ports: portSpecs(),
        action: ruleAction,
      }
    }

    if (!payload.name) { showToast('Rule name is required'); return }

    setSubmitting(true)
    try {
      const r = await fetch('/api/firewall/sail-policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      showToast(`✓ SAIL_${payload.name} created`)
      // reset shared bits
      setRuleName(''); setNameTouched(false)
      setPorts([{ id: ++_pid, protocol: 'tcp', port: '' }])
      // reset mode-specific bits
      if (mode === 'simple') {
        setSubjectIp(''); setOtherIp(''); setOtherType('any'); setDirection('inbound')
      } else {
        setSrcType('any'); setDstType('specific'); setSrcIp(''); setDstIp('')
      }
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
  const radioLabelBlock: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, cursor: 'pointer', marginBottom: 8,
  }

  const quickBtn: React.CSSProperties = {
    fontSize: 10, padding: '2px 7px', borderRadius: 2, cursor: 'pointer',
    border: '1px solid var(--hpe-green-mid)', background: 'var(--hpe-green-lt)',
    color: 'var(--hpe-green-dk)', fontWeight: 700, lineHeight: 1.6,
  }

  const modeBtn = (active: boolean): React.CSSProperties => ({
    fontSize: 11, padding: '4px 12px', fontWeight: 700, cursor: 'pointer',
    border: active ? '2px solid var(--hpe-green-mid)' : '2px solid var(--border)',
    background: active ? 'var(--hpe-green-lt)' : 'transparent',
    color: active ? 'var(--hpe-green-dk)' : 'var(--muted)',
    borderRadius: 2,
  })

  // ── shared port-list UI ─────────────────────────────────────────────────────
  const portListUI = (
    <>
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

      <div style={{ marginBottom: 12 }}>
        <FieldLabel>Ports</FieldLabel>
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
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>No ports = all ports</div>
        )}
      </div>
    </>
  )

  // ── shared action-toggle UI ──────────────────────────────────────────────────
  const actionUI = (
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
            {a === 'permit' ? '✓ Allow' : '⊘ Block'}
          </button>
        ))}
      </div>
    </div>
  )

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
        Decide what a VM is allowed to talk to and on which ports. Each rule creates a firewall policy.
        Rules created here are prefixed <code style={{ fontSize: 10 }}>SAIL_</code> and survive
        automation reconciliation.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>

        {/* ── LEFT: rule builder ── */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
              New Rule
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={modeBtn(mode === 'simple')} onClick={() => setMode('simple')}>Simple</button>
              <button style={modeBtn(mode === 'advanced')} onClick={() => setMode('advanced')}>Advanced</button>
            </div>
          </div>

          <div style={card}>
            {mode === 'simple' ? (
              <>
                {/* Step 1: subject VM */}
                <div style={{ marginBottom: 14 }}>
                  <FieldLabel>Which VM is this rule for?</FieldLabel>
                  <select
                    value={subjectIp}
                    onChange={e => setSubjectIp(e.target.value)}
                    style={{ width: '100%', fontSize: 11, fontFamily: 'monospace' }}
                  >
                    <option value="">— select a VM —</option>
                    {Object.entries(ipsBySet).map(([set, ips]) => (
                      <optgroup key={set} label={`${set} group`}>
                        {ips.map(a => (
                          <option key={a.ip} value={a.ip}>{a.ip} ({a.source})</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                {/* Step 2: direction */}
                <div style={{ marginBottom: 14 }}>
                  <FieldLabel>What should this rule allow?</FieldLabel>
                  <label style={radioLabelBlock}>
                    <input type="radio" checked={direction === 'inbound'} onChange={() => setDirection('inbound')} />
                    Other systems can connect <strong>to</strong> this VM
                  </label>
                  <label style={radioLabelBlock}>
                    <input type="radio" checked={direction === 'outbound'} onChange={() => setDirection('outbound')} />
                    This VM can connect <strong>out to</strong> other systems
                  </label>
                </div>

                {/* Step 3: other side */}
                <div style={{ marginBottom: 14 }}>
                  <FieldLabel>{direction === 'inbound' ? 'Who can connect to it?' : 'What can it connect to?'}</FieldLabel>
                  <div style={{ marginBottom: 6 }}>
                    <label style={radioLabel}>
                      <input type="radio" checked={otherType === 'any'} onChange={() => setOtherType('any')} /> Anyone / anything
                    </label>
                    <label style={radioLabel}>
                      <input type="radio" checked={otherType === 'specific'} onChange={() => setOtherType('specific')} /> A specific VM
                    </label>
                  </div>
                  {otherType === 'specific' && (
                    <select
                      value={otherIp}
                      onChange={e => setOtherIp(e.target.value)}
                      style={{ width: '100%', fontSize: 11, fontFamily: 'monospace' }}
                    >
                      <option value="">— select VM —</option>
                      {Object.entries(ipsBySet).map(([set, ips]) => (
                        <optgroup key={set} label={`${set} group`}>
                          {ips.filter(a => a.ip !== subjectIp).map(a => (
                            <option key={a.ip} value={a.ip}>{a.ip} ({a.source})</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  )}
                </div>

                {portListUI}
                {actionUI}

                {/* zone resolution warning */}
                {subjectIp && !simpleZonesResolved && (
                  <div style={{
                    background: 'rgba(255,200,50,.08)', border: '1px solid rgba(255,200,50,.35)',
                    borderRadius: 3, padding: '10px 12px', fontSize: 11, color: '#9a7a00',
                    marginBottom: 14, lineHeight: 1.6,
                  }}>
                    ⚠ Couldn't automatically work out the firewall zone names for this VM
                    {otherType === 'specific' ? ' or the other VM' : ''}.{' '}
                    Switch to <strong onClick={() => setMode('advanced')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                      Advanced mode
                    </strong> to set them manually.
                  </div>
                )}

                {/* plain-english preview */}
                {subjectIp && simpleZonesResolved && (
                  <div style={{
                    background: 'rgba(0,0,0,.03)', border: '1px solid var(--border-lt)',
                    borderRadius: 3, padding: '10px 12px', marginBottom: 14,
                    fontSize: 11, color: 'var(--muted)', lineHeight: 1.8,
                  }}>
                    <strong style={{ color: 'var(--hpe-green-dk)' }}>This rule will…</strong><br />
                    {ruleAction === 'permit' ? 'Allow ' : 'Block '}
                    {direction === 'inbound'
                      ? (
                        <>
                          <strong>{otherType === 'any' ? 'anything' : otherIp}</strong> to reach{' '}
                          <strong>{subjectIp}</strong>
                        </>
                      )
                      : (
                        <>
                          <strong>{subjectIp}</strong> to reach{' '}
                          <strong>{otherType === 'any' ? 'anything' : otherIp}</strong>
                        </>
                      )}
                    {' '}on <strong>{portsSummary()}</strong>.
                    <div style={{ marginTop: 6, fontSize: 10, opacity: .75 }}>
                      Technical: {direction === 'inbound' ? otherZone : subjectZone} → {direction === 'inbound' ? subjectZone : otherZone}
                    </div>
                  </div>
                )}

                {/* rule name override */}
                <div style={{ marginBottom: 14 }}>
                  <FieldLabel>Rule name</FieldLabel>
                  <input
                    value={displayName}
                    onChange={e => { setRuleName(e.target.value); setNameTouched(true) }}
                    placeholder="auto-generated from your choices above"
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>
                    Will be saved as <code style={{ fontSize: 9 }}>SAIL_{displayName.toUpperCase().replace(/[^A-Z0-9_]/g, '_') || '…'}</code>
                  </div>
                </div>

                <button className="primary" onClick={handleSubmit} disabled={submitting || !subjectIp}>
                  {submitting ? 'Applying…' : '⊕ Create Rule'}
                </button>
              </>
            ) : (
              <>
                {/* Rule name */}
                <div style={{ marginBottom: 12 }}>
                  <FieldLabel>Rule Name</FieldLabel>
                  <input
                    value={ruleName}
                    onChange={e => { setRuleName(e.target.value); setNameTouched(true) }}
                    placeholder="ALLOW_WEB_TO_DB_HTTPS"
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
                  />
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>
                    Will be saved as <code style={{ fontSize: 9 }}>SAIL_{ruleName.toUpperCase().replace(/[^A-Z0-9_]/g, '_') || '…'}</code>
                  </div>
                </div>

                {/* Zone row */}
                <datalist id="zone-list">
                  {zones.map(z => <option key={z} value={z} />)}
                </datalist>
                <div style={row}>
                  <div style={col(1)}>
                    <FieldLabel>From Zone</FieldLabel>
                    <input
                      list="zone-list"
                      value={fromZone}
                      onChange={e => { setFromZone(e.target.value); setSrcIp('') }}
                      placeholder={zones.length ? zones[0] : 'e.g. trust'}
                      style={{ width: '100%', fontSize: 11, fontFamily: 'monospace' }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 6, color: 'var(--muted)', fontSize: 13 }}>→</div>
                  <div style={col(1)}>
                    <FieldLabel>To Zone</FieldLabel>
                    <input
                      list="zone-list"
                      value={toZone}
                      onChange={e => { setToZone(e.target.value); setDstIp('') }}
                      placeholder={zones.length ? zones[0] : 'e.g. untrust'}
                      style={{ width: '100%', fontSize: 11, fontFamily: 'monospace' }}
                    />
                  </div>
                </div>
                {zones.length === 0 && (
                  <div style={{ fontSize: 10, color: '#cc8800', marginTop: -8, marginBottom: 8 }}>
                    ⚠ Could not load zone names — type the zone name exactly as configured on the SRX
                  </div>
                )}

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
                      {Object.entries(ipsBySet).map(([set, ips]) => (
                        <optgroup key={set} label={`SET_${set}`}>
                          {ips.map(a => (
                            <option key={a.ip} value={a.ip}>{a.ip} ({a.source})</option>
                          ))}
                        </optgroup>
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
                      {Object.entries(ipsBySet).map(([set, ips]) => (
                        <optgroup key={set} label={`SET_${set}`}>
                          {ips.map(a => (
                            <option key={a.ip} value={a.ip}>{a.ip} ({a.source})</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  )}
                </div>

                {portListUI}
                {actionUI}

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
                    ports: {portsSummary()}<br />
                    action: <strong style={{ color: ruleAction === 'permit' ? 'var(--hpe-green-dk)' : '#7A2020' }}>{ruleAction}</strong>
                  </div>
                )}

                <button className="primary" onClick={handleSubmit} disabled={submitting}>
                  {submitting ? 'Applying…' : '⊕ Create Rule'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── RIGHT: existing SAIL policies ── */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
              Active Rules ({policies.length})
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
              No rules yet.<br />
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