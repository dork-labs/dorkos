import { motion } from 'motion/react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { cn } from '@/layers/shared/lib';
import {
  useWidgetMotion,
  WIDGET_DRAW_DURATION,
  WIDGET_EASE_OUT,
  WIDGET_SPRING,
  WIDGET_STAGGER_STEP,
} from '../../lib/widget-motion';

type ChartNodeData = Extract<WidgetNode, { type: 'chart' }>;
type ChartDatum = ChartNodeData['data'][number];

/**
 * Categorical palette resolved from the `--chart-*` theme tokens, so series
 * colors track light/dark automatically.
 */
const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
] as const;

const DEFAULT_HEIGHT = 180;

/** Resting fill opacity for an area chart's shaded region (line stays opaque). */
const AREA_FILL_OPACITY = 0.15;

/**
 * `chart` node — a minimal, dependency-free chart. Bars use CSS for natural
 * responsiveness and label alignment; line/area/pie use inline SVG with
 * non-scaling strokes so they stay crisp at any width.
 */
export function ChartNode({ node }: { node: ChartNodeData }) {
  const height = node.height ?? DEFAULT_HEIGHT;
  const label = `${node.kind} chart`;

  if (node.data.length === 0) {
    return <p className="text-muted-foreground text-xs">No data to chart.</p>;
  }

  if (node.kind === 'bar') return <BarChart data={node.data} height={height} label={label} />;
  if (node.kind === 'pie') return <PieChart data={node.data} height={height} label={label} />;
  return (
    <LineAreaChart data={node.data} height={height} area={node.kind === 'area'} label={label} />
  );
}

/** Vertical space reserved above the tallest bar for its value label. */
const BAR_LABEL_SPACE = 18;

function BarChart({ data, height, label }: { data: ChartDatum[]; height: number; label: string }) {
  const motionOn = useWidgetMotion();
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  // Pixel heights, not percentages: a percentage height on a flex child resolves
  // against an indefinite parent and collapses to zero in this layout.
  const plot = Math.max(0, height - BAR_LABEL_SPACE);
  return (
    <div role="img" aria-label={label} className="flex flex-col gap-1">
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="text-muted-foreground text-2xs tabular-nums">{d.value}</span>
            <motion.div
              className="w-full origin-bottom rounded-t-sm"
              style={{
                height: (d.value / max) * plot,
                backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
              }}
              initial={motionOn ? { scaleY: 0 } : false}
              animate={motionOn ? { scaleY: 1 } : false}
              transition={{ ...WIDGET_SPRING, delay: i * WIDGET_STAGGER_STEP }}
            />
          </div>
        ))}
      </div>
      <AxisLabels data={data} />
    </div>
  );
}

function LineAreaChart({
  data,
  height,
  area,
  label,
}: {
  data: ChartDatum[];
  height: number;
  area: boolean;
  label: string;
}) {
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  const n = data.length;
  const points = data.map((d, i) => {
    const x = n === 1 ? 50 : (i / (n - 1)) * 100;
    const y = 100 - (d.value / max) * 100;
    return { x, y };
  });
  const line = points.map((p) => `${p.x},${p.y}`).join(' ');
  const areaPath = `0,100 ${line} 100,100`;
  const color = CHART_COLORS[0];
  const motionOn = useWidgetMotion();
  const draw = { duration: WIDGET_DRAW_DURATION, ease: WIDGET_EASE_OUT };

  return (
    <div role="img" aria-label={label} className="flex flex-col gap-1">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ height }}
        className="w-full overflow-visible"
      >
        {area && (
          <motion.polygon
            points={areaPath}
            fill={color}
            // Static fill when motion is off; otherwise fade the fill in behind
            // the drawing line. `opacity` is the resting value the animation
            // targets, so it also serves as the reduced-motion final state.
            opacity={motionOn ? undefined : AREA_FILL_OPACITY}
            initial={motionOn ? { opacity: 0 } : false}
            animate={motionOn ? { opacity: AREA_FILL_OPACITY } : false}
            transition={{ ...draw, delay: WIDGET_DRAW_DURATION * 0.5 }}
          />
        )}
        <motion.polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          initial={motionOn ? { pathLength: 0 } : false}
          animate={motionOn ? { pathLength: 1 } : false}
          transition={draw}
        />
      </svg>
      <AxisLabels data={data} />
    </div>
  );
}

/**
 * A slice covering (effectively) the whole pie degenerates in `arcPath`: start
 * and end resolve to the same point, so the arc draws nothing. At or beyond
 * this sweep the slice renders as a full circle instead.
 */
const FULL_CIRCLE_SWEEP = 359.99;

function PieChart({ data, height, label }: { data: ChartDatum[]; height: number; label: string }) {
  const motionOn = useWidgetMotion();
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  // Cumulative start angle per slice, computed without render-time mutation.
  const slices = data.map((d, i) => {
    const prior = data.slice(0, i).reduce((sum, x) => sum + x.value, 0);
    const start = -90 + (prior / total) * 360;
    const sweep = (d.value / total) * 360;
    const full = sweep >= FULL_CIRCLE_SWEEP;
    return { d, full, path: full ? '' : arcPath(start, start + sweep) };
  });

  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 100 100" role="img" aria-label={label} style={{ height, width: height }}>
        {slices.map((s, i) => {
          const fill = CHART_COLORS[i % CHART_COLORS.length];
          const anim = {
            initial: motionOn ? { opacity: 0, scale: 0.6 } : false,
            animate: motionOn ? { opacity: 1, scale: 1 } : false,
            transition: { ...WIDGET_SPRING, delay: i * WIDGET_STAGGER_STEP },
            style: { transformOrigin: '50px 50px' },
          } as const;
          return s.full ? (
            <motion.circle key={i} cx={50} cy={50} r={50} fill={fill} {...anim} />
          ) : (
            <motion.path key={i} d={s.path} fill={fill} {...anim} />
          );
        })}
      </svg>
      <ul className="flex flex-col gap-1 text-xs">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
              aria-hidden
            />
            <span className="text-foreground">{d.label}</span>
            <span className="text-muted-foreground tabular-nums">{d.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AxisLabels({ data }: { data: ChartDatum[] }) {
  return (
    <div className="flex gap-2">
      {data.map((d, i) => (
        <span
          key={i}
          className={cn('text-muted-foreground text-2xs min-w-0 flex-1 truncate text-center')}
          title={d.label}
        >
          {d.label}
        </span>
      ))}
    </div>
  );
}

/** SVG arc path for a pie slice between two angles (degrees), in a 100×100 box. */
function arcPath(startDeg: number, endDeg: number): string {
  const cx = 50;
  const cy = 50;
  const r = 50;
  const start = polar(cx, cy, r, startDeg);
  const end = polar(cx, cy, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
