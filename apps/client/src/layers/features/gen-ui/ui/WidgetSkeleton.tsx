import { motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { useWidgetMotion } from '../lib/widget-motion';

/** Seconds for one shimmer sweep to travel across the skeleton. */
const SHIMMER_DURATION = 1.6;

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
          // A shimmer is a light reflection, so the sheen is literal white (not
          // a theme token — a foreground-based band reads as a moving shadow in
          // light mode). Skewed and soft-edged like a glint; alpha is tuned per
          // theme so it stays subtle on both white and near-black cards.
          className="pointer-events-none absolute inset-y-0 left-0 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/50 to-transparent dark:via-white/[0.06]"
          initial={{ x: '-150%' }}
          animate={{ x: '350%' }}
          transition={{
            duration: SHIMMER_DURATION,
            ease: 'linear',
            repeat: Infinity,
            repeatDelay: 0.4,
          }}
        />
      )}
    </div>
  );
}
