'use client'

import {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { motion, AnimatePresence, animate } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { STAGGER, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ─── Layout constants ───────────────────────────────────────────────────────

const VIEWBOX_W = 900
const VIEWBOX_H = 450
const NODE_R = 32

/** Default node positions — force-directed-ish starting layout. */
const DEFAULT_POSITIONS: Record<string, { x: number; y: number }> = {
  core:     { x: 450, y: 195 },
  console:  { x: 175, y:  80 },
  wing:    { x: 725, y:  80 },
  pulse:    { x: 175, y: 330 },
  mesh:     { x: 450, y: 345 },
  channels: { x: 725, y: 330 },
}

/** Which connections to render. `spine` = thicker Core↔Mesh line. */
interface ConnectionDef {
  id: string
  from: string
  to: string
  spine?: boolean
}

const CONNECTIONS: ConnectionDef[] = [
  { id: 'core-console',  from: 'core',  to: 'console'  },
  { id: 'core-wing',    from: 'core',  to: 'wing'    },
  { id: 'core-pulse',    from: 'core',  to: 'pulse'    },
  { id: 'core-mesh',     from: 'core',  to: 'mesh',    spine: true },
  { id: 'mesh-channels', from: 'mesh',  to: 'channels' },
  { id: 'mesh-pulse',    from: 'mesh',  to: 'pulse'    },
]

/** Spring config for release animation — slight overshoot for bounce. */
const RELEASE_SPRING = { type: 'spring', stiffness: 280, damping: 22, mass: 0.9 } as const

/** Snap back to default if within this radius of original position. */
const SNAP_RADIUS = 40

// ─── Types ──────────────────────────────────────────────────────────────────

type NodePositions = Record<string, { x: number; y: number }>

interface DragState {
  nodeId: string
  startX: number
  startY: number
  startNodeX: number
  startNodeY: number
  /** SVG coordinate scale factor (SVG units per CSS pixel). */
  scale: number
}

// ─── Utility helpers ────────────────────────────────────────────────────────

/** Distance between two points. */
function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2)
}

/**
 * Build a quadratic Bezier path between two nodes.
 * The control point bows outward perpendicular to the line.
 *
 * @param ax - Source x
 * @param ay - Source y
 * @param bx - Target x
 * @param by - Target y
 * @param lag - Amount to offset control point (creates rubber-band stretch)
 */
function buildConnectionPath(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  lag = 0,
): string {
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  // Perpendicular offset for bow — scale with distance so short lines bow less
  const d = dist(ax, ay, bx, by)
  const bow = Math.min(d * 0.12, 28)
  // Perpendicular unit vector
  const dx = bx - ax
  const dy = by - ay
  const len = d || 1
  const px = -dy / len
  const py = dx / len
  // Control point with optional lag pull
  const cx = mx + px * bow + lag
  const cy = my + py * bow + lag
  return `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`
}

/**
 * Compute the SVG coordinate scale factor from the SVG element.
 * Returns (SVG units) / (CSS pixel).
 */
function getSvgScale(svgEl: SVGSVGElement): number {
  const rect = svgEl.getBoundingClientRect()
  if (rect.width === 0) return 1
  return VIEWBOX_W / rect.width
}

// ─── Sub-component: Connection line ─────────────────────────────────────────

interface ConnectionLineProps {
  conn: ConnectionDef
  positions: NodePositions
  /** Whether the `from` or `to` node is being dragged. */
  isDragging: boolean
  /** How much to pull the control point toward the drag direction. */
  dragLag: number
  /** Whether either endpoint is highlighted. */
  highlighted: boolean
}

/** Single animated connection between two nodes. */
function ConnectionLine({
  conn,
  positions,
  isDragging,
  dragLag,
  highlighted,
}: ConnectionLineProps) {
  const from = positions[conn.from]
  const to   = positions[conn.to]
  if (!from || !to) return null

  const path = buildConnectionPath(from.x, from.y, to.x, to.y, isDragging ? dragLag : 0)
  const strokeW  = conn.spine ? 2.5 : 1.5
  const baseOpacity = highlighted ? 0.75 : 0.38

  return (
    <motion.path
      d={path}
      fill="none"
      stroke="var(--color-brand-orange)"
      strokeWidth={strokeW}
      strokeOpacity={baseOpacity}
      strokeLinecap="round"
      animate={{ strokeOpacity: baseOpacity }}
      transition={{ duration: 0.15 }}
    />
  )
}

