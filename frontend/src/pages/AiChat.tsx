export default function AiChat() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: 'calc(100vh - 115px)',
      flexDirection: 'column', gap: 12,
      color: 'var(--muted)',
    }}>
      <div style={{ fontSize: 32 }}>🤖</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
        AI Chat — Coming Soon
      </div>
      <div style={{ fontSize: 12, maxWidth: 400, textAlign: 'center', lineHeight: 1.6 }}>
        The local AI analyst will trace drift events, explain what happened
        in plain language, and generate post-incident reports. Stay tuned.
      </div>
    </div>
  )
}