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

// ── Stable module-level cache (survives remounts, not page refresh) ────────────
// These are plain objects — never mutated during render. Only written in event
// handlers / effects so there are no stale-closure or double-render hazards.
const cache: {
  topology:  TopologyData | null
  lastFetch: Date | null
  pan:       { x: number; y: number }
  zoom:      number
  selected:  string | null
} = {
  topology:  null,
  lastFetch: null,
  pan:       { x: 0, y: 0 },
  zoom:      0.85,
  selected:  null,
}

const TOPOLOGY_REFRESH_MS = 10_000

const NODE_COLORS: Record<string, string> = {
  orange:          'var(--orange, #CC4E00)',
  blue:            'var(--hpe-green-dk, #007B5E)',
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

// ── Horizontal Layered Layout ─────────────────────────────────────────────────
function buildLayout(topo: TopologyData): LayoutNode[] {
  const layerX = { firewall: 200, zones: 500, vms: 850 }
  const centerY = 500

  const srx   = topo.nodes.find(n => n.id === 'srx')
  const zones = topo.nodes.filter(n => n.id.startsWith('zone_'))
  const vms   = topo.nodes.filter(n => !n.id.startsWith('zone_') && n.id !== 'srx')

  const result: LayoutNode[] = []

  if (srx) result.push({ ...srx, x: layerX.firewall, y: centerY, r: 42 })

  const zoneSpacing = Math.min(240, 800 / Math.max(1, zones.length))
  const zoneStartY  = centerY - ((zones.length - 1) * zoneSpacing) / 2
  const zoneYMap: Record<string, number> = {}

  zones.forEach((z, i) => {
    const y = zoneStartY + i * zoneSpacing
    zoneYMap[z.id] = y
    result.push({ ...z, x: layerX.zones, y, r: 34 })
  })

  const zoneVms: Record<string, string[]> = {}
  topo.edges.forEach(e => {
    if (e.source.startsWith('zone_')) {
      if (!zoneVms[e.source]) zoneVms[e.source] = []
      if (!zoneVms[e.source].includes(e.target)) zoneVms[e.source].push(e.target)
    }
  })

  const placedVms = new Set<string>()
  Object.entries(zoneVms).forEach(([zoneId, vmIds]) => {
    const parentY   = zoneYMap[zoneId] ?? centerY
    const vmStartY  = parentY - ((vmIds.length - 1) * 75) / 2
    vmIds.forEach((vmId, i) => {
      const vm = vms.find(v => v.id === vmId)
      if (!vm) return
      placedVms.add(vmId)
      result.push({ ...vm, x: layerX.vms, y: vmStartY + i * 75, r: 28 })
    })
  })

  const orphans      = vms.filter(v => !placedVms.has(v.id))
  const orphanStartY = centerY - ((orphans.length - 1) * 75) / 2
  orphans.forEach((vm, i) => {
    result.push({ ...vm, x: layerX.vms, y: orphanStartY + i * 75, r: 28 })
  })

  return result
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Node({ n, selected, onClick }: { n: LayoutNode; selected: boolean; onClick: () => void }) {
  const fill   = resolveColor(n.color)
  const stroke = selected ? 'var(--text, #1A1A1A)' : 'rgba(0,0,0,0.12)'
  const sw     = selected ? 3 : 1.5

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
        {n.title}
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
        ['Node ID',      node.id],
        ['Address/Sub',  node.subTitle],
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
            color: 'var(--text-2)', overflowX: 'auto',
          }}>{value}</div>
        </div>
      ) : null)}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Topology() {
  const [topo,      setTopo]      = useState<TopologyData | null>(() => cache.topology)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [selected,  setSelected]  = useState<string | null>(() => cache.selected)
  const [lastFetch, setLastFetch] = useState<Date | null>(() => cache.lastFetch)
  const [pan,       setPan]       = useState(() => cache.pan)
  const [zoom,      setZoom]      = useState(() => cache.zoom)
  const [isDragging, setIsDragging] = useState(false)

  const containerRef        = useRef<HTMLDivElement>(null)
  const dragStart           = useRef({ x: 0, y: 0 })
  const clickStartTimestamp = useRef(0)

  // ── Refs that always reflect current state ─────────────────────────────────
  // Using refs here avoids including pan/zoom in fetchTopo's dependency array,
  // which previously caused the polling interval to restart on every pan/zoom.
  const panRef      = useRef(pan)
  const zoomRef     = useRef(zoom)
  const selectedRef = useRef(selected)

  useEffect(() => { panRef.current      = pan;      cache.pan      = pan      }, [pan])
  useEffect(() => { zoomRef.current     = zoom;     cache.zoom     = zoom     }, [zoom])
  useEffect(() => { selectedRef.current = selected; cache.selected = selected }, [selected])

  // ── Canvas centering ───────────────────────────────────────────────────────
  const initializeCenterPosition = useCallback((width: number, height: number) => {
    const virtualW = 1000, virtualH = 1000
    const scale    = Math.min(width / virtualW, height / virtualH) * 0.95
    const nextPan  = {
      x: (width  - virtualW * scale) / 2 + 50,
      y: (height - virtualH * scale) / 2,
    }
    // Write to both state (triggers render) and cache (survives remount)
    setZoom(scale)
    setPan(nextPan)
  }, [])  // no external deps — safe to be stable

  // ── Resize observer: center only on first load ─────────────────────────────
  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      if (!entries.length || cache.topology === null) return
      // Only auto-center if pan/zoom are still at their initial defaults
      if (panRef.current.x === 0 && panRef.current.y === 0 && zoomRef.current === 0.85) {
        const { width, height } = entries[0].contentRect
        initializeCenterPosition(width, height)
      }
    })
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [initializeCenterPosition])
  // NOTE: `topo` removed from deps — the ResizeObserver itself doesn't depend
  // on topo; we gate on cache.topology (the ref-equivalent) inside the callback.

  // ── Fetch ──────────────────────────────────────────────────────────────────
  // fetchTopo no longer closes over pan/zoom state — it reads from refs instead.
  // This means the polling interval is created exactly once and never restarted.
  const fetchTopo = useCallback(async (isBackgroundSync = false) => {
    const hasCanvasData = cache.topology !== null

    if (!isBackgroundSync && !hasCanvasData) setLoading(true)

    try {
      const r = await fetch('/topology.json?t=' + Date.now())
      if (!r.ok) throw new Error(`HTTP ${r.status}`)

      const data: TopologyData = await r.json()
      if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        throw new Error('Data structure parsing error.')
      }

      cache.topology  = data
      cache.lastFetch = new Date()

      setTopo(data)
      setLastFetch(cache.lastFetch)
      setError('')

      // Center canvas only on the very first successful load
      if (!hasCanvasData && containerRef.current && panRef.current.x === 0 && panRef.current.y === 0) {
        const { width, height } = containerRef.current.getBoundingClientRect()
        initializeCenterPosition(width, height)
      }
    } catch (e: any) {
      const message = e?.message ?? 'Failed to refresh topology'
      setError(cache.topology ? `Showing last known topology. Refresh failed: ${message}` : message)
      if (!isBackgroundSync) showToast('Topology: ' + message)
    } finally {
      setLoading(false)
    }
  }, [initializeCenterPosition])
  // pan / zoom are intentionally absent — read via refs above

  // ── Polling: stable interval, never restarted by pan/zoom changes ──────────
  useEffect(() => {
    fetchTopo(cache.topology !== null)
    const id = setInterval(() => fetchTopo(true), TOPOLOGY_REFRESH_MS)
    return () => clearInterval(id)
  }, [fetchTopo])  // fetchTopo is now stable (no pan.x dep)

  // ── Pan & zoom handlers ────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.no-pan')) return
    setIsDragging(true)
    clickStartTimestamp.current = Date.now()
    dragStart.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return
    setPan({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y })
  }

  const handleMouseUp = () => setIsDragging(false)

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    if (!containerRef.current) return

    const rect       = containerRef.current.getBoundingClientRect()
    const mouseX     = e.clientX - rect.left
    const mouseY     = e.clientY - rect.top
    const zoomFactor = 1.12
    const currentZoom = zoomRef.current
    const nextZoom   = Math.max(0.2, Math.min(e.deltaY < 0 ? currentZoom * zoomFactor : currentZoom / zoomFactor, 4.0))

    // Read current pan from ref to avoid stale closure
    setPan({
      x: mouseX - (mouseX - panRef.current.x) * (nextZoom / currentZoom),
      y: mouseY - (mouseY - panRef.current.y) * (nextZoom / currentZoom),
    })
    setZoom(nextZoom)
  }

  // ── Derived data ───────────────────────────────────────────────────────────
  const layout       = topo ? buildLayout(topo) : []
  const selectedNode = layout.find(n => n.id === selected) ?? null
  const nodeMap      = Object.fromEntries(layout.map(n => [n.id, n]))

  function edgePath(src: LayoutNode, tgt: LayoutNode): string {
    const x1 = src.x + src.r, y1 = src.y
    const x2 = tgt.x - tgt.r, y2 = tgt.y
    const cpX = (x2 - x1) / 2
    return `M${x1},${y1} C${x1 + cpX},${y1} ${x2 - cpX},${y2} ${x2},${y2}`
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 130px)', width: '100%', userSelect: 'none' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
        background: 'var(--stats-bg)', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Live Network Topology Map
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 16, display: 'inline-flex', gap: 10 }}>
          <span>Drag to Move</span>
          <span>Scroll to Zoom</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          {error && topo && (
            <span style={{ fontSize: 11, color: 'var(--yellow, #A8750A)', fontWeight: 700 }}>
              ⚠ Last refresh failed
            </span>
          )}
          {lastFetch && (
            <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
              Live Synced: {lastFetch.toLocaleTimeString()}
            </span>
          )}
          <button onClick={() => fetchTopo(false)} disabled={loading} className="primary">
            {loading ? 'Syncing...' : '↻ Sync Canvas'}
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{
          flex: 1, position: 'relative', overflow: 'hidden',
          background: 'var(--bg)', cursor: isDragging ? 'grabbing' : 'grab',
        }}
      >
        {error && !topo && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📡</div>
            <div style={{ fontWeight: 700, color: 'var(--text)' }}>{error}</div>
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--muted)' }}>
              Verify network path connectivity configurations on endpoint target 8880.
            </div>
          </div>
        )}

        {error && topo && (
          <div className="no-pan" style={{
            position: 'absolute', left: 20, bottom: 20, maxWidth: 420,
            background: 'var(--surface)', border: '1px solid var(--yellow, #A8750A)',
            color: 'var(--text)', padding: '10px 12px', fontSize: 11,
            fontWeight: 600, zIndex: 90, boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          }}>
            ⚠ {error}
          </div>
        )}

        {topo && (
          <svg
            width="100%" height="100%"
            style={{ display: 'block', pointerEvents: 'auto' }}
            onClick={e => {
              if (Date.now() - clickStartTimestamp.current > 200) return
              if ((e.target as SVGElement).tagName === 'svg') setSelected(null)
            }}
          >
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              <g>
                {topo.edges.map(edge => {
                  const src = nodeMap[edge.source]
                  const tgt = nodeMap[edge.target]
                  if (!src || !tgt) return null
                  return (
                    <path
                      key={edge.id}
                      d={edgePath(src, tgt)}
                      stroke="var(--border)"
                      strokeWidth={2}
                      fill="none"
                      strokeOpacity={0.8}
                    />
                  )
                })}
              </g>
              <g>
                {layout.map(n => (
                  <Node
                    key={n.id}
                    n={n}
                    selected={selected === n.id}
                    onClick={() => {
                      if (Date.now() - clickStartTimestamp.current > 200) return
                      setSelected(selected === n.id ? null : n.id)
                    }}
                  />
                ))}
              </g>
            </g>
          </svg>
        )}

        {selectedNode && (
          <DetailPanel node={selectedNode} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  )
}