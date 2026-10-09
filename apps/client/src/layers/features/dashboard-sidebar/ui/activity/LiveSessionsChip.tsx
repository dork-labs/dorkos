/**
 * The "N live" chip on an agent row.
 *
 * @module features/dashboard-sidebar/ui/activity/LiveSessionsChip
 */
import { cn } from '@/layers/shared/lib';
import { statusDotClass } from '@/layers/shared/ui';

/**
 * The "N live" chip — the agent row's door into Switch session, and the mark
 * that says why the door is there.
 *
 * Its own module because it is drawn TWICE on one row and must be the same
 * width both times: once invisibly, inside the row's trailing slot, to reserve
 * the space, and once for real in the button that sits over it. See
 * `AgentListItem`.
 *
 * @param props - How many of the agent's chats are live.
 */
export function LiveSessionsChip({ count }: { count: number }) {
  return (
    <span className="bg-status-success/15 text-status-success text-3xs flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold tabular-nums">
      <span className={cn('size-1.5 rounded-full', statusDotClass('working'))} />
      {count} live
    </span>
  );
}
