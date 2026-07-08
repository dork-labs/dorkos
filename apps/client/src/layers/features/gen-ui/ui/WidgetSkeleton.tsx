import { motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { useWidgetMotion, WIDGET_EASE_OUT } from '../lib/widget-motion';

/** Seconds for one shimmer sweep to travel across the skeleton. */
const SHIMMER_DURATION = 1.5;

/** A single muted placeholder bar. */
function Bar({ className }: { className?: string }) {
  return <div className={cn('bg-muted rounded-md', className)} />;
}

/**
 * D3 loading state: shown while a `dorkos-ui` fence is still streaming. Rather
 * than three flat bars, it sketches the silhouette of a card (icon + title,
 * body lines, a content block) with a light shimmer sweeping across — so the
 * wait reads as "a widget is composing", not "something is broken". Under
 * reduced motion the sweep is dropped and the silhouette holds still.
 */
export function WidgetSkeleton() {
  const motionOn = useWidgetMotion();
  return (
    <div
      className="bg-card shadow-soft relative flex flex-col gap-3 overflow-hidden rounded-lg border p-4"
      aria-busy="true"
      aria-label="Loading widget"
    >
      <div className="flex items-center gap-2.5">
        <Bar className="size-8 rounded-lg" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Bar className="h-3.5 w-1/3" />
          <Bar className="h-2.5 w-1/2" />
        </div>
      </div>
      <Bar className="h-2.5 w-full" />
      <Bar className="h-2.5 w-5/6" />
      <Bar className="h-16 w-full" />

      {motionOn && (
        <motion.div
          aria-hidden
          className="via-foreground/[0.06] pointer-events-none absolute inset-y-0 left-0 w-2/3 bg-gradient-to-r from-transparent to-transparent"
          initial={{ x: '-120%' }}
          animate={{ x: '220%' }}
          transition={{
            duration: SHIMMER_DURATION,
            ease: WIDGET_EASE_OUT,
            repeat: Infinity,
            repeatDelay: 0.35,
          }}
        />
      )}
    </div>
  );
}
