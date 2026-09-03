/**
 * The Inbox's marker in the header — the pill, and nothing else.
 *
 * Split out from the bell so its states are a thing that can be drawn without a
 * server: the wired component subscribes to `/api/events` and three live
 * queries, which is exactly why the playground could never show it before.
 *
 * @module widgets/inbox-bell/ui/InboxBellPill
 */
import type { ComponentProps } from 'react';
import { motion } from 'motion/react';
import { Bell, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

/**
 * Above this the pill shows a capped "N+" rather than a growing number — the
 * exact size of a long queue is on the cards, not on a header chip.
 */
export const DISPLAY_CAP = 9;

/**
 * Which silhouette the pill wears.
 *
 * A person reads this pill by shape far more often than by its accessible name,
 * so the four states that mean genuinely different things get genuinely
 * different marks: something is blocked, something happened, trust is live,
 * trust could not be checked.
 *
 * A record rather than a function, because the pill looks the icon up during
 * render (`react-hooks/static-components`).
 */
const PILL_ICONS = {
  waiting: TriangleAlert,
  unread: Bell,
  trusted: ShieldCheck,
  untrusted: ShieldAlert,
} as const;

/** Which silhouette the pill wears. */
export type InboxBellGlyph = keyof typeof PILL_ICONS;

export interface InboxBellPillProps extends ComponentProps<typeof motion.button> {
  /**
   * Amber or neutral.
   *
   * **Amber means exactly one thing and keeps meaning it:** something is stopped
   * and waiting on a person. Unread activity, live standing permissions and a
   * failed permission read are all neutral, because spending the alarm on news
   * that is not urgent is how a marker stops being read.
   */
  tone: 'waiting' | 'neutral';
  /** The mark. */
  glyph: InboxBellGlyph;
  /** The number, capped. Omit where a count would be a sentence about nothing. */
  count?: number;
  /** The accessible name — the count and what clicking does, spelled out. */
  label: string;
  /** The word beside the number, hidden below `sm` where only the mark fits. */
  text: string;
}

/**
 * The header pill, as a picture of state.
 *
 * Hover and press are carried by CSS, not only by the motion scale: the shell's
 * `MotionConfig reducedMotion="user"` drops transform animations, and somebody
 * who asked for less motion still has to be able to see that this is a button.
 * The load-bearing part is the BORDER going 60% to full alpha — the `hover:bg-*`
 * utilities replace `bg-status-warning-bg` rather than layering over it, so they
 * only shift the fill a few values per channel. Keep the border change if you
 * tune this; the fill alone is not an affordance.
 *
 * No `AnimatePresence`: the bell unmounts the pill when everything drains, so
 * there is no exit to play, only the entrance beat saying something arrived.
 *
 * @param props - The {@link InboxBellPillProps.tone}, mark, count and words,
 * plus whatever the popover trigger cloned onto it.
 */
export function InboxBellPill({
  tone,
  glyph,
  count,
  label,
  text,
  className,
  ...rest
}: InboxBellPillProps) {
  const Glyph = PILL_ICONS[glyph];

  return (
    <motion.button
      type="button"
      data-testid="inbox-bell"
      data-tone={tone}
      aria-label={label}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
      className={cn(
        'focus-visible:ring-ring/60 flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2',
        tone === 'waiting'
          ? 'bg-status-warning-bg text-status-warning-fg border-status-warning-border/60 hover:border-status-warning-border hover:bg-status-warning-border/25 active:bg-status-warning-border/40'
          : 'text-muted-foreground border-border/60 hover:border-border hover:bg-muted active:bg-muted/70',
        className
      )}
      {...rest}
    >
      <Glyph aria-hidden className="size-3.5 shrink-0" />
      {count !== undefined && (
        <span className="tabular-nums">{count > DISPLAY_CAP ? `${DISPLAY_CAP}+` : count}</span>
      )}
      <span className="hidden sm:inline">{text}</span>
    </motion.button>
  );
}
