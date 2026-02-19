/**
 * Pure computation helpers for the v13 canvas dot-matrix reveal diagram.
 * No React, no DOM — only math and data structures.
 */

import type { SystemModule } from '@/layers/features/marketing/lib/modules'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Dot grid spacing in pixels */
export const DOT_SPACING = 5

/** Dot radius in pixels */
export const DOT_RADIUS = 1.5

/** Cursor illumination radius in pixels */
export const ILLUMINATE_RADIUS = 160

/** Locked illumination points fade radius (slightly smaller) */
export const LOCK_RADIUS = 130

/** After this many ms of interaction, start the persistence fade-in */
export const PERSISTENCE_DELAY_MS = 5000

/** How long the full persistence fade takes (ms) */
export const PERSISTENCE_FADE_MS = 8000

/** Node circle radius in canvas pixels */
export const NODE_RADIUS_PX = 28

/** Brand orange channel values */
export const ORANGE_HEX = '#E85D04'
export const ORANGE_R   = 232
export const ORANGE_G   = 93
export const ORANGE_B   = 4

// ─── Architecture layout (normalized 0–1 coordinates) ────────────────────────
//
// 3×2 grid: Core and Mesh occupy the inner columns, others wrap around.
// These are multiplied by canvas dimensions at render time.

export const MODULE_POSITIONS: Record<string, { nx: number; ny: number }> = {
  core:     { nx: 0.38, ny: 0.38 },   // center-left — primary anchor
  mesh:     { nx: 0.62, ny: 0.38 },   // center-right — network hub
  console:  { nx: 0.17, ny: 0.27 },   // upper-left
  wing:    { nx: 0.17, ny: 0.65 },   // lower-left
  pulse:    { nx: 0.83, ny: 0.27 },   // upper-right
  channels: { nx: 0.83, ny: 0.65 },   // lower-right
}

/** Connections between modules */
export const CONNECTIONS: Array<[string, string]> = [
  ['core',    'console'],
  ['core',    'wing'],
  ['core',    'mesh'],
  ['mesh',    'pulse'],
  ['mesh',    'channels'],
  ['core',    'pulse'],     // secondary diagonal
]

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Point {
  x: number
  y: number
}

export interface LockedPoint extends Point {
  id: number
  radius: number
}

export interface ArchitectureMask {
  /** Set of dot grid indices (row * cols + col) that belong to the architecture */
  dotSet: Set<number>
  /** Canvas-pixel positions of module centers, keyed by module id */
  centers: Record<string, Point>
}

export interface DrawState {
  cursor: Point | null
  locked: LockedPoint[]
  mask: ArchitectureMask | null
  persistenceT: number    // 0 = hidden, 1 = fully revealed
  w: number
  h: number
}

// ─── Architecture mask builder ────────────────────────────────────────────────

/**
 * Pre-compute which dot grid cells belong to the architecture (nodes + edges).
 * Returns a Set of flattened indices (row * cols + col) and a map of pixel centers.
 *
 * @param w - Canvas width in logical pixels
 * @param h - Canvas height in logical pixels
 * @param modules - System modules to position
 */
export function buildArchitectureMask(
  w: number,
  h: number,
  modules: SystemModule[],
): ArchitectureMask {
  const cols = Math.ceil(w / DOT_SPACING)
  const rows = Math.ceil(h / DOT_SPACING)
  const dotSet = new Set<number>()

  // Resolve pixel centers from normalized positions
  const centers: Record<string, Point> = {}
  for (const mod of modules) {
    const pos = MODULE_POSITIONS[mod.id]
    if (!pos) continue
    centers[mod.id] = { x: pos.nx * w, y: pos.ny * h }
  }

  // Mark dots inside node circles
  for (const [, center] of Object.entries(centers)) {
    const r = NODE_RADIUS_PX
    const minCol = Math.max(0, Math.floor((center.x - r) / DOT_SPACING))
    const maxCol = Math.min(cols - 1, Math.ceil((center.x + r) / DOT_SPACING))
    const minRow = Math.max(0, Math.floor((center.y - r) / DOT_SPACING))
    const maxRow = Math.min(rows - 1, Math.ceil((center.y + r) / DOT_SPACING))

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const dx = col * DOT_SPACING - center.x
        const dy = row * DOT_SPACING - center.y
        if (dx * dx + dy * dy <= r * r) {
          dotSet.add(row * cols + col)
        }
      }
    }
  }

  // Mark dots along connection lines
  markConnectionDots(centers, cols, rows, dotSet)

  return { dotSet, centers }
}

