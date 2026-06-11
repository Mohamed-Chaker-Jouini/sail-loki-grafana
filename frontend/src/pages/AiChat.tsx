import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

type ChatSession = {
  conversationId: string
  messages: ChatMessage[]
}

const STORAGE_KEY = 'sail.aichat.session.v1'

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function initialAssistantMessage(): ChatMessage {
  return {
    id: uid(),
    role: 'assistant',
    content:
      'Hi — I can help explain drift events, summarize logs, and draft incident reports. Ask me about what changed, why it changed, or how to fix it.',
    createdAt: Date.now(),
  }
}

function safeLoadSession(): ChatSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.conversationId !== 'string') return null
    if (!Array.isArray(parsed.messages)) return null

    const messages = parsed.messages
      .filter(
        (m: any) =>
          m &&
          typeof m.content === 'string' &&
          (m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      )
      .map((m: any) => ({
        id: String(m.id ?? uid()),
        role: m.role,
        content: String(m.content),
        createdAt: Number(m.createdAt ?? Date.now()),
      }))

    return {
      conversationId: parsed.conversationId,
      messages: messages.length ? messages : [initialAssistantMessage()],
    }
  } catch {
    return null
  }
}



export default function AiChat() {
  const endpoint = useMemo(
    () => (import.meta as any)?.env?.VITE_AI_CHAT_URL || '/api/ai/chat',
    []
  )

  const loadedSession = useMemo(() => safeLoadSession(), [])

  const [conversationId, setConversationId] = useState<string>(
    () => loadedSession?.conversationId || uid()
  )

  const [messages, setMessages] = useState<ChatMessage[]>(
    () => loadedSession?.messages || [initialAssistantMessage()]
  )

  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          conversationId,
          messages,
        } satisfies ChatSession)
      )
    } catch {
      // ignore storage failures
    }
  }, [conversationId, messages])

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
          conversation_id: conversationId,
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

  function newChat() {
    const nextConversationId = uid()
    setConversationId(nextConversationId)
    setMessages([initialAssistantMessage()])
    setInput('')
    setError(null)
    setSending(false)

    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore storage failures
    }
  }

  const canSend = input.trim().length > 0 && !sending

  return (
    <div
      style={{
        height: 'calc(100vh - 115px)',
        padding: 16,
      }}
    >
      <section
        style={{
          height: '100%',
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
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>AI Chat</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Local analyst for drift explanations, summaries, and incident writeups
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              className="badge b-clean"
              style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11 }}
            >
              {sending ? 'Thinking' : 'Ready'}
            </span>
            <button type="button" onClick={newChat}>
              New chat
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
            background: 'linear-gradient(180deg, rgba(230,247,243,.35), transparent 80px)',
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
              rows={3}
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
    </div>
  )
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
          maxWidth: '85%',
          padding: '10px 14px',
          borderRadius: 10,
          border: '1px solid',
          borderColor: isUser ? 'var(--hpe-green-mid)' : 'var(--border)',
          background: isUser ? 'var(--hpe-green-lt)' : 'var(--surface)',
          color: 'var(--text)',
          boxShadow: isAssistant ? '0 1px 0 rgba(0,0,0,.02)' : 'none',
          fontSize: 13,
          lineHeight: 1.6,
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

        {isUser ? (
          <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
        ) : (
          <div className="ai-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}