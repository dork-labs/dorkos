'use client';

import { motion } from 'motion/react';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Globe viewBox dimensions — square for symmetry. */
const G_W = 480;
const G_H = 480;
const CX = 240;
const CY = 240;
const R = 160;

/** Brand orange at the opacity levels required by the design spec. */
const ORANGE = '#E85D04';
const ORANGE_WIRE = 'rgba(232, 93, 4, 0.10)';
const ORANGE_ARC = 'rgba(232, 93, 4, 0.55)';
const ORANGE_DOT = 'rgba(232, 93, 4, 0.80)';

/** Arc endpoint definitions — viewBox coordinates for each connection. */
const ARCS: Array<{
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  device1: 'laptop' | 'phone' | 'tablet';
  device2: 'laptop' | 'phone' | 'tablet';
  /** Positive curves up (toward top), negative curves down. */
  curvature: number;
  delay: number;
}> = [
  {
    id: 'arc-a',
    x1: 130,
    y1: 170,
    x2: 330,
    y2: 200,
    device1: 'laptop',
    device2: 'phone',
    curvature: -60,
    delay: 0.0,
  },
  {
    id: 'arc-b',
    x1: 175,
    y1: 290,
    x2: 360,
    y2: 270,
    device1: 'tablet',
    device2: 'laptop',
    curvature: 55,
    delay: 0.4,
  },
  {
    id: 'arc-c',
    x1: 145,
    y1: 230,
    x2: 310,
    y2: 330,
    device1: 'phone',
    device2: 'tablet',
    curvature: -40,
    delay: 0.8,
  },
  {
    id: 'arc-d',
    x1: 210,
    y1: 155,
    x2: 345,
    y2: 320,
    device1: 'laptop',
    device2: 'phone',
    curvature: 65,
    delay: 1.2,
  },
];

// ─── Math Helpers ─────────────────────────────────────────────────────────────

/** Quadratic bezier control point offset perpendicularly from the chord. */
function controlPoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature: number
): { cx: number; cy: number } {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  // Perpendicular (rotated 90°) unit vector
  const nx = -dy / len;
  const ny = dx / len;
  return { cx: mx + nx * curvature, cy: my + ny * curvature };
}

/** Build the `d` attribute string for a quadratic bezier arc. */
function arcPath(x1: number, y1: number, x2: number, y2: number, curvature: number): string {
  const { cx, cy } = controlPoint(x1, y1, x2, y2, curvature);
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

// ─── Device Icons ─────────────────────────────────────────────────────────────

function LaptopIcon({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x - 12} ${y - 9})`}>
      <rect x="1" y="0" width="22" height="14" rx="1.5" fill={ORANGE} opacity="0.85" />
      <rect x="3" y="2" width="18" height="10" rx="0.5" fill="rgba(245,240,230,0.9)" />
      <rect x="0" y="14.5" width="24" height="3" rx="1" fill={ORANGE} opacity="0.7" />
      <line x1="2" y1="14.5" x2="22" y2="14.5" stroke="rgba(245,240,230,0.5)" strokeWidth="0.5" />
    </g>
  );
}

function PhoneIcon({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x - 7} ${y - 10})`}>
      <rect x="0" y="0" width="14" height="20" rx="2.5" fill={ORANGE} opacity="0.85" />
      <rect x="1.5" y="2.5" width="11" height="13.5" rx="0.5" fill="rgba(245,240,230,0.9)" />
      <rect x="5" y="17.2" width="4" height="1.2" rx="0.6" fill="rgba(245,240,230,0.6)" />
      <rect x="5" y="1" width="4" height="1" rx="0.5" fill="rgba(245,240,230,0.4)" />
    </g>
  );
}

