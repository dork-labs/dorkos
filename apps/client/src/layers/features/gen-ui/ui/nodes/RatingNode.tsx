import { motion } from 'motion/react';
import { Star } from 'lucide-react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { cn } from '@/layers/shared/lib';
import { useWidgetMotion, WIDGET_SPRING } from '../../lib/widget-motion';

type RatingNodeData = Extract<WidgetNode, { type: 'rating' }>;

const STAR_COUNT = 5;
const STARS = Array.from({ length: STAR_COUNT });

/** A row of five stars, sharing sizing between the base and filled overlay. */
function StarRow({ className }: { className: string }) {
  return (
    <div className="flex" aria-hidden>
      {STARS.map((_, i) => (
        <Star key={i} className={cn('size-4', className)} />
      ))}
    </div>
  );
}

/**
 * `rating` node — five stars with a fractional fill overlay, plus the numeric
 * value and an optional review count and label. The fill is a clipped overlay of
 * filled stars sized to `value/5`, so half-stars read exactly.
 */
export function RatingNode({ node }: { node: RatingNodeData }) {
  const motionOn = useWidgetMotion();
  const fillPct = (node.value / STAR_COUNT) * 100;
  return (
    <motion.div
      className="flex items-center gap-2"
      initial={motionOn ? { opacity: 0, y: 4 } : false}
      animate={motionOn ? { opacity: 1, y: 0 } : false}
      transition={WIDGET_SPRING}
    >
      <div
        className="relative w-fit"
        role="img"
        aria-label={`Rated ${node.value.toFixed(1)} out of ${STAR_COUNT}`}
      >
        <StarRow className="text-muted-foreground" />
        <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${fillPct}%` }}>
          <StarRow className="fill-status-warning text-status-warning" />
        </div>
      </div>
      <span className="text-foreground text-sm font-medium tabular-nums">
        {node.value.toFixed(1)}
      </span>
      {node.count !== undefined && (
        <span className="text-muted-foreground text-sm tabular-nums">
          ({node.count.toLocaleString()})
        </span>
      )}
      {node.label && <span className="text-muted-foreground text-sm">{node.label}</span>}
    </motion.div>
  );
}