// ─── Sub-component: Node ────────────────────────────────────────────────────

interface NodeProps {
  module: SystemModule
  position: { x: number; y: number }
  isDragging: boolean
  isHovered: boolean
  isHighlighted: boolean
  onPointerDown: (e: ReactPointerEvent<SVGGElement>, id: string) => void
  onDoubleClick: (id: string) => void
  onPointerEnter: (id: string) => void
  onPointerLeave: () => void
  dragVelocity: { x: number; y: number }
}

/** Draggable node circle with label, status, and hover glow. */
function NodeCircle({
  module,
  position,
  isDragging,
  isHovered,
  isHighlighted,
  onPointerDown,
  onDoubleClick,
  onPointerEnter,
  onPointerLeave,
  dragVelocity,
}: NodeProps) {
  const isAvailable = module.status === 'available'

  // Stroke appearance
  const strokeColor = isAvailable
    ? 'var(--color-brand-orange)'
    : 'var(--color-warm-gray)'
  const strokeWidth = isDragging ? 2.5 : isHovered || isHighlighted ? 2 : 1.5
  const strokeOpacity = isAvailable ? 1 : 0.5
  const strokeDasharray = isAvailable ? undefined : '4 3'

  // Shadow / glow behind node
  const glowOpacity = isDragging ? 0.5 : isHovered ? 0.35 : isHighlighted ? 0.2 : 0.08

  // Slight tilt when dragging based on velocity
  const tiltX = isDragging ? Math.max(-8, Math.min(8, dragVelocity.y * 0.04)) : 0
  const tiltY = isDragging ? Math.max(-8, Math.min(8, -dragVelocity.x * 0.04)) : 0

  return (
    <g
      transform={`translate(${position.x}, ${position.y}) rotate(${tiltX}, 0, 0)`}
      style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      onPointerDown={(e) => onPointerDown(e, module.id)}
      onDoubleClick={() => onDoubleClick(module.id)}
      onPointerEnter={() => onPointerEnter(module.id)}
      onPointerLeave={onPointerLeave}
    >
      {/* Glow halo */}
      <circle
        r={NODE_R + 16}
        fill="var(--color-brand-orange)"
        opacity={glowOpacity}
        style={{ filter: 'blur(12px)', transition: 'opacity 0.2s ease' }}
      />

      {/* Scale ring — visible when hovering or highlighted */}
      {(isHovered || isHighlighted) && (
        <motion.circle
          r={NODE_R + 6}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1"
          strokeOpacity="0.35"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 1.2, opacity: 0 }}
          transition={{ duration: 0.2 }}
        />
      )}

      {/* Main node body */}
      <circle
        r={NODE_R}
        fill="var(--color-cream-white)"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeOpacity={strokeOpacity}
        strokeDasharray={strokeDasharray}
        style={{
          filter: isDragging
            ? 'drop-shadow(0 8px 20px rgba(232,93,4,0.25))'
            : 'drop-shadow(0 2px 6px rgba(0,0,0,0.1))',
          transition: 'filter 0.2s ease, stroke-width 0.15s ease',
        }}
      />

      {/* Inner orange accent */}
      <circle
        r={7}
        fill="var(--color-brand-orange)"
        opacity={isAvailable ? 0.8 : 0.3}
      />

      {/* Module name */}
      <text
        y={-7}
        textAnchor="middle"
        style={{
          fontSize: '11px',
          fontWeight: 700,
          fill: 'var(--color-charcoal)',
          userSelect: 'none',
          pointerEvents: 'none',
          letterSpacing: '-0.01em',
        }}
      >
        {module.name}
      </text>

      {/* Module label / sublabel */}
      <text
        y={6}
        textAnchor="middle"
        style={{
          fontSize: '8px',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fill: 'var(--color-warm-gray)',
          userSelect: 'none',
          pointerEvents: 'none',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        } as React.CSSProperties}
      >
        {module.label}
      </text>

      {/* Status indicator dot */}
      <circle
        cx={NODE_R - 6}
        cy={-(NODE_R - 6)}
        r={4}
        fill={isAvailable ? 'var(--color-brand-green, #16a34a)' : 'var(--color-warm-gray)'}
        opacity={isAvailable ? 0.9 : 0.45}
      />

      {/* Drag hint ring when being dragged */}
      {isDragging && (
        <motion.circle
          r={NODE_R + 2}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1"
          strokeOpacity="0.6"
          strokeDasharray="3 3"
          initial={{ rotate: 0 }}
          animate={{ rotate: 360 }}
          transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
          style={{ transformOrigin: '0 0' }}
        />
      )}

      {/* Velocity-based tilt — visual only */}
      {isDragging && (
        <motion.circle
          cx={tiltY * 1.5}
          cy={tiltX * 1.5}
          r={3}
          fill="var(--color-brand-orange)"
          opacity={0.5}
          animate={{ opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 0.8, repeat: Infinity }}
        />
      )}
    </g>
  )
}

