import { useRef, useEffect, useId } from 'react';
import { cn } from '@/layers/shared/lib';
import { DEFAULT_PRESET_COLORS, type PresetColors } from '../model/personality-presets';

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
  /** Color palette for the Cosmic Nebula effect. */
  colors?: PresetColors;
  /** SVG size in px. Default 180. */
  size?: number;
  /** Enable Cosmic Nebula animations. Default true. */
  animated?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRAIT_LABELS = ['Tone', 'Autonomy', 'Caution', 'Communication', 'Creativity'] as const;
const TRAIT_KEYS = ['tone', 'autonomy', 'caution', 'communication', 'creativity'] as const;
const AXIS_COUNT = 5;
const MAX_VALUE = 5;
const RING_COUNT = 3;
const MORPH_MS = 800;
const FLASH_MS = 600;

/** Stardust orbit paths (designed at 200px scale, component scales via transform). */
const STARDUST = [
  {
    r: 1.2,
    dur: '9s',
    fade: '4.5s',
    begin: '0s',
    path: 'M0,0 C30,-40 60,0 40,40 C20,60 -20,40 -30,10 C-40,-20 -10,-50 0,0',
  },
  {
    r: 0.9,
    dur: '7s',
    fade: '3.5s',
    begin: '0s',
    path: 'M0,0 C-20,30 -40,20 -30,-10 C-20,-30 10,-40 20,-20 C30,0 20,30 0,0',
  },
  {
    r: 1.0,
    dur: '11s',
    fade: '5s',
    begin: '0s',
    path: 'M0,0 C40,10 30,50 0,40 C-30,30 -40,-10 -20,-30 C0,-50 30,-20 0,0',
  },
  {
    r: 0.7,
    dur: '8s',
    fade: '4s',
    begin: '2s',
    path: 'M0,0 C15,-35 45,-15 35,20 C25,45 -15,40 -25,15 C-35,-10 -5,-40 0,0',
  },
  {
    r: 1.1,
    dur: '12s',
    fade: '6s',
    begin: '1s',
    path: 'M0,0 C-25,25 -45,5 -30,-20 C-15,-45 20,-35 30,-10 C40,15 15,35 0,0',
  },
];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function traitToPoint(index: number, value: number, center: number, maxRadius: number) {
  const angle = (Math.PI * 2 * index) / AXIS_COUNT - Math.PI / 2;
  const radius = (value / MAX_VALUE) * maxRadius;
  return { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) };
}