/**
 * Walk each connection line and mark nearby dots as architecture dots.
 * Uses sub-dot-spacing steps to avoid gaps between sampled points.
 *
 * @param centers - Pixel centers for each module id
 * @param cols - Number of dot columns in the grid
 * @param rows - Number of dot rows in the grid
 * @param dotSet - Mutable set to add matching dot indices into
 */
function markConnectionDots(
  centers: Record<string, Point>,
  cols: number,
  rows: number,
  dotSet: Set<number>,
): void {
  // Gives the line some thickness in the dot grid
  const lineHalfWidth = 3.5

  for (const [fromId, toId] of CONNECTIONS) {
    const a = centers[fromId]
    const b = centers[toId]
    if (!a || !b) continue

    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.sqrt(dx * dx + dy * dy)
    // Walk at half-dot resolution so no gaps appear
    const steps = Math.ceil(len / (DOT_SPACING * 0.5))

    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const px = a.x + dx * t
      const py = a.y + dy * t

      const minCol = Math.max(0, Math.floor((px - lineHalfWidth) / DOT_SPACING))
      const maxCol = Math.min(cols - 1, Math.ceil((px + lineHalfWidth) / DOT_SPACING))
      const minRow = Math.max(0, Math.floor((py - lineHalfWidth) / DOT_SPACING))
      const maxRow = Math.min(rows - 1, Math.ceil((py + lineHalfWidth) / DOT_SPACING))

      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const ddx = col * DOT_SPACING - px
          const ddy = row * DOT_SPACING - py
          if (ddx * ddx + ddy * ddy <= lineHalfWidth * lineHalfWidth) {
            dotSet.add(row * cols + col)
          }
        }
      }
    }
  }
}

// ─── Canvas drawing ───────────────────────────────────────────────────────────

/**
 * Draw one full animation frame onto the canvas context.
 * Called from requestAnimationFrame — no heap allocations per dot.
 *
 * @param ctx - Canvas 2D rendering context (already scaled for DPR)
 * @param state - Immutable snapshot of current interaction + animation state
 */
export function drawFrame(ctx: CanvasRenderingContext2D, state: DrawState): void {
  const { cursor, locked, mask, persistenceT, w, h } = state

  ctx.clearRect(0, 0, w, h)
  if (!mask) return

  const cols = Math.ceil(w / DOT_SPACING)
  const rows = Math.ceil(h / DOT_SPACING)

  for (let row = 0; row < rows; row++) {
    const dotY = row * DOT_SPACING

    for (let col = 0; col < cols; col++) {
      const dotX = col * DOT_SPACING
      const isArch = mask.dotSet.has(row * cols + col)

      const maxBrightness = computeBrightness(dotX, dotY, cursor, locked, persistenceT, isArch)

      ctx.fillStyle = resolveDotColor(isArch, maxBrightness)
      ctx.beginPath()
      ctx.arc(dotX, dotY, DOT_RADIUS, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/**
 * Compute the maximum illumination brightness [0, 1] for a dot at (dotX, dotY).
 * Brightness comes from cursor proximity, locked points, and persistence fade.
 */
function computeBrightness(
  dotX: number,
  dotY: number,
  cursor: Point | null,
  locked: LockedPoint[],
  persistenceT: number,
  isArch: boolean,
): number {
  let max = 0

  if (cursor) {
    const dx = dotX - cursor.x
    const dy = dotY - cursor.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < ILLUMINATE_RADIUS) {
      const b = 1 - dist / ILLUMINATE_RADIUS
      // Quadratic falloff → natural flashlight feel
      max = Math.max(max, b * b)
    }
  }

  for (const lp of locked) {
    const dx = dotX - lp.x
    const dy = dotY - lp.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < lp.radius) {
      const b = 1 - dist / lp.radius
      max = Math.max(max, b * b * 0.7)
    }
  }

  // Persistence slowly reveals architecture dots only
  if (persistenceT > 0 && isArch) {
    max = Math.max(max, persistenceT * 0.55)
  }

  return max
}

/**
 * Resolve the CSS color string for a single dot based on its type and brightness.
 *
 * @param isArch - Whether this dot belongs to the architecture diagram
 * @param brightness - Illumination level [0, 1]
 */
function resolveDotColor(isArch: boolean, brightness: number): string {
  if (isArch) {
    if (brightness > 0) {
      const alpha = (0.08 + brightness * 0.92).toFixed(3)
      return `rgba(${ORANGE_R},${ORANGE_G},${ORANGE_B},${alpha})`
    }
    return `rgba(${ORANGE_R},${ORANGE_G},${ORANGE_B},0.08)`
  }

  if (brightness > 0) {
    const alpha = (brightness * 0.55).toFixed(3)
    return `rgba(255,255,255,${alpha})`
  }

  return 'rgba(255,255,255,0.025)'
}
