import { useId } from 'react';
import { motion } from 'motion/react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { MarkdownContent, Progress, Separator } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { toneBadgeClass } from '../../lib/widget-tone';
import {
  useCountUp,
  useWidgetMotion,
  WIDGET_DRAW_DURATION,
  WIDGET_EASE_OUT,
  WIDGET_SPRING,
} from '../../lib/widget-motion';
import { formatStatValue, parseStatValue } from '../../lib/stat-format';

type NodeOf<T extends WidgetNode['type']> = Extract<WidgetNode, { type: T }>;

const HEADING_CLASSES: Record<1 | 2 | 3, string> = {
  1: 'text-lg font-semibold',
  2: 'text-base font-semibold',
  3: 'text-sm font-semibold',
};

/** `heading` node — a real heading element sized by level. */
export function HeadingNode({ node }: { node: NodeOf<'heading'> }) {
  const level = node.level ?? 3;
  const className = cn(HEADING_CLASSES[level], 'text-foreground');
  if (level === 1) return <h1 className={className}>{node.text}</h1>;
  if (level === 2) return <h2 className={className}>{node.text}</h2>;
  return <h3 className={className}>{node.text}</h3>;
}

/**
 * `text` node — inline markdown via the shared markdown pipeline. Streamdown
 * sanitizes embedded HTML and renders markdown constructs only; external links
 * confirm through the shared link-safety modal, same as chat links.
 */
export function TextNode({ node }: { node: NodeOf<'text'> }) {
  return <MarkdownContent content={node.text} className="text-sm" linkSafety />;
}

/** `badge` node — a toned pill that pops in on mount. */
export function BadgeNode({ node }: { node: NodeOf<'badge'> }) {
  const motionOn = useWidgetMotion();
  return (
    <motion.span
      className={cn(
        'inline-flex w-fit items-center rounded-md border px-2 py-0.5 text-xs font-medium',
        toneBadgeClass(node.tone)
      )}
      initial={motionOn ? { opacity: 0, scale: 0.8 } : false}
      animate={motionOn ? { opacity: 1, scale: 1 } : false}
      transition={WIDGET_SPRING}
    >
      {node.text}
    </motion.span>
  );
}

/** `divider` node — a horizontal rule. */
export function DividerNode() {
  return <Separator />;
}

const DELTA_ICON = { up: ArrowUp, down: ArrowDown, flat: ArrowRight } as const;
const DELTA_CLASS = {
  up: 'text-status-success',
  down: 'text-status-error',
  flat: 'text-muted-foreground',
} as const;

/** `stat` node — a labelled metric whose value counts up, with an optional delta and hint. */
export function StatNode({ node }: { node: NodeOf<'stat'> }) {
  const motionOn = useWidgetMotion();
  const parsed = parseStatValue(node.value);
  const counted = useCountUp(parsed?.value ?? 0, motionOn && parsed !== null);
  const display = parsed ? formatStatValue(parsed, counted) : String(node.value);

  const DeltaIcon = node.delta ? DELTA_ICON[node.delta.direction] : null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs font-medium">{node.label}</span>
      <div className="flex items-center gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-foreground text-2xl font-semibold tabular-nums">{display}</span>
          {node.delta && DeltaIcon && (
            <motion.span
              className={cn(
                'inline-flex items-center gap-0.5 text-xs font-medium',
                DELTA_CLASS[node.delta.direction]
              )}
              initial={motionOn ? { opacity: 0, x: -4 } : false}
              animate={motionOn ? { opacity: 1, x: 0 } : false}
              transition={{ ...WIDGET_SPRING, delay: 0.25 }}
            >
              <DeltaIcon className="size-3" aria-hidden />
              {node.delta.value}
            </motion.span>
          )}
        </div>
        {node.trend && node.trend.length >= 2 && <StatSparkline values={node.trend} />}
      </div>
      {node.hint && <span className="text-muted-foreground text-xs">{node.hint}</span>}
    </div>
  );
}

/**
 * A compact inline sparkline for a `stat`'s `trend` series. Uses the same
 * clip-path wipe reveal as {@link ChartNode} — a widening clip rect is immune to
 * the non-uniform stretch from `preserveAspectRatio="none"` that would distort a
 * stroke-dash draw.
 */
function StatSparkline({ values }: { values: number[] }) {
  const motionOn = useWidgetMotion();
  // useId emits colons, invalid inside a `url(#…)` reference.
  const clipId = `spark-wipe-${useId().replace(/:/g, '')}`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = max === min ? 50 : 100 - ((v - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="h-5 w-16 shrink-0 overflow-visible"
      aria-hidden
    >
      {motionOn && (
        <defs>
          <clipPath id={clipId}>
            <motion.rect
              x={-4}
              y={-12}
              height={124}
              initial={{ width: 0 }}
              animate={{ width: 108 }}
              transition={{ duration: WIDGET_DRAW_DURATION, ease: WIDGET_EASE_OUT }}
            />
          </clipPath>
        </defs>
      )}
      <g clipPath={motionOn ? `url(#${clipId})` : undefined}>
        <polyline
          points={points}
          fill="none"
          stroke="hsl(var(--chart-1))"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}

/** `keyValue` node — a two-column key/value list. */
export function KeyValueNode({ node }: { node: NodeOf<'keyValue'> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {node.items.map((item, i) => (
        <div key={`${item.key}-${i}`} className="contents">
          <dt className="text-muted-foreground">{item.key}</dt>
          <dd className="text-foreground text-right break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** `progress` node — a labelled determinate bar whose fill (and %) counts up from zero. */
export function ProgressNode({ node }: { node: NodeOf<'progress'> }) {
  const motionOn = useWidgetMotion();
  const value = useCountUp(node.value, motionOn);
  return (
    <div className="flex flex-col gap-1">
      {(node.label || node.label === '') && (
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>{node.label}</span>
          <span className="tabular-nums">{Math.round(value)}%</span>
        </div>
      )}
      <Progress value={value} />
    </div>
  );
}

/** `image` node — a bounded image with optional caption (https/data sources only). */
export function ImageNode({ node }: { node: NodeOf<'image'> }) {
  return (
    <figure className="flex flex-col gap-1">
      <img
        src={node.src}
        alt={node.alt}
        className="max-h-80 w-full rounded-md border object-contain"
        loading="lazy"
      />
      {node.caption && (
        <figcaption className="text-muted-foreground text-xs">{node.caption}</figcaption>
      )}
    </figure>
  );
}
