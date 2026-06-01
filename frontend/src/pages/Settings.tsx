import { useState, useEffect } from 'react'
import { showToast } from '../components/Toast'

const COOKIE = 'sail_srx_cfg'

interface SRXConfig {
  host: string
  username: string
  password: string
  port: number
}

function readCookie(): SRXConfig | null {
  const m = document.cookie.split('; ').find(r => r.startsWith(COOKIE + '='))
  if (!m) return null
  try { return JSON.parse(decodeURIComponent(m.split('=').slice(1).join('='))) }
  catch { return null }
}

function writeCookie(cfg: SRXConfig) {
  const val = encodeURIComponent(JSON.stringify(cfg))
  // SameSite=Strict, no Secure flag (HTTP internal network), 30-day expiry
  const exp = new Date(Date.now() + 30 * 864e5).toUTCString()
  document.cookie = `${COOKIE}=${val}; expires=${exp}; path=/; SameSite=Strict`
}

function clearCookie() {
  document.cookie = `${COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`
}

export function loadCredentialsFromCookie(): SRXConfig | null {
  return readCookie()
}

export default function Settings() {
  const [host, setHost]       = useState('')
  const [username, setUser]   = useState('root')
  const [password, setPass]   = useState('')
  const [port, setPort]       = useState(830)
  const [saving, setSaving]   = useState(false)
  const [status, setStatus]   = useState<'idle'|'ok'|'err'>('idle')

  useEffect(() => {
    const cfg = readCookie()
    if (cfg) {
      setHost(cfg.host)
      setUser(cfg.username)
      setPass(cfg.password)
      setPort(cfg.port)
    }
  }, [])

  async function handleSave() {
    if (!host || !password) {
      showToast('Host and password are required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/firewall/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, username, password, port }),
      })
      if (!res.ok) throw new Error(await res.text())
      writeCookie({ host, username, password, port })
      setStatus('ok')
      showToast('Credentials saved')
    } catch (e: any) {
      setStatus('err')
      showToast('Save failed: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleClear() {
    await fetch('/api/firewall/credentials', { method: 'DELETE' })
    clearCookie()
    setHost(''); setUser('root'); setPass(''); setPort(830)
    setStatus('idle')
    showToast('Credentials cleared')
  }

  const row: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16,
  }
  const label: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: 'var(--muted)',
    textTransform: 'uppercase', letterSpacing: '.07em',
  }

  return (
    <div style={{ padding: '32px 28px', maxWidth: 520 }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
        vSRX Connection
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 24 }}>
        Credentials are stored in a browser cookie (SameSite=Strict) and sent
        to the backend on each firewall request. They are never written to disk.
        Clearing removes both the cookie and the in-memory store.
      </div>

      <div style={row}>
        <label style={label}>Host / IP</label>
        <input
          type="text" value={host} onChange={e => setHost(e.target.value)}
          placeholder="10.202.52.10" style={{ width: 300 }}
        />
      </div>

      <div style={row}>
        <label style={label}>Username</label>
        <input
          type="text" value={username} onChange={e => setUser(e.target.value)}
          style={{ width: 200 }}
        />
      </div>

      <div style={row}>
        <label style={label}>Password</label>
        <input
          type="password" value={password} onChange={e => setPass(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <div style={row}>
        <label style={label}>NETCONF Port</label>
        <input
          type="number" value={port}
          onChange={e => setPort(Number(e.target.value))}
          style={{ width: 120 }}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
        <button className="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Credentials'}
        </button>
        <button className="danger" onClick={handleClear}>
          Clear Credentials
        </button>
        {status === 'ok' && (
          <span style={{ color: 'var(--hpe-green-dk)', fontSize: 12, fontWeight: 700 }}>
            ✓ Connected
          </span>
        )}
        {status === 'err' && (
          <span style={{ color: 'var(--red)', fontSize: 12, fontWeight: 700 }}>
            ✗ Failed
          </span>
        )}
      </div>
    </div>
  )
}