// ─── Sub-component: Expand overlay ──────────────────────────────────────────

interface ExpandOverlayProps {
  module: SystemModule | null
  onClose: () => void
}

/** Full module detail overlay — shown on double-click. */
function ExpandOverlay({ module, onClose }: ExpandOverlayProps) {
  return (
    <AnimatePresence>
      {module && (
        <motion.div
          key={module.id}
          initial={{ opacity: 0, scale: 0.85, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 5 }}
          transition={{ type: 'spring', stiffness: 380, damping: 28 }}
          onClick={onClose}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(245,240,230,0.82)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            zIndex: 20,
            cursor: 'pointer',
          }}
        >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 20 }}
            animate={{ y: 0 }}
            transition={{ type: 'spring', stiffness: 340, damping: 26, delay: 0.04 }}
            style={{
              background: 'var(--color-cream-white, #faf7f2)',
              border: '1.5px solid var(--color-brand-orange)',
              borderRadius: 16,
              padding: '28px 32px',
              maxWidth: 340,
              boxShadow: '0 20px 60px rgba(232,93,4,0.18), 0 4px 16px rgba(0,0,0,0.08)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: module.status === 'available'
                    ? 'var(--color-brand-green, #16a34a)'
                    : 'var(--color-warm-gray)',
                  opacity: module.status === 'available' ? 0.9 : 0.5,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  color: 'var(--color-warm-gray)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                } as React.CSSProperties}
              >
                {module.status === 'available' ? 'Available' : 'Coming Soon'}
              </span>
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: 'var(--color-charcoal)',
                marginBottom: 4,
                letterSpacing: '-0.02em',
              }}
            >
              {module.name}
            </div>
            <div
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono, ui-monospace)',
                color: 'var(--color-brand-orange)',
                marginBottom: 14,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              } as React.CSSProperties}
            >
              {module.label}
            </div>
            <p
              style={{
                fontSize: 13.5,
                lineHeight: 1.6,
                color: 'var(--color-charcoal)',
                margin: 0,
                opacity: 0.85,
              }}
            >
              {module.description}
            </p>
            <button
              onClick={onClose}
              style={{
                marginTop: 20,
                fontSize: 11,
                fontFamily: 'var(--font-mono, ui-monospace)',
                color: 'var(--color-warm-gray)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                letterSpacing: '0.06em',
                padding: '4px 0',
                opacity: 0.7,
              }}
            >
              click anywhere to dismiss
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─── Sub-component: Reset button ────────────────────────────────────────────

interface ResetButtonProps {
  onReset: () => void
  isResetting: boolean
}

