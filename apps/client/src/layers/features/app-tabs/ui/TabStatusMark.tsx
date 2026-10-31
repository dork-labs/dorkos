import { cn } from '@/layers/shared/lib';
import { CountPill, statusDotClass, type StatusSignal } from '@/layers/shared/ui';
import type { TabIdentity, TabStatus } from '../lib/tab-identity';

/**
 * The dot each tab status wears. The colours and the motion come from the
 * shared token map, so a tab cannot drift from the sidebar row saying the same
 * thing one pane away. Only `working` moves.
 */
export const TAB_STATUS_SIGNAL: Record<TabStatus, StatusSignal> = {
  'needs-you': 'needs-you',
  failed: 'error',
  paused: 'paused',
  working: 'working',
  new: 'unseen',
};

interface TabStatusMarkProps {
  /** The identity whose status or count to draw. */
  identity: Pick<TabIdentity, 'status' | 'count' | 'countTone'>;
  /** Extra classes for the mark. */
  className?: string;
}

/**
 * One mark at most: a count badge when the page has a count, else a status
 * dot, else nothing. Decoration only: the tab's accessible name carries the
 * same fact in words, so colour is never the only signal.
 */
export function TabStatusMark({ identity, className }: TabStatusMarkProps) {
  const { count, status } = identity;
  if (count !== undefined && count > 0) {
    // No label: the tab's accessible name already says the count in words.
    // Capped at 99+ so a count never outgrows its tab.
    return (
      <CountPill
        data-slot="tab-count"
        count={count}
        tone={identity.countTone ?? 'neutral'}
        className={className}
      />
    );
  }
  if (!status) return null;
  return (
    <span
      aria-hidden="true"
      data-slot="tab-status"
      data-status={status}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        statusDotClass(TAB_STATUS_SIGNAL[status]),
        className
      )}
    />
  );
}
