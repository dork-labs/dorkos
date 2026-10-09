import type { SessionBorderKind } from '@/layers/entities/session';
import { cn } from '@/layers/shared/lib';
import { statusDotClass, type StatusSignal } from '@/layers/shared/ui';

interface AgentActivityBadgeProps {
  status: SessionBorderKind;
  label: string;
}

/**
 * How a session's border kind reads as a dot. `idle` is absent on purpose —
 * a row with nothing to report shows nothing, which is what makes the rows
 * that do report mean something.
 *
 * The colours themselves live in the shared token map, not here: this dot said
 * `bg-green-500` while the tab strip said the same thing in the same green and
 * a room row said it in `bg-status-success`, and one fact wearing three
 * spellings is one that drifts the first time either theme moves.
 */
const DOT_SIGNAL: Partial<Record<SessionBorderKind, StatusSignal>> = {
  streaming: 'working',
  pendingApproval: 'needs-you',
  error: 'error',
  unseen: 'unseen',
};

/**
 * Compact dot badge showing aggregate agent activity status.
 *
 * Renders a 6px (`size-1.5`) colored dot. Returns null when idle.
 * Designed for the dashboard sidebar agent row — visible even when
 * the agent is collapsed.
 *
 * Only the streaming dot moves ({@link statusDotClass}): an agent mid-turn is
 * an event, an agent waiting on you is a state, and a state that pulsed would
 * claim to still be going.
 */
export function AgentActivityBadge({ status, label }: AgentActivityBadgeProps) {
  const signal = DOT_SIGNAL[status];
  if (!signal) return null;

  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(signal))}
      role="status"
      aria-label={label}
    />
  );
}