/** Small mono-font reset button for top-right corner. */
function ResetButton({ onReset, isResetting }: ResetButtonProps) {
  return (
    <motion.button
      onClick={onReset}
      disabled={isResetting}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 10,
        fontFamily: 'var(--font-mono, ui-monospace)',
        fontSize: 10,
        letterSpacing: '0.08em',
        color: 'var(--color-warm-gray)',
        background: 'var(--color-cream-white, #faf7f2)',
        border: '1px solid var(--border-warm, rgba(0,0,0,0.12))',
        borderRadius: 6,
        padding: '5px 10px',
        cursor: isResetting ? 'default' : 'pointer',
        opacity: isResetting ? 0.5 : 1,
        transition: 'opacity 0.2s ease',
        textTransform: 'uppercase',
      } as React.CSSProperties}
    >
      {isResetting ? 'Resetting…' : 'Reset Layout'}
    </motion.button>
  )
}

// ─── Sub-component: Legend ───────────────────────────────────────────────────

/** Small drag-hint legend at bottom left. */
function Legend() {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 10,
        left: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontFamily: 'var(--font-mono, ui-monospace)',
          color: 'var(--color-warm-gray)',
          letterSpacing: '0.06em',
          opacity: 0.6,
          textTransform: 'uppercase',
        } as React.CSSProperties}
      >
        drag nodes · double-click to expand
      </span>
    </div>
  )
}

// ─── Animated SVG node wrapper ───────────────────────────────────────────────

/**
 * Wraps a node group with Framer Motion for entrance animation.
 * Position is controlled imperatively via the `transform` on the inner group.
 */
interface AnimatedNodeProps {
  nodeId: string
  position: { x: number; y: number }
  delay: number
  children: React.ReactNode
}

