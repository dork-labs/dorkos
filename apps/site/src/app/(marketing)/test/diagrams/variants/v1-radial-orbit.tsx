'use client';

import React, { useState } from 'react';
import { motion } from 'motion/react';
import type { SystemModule } from '@/layers/features/marketing/lib/modules';
import {
  VIEWPORT,
  STAGGER,
  SCALE_IN,
  DRAW_PATH,
} from '@/layers/features/marketing/lib/motion-variants';

// ─── Geometry constants ────────────────────────────────────────────────────────

const CX = 300;
const CY = 280;
const ORBIT_R = 168;
const CORE_R = 34;
const NODE_R = 22;
// Second, tighter dashed ring — decorative inner orbit
const INNER_RING_R = 72;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert polar coords (origin = CX,CY) to SVG x,y. */
function polar(r: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
}

/** Build an SVG arc path for a full circle (two arcs joined). */
function circlePath(cx: number, cy: number, r: number): string {
  return [
    `M ${cx - r} ${cy}`,
    `A ${r} ${r} 0 1 1 ${cx + r} ${cy}`,
    `A ${r} ${r} 0 1 1 ${cx - r} ${cy}`,
    'Z',
  ].join(' ');
}

// ─── Node angle layout ─────────────────────────────────────────────────────────
// 5 satellite modules at 72° spacing, starting at -90° (top)
const SATELLITE_START_DEG = -90;
const SATELLITE_STEP_DEG = 72;

// ─── Label placement helpers ───────────────────────────────────────────────────

/** Determine text-anchor based on horizontal position relative to center. */
function anchorFor(x: number): 'start' | 'middle' | 'end' {
  if (x < CX - 20) return 'end';
  if (x > CX + 20) return 'start';
  return 'middle';
}

/** Push label outward from the node center so it clears the circle. */
function labelOffset(nx: number, ny: number, labelR: number): { lx: number; ly: number } {
  const dx = nx - CX;
  const dy = ny - CY;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  return {
    lx: nx + (dx / dist) * labelR,
    ly: ny + (dy / dist) * labelR,
  };
}

// ─── Sub-components ────────────────────────────────────────────────────────────

interface StatusDotProps {
  cx: number;
  cy: number;
  available: boolean;
}

/** Small status indicator dot rendered in SVG. */
function StatusDot({ cx, cy, available }: StatusDotProps) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill={available ? 'var(--brand-green)' : 'var(--warm-gray-light)'}
      opacity={available ? 0.9 : 0.6}
    />
  );
}

interface SpokeParticleProps {
  path: string;
  dur: string;
  begin: string;
}

