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
  id:      string
  source:  string
  target:  string
}

interface TopologyData {
  nodes: TopoNode[]
  edges: TopoEdge[]
}

// Map color tokens to match your corporate system palette or fall back safely
const NODE_COLORS: Record<string, string> = {
  orange:          'var(--orange, #CC4E00)',
  blue:            'var(--hpe-green-dk, #007B5E)', // mapping fallback blue cleanly
  purple:          'var(--purple, #6B40A8)',
  green:           'var(--hpe-green, #01A982)',
  yellow:          'var(--yellow, #A8750A)',
  'semi-dark-red': 'var(--red, #C54E4B)',
  red:             'var(--red, #C54E4B)',
}

function resolveColor(c: string): string {
  return NODE_COLORS[c] ?? c ?? 'var(--hpe-green, #01A982)'
}

interface LayoutNode extends TopoNode {
  x: number
  y: number
  r: number
}

// Computes structural coordinates inside an isolated 1000x1000 virtual matrix
function buildLayout(topo: TopologyData): LayoutNode[] {
  const cx = 500
  const cy = 500

  const srx   = topo.nodes.find(n => n.id === 'srx')
  const zones  = topo.nodes.filter(n => n.id.startsWith('zone_'))
  const vms    = topo.nodes.filter(n => !n.id.startsWith('zone_') && n.id !== 'srx')

  const result: LayoutNode[] = []

  // Centerpiece gateway
  if (srx) result.push({ ...srx, x: cx, y: cy, r: 42 })

  // Structural rings scaled perfectly for smaller node environments
  const zoneR = 180
  zones.forEach((z, i) => {
    const angle = (2 * Math.PI * i) / zones.length - Math.PI / 2
    result.push({
      ...z,
      x: cx + zoneR * Math.cos(angle),
      y: cy + zoneR * Math.sin(angle),
      r: 32,
    })
  })

  const vmR = 320
  const zoneAngles: Record<string, number> = {}
  zones.forEach((z, i) => {
    zoneAngles[z.id] = (2 * Math.PI * i) / zones.length - Math.PI / 2
  })

  const zoneVms: Record<string, string[]> = {}
  topo.edges.forEach(e => {
    const src = e.source
    const target = e.target
    if (src.startsWith('zone_')) {
      if (!zoneVms[src]) zoneVms[src] = []
      if (!zoneVms[src].includes(target)) zoneVms[src].push(target)
    }
  })

  Object.entries(zoneVms).forEach(([zoneId, vmIds]) => {
    const baseAngle = zoneAngles[zoneId] ?? 0
    const spread    = Math.min(0.8, vmIds.length * 0.22)
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
        r: 24,
      })
    })
  })

  const placed = new Set(result.map(n => n.id))
  const orphans = vms.filter(v => !placed.has(v.id))
  orphans.forEach((vm, i) => {
    const angle = (2 * Math.PI * i) / orphans.length
    result.push({
      ...vm,
      x: cx + vmR * Math.cos(angle),
      y: cy + vmR * Math.sin(angle),
      r: 24,
    })
  })

  return result
}

