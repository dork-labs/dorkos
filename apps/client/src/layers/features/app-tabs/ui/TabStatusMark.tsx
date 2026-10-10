import { cn } from '@/layers/shared/lib';
import {
  statusDotClass,
  STATUS_TONE_DOT,
  STATUS_TONE_SURFACE,
  type StatusSignal,
} from '@/layers/shared/ui';
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

/** Counts above this read as `99+`, so a badge never outgrows its tab. */
const MAX_COUNT = 99;

interface TabStatusMarkProps {
  /** The identity whose status or count to draw. */
  identity: Pick<TabIdentity, 'status' | 'count' | 'countEmphasis'>;
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
    return (
      <span
        aria-hidden="true"
        data-slot="tab-count"
        className={cn(
          'shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-medium tabular-nums',
          // Aimed at you: a solid fill, so it reads as urgent at a glance in
          // both themes, red for a failure as its dot would be. The quiet tint
          // is for counts that are only activity.
          identity.countEmphasis
            ? `${status === 'failed' ? STATUS_TONE_DOT.error : STATUS_TONE_DOT.warning} text-background`
            : STATUS_TONE_SURFACE.neutral,
          className
        )}
      >
        {count > MAX_COUNT ? `${MAX_COUNT}+` : count}
      </span>
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
