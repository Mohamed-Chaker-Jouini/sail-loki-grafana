import React from 'react'
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
      borderBottom: '4px solid var(--hpe-green)',
      boxShadow: '0 2px 12px rgba(1,169,130,.13)',
      position: 'sticky',
      top: 0,
      zIndex: 100,
    }}>
      {/* logo row */}
      <div style={{
        padding: '0 32px',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        minHeight: 62,
        borderBottom: '1px solid var(--border-lt)',
      }}>
        
          href="https://www.hpe.com"
          target="_blank"
          rel="noreferrer"
          style={{ display: 'block', lineHeight: '0' }}
        >
          <img
            src="https://upload.wikimedia.org/wikipedia/commons/e/e7/Hewlett_Packard_Enterprise_logo_2025.svg"
            alt="Hewlett Packard Enterprise"
            height={36}
          />
        </a>
        <div style={{ width: 1, height: 38, background: 'var(--border)' }} />
        <div>
          <div style={{
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--text)',
            letterSpacing: '.01em',
          }}>
            SAIL
          </div>
          <div style={{
            fontSize: 10,
            color: 'var(--muted)',
            letterSpacing: '.08em',
            textTransform: 'uppercase' as const,
            marginTop: 1,
          }}>
            Security Automation &amp; Infrastructure Link
          </div>
        </div>
      </div>

      {/* tab row */}
      <nav style={{
        display: 'flex',
        paddingLeft: 24,
        background: 'var(--surface)',
        gap: 2,
      }}>
        {tabs.map(t => {
          const active = activeTab === t.id
          return (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              style={{
                border: 'none',
                borderBottom: active
                  ? '4px solid var(--hpe-green)'
                  : '4px solid transparent',
                borderTop: 'none',
                borderLeft: 'none',
                borderRight: 'none',
                borderRadius: 0,
                background: active ? 'var(--hpe-green-lt)' : 'transparent',
                color: active ? 'var(--hpe-green-dk)' : 'var(--text-2)',
                fontWeight: active ? 700 : 500,
                padding: '14px 22px',
                fontSize: 13,
                letterSpacing: '.04em',
                textTransform: 'uppercase' as const,
                cursor: 'pointer',
                transition: 'background .12s, color .12s, border-color .12s',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap' as const,
              }}
              onMouseEnter={e => {
                if (!active) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--hpe-green-lt)'
                  ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--hpe-green-dk)'
                }
              }}
              onMouseLeave={e => {
                if (!active) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                  ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-2)'
                }
              }}
            >
              {t.label}
            </button>
          )
        })}
      </nav>
    </header>
  )
}