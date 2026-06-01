import type { Tab } from '../App'

interface Props {
  activeTab: Tab
  tabs: { id: Tab; label: string }[]
  onTabChange: (t: Tab) => void
}

export default function Header({ activeTab, tabs, onTabChange }: Props) {
  return (
    <header style={{
      background: 'var(--header-bg)',
      borderBottom: '3px solid var(--hpe-green)',
      boxShadow: '0 2px 8px rgba(1,169,130,.10)',
    }}>
      {/* top bar: logo + app name */}
      <div style={{
        padding: '0 28px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        minHeight: 56,
      }}>
        
          href="https://www.hpe.com"
          target="_blank"
          rel="noreferrer"
          style={{ display: 'block', lineHeight: 0 }}
        >
          <img
            src="https://upload.wikimedia.org/wikipedia/commons/e/e7/Hewlett_Packard_Enterprise_logo_2025.svg"
            alt="Hewlett Packard Enterprise"
            height="34"
          />
        </a>
        <div style={{ width: 1, height: 36, background: 'var(--border)' }} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
            SAIL
          </div>
          <div style={{
            fontSize: 10, color: 'var(--muted)',
            letterSpacing: '.07em', textTransform: 'uppercase',
          }}>
            SRX / Morpheus Reconciliation
          </div>
        </div>
      </div>

      {/* tab bar */}
      <nav style={{
        display: 'flex',
        paddingLeft: 20,
        borderTop: '1px solid var(--border-lt)',
      }}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            style={{
              border: 'none',
              borderBottom: activeTab === t.id
                ? '3px solid var(--hpe-green)'
                : '3px solid transparent',
              borderRadius: 0,
              background: 'transparent',
              color: activeTab === t.id ? 'var(--hpe-green-dk)' : 'var(--muted)',
              fontWeight: activeTab === t.id ? 700 : 400,
              padding: '10px 18px',
              fontSize: 12,
              letterSpacing: '.05em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              transition: 'color .12s, border-color .12s',
              marginBottom: -3,
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  )
}