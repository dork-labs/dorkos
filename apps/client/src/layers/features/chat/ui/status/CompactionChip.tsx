import { motion } from 'motion/react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface CompactionChipProps {
  /** Live context-usage percent to show in the copy (e.g. `82`). */
  percent: number;
  /** True while the dispatch is in flight — disables the button and spins the icon. */
  pending: boolean;
  /** Fire the compact intent. */
  onClick: () => void;
}

/**
 * Quiet, one-click nudge shown in the chat status area once context usage
 * nears the ceiling (DOR-112). Dispatches the same `compact` command intent
 * as the `/compact` palette entry — visibility and dispatch are owned by
 * {@link import('../../model/status/use-compaction-chip').useCompactionChip};
 * this component is presentation-only.
 *
 * Styled as a quiet secondary chip (matching `ShortcutChips`), not an alarm —
 * `ContextItem`'s amber/red badge already carries the warning color; this is
 * the calm follow-up action, not a second warning.
 */
export function CompactionChip({ percent, pending, onClick }: CompactionChipProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-label={pending ? 'Compacting conversation…' : `Context ${percent}% full — compact now`}
      aria-busy={pending}
      data-testid="compaction-chip"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <RefreshCw aria-hidden="true" className={cn('size-3 shrink-0', pending && 'animate-spin')} />
      <span className="truncate">
        Context {percent}% full — <span className="font-medium">Compact now</span>
      </span>
    </motion.button>
  );
}