function toPointsString(points: { x: number; y: number }[]) {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

function ringPoints(fraction: number, center: number, maxRadius: number) {
  return toPointsString(
    Array.from({ length: AXIS_COUNT }, (_, i) =>
      traitToPoint(i, fraction * MAX_VALUE, center, maxRadius)
    )
  );
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Cosmic Nebula radar chart visualising 5 personality traits on a pentagon.
 *
 * Features a swirling nebula background, orbiting stardust particles, vertex
 * glow halos, smooth morph transitions between presets (800ms easeInOutCubic),
 * per-preset color palettes with CSS-transitioned gradients, and a radial
 * flash on preset change.
 */
export function PersonalityRadar({
  traits,
  colors = DEFAULT_PRESET_COLORS,
  size = 180,
  animated = true,
  className,
}: PersonalityRadarProps) {
  const uid = useId().replace(/:/g, '');
  const center = size / 2;
  const maxRadius = size * 0.32;
  const labelOffset = maxRadius + 16;
  const stardustScale = size / 200;

  // Refs for imperative animation (bypasses React render cycle)
  const dataShapeRef = useRef<SVGPolygonElement>(null);
  const flashRef = useRef<SVGCircleElement>(null);
  const haloRefs = useRef<(SVGCircleElement | null)[]>([]);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);

  const animRef = useRef({
    current: { ...traits },
    from: null as PersonalityTraits | null,
    target: { ...traits },
    morphStart: 0,
    breathe: 0,
  });

  // Detect trait changes → start morph + flash
  const prevTraitsRef = useRef(traits);
  useEffect(() => {
    const prev = prevTraitsRef.current;
    const changed = TRAIT_KEYS.some((k) => prev[k] !== traits[k]);
    if (changed) {
      const a = animRef.current;
      if (animated) {
        a.from = { ...a.current };
        a.target = { ...traits };
        a.morphStart = performance.now();

        // Radial flash animation
        const fl = flashRef.current;
        if (fl) {
          const start = performance.now();
          (function fadeFlash() {
            const t = Math.min((performance.now() - start) / FLASH_MS, 1);
            const ease = 1 - (1 - t) * (1 - t);
            fl.setAttribute('r', String(maxRadius * (0.7 + 0.6 * ease)));
            fl.setAttribute('opacity', String(0.4 * (1 - ease)));
            if (t < 1) requestAnimationFrame(fadeFlash);
          })();
        }
      } else {
        // Keep animRef in sync when not animating
        Object.assign(a.current, traits);
        Object.assign(a.target, traits);
      }
    }
    prevTraitsRef.current = traits;
  }, [traits, animated, maxRadius]);

  // Main rAF loop — breathing + morph interpolation
  useEffect(() => {
    if (!animated) return;
    let rafId: number;
    const a = animRef.current;

    function tick() {
      a.breathe += 0.015;
      const breathe = 1 + Math.sin(a.breathe) * 0.04;

      if (a.from) {
        const t = Math.min((performance.now() - a.morphStart) / MORPH_MS, 1);
        const e = easeInOutCubic(t);
        for (const k of TRAIT_KEYS) {
          a.current[k] = a.from[k] + (a.target[k] - a.from[k]) * e;
        }
        if (t >= 1) {
          a.from = null;
          Object.assign(a.current, a.target);
        }
      }

      const vals = TRAIT_KEYS.map((k) => a.current[k]);
      const pts = vals.map((v, i) => traitToPoint(i, v * breathe, center, maxRadius));
      dataShapeRef.current?.setAttribute('points', toPointsString(pts));

      pts.forEach((p, i) => {
        const h = haloRefs.current[i];
        const d = dotRefs.current[i];
        if (h) {
          h.setAttribute('cx', String(p.x));
          h.setAttribute('cy', String(p.y));
          h.setAttribute('r', String(8 + Math.sin(a.breathe + i * 1.2) * 3));
          h.setAttribute('opacity', String(0.15 + Math.sin(a.breathe + i) * 0.1));
        }
        if (d) {
          d.setAttribute('cx', String(p.x));
          d.setAttribute('cy', String(p.y));
          d.setAttribute('r', String(3.5 + Math.sin(a.breathe + i * 0.8) * 0.8));
        }
      });

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [animated, center, maxRadius]);

  // Initial positions for first paint (rAF takes over immediately)
  const initPts = TRAIT_KEYS.map((k, i) => traitToPoint(i, traits[k], center, maxRadius));
  const initPtsStr = toPointsString(initPts);
  const stopTx = { transition: 'stop-color 0.6s ease' } as React.CSSProperties;
  const fillTx = { transition: 'fill 0.6s ease' } as React.CSSProperties;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      aria-label="Personality radar chart"
      role="img"
    >
      <defs>
        <filter id={`ng-${uid}`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="10" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={`vg-${uid}`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id={`nc-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" style={{ stopColor: colors.nebula, stopOpacity: 0.35, ...stopTx }} />
          <stop offset="50%" style={{ stopColor: colors.nebula, stopOpacity: 0.15, ...stopTx }} />
          <stop offset="100%" stopColor="#0a0a0a" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`nw-${uid}`} cx="35%" cy="35%" r="60%">
          <stop offset="0%" style={{ stopColor: colors.wisp, stopOpacity: 0.12, ...stopTx }} />
          <stop offset="100%" stopColor="#0a0a0a" stopOpacity={0} />
        </radialGradient>
        <linearGradient id={`sf-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: colors.fill, stopOpacity: 0.35, ...stopTx }} />
          <stop offset="100%" style={{ stopColor: colors.fillEnd, stopOpacity: 0.25, ...stopTx }} />
        </linearGradient>
        <linearGradient id={`ss-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: colors.stroke, ...stopTx }} />
          <stop offset="100%" style={{ stopColor: colors.strokeEnd, ...stopTx }} />
        </linearGradient>
      </defs>

      {/* Nebula background */}
      <circle cx={center} cy={center} r={size * 0.44} fill={`url(#nc-${uid})`}>
        {animated && (
          <animateTransform
            attributeName="transform"
            type="rotate"
            values={`0 ${center} ${center};360 ${center} ${center}`}
            dur="90s"
            repeatCount="indefinite"
          />
        )}
      </circle>
      <ellipse
        cx={center * 0.94}
        cy={center * 0.97}
        rx={size * 0.35}
        ry={size * 0.25}
        fill={`url(#nw-${uid})`}
      >
        {animated && (
          <animateTransform
            attributeName="transform"
            type="rotate"
            values={`0 ${center} ${center};-360 ${center} ${center}`}
            dur="60s"
            repeatCount="indefinite"
          />
        )}
      </ellipse>

      {/* Breathing ring */}
      {animated && (
        <circle
          cx={center}
          cy={center}
          r={maxRadius * 0.92}
          fill="none"
          style={{ stroke: colors.stroke, transition: 'stroke 0.6s ease' }}
          strokeWidth={0.3}
          opacity={0.15}
        >
          <animate
            attributeName="r"
            values={`${maxRadius * 0.85};${maxRadius * 1.08};${maxRadius * 0.85}`}
            dur="4s"
            repeatCount="indefinite"
            calcMode="spline"
            keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
          />
          <animate
            attributeName="opacity"
            values="0.15;0.25;0.15"
            dur="4s"
            repeatCount="indefinite"
            calcMode="spline"
            keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
          />
        </circle>
      )}

      {/* Stardust particles */}
      {animated && (
        <g transform={`translate(${center},${center}) scale(${stardustScale})`}>
          {STARDUST.map((s, i) => (
            <circle key={`star-${i}`} r={s.r} style={{ fill: colors.dot, ...fillTx }}>
              <animateMotion dur={s.dur} repeatCount="indefinite" begin={s.begin} path={s.path} />
              <animate
                attributeName="opacity"
                values="0;0.8;0"
                dur={s.fade}
                repeatCount="indefinite"
                begin={s.begin}
              />
            </circle>
          ))}
        </g>
      )}

      {/* Flash (triggered imperatively on preset change) */}
      <circle ref={flashRef} cx={center} cy={center} r={0} fill={colors.nebula} opacity={0} />

      {/* Guide rings */}
      {Array.from({ length: RING_COUNT }, (_, i) => (
        <polygon
          key={`ring-${i}`}
          points={ringPoints((i + 1) / RING_COUNT, center, maxRadius)}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.5}
          opacity={0.06 + i * 0.02}
        />
      ))}

      {/* Axis lines */}
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

      {/* Data polygon */}
      <polygon
        ref={dataShapeRef}
        points={initPtsStr}
        fill={`url(#sf-${uid})`}
        stroke={`url(#ss-${uid})`}
        strokeWidth={2}
        strokeLinejoin="round"
        filter={`url(#ng-${uid})`}
      />

      {/* Vertex halos */}
      {initPts.map((pt, i) => (
        <circle
          key={`halo-${i}`}
          ref={(el) => {
            haloRefs.current[i] = el;
          }}
          cx={pt.x}
          cy={pt.y}
          r={8}
          style={{ fill: colors.glow, ...fillTx }}
          opacity={0.2}
        />
      ))}

      {/* Vertex dots */}
      {initPts.map((pt, i) => (
        <circle
          key={`dot-${i}`}
          ref={(el) => {
            dotRefs.current[i] = el;
          }}
          cx={pt.x}
          cy={pt.y}
          r={4}
          style={{ fill: colors.dot, ...fillTx }}
          filter={`url(#vg-${uid})`}
        />
      ))}

      {/* Axis labels */}
      {TRAIT_LABELS.map((label, i) => {
        const angle = (Math.PI * 2 * i) / AXIS_COUNT - Math.PI / 2;
        return (
          <text
            key={label}
            x={center + labelOffset * Math.cos(angle)}
            y={center + labelOffset * Math.sin(angle)}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="currentColor"
            opacity={0.5}
            fontSize={8}
            className="select-none"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}
