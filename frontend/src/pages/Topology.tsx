import { useState, useEffect, useRef, useCallback } from 'react'
import { showToast } from '../components/Toast'

interface TopoNode {
  id:       string
  title:    string
  subTitle: string
  mainStat: string
  color:    string
}
interface TopoEdge {
  id:     string
  source: string
  target: string
}
interface Topology {
  nodes: TopoNode[]
  edges: TopoEdge[]
}

// ── colour map matching Grafana node graph exactly ────────────────────────────
const NODE_COLORS: Record<string, string> = {
  orange:        '#E8853D',
  blue:          '#4C78A8',
  purple:        '#7B61C4',
  green:         '#3AA655',
  yellow:        '#C4A229',
  'semi-dark-red':'#B03A2E',
  red:           '#C54E4B',
}
function resolveColor(c: string): string {
  return NODE_COLORS[c] ?? c ?? '#4C78A8'
}

// ── layout: radial from centre ────────────────────────────────────────────────
interface LayoutNode extends TopoNode {
  x: number
  y: number
  r: number
}

function buildLayout(topo: Topology, w: number, h: number): LayoutNode[] {
  const cx = w / 2
  const cy = h / 2

  const srx   = topo.nodes.find(n => n.id === 'srx')
  const zones  = topo.nodes.filter(n => n.id.startsWith('zone_'))
  const vms    = topo.nodes.filter(n => !n.id.startsWith('zone_') && n.id !== 'srx')

  const result: LayoutNode[] = []

  // SRX in centre
  if (srx) result.push({ ...srx, x: cx, y: cy, r: 38 })

  // zones on inner ring
  const zoneR = Math.min(w, h) * 0.28
  zones.forEach((z, i) => {
    const angle = (2 * Math.PI * i) / zones.length - Math.PI / 2
    result.push({
      ...z,
      x: cx + zoneR * Math.cos(angle),
      y: cy + zoneR * Math.sin(angle),
      r: 30,
    })
  })

  // VMs on outer ring, grouped by zone
  const vmR = Math.min(w, h) * 0.46
  const zoneAngles: Record<string, number> = {}
  zones.forEach((z, i) => {
    zoneAngles[z.id] = (2 * Math.PI * i) / zones.length - Math.PI / 2
  })

  // group VMs by their zone edge
  const zoneVms: Record<string, string[]> = {}
  topo.edges.forEach(e => {
    const target = e.target
    const src    = e.source
    if (src.startsWith('zone_')) {
      if (!zoneVms[src]) zoneVms[src] = []
      zoneVms[src].push(target)
    }
  })

  // also handle removed- nodes (source is zone_*)
  topo.edges.forEach(e => {
    if (e.source.startsWith('zone_') && e.target.startsWith('removed-')) {
      if (!zoneVms[e.source]) zoneVms[e.source] = []
      if (!zoneVms[e.source].includes(e.target))
        zoneVms[e.source].push(e.target)
    }
  })

  Object.entries(zoneVms).forEach(([zoneId, vmIds]) => {
    const baseAngle = zoneAngles[zoneId] ?? 0
    const spread    = Math.min(0.6, vmIds.length * 0.15)
    vmIds.forEach((vmId, i) => {
      const vm = vms.find(v => v.id === vmId)
      if (!vm) return
      const offset = vmIds.length === 1
        ? 0
        : -spread / 2 + (spread / (vmIds.length - 1)) * i
      const angle = baseAngle + offset
      result.push({
        ...vm,
        x: cx + vmR * Math.cos(angle),
        y: cy + vmR * Math.sin(angle),
        r: 22,
      })
    })
  })

  // any VMs not connected to a zone — spread around outer ring
  const placed = new Set(result.map(n => n.id))
  const orphans = vms.filter(v => !placed.has(v.id))
  orphans.forEach((vm, i) => {
    const angle = (2 * Math.PI * i) / orphans.length
    result.push({
      ...vm,
      x: cx + vmR * Math.cos(angle),
      y: cy + vmR * Math.sin(angle),
      r: 22,
    })
  })

  return result
}

// ── node component ────────────────────────────────────────────────────────────
function Node({ n, selected, onClick }: {
  n: LayoutNode
  selected: boolean
  onClick: () => void
}) {
  const fill   = resolveColor(n.color)
  const stroke = selected ? '#fff' : 'rgba(0,0,0,.18)'
  const sw     = selected ? 3 : 1.5

  return (
    <g
      onClick={onClick}
      style={{ cursor: 'pointer' }}
      transform={`translate(${n.x},${n.y})`}
    >
      <circle
        r={n.r + (selected ? 5 : 0)}
        fill={fill}
        fillOpacity={0.15}
        stroke={selected ? fill : 'transparent'}
        strokeWidth={selected ? 2 : 0}
      />
      <circle r={n.r} fill={fill} stroke={stroke} strokeWidth={sw} />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontSize: n.r > 30 ? 11 : 9,
          fontWeight: 700,
          fill: '#fff',
          fontFamily: 'inherit',
          pointerEvents: 'none',
        }}
      >
        {n.title.length > 8 ? n.title.slice(0, 7) + '…' : n.title}
      </text>
      <text
        y={n.r + 14}
        textAnchor="middle"
        style={{
          fontSize: 10,
          fill: 'var(--text-2)',
          fontFamily: 'inherit',
          pointerEvents: 'none',
        }}
      >
        {n.mainStat}
      </text>
    </g>
  )
}

