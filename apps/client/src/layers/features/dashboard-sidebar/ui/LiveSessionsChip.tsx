/**
 * The "N live" chip on an agent row.
 *
 * @module features/dashboard-sidebar/ui/LiveSessionsChip
 */
import { Badge } from '@/layers/shared/ui';

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
    <Badge live size="xs">
      {count} live
    </Badge>
  );
}
