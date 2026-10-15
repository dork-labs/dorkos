/**
 * Whether an agent in a space channel is there, in words (DOR-2878).
 *
 * @module widgets/room-view/lib/remote-agent-availability
 */
import type { RemoteCommunityMember } from '@dorkos/shared/community-views';

/** What a roster row says about an agent being there, and the exact time behind it. */
export interface RemoteAgentAvailabilityLabel {
  /** "Available", or "Offline since 3:04 PM". */
  text: string;
  /** The last report's full date and time, for the row's hover; absent when there is none. */
  title?: string;
}

/**
 * When an agent went offline, short: the time of day when it was today, otherwise the date.
 *
 * @param iso - The agent's last report.
 * @param now - The time it is read at.
 */
function formatSince(iso: string, now: Date): string {
  const since = new Date(iso);
  return since.toDateString() === now.toDateString()
    ? since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : since.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
  const title = member.lastSeenAt ? new Date(member.lastSeenAt).toLocaleString() : undefined;
  if (member.availability === 'available') return { text: 'Available', title };
  if (member.availability === 'offline' && member.lastSeenAt)
    return { text: `Offline since ${formatSince(member.lastSeenAt, now)}`, title };
  return null;
}