// ── detail panel ──────────────────────────────────────────────────────────────
function DetailPanel({ node, onClose }: { node: LayoutNode; onClose: () => void }) {
  const fill = resolveColor(node.color)
  return (
    <div style={{
      position: 'absolute', top: 16, right: 16,
      background: 'var(--surface)',
      border: `2px solid ${fill}`,
      borderRadius: 4, padding: '16px 18px', minWidth: 200,
      boxShadow: '0 4px 16px rgba(0,0,0,.10)',
      zIndex: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{
            width: 14, height: 14, borderRadius: '50%',
            background: fill, flexShrink: 0,
          }} />
          <div style={{ fontWeight: 700, fontSize: 13 }}>{node.title}</div>
        </div>
        <button
          onClick={onClose}
          style={{
            border: 'none', background: 'none', cursor: 'pointer',
            color: 'var(--muted)', fontSize: 16, padding: '0 0 0 8px',
            fontWeight: 700, lineHeight: 1,
          }}
        >×</button>
      </div>
      {[
        ['ID',       node.id],
        ['Subtitle', node.subTitle],
        ['Stat',     node.mainStat],
      ].map(([l, v]) => v ? (
        <div key={l} style={{ marginBottom: 8 }}>
          <div style={{
            fontSize: 9, fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 2,
          }}>{l}</div>
          <div style={{
            fontSize: 11, fontFamily: 'monospace',
            background: 'var(--bg)', padding: '3px 7px',
            border: '1px solid var(--border)', borderRadius: 2,
          }}>{v}</div>
        </div>
      ) : null)}
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────
export default function Topology() {
  const [topo,     setTopo]     = useState<Topology | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [lastFetch,setLastFetch]= useState<Date | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 800, h: 560 })
  const cooldownTimer = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setDims({ w: Math.max(width, 400), h: Math.max(height, 400) })
    })
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  const startCooldown = useCallback(() => {
    setCooldown(30)
    clearInterval(cooldownTimer.current)
    cooldownTimer.current = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) { clearInterval(cooldownTimer.current); return 0 }
        return prev - 1
      })
    }, 1000)
  }, [])

  const fetchTopo = useCallback(async () => {
    if (cooldown > 0) return
    setLoading(true); setError('')
    try {
      const r = await fetch('/topology.json?t=' + Date.now())
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      if (!data.nodes) throw new Error('No topology data yet')
      setTopo(data)
      setLastFetch(new Date())
      startCooldown()
    } catch (e: any) {
      setError(e.message)
      showToast('Topology: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [cooldown, startCooldown])

  useEffect(() => { fetchTopo() }, [])

  const layout = topo ? buildLayout(topo, dims.w, dims.h) : []
  const selectedNode = layout.find(n => n.id === selected) ?? null

  // build edge path between two layout nodes
  function edgePath(src: LayoutNode, tgt: LayoutNode): string {
    const dx = tgt.x - src.x
    const dy = tgt.y - src.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist === 0) return ''
    const nx = dx / dist
    const ny = dy / dist
    const x1 = src.x + nx * src.r
    const y1 = src.y + ny * src.r
    const x2 = tgt.x - nx * tgt.r
    const y2 = tgt.y - ny * tgt.r
    return `M${x1},${y1} L${x2},${y2}`
  }

  const nodeMap = Object.fromEntries(layout.map(n => [n.id, n]))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 130px)' }}>
      {/* toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 20px',
        background: 'var(--stats-bg)',
        borderBottom: '1px solid var(--hpe-green-mid)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)',
                      textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Live Network Topology
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          {lastFetch && (
            <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700 }}>
              Last fetched: {lastFetch.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={fetchTopo}
            disabled={loading || cooldown > 0}
          >
            {loading ? '…' : cooldown > 0 ? `↻ Refresh (${cooldown}s)` : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* legend */}
      <div style={{
        display: 'flex', gap: 16, padding: '8px 20px',
        background: 'var(--surface)', borderBottom: '1px solid var(--border-lt)',
        flexShrink: 0, flexWrap: 'wrap',
      }}>
        {[
          { color: '#E8853D', label: 'vSRX Firewall' },
          { color: '#4C78A8', label: 'Zone' },
          { color: '#3AA655', label: 'In Sync' },
          { color: '#C54E4B', label: 'Drift Fixed / Removed' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: color, flexShrink: 0,
            }} />
            <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700,
                           textTransform: 'uppercase', letterSpacing: '.06em' }}>
              {label}
            </span>
          </div>
        ))}
      </div>

      {/* graph area */}
      <div
        ref={containerRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--bg)' }}
      >
        {error && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%,-50%)',
            textAlign: 'center', color: 'var(--muted)',
          }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📡</div>
            <div style={{ fontWeight: 700 }}>{error}</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>
              Waiting for the first Ansible run to publish topology data.
            </div>
          </div>
        )}

        {!error && topo && (
          <svg
            width={dims.w}
            height={dims.h}
            style={{ display: 'block' }}
            onClick={e => {
              if ((e.target as SVGElement).tagName === 'svg') setSelected(null)
            }}
          >
            {/* edges */}
            <g>
              {topo.edges.map(edge => {
                const src = nodeMap[edge.source]
                const tgt = nodeMap[edge.target]
                if (!src || !tgt) return null
                const d = edgePath(src, tgt)
                return (
                  <path
                    key={edge.id}
                    d={d}
                    stroke="var(--border)"
                    strokeWidth={1.5}
                    fill="none"
                    strokeOpacity={0.7}
                  />
                )
              })}
            </g>
            {/* nodes */}
            <g>
              {layout.map(n => (
                <Node
                  key={n.id}
                  n={n}
                  selected={selected === n.id}
                  onClick={() => setSelected(selected === n.id ? null : n.id)}
                />
              ))}
            </g>
          </svg>
        )}

        {selectedNode && (
          <DetailPanel
            node={selectedNode}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  )
}