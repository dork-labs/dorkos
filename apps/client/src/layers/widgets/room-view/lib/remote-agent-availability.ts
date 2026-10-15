/**
 * Whether an agent in a space channel is there, in words (DOR-2878).
 *
 * @module widgets/room-view/lib/remote-agent-availability
 */
import type { RemoteCommunityMember } from '@dorkos/shared/community-views';

/** What a roster row says about an agent being there. */
export interface RemoteAgentAvailabilityLabel {
  /** "Available", or "Offline since" followed by {@link RemoteAgentAvailabilityLabel.since}. */
  text: string;
  /**
   * When an offline agent was last there: the machine-readable instant and the words shown.
   * Shown in full, never only on hover, so keyboard, touch and screen-reader users get it too.
   */
  since?: { dateTime: string; label: string };
}

/**
 * When an agent went offline: the time of day when it was today, otherwise the date and time,
 * with the year when it was not this year.
 *
 * @param iso - The agent's last report.
 * @param now - The time it is read at.
 */
export function formatOfflineSince(iso: string, now: Date): string {
  const since = new Date(iso);
  const time = since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (since.toDateString() === now.toDateString()) return time;
  const date = since.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(since.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/**
 * The status a roster row shows for one member, or `null` for none. Only an agent the space
 * reported on gets one: a person never does, and neither does an agent no app has reported for
 * (`unknown`) or any row from a space without availability, so an older app's agent is never
 * shown as gone.
 *
 * @param member - The roster row.
 * @param now - The time it is read at.
 */
export function remoteAgentAvailabilityLabel(
  member: Pick<RemoteCommunityMember, 'kind' | 'availability' | 'lastSeenAt'>,
  now: Date = new Date()
): RemoteAgentAvailabilityLabel | null {
  if (member.kind !== 'agent') return null;
  if (member.availability === 'available') return { text: 'Available' };
  if (member.availability === 'offline' && member.lastSeenAt)
    return {
      text: 'Offline since',
      since: {
        dateTime: new Date(member.lastSeenAt).toISOString(),
        label: formatOfflineSince(member.lastSeenAt, now),
      },
    };
  return null;
}
