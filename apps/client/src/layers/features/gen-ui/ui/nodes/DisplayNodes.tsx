import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { MarkdownContent, Progress, Separator } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { toneBadgeClass } from '../../lib/widget-tone';

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

/** `text` node — inline markdown via the shared markdown pipeline (no raw HTML). */
export function TextNode({ node }: { node: NodeOf<'text'> }) {
  return <MarkdownContent content={node.text} className="text-sm" />;
}

/** `badge` node — a toned pill. */
export function BadgeNode({ node }: { node: NodeOf<'badge'> }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-md border px-2 py-0.5 text-xs font-medium',
        toneBadgeClass(node.tone)
      )}
    >
      {node.text}
    </span>
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

/** `stat` node — a labelled metric with an optional delta and hint. */
export function StatNode({ node }: { node: NodeOf<'stat'> }) {
  const DeltaIcon = node.delta ? DELTA_ICON[node.delta.direction] : null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs font-medium">{node.label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-foreground text-2xl font-semibold tabular-nums">{node.value}</span>
        {node.delta && DeltaIcon && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium',
              DELTA_CLASS[node.delta.direction]
            )}
          >
            <DeltaIcon className="size-3" aria-hidden />
            {node.delta.value}
          </span>
        )}
      </div>
      {node.hint && <span className="text-muted-foreground text-xs">{node.hint}</span>}
    </div>
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

/** `progress` node — a labelled determinate progress bar. */
export function ProgressNode({ node }: { node: NodeOf<'progress'> }) {
  return (
    <div className="flex flex-col gap-1">
      {(node.label || node.label === '') && (
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>{node.label}</span>
          <span className="tabular-nums">{Math.round(node.value)}%</span>
        </div>
      )}
      <Progress value={node.value} />
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
