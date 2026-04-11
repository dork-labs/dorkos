import type { SessionBorderKind } from '@/layers/entities/session';
import { cn } from '@/layers/shared/lib';

interface AgentActivityBadgeProps {
  status: SessionBorderKind;
  label: string;
}

/** Dot color mapping — idle returns null (no dot rendered). */
const DOT_COLOR: Record<SessionBorderKind, string | null> = {
  streaming: 'bg-green-500',
  active: 'bg-green-500',
  pendingApproval: 'bg-amber-500',
  error: 'bg-destructive',
  unseen: 'bg-blue-500',
  idle: null,
};

/**
 * Compact dot badge showing aggregate agent activity status.
 *
 * Renders a 6px (`size-1.5`) colored dot. Returns null when idle.
 * Designed for the dashboard sidebar agent row — visible even when
 * the agent is collapsed.
 */
export function AgentActivityBadge({ status, label }: AgentActivityBadgeProps) {
  const colorClass = DOT_COLOR[status];
  if (!colorClass) return null;

  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', colorClass)}
      role="status"
      aria-label={label}
    />
  );
}
