'use client'

import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { STAGGER, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ---------------------------------------------------------------------------
// Isometric projection helpers
// ---------------------------------------------------------------------------

/** Tile dimensions for isometric grid. */
const TILE_W = 100
const TILE_H = 58 // TILE_W * sin(30°) ≈ 0.577 for classic iso, adjusted for readability

/**
 * Convert isometric grid coordinates to SVG screen coordinates.
 * Origin is the top-center of the viewBox.
 *
 * @param col - Column index on the isometric grid (positive = right)
 * @param row - Row index on the isometric grid (positive = down-left)
 * @param originX - Screen X of the grid origin
 * @param originY - Screen Y of the grid origin
 */
function isoToScreen(
  col: number,
  row: number,
  originX: number,
  originY: number,
): { x: number; y: number } {
  return {
    x: originX + (col - row) * (TILE_W / 2),
    y: originY + (col + row) * (TILE_H / 2),
  }
}

/** Build the 4 corners of an isometric top face (rhombus) for a 1×1 tile. */
function topFace(col: number, row: number, ox: number, oy: number): string {
  const c = isoToScreen(col, row, ox, oy)
  const r = isoToScreen(col + 1, row, ox, oy)
  const b = isoToScreen(col + 1, row + 1, ox, oy)
  const l = isoToScreen(col, row + 1, ox, oy)
  return `${c.x},${c.y} ${r.x},${r.y} ${b.x},${b.y} ${l.x},${l.y}`
}

/**
 * Build polygons for a 3D block: top, left face, right face.
 * Height is in screen pixels (vertical drop).
 *
 * @param col - Grid column of top-left corner
 * @param row - Grid row of top-left corner
 * @param blockHeight - Pixel height of the extruded block
 * @param ox - SVG origin X
 * @param oy - SVG origin Y
 */
function blockFaces(
  col: number,
  row: number,
  blockHeight: number,
  ox: number,
  oy: number,
): {
  top: string
  left: string
  right: string
  center: { x: number; y: number }
} {
  const tl = isoToScreen(col, row, ox, oy)
  const tr = isoToScreen(col + 1, row, ox, oy)
  const br = isoToScreen(col + 1, row + 1, ox, oy)
  const bl = isoToScreen(col, row + 1, ox, oy)

  const h = blockHeight

  // Top rhombus
  const top = `${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`

  // Left face: bottom-left edge drops down
  const left = [
    `${bl.x},${bl.y}`,
    `${br.x},${br.y}`,
    `${br.x},${br.y + h}`,
    `${bl.x},${bl.y + h}`,
  ].join(' ')

  // Right face: bottom-right edge drops down
  const right = [
    `${tr.x},${tr.y}`,
    `${br.x},${br.y}`,
    `${br.x},${br.y + h}`,
    `${tr.x},${tr.y + h}`,
  ].join(' ')

  // Center of top face for label placement
  const center = {
    x: (tl.x + tr.x + br.x + bl.x) / 4,
    y: (tl.y + tr.y + br.y + bl.y) / 4,
  }

  return { top, left, right, center }
}

// ---------------------------------------------------------------------------
// Layout: isometric grid positions + block heights
// ---------------------------------------------------------------------------

/**
 * Each module's position on the isometric grid and block height (hierarchy).
 * col/row are grid coords; blockHeight in px gives vertical extrusion.
 */
interface BlockConfig {
  id: string
  col: number
  row: number
  blockHeight: number
  /** Order in which this block animates in (0 = first). */
  order: number
}

const BLOCK_CONFIGS: BlockConfig[] = [
  // Core — tallest, center
  { id: 'core', col: 2, row: 1, blockHeight: 90, order: 0 },
  // Console — medium, left of core
  { id: 'console', col: 0, row: 1, blockHeight: 60, order: 1 },
  // Wing — medium, right of core
  { id: 'wing', col: 4, row: 1, blockHeight: 60, order: 2 },
  // Pulse — shorter, forward-left
  { id: 'pulse', col: 0, row: 3, blockHeight: 38, order: 3 },
  // Mesh — shorter, forward-center
  { id: 'mesh', col: 2, row: 3, blockHeight: 38, order: 4 },
  // Channels — shorter, forward-right
  { id: 'channels', col: 4, row: 3, blockHeight: 38, order: 5 },
]

// ---------------------------------------------------------------------------
// Pipe paths between blocks (isometric conduits)
// ---------------------------------------------------------------------------

/**
 * Compute the SVG path for a pipe between two block top-face centers,
 * offset downward by each block's height so pipes sit at ground level.
 * Pipes travel along isometric axes with an orthogonal mid-jog.
 */
function pipePath(
  fromCol: number,
  fromRow: number,
  fromH: number,
  toCol: number,
  toRow: number,
  toH: number,
  ox: number,
  oy: number,
): string {
  // Bottom-center of each block's front face — center of bottom edge
  const fromTop = isoToScreen(fromCol + 0.5, fromRow + 1, ox, oy)
  const toTop = isoToScreen(toCol + 0.5, toRow, ox, oy)

  const fy = fromTop.y + fromH
  const ty = toTop.y + toH

  // Simple L-shaped path from bottom of source to top of target
  const midY = (fy + ty) / 2
  return `M ${fromTop.x} ${fy} L ${fromTop.x} ${midY} L ${toTop.x} ${midY} L ${toTop.x} ${ty}`
}

const PIPE_DEFINITIONS = [
  // Core ↔ Console (top row)
  { from: 'console', to: 'core' },
  // Core ↔ Wing (top row)
  { from: 'core', to: 'wing' },
  // Console ↔ Pulse (front column)
  { from: 'console', to: 'pulse' },
  // Core ↔ Mesh (front column)
  { from: 'core', to: 'mesh' },
  // Wing ↔ Channels (front column)
  { from: 'wing', to: 'channels' },
]

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

const COLORS = {
  orange: 'var(--color-brand-orange)',
  charcoal: 'var(--color-charcoal)',
  creamWhite: 'var(--color-cream-white)',
  // Top face fill — available = cream, coming-soon = desaturated
  topAvailable: '#FFFEFB',
  topComingSoon: '#D4CFCA',
  // Left face: 70% opacity darkening
  leftAvailable: '#DEDACC',
  leftComingSoon: '#B8B4B0',
  // Right face: 85% opacity
  rightAvailable: '#EAE6D8',
  rightComingSoon: '#C6C2BE',
  // Highlight stripe on top face for available
  highlight: 'var(--color-brand-orange)',
}

function faceColors(status: 'available' | 'coming-soon') {
  return {
    top: status === 'available' ? COLORS.topAvailable : COLORS.topComingSoon,
    left: status === 'available' ? COLORS.leftAvailable : COLORS.leftComingSoon,
    right: status === 'available' ? COLORS.rightAvailable : COLORS.rightComingSoon,
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface IsoBlockProps {
  config: BlockConfig
  module: SystemModule
  ox: number
  oy: number
  animDelay: number
}

/** A single 3D isometric block with entrance animation. */
function IsoBlock({ config, module, ox, oy, animDelay }: IsoBlockProps) {
  const { col, row, blockHeight } = config
  const faces = blockFaces(col, row, blockHeight, ox, oy)
  const colors = faceColors(module.status)

  // The block "builds up" from zero height — we scale the clip rect
  return (
    <motion.g
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4 }}
      viewport={VIEWPORT}
      transition={{
        opacity: { duration: 0.4, delay: animDelay },
        y: { type: 'spring', stiffness: 200, damping: 22, delay: animDelay },
      }}
      style={{ cursor: 'default' }}
    >
      {/* Shadow ellipse beneath block */}
      <motion.ellipse
        cx={faces.center.x}
        cy={faces.center.y + blockHeight + 4}
        rx={TILE_W * 0.42}
        ry={TILE_H * 0.28}
        fill="rgba(26,24,20,0.12)"
        initial={{ scaleX: 0, opacity: 0 }}
        whileInView={{ scaleX: 1, opacity: 1 }}
        viewport={VIEWPORT}
        transition={{ duration: 0.5, delay: animDelay + 0.1 }}
        style={{ transformOrigin: `${faces.center.x}px ${faces.center.y + blockHeight + 4}px` }}
      />

      {/* Left face */}
      <polygon
        points={faces.left}
        fill={colors.left}
        stroke={COLORS.charcoal}
        strokeWidth="0.8"
        strokeOpacity="0.4"
      />

      {/* Right face */}
      <polygon
        points={faces.right}
        fill={colors.right}
        stroke={COLORS.charcoal}
        strokeWidth="0.8"
        strokeOpacity="0.4"
      />

      {/* Top face */}
      <polygon
        points={faces.top}
        fill={colors.top}
        stroke={COLORS.charcoal}
        strokeWidth="0.8"
        strokeOpacity="0.5"
      />

      {/* Orange accent stripe on top-left edge for available modules */}
      {module.status === 'available' && (
        <polygon
          points={(() => {
            const tl = isoToScreen(col, row, ox, oy)
            const tr = isoToScreen(col + 1, row, ox, oy)
            const bl = isoToScreen(col, row + 1, ox, oy)
            // Thin strip along left+top edge of top face
            const insetTr = { x: tr.x * 0.15 + tl.x * 0.85, y: tr.y * 0.15 + tl.y * 0.85 }
            const insetBl = { x: bl.x * 0.15 + tl.x * 0.85, y: bl.y * 0.15 + tl.y * 0.85 }
            return `${tl.x},${tl.y} ${insetTr.x},${insetTr.y} ${insetBl.x},${insetBl.y}`
          })()}
          fill={COLORS.highlight}
          opacity="0.55"
        />
      )}

      {/* Module name on top face */}
      <text
        x={faces.center.x}
        y={faces.center.y + 1}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={blockHeight > 55 ? 10 : 8.5}
        fontWeight="600"
        fontFamily="inherit"
        fill={COLORS.charcoal}
        opacity="0.9"
      >
        {module.name}
      </text>

      {/* Label (sublabel) beneath module name */}
      <text
        x={faces.center.x}
        y={faces.center.y + (blockHeight > 55 ? 13 : 11)}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={7}
        fontFamily="monospace"
        fill={COLORS.charcoal}
        opacity="0.5"
        letterSpacing="0.04em"
      >
        {module.label.toUpperCase()}
      </text>

      {/* Status dot — right face lower region */}
      {(() => {
        const tr = isoToScreen(col + 1, row, ox, oy)
        const br = isoToScreen(col + 1, row + 1, ox, oy)
        const dotX = (tr.x + br.x) / 2 + 2
        const dotY = br.y + blockHeight * 0.72
        return (
          <circle
            cx={dotX}
            cy={dotY}
            r={3}
            fill={module.status === 'available' ? COLORS.orange : COLORS.topComingSoon}
            stroke={COLORS.charcoal}
            strokeWidth="0.6"
            strokeOpacity="0.3"
          />
        )
      })()}
    </motion.g>
  )
}

interface IsoPipeProps {
  fromConfig: BlockConfig
  toConfig: BlockConfig
  ox: number
  oy: number
  delay: number
}

/** An isometric pipe (conduit) with a traveling data dot. */
function IsoPipe({ fromConfig, toConfig, ox, oy, delay }: IsoPipeProps) {
  const d = pipePath(
    fromConfig.col,
    fromConfig.row,
    fromConfig.blockHeight,
    toConfig.col,
    toConfig.row,
    toConfig.blockHeight,
    ox,
    oy,
  )

  return (
    <g>
      {/* Pipe track */}
      <motion.path
        d={d}
        fill="none"
        stroke={COLORS.orange}
        strokeWidth="2"
        strokeOpacity="0.35"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="4 3"
        initial={{ pathLength: 0, opacity: 0 }}
        whileInView={{ pathLength: 1, opacity: 1 }}
        viewport={VIEWPORT}
        transition={{ duration: 0.9, delay, ease: 'easeInOut' }}
      />

      {/* Traveling data particle */}
      <circle r="3" fill={COLORS.orange} opacity="0.75">
        <animateMotion path={d} dur={`${2.2 + delay * 0.4}s`} repeatCount="indefinite" begin={`${delay + 0.8}s`} />
      </circle>
    </g>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/** Isometric 3D block diagram of the DorkOS six-module architecture. */
export function DiagramV6({ modules }: { modules: SystemModule[] }) {
  // SVG viewBox: wide enough to fit the isometric grid
  const VW = 820
  const VH = 480

  // Origin: top-center of SVG, pushed down so blocks have room
  const OX = VW / 2
  const OY = 60

  // Build a lookup map for modules by id
  const moduleMap = new Map(modules.map((m) => [m.id, m]))

  // Build a lookup map for block configs by id
  const configMap = new Map(BLOCK_CONFIGS.map((c) => [c.id, c]))

  return (
    <motion.svg
      viewBox={`0 0 ${VW} ${VH}`}
      className="w-full h-auto"
      preserveAspectRatio="xMidYMid meet"
      aria-label="DorkOS isometric architecture diagram"
      role="img"
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      variants={STAGGER}
    >
      {/* Subtle grid floor — isometric tiles at y=0 ground level */}
      <g opacity="0.07">
        {[0, 1, 2, 3, 4, 5].map((col) =>
          [0, 1, 2, 3, 4].map((row) => (
            <polygon
              key={`grid-${col}-${row}`}
              points={topFace(col - 3, row, OX, OY + 240)}
              fill="none"
              stroke={COLORS.charcoal}
              strokeWidth="0.5"
            />
          )),
        )}
      </g>

      {/* Pipes — rendered before blocks so blocks sit on top */}
      {PIPE_DEFINITIONS.map((pipe, i) => {
        const fromConfig = configMap.get(pipe.from)
        const toConfig = configMap.get(pipe.to)
        if (!fromConfig || !toConfig) return null
        return (
          <IsoPipe
            key={`pipe-${pipe.from}-${pipe.to}`}
            fromConfig={fromConfig}
            toConfig={toConfig}
            ox={OX}
            oy={OY}
            delay={0.6 + i * 0.12}
          />
        )
      })}

      {/* Blocks — sorted by render order (back to front for correct z-order) */}
      {BLOCK_CONFIGS.sort((a, b) => a.order - b.order).map((config) => {
        const module = moduleMap.get(config.id)
        if (!module) return null
        return (
          <IsoBlock
            key={config.id}
            config={config}
            module={module}
            ox={OX}
            oy={OY}
            animDelay={config.order * 0.1}
          />
        )
      })}

      {/* Legend */}
      <g transform={`translate(${VW - 140}, ${VH - 56})`}>
        <rect x="0" y="0" width="130" height="46" rx="4" fill={COLORS.creamWhite} opacity="0.7" />
        <circle cx="14" cy="14" r="4" fill={COLORS.orange} />
        <text x="24" y="18" fontSize="9" fontFamily="monospace" fill={COLORS.charcoal} opacity="0.75">
          Available
        </text>
        <circle cx="14" cy="32" r="4" fill={COLORS.topComingSoon} stroke={COLORS.charcoal} strokeWidth="0.5" strokeOpacity="0.3" />
        <text x="24" y="36" fontSize="9" fontFamily="monospace" fill={COLORS.charcoal} opacity="0.75">
          Coming soon
        </text>
      </g>
    </motion.svg>
  )
}
