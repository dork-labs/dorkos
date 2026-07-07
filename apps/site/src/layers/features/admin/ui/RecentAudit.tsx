import type { AuditEntryView } from '@/lib/audit-service';

/** Humanize a dotted audit action name, e.g. `admin.ban_user` → `ban user`. */
function humanizeAction(action: string): string {
  return action
    .replace(/^admin\./, '')
    .replace(/^account\./, '')
    .replace(/[._]/g, ' ');
}

/**
 * Read-only panel of the most recent audit-log entries, so an operator can see
 * (and self-verify) what admin actions and self-serve deletions have happened.
 * Presentational — the rows are fetched server-side and passed in.
 *
 * @param props.entries - Recent audit entries, newest first.
 */
export function RecentAudit({ entries }: { entries: AuditEntryView[] }) {
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">No activity recorded yet.</p>;
  }
  return (
    <ul className="flex flex-col">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-col gap-0.5 border-b py-2 text-sm last:border-b-0">
          <span>
            <span className="font-medium">{humanizeAction(e.action)}</span>
            {e.targetUserId ? (
              <span className="text-muted-foreground"> · target {e.targetUserId.slice(0, 8)}…</span>
            ) : null}
            {e.reason ? <span className="text-muted-foreground"> · {e.reason}</span> : null}
          </span>
          <span className="text-muted-foreground text-xs">
            by {e.actorUserId === 'unknown' ? 'unknown' : `${e.actorUserId.slice(0, 8)}…`} ·{' '}
            {new Date(e.createdAt).toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