function Node({ n, selected, onClick }: { n: LayoutNode; selected: boolean; onClick: () => void }) {
  const fill = resolveColor(n.color)
  const stroke = selected ? 'var(--text, #1A1A1A)' : 'rgba(0,0,0,0.12)'
  const sw = selected ? 3 : 1.5

  return (
    <g onClick={onClick} style={{ cursor: 'pointer' }} transform={`translate(${n.x},${n.y})`}>
      <circle
        r={n.r + (selected ? 6 : 0)}
        fill={fill}
        fillOpacity={0.10}
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
          fill: '#FFFFFF',
          fontFamily: 'inherit',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {n.title.length > 10 ? n.title.slice(0, 9) + '…' : n.title}
      </text>
      <text
        y={n.r + 15}
        textAnchor="middle"
        style={{
          fontSize: 10,
          fontWeight: 600,
          fill: 'var(--text-2)',
          fontFamily: 'inherit',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {n.mainStat}
      </text>
    </g>
  )
}

function DetailPanel({ node, onClose }: { node: LayoutNode; onClose: () => void }) {
  const fill = resolveColor(node.color)
  return (
    <div className="no-pan" style={{
      position: 'absolute', top: 20, right: 20,
      background: 'var(--surface)',
      border: `1px solid var(--border)`,
      borderTop: `4px solid ${fill}`,
      borderRadius: 2, padding: '16px 18px', minWidth: 240,
      boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
      zIndex: 100,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: fill }} />
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>{node.title}</div>
        </div>
        <button
          onClick={onClose}
          style={{
            border: 'none', background: 'none', cursor: 'pointer',
            color: 'var(--muted)', fontSize: 16, padding: '0 4px',
            fontWeight: 700, lineHeight: 1,
          }}
        >×</button>
      </div>
      {[
        ['Node ID', node.id],
        ['Address/Sub', node.subTitle],
        ['Status Scope', node.mainStat],
      ].map(([label, value]) => value ? (
        <div key={label} style={{ marginBottom: 10 }}>
          <div style={{
            fontSize: 9, fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3,
          }}>{label}</div>
          <div style={{
            fontSize: 11, fontFamily: 'monospace',
            background: 'var(--bg)', padding: '4px 8px',
            border: '1px solid var(--border-lt)', borderRadius: 2,
            color: 'var(--text-2)', overflowX: 'auto'
          }}>{value}</div>
        </div>
      ) : null)}
    </div>
  )
}

export default function Topology() {
  const [topo, setTopo] = useState<TopologyData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)
  const [cooldown, setCooldown] = useState(0)
  
  // Transform State Systems for Mapping/Panning/Zooming Engine
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(0.85) // Start tracking outward slightly to center coordinate frame cleanly
  const [isDragging, setIsDragging] = useState(false)
  
  const containerRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef({ x: 0, y: 0 })
  const clickStartTimestamp = useRef<number>(0)
  const cooldownTimer = useRef<number | null>(null)

  // Automatic Viewport Centering Logic based on element scale
  const initializeCenterPosition = useCallback((width: number, height: number) => {
    const virtualCanvasSize = 1000
    const initialScale = Math.min(width, height) / virtualCanvasSize * 0.85
    setZoom(initialScale)
    setPan({
      x: (width - virtualCanvasSize * initialScale) / 2,
      y: (height - virtualCanvasSize * initialScale) / 2
    })
  }, [])

  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      if (!entries || entries.length === 0 || topo === null) return
      // Only execute centering structural logic on initialization parameters
      if (pan.x === 0 && pan.y === 0 && zoom === 0.85) {
        const { width, height } = entries[0].contentRect
        initializeCenterPosition(width, height)
      }
    })
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [topo, initializeCenterPosition, pan.x, pan.y, zoom])

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) window.clearInterval(cooldownTimer.current)
    }
  }, [])

  const startCooldown = useCallback(() => {
    setCooldown(30)
    if (cooldownTimer.current) window.clearInterval(cooldownTimer.current)
    
    cooldownTimer.current = window.setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) {
          if (cooldownTimer.current) window.clearInterval(cooldownTimer.current)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [])

  const fetchTopo = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetch('/topology.json?t=' + Date.now())
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      if (!data || !data.nodes) throw new Error('Data structure parsing error.')
      
      setTopo(data)
      setLastFetch(new Date())
      startCooldown()
      
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        initializeCenterPosition(rect.width, rect.height)
      }
    } catch (e: any) {
      setError(e.message)
      showToast('Topology: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [startCooldown, initializeCenterPosition])

  useEffect(() => {
    fetchTopo()
  }, [fetchTopo])

  // Mouse Input/Pointer Events Interceptors for spatial canvas movement
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.no-pan')) return
    setIsDragging(true)
    clickStartTimestamp.current = Date.now()
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return
    setPan({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y
    })
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    if (!containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    // Configure zoom scale coefficient factors
    const zoomFactor = 1.12
    let nextZoom = e.deltaY < 0 ? zoom * zoomFactor : zoom / zoomFactor
    
    // Hard ceiling constraints for map scaling stability
    nextZoom = Math.max(0.2, Math.min(nextZoom, 4.0))

    // Mathematical adjustments to scale viewport directly into mouse pointer focal vector
    setPan(prevPan => ({
      x: mouseX - (mouseX - prevPan.x) * (nextZoom / zoom),
      y: mouseY - (mouseY - prevPan.y) * (nextZoom / zoom)
    }))
    setZoom(nextZoom)
  }

  const layout = topo ? buildLayout(topo) : []
  const selectedNode = layout.find(n => n.id === selected) ?? null
  const nodeMap = Object.fromEntries(layout.map(n => [n.id, n]))

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 130px)', width: '100%', userSelect: 'none' }}>
      {/* Control Bar Actions */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
        background: 'var(--stats-bg)', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Live Network Topology Map
        </div>
        
        {/* Navigation Help Indicator */}
        <div style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 16, display: 'inline-flex', gap: 10 }}>
          <span>🖱️ Drag to Move</span>
          <span>📜 Scroll to Zoom</span>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          {lastFetch && (
            <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
              Synced: {lastFetch.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={fetchTopo}
            disabled={loading || cooldown > 0}
            className={cooldown === 0 ? "primary" : ""}
          >
            {loading ? '...' : cooldown > 0 ? `↻ Sync (${cooldown}s)` : '↻ Sync Canvas'}
          </button>
        </div>
      </div>

      {/* Dynamic Graphing Canvas Grid */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{
          flex: 1, position: 'relative', overflow: 'hidden',
          background: 'var(--bg)', cursor: isDragging ? 'grabbing' : 'grab'
        }}
      >
        {error && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📡</div>
            <div style={{ fontWeight: 700, color: 'var(--text)' }}>{error}</div>
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--muted)' }}>
              Verify network path connectivity configurations on endpoint target 8880.
            </div>
          </div>
        )}

        {!error && topo && (
          <svg
            width="100%"
            height="100%"
            style={{ display: 'block', pointerEvents: 'auto' }}
            onClick={e => {
              // Ensure that shifting canvas around does not drop selection properties or trigger accidental closures
              const interactionDuration = Date.now() - clickStartTimestamp.current
              if (interactionDuration > 200) return 

              if ((e.target as SVGElement).tagName === 'svg') {
                setSelected(null)
              }
            }}
          >
            {/* Global Matrix Transform Node Wrappers */}
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {/* Layout Vector Connectors */}
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
                      strokeWidth={1.75}
                      fill="none"
                      strokeOpacity={0.8}
                    />
                  )
                })}
              </g>

              {/* Layout Node Systems */}
              <g>
                {layout.map(n => (
                  <Node
                    key={n.id}
                    n={n}
                    selected={selected === n.id}
                    onClick={() => {
                      const dragDuration = Date.now() - clickStartTimestamp.current
                      if (dragDuration > 200) return // Drag event isolated successfully
                      setSelected(selected === n.id ? null : n.id)
                    }}
                  />
                ))}
              </g>
            </g>
          </svg>
        )}

        {/* Floating Detail Overlay */}
        {selectedNode && (
          <DetailPanel node={selectedNode} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  )
}