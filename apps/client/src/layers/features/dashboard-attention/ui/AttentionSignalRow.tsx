import { motion } from 'motion/react';
import { AlertTriangle, CircleHelp } from 'lucide-react';
import { useRouter } from '@tanstack/react-router';
import type { AttentionSignal } from '@/layers/entities/attention';
import { Button } from '@/layers/shared/ui';
import { cn, formatCompactAge } from '@/layers/shared/lib';

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
} as const;

/** What {@link AttentionSignalRow} draws. */
export interface AttentionSignalRowProps {
  /** The signal, straight from `entities/attention`. */
  signal: AttentionSignal;
}

/**
 * One blockage from the attention engine, as a row.
 *
 * Deliberately plain: the signal carries facts and nothing about how to draw
 * them (no icon, no colour, no relative time), so the choice of all three is
 * made here. On the home surface the only kind that reaches this row is
 * `error` — a session that stopped — because permission prompts and questions
 * get a full card in "Waiting On You" instead. The phone's Home also hands it a
 * session blocked on a prompt that has not reached the pending list yet, which
 * is waiting rather than broken, so it draws in the needs-you amber.
 *
 * Navigation goes through the router's `href` form rather than a typed route,
 * because a signal's deep link is a string the engine built and this row has no
 * business taking it apart again. It does NOT `recordOpened` on the way, which
 * is deliberate: a wedged session is something you clear, not something you
 * were working on, so it must not move up ⌘K's recent list. The Recent-Activity
 * rows beside this one do record, because those really are doors into work.
 *
 * @param props - The {@link AttentionSignalRowProps.signal} to draw.
 */
export function AttentionSignalRow({ signal }: AttentionSignalRowProps) {
  const router = useRouter();
  const relativeTime = formatCompactAge(signal.since);
  const broken = signal.kind === 'error';
  const Icon = broken ? AlertTriangle : CircleHelp;

  return (
    <motion.div
      variants={staggerItem}
      data-slot="attention-signal-row"
      className="hover:bg-accent/50 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1 transition-colors"
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          broken ? 'bg-status-error' : 'bg-status-warning'
        )}
        aria-hidden
      />
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          broken ? 'text-status-error/70' : 'text-status-warning-fg'
        )}
        aria-hidden
      />
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
        onClick={() => void router.navigate({ href: signal.deepLink })}
      >
        Open →
      </Button>
    </motion.div>
  );
}
