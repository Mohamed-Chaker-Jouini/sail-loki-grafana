import { useEffect, useMemo, useRef, useState } from 'react'

type Role = 'user' | 'assistant' | 'system'

type ChatMessage = {
  id: string
  role: Role
  content: string
  createdAt: number
}

type AiChatResponse = {
  conversation_id?: string
  message?: {
    id?: string
    role?: 'assistant'
    content?: string
    created_at?: string
  }
  reply?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  trace?: Record<string, unknown>
  error?: string
}

const STORAGE_KEY = 'sail.aichat.history.v1'

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function safeLoadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
      .map((m) => ({
        id: String(m.id ?? uid()),
        role: m.role,
        content: String(m.content),
        createdAt: Number(m.createdAt ?? Date.now()),
      }))
  } catch {
    return []
  }
}

export default function AiChat() {
  const endpoint = useMemo(
    () => (import.meta as any)?.env?.VITE_AI_CHAT_URL || '/api/ai/chat',
    []
  )

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = safeLoadHistory()
    return saved.length
      ? saved
      : [
          {
            id: uid(),
            role: 'assistant',
            content:
              'Hi — I can help explain drift events, summarize logs, and draft incident reports. Ask me about what changed, why it changed, or how to fix it.',
            createdAt: Date.now(),
          },
        ]
  })

  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
    } catch {
      // ignore storage failures
    }
  }, [messages])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  async function sendMessage() {
    const text = input.trim()
    if (!text || sending) return

    setError(null)
    setInput('')

    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    }

    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setSending(true)

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          conversation_id: getConversationId(nextMessages),
          messages: nextMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: false,
          temperature: 0.2,
          max_output_tokens: 600,
          context: {
            app: 'SAIL',
            page: 'ai_chat',
          },
        }),
      })

      const contentType = res.headers.get('content-type') || ''
      let payload: AiChatResponse | null = null

      if (contentType.includes('application/json')) {
        payload = (await res.json()) as AiChatResponse
      } else {
        const text = await res.text()
        payload = { reply: text }
      }

      if (!res.ok) {
        const detail = payload?.error || payload?.reply || `Request failed (${res.status})`
        throw new Error(detail)
      }

      const reply =
        payload?.message?.content ||
        payload?.reply ||
        'No response was returned by the AI service.'

      setMessages((prev) => [
        ...prev,
        {
          id: payload?.message?.id || uid(),
          role: 'assistant',
          content: reply,
          createdAt: Date.now(),
        },
      ])
    } catch (e: any) {
      setError(e?.message || 'Unable to reach the AI service.')
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'assistant',
          content:
            'I could not connect to the AI backend yet. Once the service is online, this chat will start replying normally.',
          createdAt: Date.now(),
        },
      ])
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }

  function clearChat() {
    setMessages([
      {
        id: uid(),
        role: 'assistant',
        content:
          'Hi — I can help explain drift events, summarize logs, and draft incident reports. Ask me about what changed, why it changed, or how to fix it.',
        createdAt: Date.now(),
      },
    ])
    setError(null)
  }

  const canSend = input.trim().length > 0 && !sending

  return (
    <div
      style={{
        height: 'calc(100vh - 115px)',
        display: 'grid',
        gridTemplateColumns: '1.5fr .7fr',
        gap: 16,
        padding: 16,
      }}
    >
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: '0 1px 0 rgba(0,0,0,.02)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--border-lt)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>AI Chat</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Local analyst for drift explanations, summaries, and incident writeups
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              className="badge b-clean"
              style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11 }}
            >
              {sending ? 'Thinking' : 'Ready'}
            </span>
            <button type="button" onClick={clearChat}>
              Clear
            </button>
          </div>
        </div>

        <div
          ref={listRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 16,
            background: 'linear-gradient(180deg, rgba(230,247,243,.35), transparent 120px)',
          }}
        >
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}

          {sending && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
              <div
                style={{
                  maxWidth: '80%',
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--muted)',
                  fontSize: 12,
                }}
              >
                Generating response…
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            padding: 14,
            borderTop: '1px solid var(--border-lt)',
            background: 'var(--surface)',
          }}
        >
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            {[
              'Summarize the latest drift',
              'Explain why this firewall rule changed',
              'Draft an incident report',
            ].map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => setInput(prompt)}
                disabled={sending}
                style={{ textTransform: 'none', fontSize: 11, fontWeight: 700 }}
              >
                {prompt}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about a drift event, a firewall change, or request a report..."
              rows={4}
              style={{
                flex: 1,
                resize: 'none',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
                padding: '10px 12px',
                fontSize: 13,
                outline: 'none',
                borderRadius: 6,
                fontFamily: 'inherit',
                lineHeight: 1.5,
              }}
            />
            <button type="button" className="primary" onClick={sendMessage} disabled={!canSend}>
              Send
            </button>
          </div>

          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
            Press Enter to send, Shift+Enter for a new line.
            {error ? <span style={{ color: 'var(--red)', marginLeft: 8 }}>{error}</span> : null}
          </div>
        </div>
      </section>

      <aside
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: 0,
        }}
      >
        <Card title="What this endpoint should do">
          <p style={helpText}>
            Send the full message history, optional incident context, and request flags. The AI
            service should return a single assistant message for now, with streaming added later if
            you want token-by-token output.
          </p>
        </Card>

        <Card title="Suggested behavior">
          <p style={helpText}>
            Best results come from a model that can: inspect drift logs, compare before/after
            config, identify likely root cause, and produce a concise action plan.
          </p>
        </Card>

        <Card title="Frontend config">
          <p style={helpText}>
            The component uses <code>/api/ai/chat</code> by default. Override it with
            <code>VITE_AI_CHAT_URL</code> when the backend lives elsewhere.
          </p>
        </Card>
      </aside>
    </div>
  )
}

function getConversationId(messages: ChatMessage[]) {
  const first = messages[0]
  if (!first) return uid()
  return `sail-${first.createdAt}`
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 12,
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid',
          borderColor: isUser ? 'var(--hpe-green-mid)' : 'var(--border)',
          background: isUser ? 'var(--hpe-green-lt)' : 'var(--surface)',
          color: 'var(--text)',
          boxShadow: isAssistant ? '0 1px 0 rgba(0,0,0,.02)' : 'none',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
          fontSize: 13,
        }}
      >
        <div
          style={{
            marginBottom: 6,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: isUser ? 'var(--hpe-green-dk)' : 'var(--muted)',
          }}
        >
          {isUser ? 'You' : 'AI'}
        </div>
        {message.content}
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 14,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

const helpText: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-2)',
  lineHeight: 1.7,
}