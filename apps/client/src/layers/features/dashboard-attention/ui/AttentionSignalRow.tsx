import { motion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import { useRouter } from '@tanstack/react-router';
import type { AttentionSignal } from '@/layers/entities/attention';
import { Button } from '@/layers/shared/ui';
import { formatRelativeTime } from '../lib/format-relative-time';

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
} as const;

/** What {@link AttentionSignalRow} draws. */
export interface AttentionSignalRowProps {
  /** The signal, straight from `entities/attention`. */
  signal: AttentionSignal;
  /** Called after the row is opened, e.g. to close a popover. */
  onOpened?: () => void;
}

/**
 * One blockage from the attention engine, as a row.
 *
 * Deliberately plain: the signal carries facts and nothing about how to draw
 * them (no icon, no colour, no relative time), so the choice of all three is
 * made here. Today the only kind that reaches this row is `error` — a session
 * that stopped — because permission prompts and questions get a full card in
 * "Waiting On You" instead.
 *
 * Navigation goes through the router's `href` form rather than a typed route,
 * because a signal's deep link is a string the engine built and this row has no
 * business taking it apart again.
 *
 * @param props - The {@link AttentionSignalRowProps.signal} and an optional
 * {@link AttentionSignalRowProps.onOpened} callback.
 */
export function AttentionSignalRow({ signal, onOpened }: AttentionSignalRowProps) {
  const router = useRouter();
  const relativeTime = formatRelativeTime(signal.since);

  return (
    <motion.div
      variants={staggerItem}
      data-slot="attention-signal-row"
      className="hover:bg-accent/50 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1 transition-colors"
    >
      <span className="bg-status-error size-1.5 shrink-0 rounded-full" aria-hidden />
      <AlertTriangle className="text-status-error/70 size-3.5 shrink-0" aria-hidden />
      <span className="text-foreground/90 min-w-0 flex-1 truncate text-xs">
        {signal.primary}
        {signal.secondary !== undefined && (
          <span className="text-muted-foreground"> · {signal.secondary}</span>
        )}
      </span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{relativeTime}</span>
      <Button
        variant="ghost"
        size="sm"
        className="relative h-6 shrink-0 px-2 text-xs after:absolute after:-inset-3 md:after:hidden"
        aria-label={`Open ${signal.primary}`}
        onClick={() => {
          void router.navigate({ href: signal.deepLink });
          onOpened?.();
        }}
      >
        Open →
      </Button>
    </motion.div>
  );
}
