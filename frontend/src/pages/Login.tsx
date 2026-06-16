import { useState } from 'react'

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault()
    // Hard-coded admin credentials
    if (username === 'admin' && password === 'admin') {
      setError('')
      onLogin()
    } else {
      setError('Invalid credentials. Please use admin / admin.')
    }
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100vh',
      background: 'var(--bg)'
    }}>
      <div style={{
        background: 'var(--surface)',
        padding: '40px',
        borderRadius: '4px',
        border: '1px solid var(--border)',
        width: '100%',
        maxWidth: '380px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.03)'
      }}>

        {/* HPE Themed Header */}
        <div style={{
          borderBottom: '3px solid var(--hpe-green)',
          paddingBottom: '16px',
          marginBottom: '24px',
          textAlign: 'center'
        }}>
          <h2 style={{
            margin: 0,
            color: 'var(--text)',
            fontSize: '22px',
            fontWeight: 800,
            letterSpacing: '0.02em'
          }}>
            Sign In
          </h2>
        </div>

        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Error Message */}
          {error && (
            <div style={{
              color: 'var(--red)',
              background: 'var(--red-lt)',
              padding: '8px 12px',
              borderRadius: '2px',
              fontSize: '12px',
              border: '1px solid var(--red)'
            }}>
              {error}
            </div>
          )}

          {/* Username Input */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter admin"
            />
          </div>

          {/* Password Input */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter admin"
            />
          </div>

          {/* Submit Button */}
          <button type="submit" className="primary" style={{ marginTop: '12px', height: '36px', fontSize: '12px' }}>
            Secure Login
          </button>

        </form>
      </div>
    </div>
  )
}