function AnimatedNode({ nodeId, position: _pos, delay, children }: AnimatedNodeProps) {
  return (
    <motion.g
      key={nodeId}
      variants={{
        hidden: { opacity: 0, scale: 0 },
        visible: {
          opacity: 1,
          scale: 1,
          transition: {
            type: 'spring',
            stiffness: 300,
            damping: 22,
            delay,
          },
        },
      }}
    >
      {children}
    </motion.g>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

/**
 * Interactive draggable node graph architecture diagram with spring-physics connections.
 *
 * Each module is a draggable node. Connections render as quadratic Bezier SVG paths
 * that update in real-time as nodes move. Spring release animations provide tactile feedback.
 * Double-click any node to see module details. Reset button restores default positions.
 */
export function DiagramV15({ modules }: { modules: SystemModule[] }) {
  // ── State ──────────────────────────────────────────────────────────────────

  const [positions, setPositions] = useState<NodePositions>(() =>
    Object.fromEntries(
      Object.entries(DEFAULT_POSITIONS).map(([id, pos]) => [id, { ...pos }]),
    ),
  )

  const [dragState, setDragState] = useState<DragState | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [expandedModule, setExpandedModule] = useState<SystemModule | null>(null)
  const [isResetting, setIsResetting] = useState(false)

  // Track drag velocity for tilt effect
  const [dragVelocity, setDragVelocity] = useState({ x: 0, y: 0 })
  const lastPointerPos = useRef({ x: 0, y: 0 })

  // Refs
  const svgRef = useRef<SVGSVGElement>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const positionsRef = useRef<NodePositions>(positions)

  // Keep ref in sync
  useEffect(() => { positionsRef.current = positions }, [positions])
  useEffect(() => { dragStateRef.current = dragState }, [dragState])

  // ── Highlighted nodes (hover propagation) ──────────────────────────────────

  const highlightedIds = useMemo<Set<string>>(() => {
    if (!hoveredId) return new Set()
    const connected = new Set<string>()
    CONNECTIONS.forEach(({ from, to }) => {
      if (from === hoveredId) connected.add(to)
      if (to === hoveredId) connected.add(from)
    })
    return connected
  }, [hoveredId])

  // ── Drag lagRef — for rubber-band control point pull ──────────────────────

  const dragLag = useRef(0)

  // ── Pointer handlers ───────────────────────────────────────────────────────

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<SVGGElement>, nodeId: string) => {
      e.preventDefault()
      e.stopPropagation()
      if (!svgRef.current) return

      const scale = getSvgScale(svgRef.current)
      const state: DragState = {
        nodeId,
        startX: e.clientX,
        startY: e.clientY,
        startNodeX: positionsRef.current[nodeId]?.x ?? 0,
        startNodeY: positionsRef.current[nodeId]?.y ?? 0,
        scale,
      }
      dragStateRef.current = state
      setDragState(state)
      dragLag.current = 0
      lastPointerPos.current = { x: e.clientX, y: e.clientY }

      // Capture pointer so we receive events outside SVG
      ;(e.currentTarget as SVGGElement).setPointerCapture(e.pointerId)
    },
    [],
  )

  const handleSvgPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const state = dragStateRef.current
    if (!state) return
    e.preventDefault()

    const dx = (e.clientX - state.startX) * state.scale
    const dy = (e.clientY - state.startY) * state.scale

    // Compute velocity for tilt
    const vx = e.clientX - lastPointerPos.current.x
    const vy = e.clientY - lastPointerPos.current.y
    lastPointerPos.current = { x: e.clientX, y: e.clientY }
    setDragVelocity({ x: vx, y: vy })

    // Control point lag — pulls Bezier curve as you drag
    dragLag.current = Math.sign(dx) * Math.min(Math.abs(dx) * 0.08, 20)

    const newX = Math.max(NODE_R + 4, Math.min(VIEWBOX_W - NODE_R - 4, state.startNodeX + dx))
    const newY = Math.max(NODE_R + 4, Math.min(VIEWBOX_H - NODE_R - 4, state.startNodeY + dy))

    setPositions((prev) => ({
      ...prev,
      [state.nodeId]: { x: newX, y: newY },
    }))
  }, [])

  const handleSvgPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const state = dragStateRef.current
      if (!state) return
      e.preventDefault()

      const curPos = positionsRef.current[state.nodeId]
      const defPos = DEFAULT_POSITIONS[state.nodeId]

      // Snap back if released near default position
      if (
        curPos &&
        defPos &&
        dist(curPos.x, curPos.y, defPos.x, defPos.y) < SNAP_RADIUS
      ) {
        // Animate spring back to default
        const fromX = curPos.x
        const fromY = curPos.y
        const nodeId = state.nodeId

        animate(fromX, defPos.x, {
          ...RELEASE_SPRING,
          onUpdate: (v) => {
            setPositions((prev) => ({
              ...prev,
              [nodeId]: { ...prev[nodeId]!, x: v },
            }))
          },
        })
        animate(fromY, defPos.y, {
          ...RELEASE_SPRING,
          onUpdate: (v) => {
            setPositions((prev) => ({
              ...prev,
              [nodeId]: { ...prev[nodeId]!, y: v },
            }))
          },
        })
      }

      dragLag.current = 0
      dragStateRef.current = null
      setDragState(null)
      setDragVelocity({ x: 0, y: 0 })
    },
    [],
  )

  // ── Double-click to expand ──────────────────────────────────────────────────

  const handleDoubleClick = useCallback(
    (nodeId: string) => {
      const mod = modules.find((m) => m.id === nodeId)
      if (mod) setExpandedModule(mod)
    },
    [modules],
  )

  // ── Reset layout ────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    if (isResetting) return
    setIsResetting(true)

    // Animate all nodes back to default simultaneously with spring physics
    const nodeIds = Object.keys(DEFAULT_POSITIONS)
    let remaining = nodeIds.length * 2 // x + y per node

    const done = () => {
      remaining--
      if (remaining === 0) setIsResetting(false)
    }

    nodeIds.forEach((nodeId) => {
      const curPos = positionsRef.current[nodeId]
      const defPos = DEFAULT_POSITIONS[nodeId]
      if (!curPos || !defPos) { remaining -= 2; return }

      animate(curPos.x, defPos.x, {
        ...RELEASE_SPRING,
        onUpdate: (v) => setPositions((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId]!, x: v } })),
        onComplete: done,
      })
      animate(curPos.y, defPos.y, {
        ...RELEASE_SPRING,
        onUpdate: (v) => setPositions((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId]!, y: v } })),
        onComplete: done,
      })
    })
  }, [isResetting])

  // ── Hover handlers ─────────────────────────────────────────────────────────

  const handlePointerEnter = useCallback((id: string) => setHoveredId(id), [])
  const handlePointerLeave = useCallback(() => setHoveredId(null), [])

  // ── Entrance stagger order ─────────────────────────────────────────────────

  const nodeOrder: Record<string, number> = { core: 0, console: 1, wing: 2, pulse: 3, mesh: 4, channels: 5 }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
      aria-label="Interactive draggable architecture diagram — drag any node to rearrange"
    >
      {/* Controls */}
      <ResetButton onReset={handleReset} isResetting={isResetting} />

      {/* SVG canvas */}
      <motion.svg
        ref={svgRef}
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
        style={{ touchAction: 'none', display: 'block' }}
        onPointerMove={handleSvgPointerMove}
        onPointerUp={handleSvgPointerUp}
        onPointerLeave={handleSvgPointerUp}
      >
        <defs>
          {/* Radial gradient for node fill */}
          <radialGradient id="v15-node-fill" cx="40%" cy="35%" r="65%">
            <stop offset="0%" stopColor="var(--color-cream-white, #faf7f2)" />
            <stop offset="100%" stopColor="var(--color-cream-secondary, #f0ebe0)" />
          </radialGradient>

          {/* Soft blur filter for glow */}
          <filter id="v15-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Layer 1: Connection lines — drawn first (behind nodes) */}
        <motion.g
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.08, delayChildren: 0.3 } },
          }}
        >
          {CONNECTIONS.map((conn) => {
            const isDraggingConn =
              dragState?.nodeId === conn.from || dragState?.nodeId === conn.to
            const isHighlighted =
              hoveredId === conn.from ||
              hoveredId === conn.to

            return (
              <motion.g
                key={conn.id}
                variants={{
                  hidden: { opacity: 0 },
                  visible: { opacity: 1, transition: { duration: 0.6 } },
                }}
              >
                <ConnectionLine
                  conn={conn}
                  positions={positions}
                  isDragging={isDraggingConn}
                  dragLag={isDraggingConn ? dragLag.current : 0}
                  highlighted={isHighlighted}
                />
              </motion.g>
            )
          })}
        </motion.g>

        {/* Layer 2: Module nodes */}
        <motion.g
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.1, delayChildren: 0.5 } },
          }}
        >
          {modules.map((mod) => {
            const pos = positions[mod.id]
            if (!pos) return null
            const delay = (nodeOrder[mod.id] ?? 0) * 0.08
            const isDragging = dragState?.nodeId === mod.id
            const isHovered = hoveredId === mod.id
            const isHighlighted = highlightedIds.has(mod.id)

            return (
              <AnimatedNode key={mod.id} nodeId={mod.id} position={pos} delay={delay}>
                <NodeCircle
                  module={mod}
                  position={pos}
                  isDragging={isDragging}
                  isHovered={isHovered}
                  isHighlighted={isHighlighted}
                  onPointerDown={handlePointerDown}
                  onDoubleClick={handleDoubleClick}
                  onPointerEnter={handlePointerEnter}
                  onPointerLeave={handlePointerLeave}
                  dragVelocity={isDragging ? dragVelocity : { x: 0, y: 0 }}
                />
              </AnimatedNode>
            )
          })}
        </motion.g>

        {/* Layer 3: Active drag particle trail */}
        {dragState && positions[dragState.nodeId] && (
          <g>
            {[0.5, 0.3, 0.15].map((opacity, i) => (
              <circle
                key={i}
                cx={positions[dragState.nodeId]!.x + (i + 1) * dragVelocity.x * -0.8}
                cy={positions[dragState.nodeId]!.y + (i + 1) * dragVelocity.y * -0.8}
                r={4 - i * 1.2}
                fill="var(--color-brand-orange)"
                opacity={opacity}
                style={{ pointerEvents: 'none' }}
              />
            ))}
          </g>
        )}
      </motion.svg>

      {/* HTML overlay: expand overlay */}
      <ExpandOverlay
        module={expandedModule}
        onClose={() => setExpandedModule(null)}
      />

      {/* Legend */}
      <Legend />
    </div>
  )
}
