import { cn } from '@/layers/shared/lib';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonalityTraits {
  tone: number; // 1-5
  autonomy: number; // 1-5
  caution: number; // 1-5
  communication: number; // 1-5
  creativity: number; // 1-5
}

export interface PersonalityRadarProps {
  traits: PersonalityTraits;
  /** SVG size in px. Default 130. */
  size?: number;
  /** Enable breathing animation on the radar shape. Default true. */
  animated?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRAIT_LABELS = ['Tone', 'Autonomy', 'Caution', 'Communication', 'Creativity'] as const;
const AXIS_COUNT = 5;
const MAX_VALUE = 5;
/** Number of concentric guide rings. */
const RING_COUNT = 3;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Convert a trait index + value to an (x, y) coordinate on the radar.
 * Index 0 starts at the top (12-o'clock) and proceeds clockwise.
 */
function traitToPoint(
  index: number,
  value: number,
  center: number,
  maxRadius: number
): { x: number; y: number } {
  const angle = (Math.PI * 2 * index) / AXIS_COUNT - Math.PI / 2;
  const radius = (value / MAX_VALUE) * maxRadius;
  return {
    x: center + radius * Math.cos(angle),
    y: center + radius * Math.sin(angle),
  };
}

/** Build a polygon points string from an array of { x, y }. */
function toPointsString(points: { x: number; y: number }[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

/** Build a pentagon at a given fraction of maxRadius. */
function ringPoints(fraction: number, center: number, maxRadius: number): string {
  const points = Array.from({ length: AXIS_COUNT }, (_, i) =>
    traitToPoint(i, fraction * MAX_VALUE, center, maxRadius)
  );
  return toPointsString(points);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * SVG radar chart visualising 5 personality traits on a pentagon.
 *
 * Renders concentric guide rings, axis lines with labels, a filled data
 * polygon, and data-point circles at each vertex. When `animated` is true,
 * the data polygon has a subtle 3-second breathing animation.
 */
export function PersonalityRadar({
  traits,
  size = 130,
  animated = true,
  className,
}: PersonalityRadarProps) {
  const center = size / 2;
  const maxRadius = size * 0.38; // Leave room for labels
  const labelOffset = maxRadius + 14;

  const traitValues = [
    traits.tone,
    traits.autonomy,
    traits.caution,
    traits.communication,
    traits.creativity,
  ];

  // Data shape points
  const dataPoints = traitValues.map((val, i) => traitToPoint(i, val, center, maxRadius));
  const dataPolygonPoints = toPointsString(dataPoints);

  // Slightly scaled version for breathing animation target
  const breathePoints = traitValues.map((val, i) =>
    traitToPoint(i, Math.min(val * 1.06, MAX_VALUE), center, maxRadius)
  );
  const breathePolygonPoints = toPointsString(breathePoints);

  // Label positions — placed outside the outermost ring
  const labelPositions = TRAIT_LABELS.map((label, i) => {
    const angle = (Math.PI * 2 * i) / AXIS_COUNT - Math.PI / 2;
    return {
      label,
      x: center + labelOffset * Math.cos(angle),
      y: center + labelOffset * Math.sin(angle),
    };
  });

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      aria-label="Personality radar chart"
      role="img"
    >
      {/* Concentric guide rings */}
      {Array.from({ length: RING_COUNT }, (_, i) => {
        const fraction = (i + 1) / RING_COUNT;
        const opacity = 0.06 + i * 0.02;
        return (
          <polygon
            key={`ring-${i}`}
            points={ringPoints(fraction, center, maxRadius)}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.5}
            opacity={opacity}
          />
        );
      })}

      {/* Axis lines from center to each vertex */}
      {Array.from({ length: AXIS_COUNT }, (_, i) => {
        const outer = traitToPoint(i, MAX_VALUE, center, maxRadius);
        return (
          <line
            key={`axis-${i}`}
            x1={center}
            y1={center}
            x2={outer.x}
            y2={outer.y}
            stroke="currentColor"
            strokeWidth={0.5}
            opacity={0.08}
          />
        );
      })}

      {/* Data polygon (filled shape) */}
      <polygon
        points={dataPolygonPoints}
        fill="hsl(var(--primary))"
        fillOpacity={0.2}
        stroke="hsl(var(--primary))"
        strokeOpacity={0.7}
        strokeWidth={1.5}
        strokeLinejoin="round"
      >
        {animated && (
          <animate
            attributeName="points"
            values={`${dataPolygonPoints};${breathePolygonPoints};${dataPolygonPoints}`}
            dur="3s"
            repeatCount="indefinite"
            calcMode="spline"
            keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
          />
        )}
      </polygon>

      {/* Data point circles at vertices */}
      {dataPoints.map((pt, i) => (
        <circle
          key={`point-${i}`}
          cx={pt.x}
          cy={pt.y}
          r={3}
          fill="hsl(var(--primary))"
          fillOpacity={0.9}
        >
          {animated && (
            <animate
              attributeName="r"
              values="3;3.5;3"
              dur="3s"
              repeatCount="indefinite"
              calcMode="spline"
              keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
            />
          )}
        </circle>
      ))}

      {/* Axis labels */}
      {labelPositions.map(({ label, x, y }) => (
        <text
          key={label}
          x={x}
          y={y}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="currentColor"
          opacity={0.5}
          fontSize={8}
          className="select-none"
        >
          {label}
        </text>
      ))}
    </svg>
  );
}
