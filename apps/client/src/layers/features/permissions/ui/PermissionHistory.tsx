import { usePermissionHistory } from '@/layers/entities/permissions';
import { formatRelativeTime } from '@/layers/shared/lib';
import { Skeleton } from '@/layers/shared/ui';

/** Props for {@link PermissionHistory}. */
export interface PermissionHistoryProps {
  /** Narrow to the changes that touched one agent. */
  agentId?: string;
}

/**
 * The permission history, newest first: what changed, who changed it, and
 * when. Read-only; a login-off change says why it cannot name who made it.
 *
 * @param props - See {@link PermissionHistoryProps}.
 */
export function PermissionHistory({ agentId }: PermissionHistoryProps) {
  const { data, isPending } = usePermissionHistory(agentId);
  if (isPending) return <Skeleton className="h-12 w-full" />;
  const items = data?.items ?? [];
  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">No permission changes yet.</p>;
  }
  return (
    <ul className="space-y-3" aria-label="Permission history">
      {items.map((item) => (
        <li key={item.id} className="space-y-0.5">
          <p className="text-sm">{item.summary}</p>
          <p className="text-muted-foreground text-xs">
            {item.actorLabel} · {formatRelativeTime(item.occurredAt)}
          </p>
          {item.actorDetail ? (
            <p className="text-muted-foreground text-xs">{item.actorDetail}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
