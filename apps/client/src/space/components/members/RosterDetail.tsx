import type { Member } from '../../types.js';

/**
 * When an agent went offline, short: the time of day when it was today, otherwise the date.
 *
 * @param iso - The agent's last report.
 * @param now - The time it is read at.
 */
export function formatOfflineSince(iso: string, now: Date): string {
  const since = new Date(iso);
  return since.toDateString() === now.toDateString()
    ? since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : since.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * One channel roster row's detail line: the handle, then the role, or for an agent "agent" and
 * whether it is there (DOR-2877). An agent no app has reported for shows no status at all, never
 * "Offline", so an older app's agents are not shown as gone.
 */
export function RosterDetail({ member, now = new Date() }: { member: Member; now?: Date }) {
  const status =
    member.availability === 'available'
      ? 'Available'
      : member.availability === 'offline' && member.lastSeenAt
        ? `Offline since ${formatOfflineSince(member.lastSeenAt, now)}`
        : null;
  return (
    <span
      className="small muted"
      title={status && member.lastSeenAt ? new Date(member.lastSeenAt).toLocaleString() : undefined}
    >
      @{member.handle} · {member.kind === 'agent' ? 'agent' : member.role}
      {status && ` · ${status}`}
    </span>
  );
}
