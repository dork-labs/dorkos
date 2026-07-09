import { motion } from 'motion/react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { cn } from '@/layers/shared/lib';
import { resolveWidgetIcon } from '../../lib/widget-icon';
import { useWidgetMotion, widgetEntrance, widgetStaggerContainer } from '../../lib/widget-motion';

type TimelineNodeData = Extract<WidgetNode, { type: 'timeline' }>;
type TimelineItem = TimelineNodeData['items'][number];
type TimelineStatus = NonNullable<TimelineItem['status']>;

/** Dot styling per status; `upcoming`/undefined share the hollow, muted look. */
const DOT_CLASS: Record<TimelineStatus, string> = {
  done: 'border-status-success bg-status-success text-status-success-fg',
  active: 'border-primary bg-primary text-primary-foreground',
  upcoming: 'border-border bg-background text-muted-foreground',
};

/**
 * `timeline` node — a vertical rail of events. Each item pairs a status dot (with
 * a connecting segment to the next) with a time/title/subtitle stack; items
 * cascade in. An `active` dot gets a soft pulsing ring, gated on reduced motion.
 */
export function TimelineNode({ node }: { node: TimelineNodeData }) {
  const motionOn = useWidgetMotion();
  return (
    <motion.ol
      className="flex flex-col"
      variants={motionOn ? widgetStaggerContainer : undefined}
      initial={motionOn ? 'hidden' : false}
      animate={motionOn ? 'visible' : false}
    >
      {node.items.map((item, i) => {
        const status: TimelineStatus = item.status ?? 'upcoming';
        const isLast = i === node.items.length - 1;
        const Icon = item.icon ? resolveWidgetIcon(item.icon) : null;
        return (
          <motion.li
            key={i}
            className="flex gap-3"
            variants={motionOn ? widgetEntrance : undefined}
          >
            <div className="flex flex-col items-center">
              <span className="relative flex size-5 shrink-0 items-center justify-center">
                {status === 'active' && motionOn && (
                  <motion.span
                    className="border-primary absolute inset-0 rounded-full border"
                    initial={{ opacity: 0.6, scale: 1 }}
                    animate={{ opacity: 0, scale: 1.8 }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                    aria-hidden
                  />
                )}
                <span
                  className={cn(
                    'flex size-3 items-center justify-center rounded-full border',
                    DOT_CLASS[status],
                    status === 'active' && 'ring-primary/30 ring-2'
                  )}
                >
                  {Icon && <Icon className="size-2.5" aria-hidden />}
                </span>
              </span>
              {!isLast && <span className="bg-border w-px flex-1" aria-hidden />}
            </div>
            <div className={cn('min-w-0 flex-1', !isLast && 'pb-4')}>
              {item.time && (
                <p className="text-muted-foreground text-xs tabular-nums">{item.time}</p>
              )}
              <p
                className={cn(
                  'text-foreground text-sm',
                  status === 'active' ? 'font-semibold' : 'font-medium'
                )}
              >
                {item.title}
              </p>
              {item.subtitle && <p className="text-muted-foreground text-xs">{item.subtitle}</p>}
            </div>
          </motion.li>
        );
      })}
    </motion.ol>
  );
}