function TabletIcon({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x - 10} ${y - 12})`}>
      <rect x="0" y="0" width="20" height="24" rx="2" fill={ORANGE} opacity="0.85" />
      <rect x="2" y="2.5" width="16" height="18" rx="0.5" fill="rgba(245,240,230,0.9)" />
      <circle cx="10" cy="22" r="1.2" fill="rgba(245,240,230,0.5)" />
      <circle cx="10" cy="1.5" r="0.8" fill="rgba(245,240,230,0.4)" />
    </g>
  );
}

function DeviceIcon({ type, x, y }: { type: 'laptop' | 'phone' | 'tablet'; x: number; y: number }) {
  if (type === 'laptop') return <LaptopIcon x={x} y={y} />;
  if (type === 'phone') return <PhoneIcon x={x} y={y} />;
  return <TabletIcon x={x} y={y} />;
}

// ─── Wireframe Lines ──────────────────────────────────────────────────────────

/** Latitude rings — horizontal ellipses projected at each angle. */
function LatitudeLines() {
  const angles = [-60, -40, -20, 0, 20, 40, 60];
  return (
    <>
      {angles.map((angle) => {
        const rad = (angle * Math.PI) / 180;
        const ry = Math.abs(R * Math.sin(rad));
        const cy = CY - R * Math.sin(rad);
        const rx = R * Math.cos(Math.abs(rad));
        if (rx < 4) return null;
        return (
          <ellipse
            key={angle}
            cx={CX}
            cy={cy}
            rx={rx}
            ry={Math.max(ry * 0.35, 1)}
            fill="none"
            stroke={ORANGE_WIRE}
            strokeWidth="1"
          />
        );
      })}
    </>
  );
}

/** Longitude rings — vertical ellipses, perspective-compressed by rotation angle. */
function LongitudeLines() {
  const angles = [0, 30, 60, 90, 120, 150];
  return (
    <>
      {angles.map((angle) => {
        const rad = (angle * Math.PI) / 180;
        const rx = Math.abs(R * Math.cos(rad));
        return (
          <ellipse
            key={angle}
            cx={CX}
            cy={CY}
            rx={Math.max(rx, 2)}
            ry={R}
            fill="none"
            stroke={ORANGE_WIRE}
            strokeWidth="1"
          />
        );
      })}
    </>
  );
}

// ─── Arc Sub-component ────────────────────────────────────────────────────────

interface ArcProps {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  device1: 'laptop' | 'phone' | 'tablet';
  device2: 'laptop' | 'phone' | 'tablet';
  curvature: number;
  delay: number;
}

/**
 * A single animated connection arc.
 *
 * The arc line draws itself via framer-motion pathLength. A traveling dot
 * follows the path via SMIL animateMotion (CSS animation can't follow a
 * bezier path). Device icons appear at each endpoint with a scale-in.
 */
function Arc({ x1, y1, x2, y2, device1, device2, curvature, delay }: ArcProps) {
  const d = arcPath(x1, y1, x2, y2, curvature);
  const drawDuration = 1.4;
  const dotDuration = 3.2;
  const dotBegin = `${delay + drawDuration * 0.5}s`;

  return (
    <g>
      {/* Arc line */}
      <motion.path
        d={d}
        fill="none"
        stroke={ORANGE_ARC}
        strokeWidth="1.5"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: drawDuration, delay, ease: 'easeInOut' }}
      />

      {/* Traveling dot — SMIL only, no CSS fallback needed for path-following */}
      <circle r="3" fill={ORANGE_DOT} opacity="0">
        <animate
          attributeName="opacity"
          values="0;1;1;0"
          dur={`${dotDuration}s`}
          begin={dotBegin}
          repeatCount="indefinite"
        />
        <animateMotion dur={`${dotDuration}s`} begin={dotBegin} repeatCount="indefinite" path={d} />
      </circle>

      {/* Endpoint icons — scale in after arc begins drawing */}
      <motion.g
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, delay: delay + 0.3, ease: 'backOut' }}
        style={{ transformOrigin: `${(x1 + x2) / 2}px ${(y1 + y2) / 2}px` }}
      >
        <DeviceIcon type={device1} x={x1} y={y1} />
        <DeviceIcon type={device2} x={x2} y={y2} />
      </motion.g>
    </g>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * GlobeVisual — SVG wireframe globe with animated connection arcs.
 *
 * The wireframe rotates at 60s per revolution (CSS animation).
 * Four arcs draw themselves on mount with staggered delays.
 * Small device icons appear at each arc endpoint.
 *
 * Respects `prefers-reduced-motion` — rotation stops, arcs remain static.
 */
export function GlobeVisual() {
  return (
    <>
      <style>{`
        @keyframes globe-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        .globe-wireframe {
          animation: globe-spin 60s linear infinite;
          transform-origin: ${CX}px ${CY}px;
          transform-box: fill-box;
        }
        @media (prefers-reduced-motion: reduce) {
          .globe-wireframe { animation: none !important; }
        }
      `}</style>

      <svg
        viewBox={`0 0 ${G_W} ${G_H}`}
        aria-hidden="true"
        style={{ display: 'block', width: '100%', height: '100%' }}
      >
        <defs>
          <radialGradient id="globe-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={ORANGE} stopOpacity="0.05" />
            <stop offset="100%" stopColor={ORANGE} stopOpacity="0" />
          </radialGradient>
          <clipPath id="globe-clip">
            <circle cx={CX} cy={CY} r={R} />
          </clipPath>
        </defs>

        {/* Ambient glow halo behind the globe */}
        <circle cx={CX} cy={CY} r={R + 32} fill="url(#globe-glow)" />

        {/* Rotating wireframe — clipped so lines don't escape the sphere */}
        <g className="globe-wireframe">
          <circle cx={CX} cy={CY} r={R} fill="none" stroke={ORANGE_WIRE} strokeWidth="1.5" />
          <g clipPath="url(#globe-clip)">
            <LatitudeLines />
            <LongitudeLines />
          </g>
        </g>

        {/* Static boundary ring stays still while interior spins */}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke={ORANGE_WIRE} strokeWidth="1.5" />

        {/* Connection arcs and device icons */}
        {ARCS.map((arc) => (
          <Arc key={arc.id} {...arc} />
        ))}
      </svg>
    </>
  );
}