/** SMIL animateMotion particle that travels along a path indefinitely. */
function SpokeParticle({ path, dur, begin }: SpokeParticleProps) {
  return (
    <circle r="2.5" fill="var(--color-brand-orange)" opacity="0.75">
      <animateMotion path={path} dur={dur} repeatCount="indefinite" begin={begin} />
    </circle>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export interface DiagramV1Props {
  modules: SystemModule[];
}

/**
 * Radial orbit architecture diagram — Engine at center, 5 satellites in orbit.
 * Uses Framer Motion for entrance + SMIL animateMotion for continuous particles.
 */
export function DiagramV1({ modules }: DiagramV1Props) {
  const [entranceDone, setEntranceDone] = useState(false);

  const coreModule = modules.find((m) => m.id === 'engine');
  const satellites = modules.filter((m) => m.id !== 'engine');

  // Pre-compute satellite geometry
  const satelliteNodes = satellites.map((mod, i) => {
    const angleDeg = SATELLITE_START_DEG + i * SATELLITE_STEP_DEG;
    const { x, y } = polar(ORBIT_R, angleDeg);
    // Spoke: center → node surface, pulled slightly inward so particle
    // starts at the inner-ring edge rather than deep in the core.
    const startPt = polar(INNER_RING_R + 4, angleDeg);
    const endPt = polar(ORBIT_R - NODE_R - 2, angleDeg);
    const spokePath = `M ${startPt.x} ${startPt.y} L ${endPt.x} ${endPt.y}`;

    const LABEL_CLEARANCE = NODE_R + 24;
    const { lx, ly } = labelOffset(x, y, LABEL_CLEARANCE);
    const anchor = anchorFor(x);

    // Status dot sits just outside the node, toward the orbit ring edge
    const dotPt = polar(ORBIT_R + NODE_R + 10, angleDeg);

    return { mod, x, y, spokePath, lx, ly, anchor, dotPt, angleDeg };
  });

  // Orbital ring path for SMIL particles — circle centered at CX, CY
  // We encode this as a path so animateMotion can follow it.
  const orbitPathId = 'orbit-ring-path';
  const orbitPathD = circlePath(CX, CY, ORBIT_R);

  return (
    <motion.svg
      viewBox="0 0 600 560"
      className="architecture-particles h-auto w-full"
      preserveAspectRatio="xMidYMid meet"
      aria-label="DorkOS radial orbit architecture diagram"
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      variants={STAGGER}
      onAnimationComplete={() => setEntranceDone(true)}
    >
      <defs>
        {/* Reusable orbit path for animateMotion mpath references */}
        <path id={orbitPathId} d={orbitPathD} />

        {/* Soft radial glow behind core */}
        <radialGradient id="core-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--brand-orange)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--brand-orange)" stopOpacity="0" />
        </radialGradient>

        {/* Node fill gradient — cream-white center → slight warm tint */}
        <radialGradient id="node-fill" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="var(--cream-white)" stopOpacity="1" />
          <stop offset="100%" stopColor="var(--cream-secondary)" stopOpacity="1" />
        </radialGradient>

        {/* Engine fill gradient */}
        <radialGradient id="core-fill" cx="40%" cy="35%" r="65%">
          <stop offset="0%" stopColor="var(--cream-white)" />
          <stop offset="100%" stopColor="var(--cream-tertiary)" />
        </radialGradient>

        {/* Orange glow filter for core ring */}
        <filter id="orange-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ── Layer 0: Ambient glow behind core ── */}
      <motion.circle cx={CX} cy={CY} r={80} fill="url(#core-glow)" variants={SCALE_IN} />

      {/* ── Layer 1: Decorative inner dashed ring ── */}
      <motion.circle
        cx={CX}
        cy={CY}
        r={INNER_RING_R}
        fill="none"
        stroke="var(--color-brand-orange)"
        strokeWidth="1"
        strokeOpacity="0.2"
        strokeDasharray="4 6"
        variants={DRAW_PATH}
        className={entranceDone ? 'architecture-dashes' : ''}
        style={
          entranceDone ? { animationDuration: '8s', animationDirection: 'reverse' } : undefined
        }
      />

      {/* ── Layer 2: Main orbital ring ── */}
      <motion.circle
        cx={CX}
        cy={CY}
        r={ORBIT_R}
        fill="none"
        stroke="var(--color-brand-orange)"
        strokeWidth="1.5"
        strokeOpacity="0.25"
        strokeDasharray="3 5"
        variants={DRAW_PATH}
        className={entranceDone ? 'architecture-dashes' : ''}
        style={entranceDone ? { animationDuration: '6s' } : undefined}
      />

      {/* ── Layer 3: Spoke connection lines (center → satellites) ── */}
      {satelliteNodes.map(({ mod, spokePath }, i) => (
        <motion.path
          key={`spoke-${mod.id}`}
          d={spokePath}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1"
          strokeOpacity="0.3"
          strokeDasharray="3 4"
          variants={DRAW_PATH}
          custom={i}
          className={entranceDone ? 'architecture-dashes' : ''}
          style={
            entranceDone ? { animationDelay: `${i * 0.2}s`, animationDuration: '2s' } : undefined
          }
        />
      ))}

      {/* ── Layer 4: SMIL orbital ring particles (2 traveling in opposite directions) ── */}
      {/* These use mpath to follow the shared orbit path */}
      <circle r="2.5" fill="var(--color-brand-orange)" opacity="0.6">
        <animateMotion dur="12s" repeatCount="indefinite" begin="1.8s">
          <mpath href={`#${orbitPathId}`} />
        </animateMotion>
      </circle>
      <circle r="2" fill="var(--color-brand-orange)" opacity="0.4">
        <animateMotion dur="18s" repeatCount="indefinite" begin="3.2s">
          <mpath href={`#${orbitPathId}`} />
        </animateMotion>
      </circle>
      <circle r="1.5" fill="var(--color-brand-orange)" opacity="0.35">
        <animateMotion dur="22s" repeatCount="indefinite" begin="0.8s">
          <mpath href={`#${orbitPathId}`} />
        </animateMotion>
      </circle>

      {/* ── Layer 5: Spoke particles (one per spoke, bidirectional feel) ── */}
      {satelliteNodes.map(({ mod, spokePath }, i) => (
        <SpokeParticle
          key={`particle-${mod.id}`}
          path={spokePath}
          dur={`${3 + i * 0.7}s`}
          begin={`${1.5 + i * 0.4}s`}
        />
      ))}

      {/* ── Layer 6: Satellite nodes ── */}
      {satelliteNodes.map(({ mod, x, y, lx, ly, anchor, dotPt }) => (
        <motion.g key={mod.id} variants={SCALE_IN}>
          {/* Node shadow / depth ring */}
          <circle cx={x} cy={y} r={NODE_R + 5} fill="var(--color-brand-orange)" opacity="0.06" />

          {/* Node border ring */}
          <circle
            cx={x}
            cy={y}
            r={NODE_R}
            fill="url(#node-fill)"
            stroke="var(--color-brand-orange)"
            strokeWidth="1.5"
            strokeOpacity="0.45"
          />

          {/* Module name (bold, inside or just outside node) */}
          <text
            x={x}
            y={y + 1}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-charcoal font-mono"
            style={{ fontSize: '9px', fontWeight: 600, letterSpacing: '0.04em' }}
          >
            {mod.name}
          </text>

          {/* Status dot */}
          <StatusDot cx={dotPt.x} cy={dotPt.y} available={mod.status === 'available'} />

          {/* Label text — module label (e.g. "Web UI") pushed outward */}
          <text
            x={lx}
            y={ly - 7}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-charcoal"
            style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '-0.01em' }}
          >
            {mod.name}
          </text>
          <text
            x={lx}
            y={ly + 8}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-warm-gray font-mono"
            style={
              {
                fontSize: '9px',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              } as React.CSSProperties
            }
          >
            {mod.label}
          </text>
        </motion.g>
      ))}

      {/* ── Layer 7: Engine node (largest, pulses gently) ── */}
      <motion.g variants={SCALE_IN}>
        {/* Pulse rings — CSS animation handled by Framer Motion animate prop
            after entrance is done; use two concentric rings */}
        <motion.circle
          cx={CX}
          cy={CY}
          r={CORE_R + 18}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1"
          strokeOpacity="0.0"
          animate={
            entranceDone
              ? {
                  strokeOpacity: [0, 0.3, 0],
                  r: [CORE_R + 10, CORE_R + 30, CORE_R + 10],
                }
              : {}
          }
          transition={{ duration: 3, repeat: Infinity, ease: 'easeOut' }}
        />
        <motion.circle
          cx={CX}
          cy={CY}
          r={CORE_R + 10}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1"
          strokeOpacity="0.0"
          animate={
            entranceDone
              ? {
                  strokeOpacity: [0, 0.22, 0],
                  r: [CORE_R + 6, CORE_R + 22, CORE_R + 6],
                }
              : {}
          }
          transition={{ duration: 3, repeat: Infinity, ease: 'easeOut', delay: 0.6 }}
        />

        {/* Engine outer ring — glowing orange stroke */}
        <circle
          cx={CX}
          cy={CY}
          r={CORE_R + 3}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1.5"
          strokeOpacity="0.5"
          filter="url(#orange-glow)"
        />

        {/* Engine node body */}
        <circle
          cx={CX}
          cy={CY}
          r={CORE_R}
          fill="url(#core-fill)"
          stroke="var(--color-brand-orange)"
          strokeWidth="2"
          strokeOpacity="0.7"
        />

        {/* Engine: module name */}
        <text
          x={CX}
          y={CY - 5}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-charcoal font-mono"
          style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em' }}
        >
          {coreModule?.name ?? 'Engine'}
        </text>

        {/* Engine: label */}
        <text
          x={CX}
          y={CY + 8}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-warm-gray font-mono"
          style={
            {
              fontSize: '8px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            } as React.CSSProperties
          }
        >
          {coreModule?.label ?? 'AI Server'}
        </text>

        {/* Engine: available status dot */}
        <circle
          cx={CX + CORE_R + 6}
          cy={CY - CORE_R + 2}
          r={4.5}
          fill="var(--brand-green)"
          opacity="0.9"
        />
      </motion.g>

      {/* ── Layer 8: Legend ── */}
      <g transform="translate(16, 510)">
        <circle cx={6} cy={6} r={4} fill="var(--brand-green)" opacity="0.85" />
        <text
          x={14}
          y={6}
          dominantBaseline="middle"
          className="fill-warm-gray font-mono"
          style={{ fontSize: '9px', letterSpacing: '0.06em' }}
        >
          Available
        </text>

        <circle cx={80} cy={6} r={4} fill="var(--warm-gray-light)" opacity="0.6" />
        <text
          x={88}
          y={6}
          dominantBaseline="middle"
          className="fill-warm-gray font-mono"
          style={{ fontSize: '9px', letterSpacing: '0.06em' }}
        >
          Coming Soon
        </text>
      </g>
    </motion.svg>
  );
}
