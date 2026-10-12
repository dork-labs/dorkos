import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';

/**
 * One connection as the Community navigation describes it: which state its membership is in,
 * whether it is reachable, and its counts.
 *
 * @param connection - The connection, as the local server reported it.
 */
export function navigationDescriptor(connection: CommunityConnectionDescriptor) {
  const lifecycle = connection.access?.lastKnown?.lifecycle;
  return {
    kind: 'community',
    key: `community:${connection.ref}`,
    ref: connection.ref,
    remoteCommunityId: connection.remoteCommunityId,
    label: connection.label,
    icon: { kind: 'community', ref: connection.ref },
    pinnedOrigin: connection.pinnedOrigin,
    membershipState:
      lifecycle === 'deletion_pending'
        ? 'deletion-pending'
        : lifecycle === 'taken_down'
          ? 'taken-down'
          : (lifecycle ?? (connection.status === 'pending' ? 'pending' : 'active')),
    connectionState: connection.status,
    availability:
      connection.access?.state === 'verified'
        ? 'online'
        : connection.access?.state === 'unverified'
          ? 'offline'
          : 'unknown',
    unreadCount: connection.attention?.unreadCount ?? null,
    mentionCount: connection.attention?.mentionCount ?? null,
  };
}

/**
 * The few words a Community's row in the switcher says about its state, or nothing when it is
 * simply there. Reconnecting comes first, since it is the one thing the person can act on; "seems
 * to be gone" never overrides what the Community actually said (deleted, or taken down).
 *
 * @param connection - The connection, as the local server reported it.
 */
export function communityRowState(connection: CommunityConnectionDescriptor): string | undefined {
  if (connection.status === 'reconnect-required') return 'Reconnect required';
  const lifecycle = connection.access?.lastKnown?.lifecycle;
  if (connection.seemsGoneSince && lifecycle !== 'deleted' && lifecycle !== 'taken_down')
    return 'Seems to be gone';
  const descriptor = navigationDescriptor(connection);
  if (descriptor.membershipState !== 'active') return descriptor.membershipState.replace('-', ' ');
  if (descriptor.availability !== 'online') return descriptor.availability;
  return undefined;
}

/**
 * The connections in the owner's saved order; anything the order does not name follows, by name.
 *
 * @param connections - The connections to order.
 * @param order - The owner's saved order of refs.
 */
export function orderedConnections(
  connections: readonly CommunityConnectionDescriptor[],
  order: readonly string[]
): CommunityConnectionDescriptor[] {
  const rank = new Map(order.map((ref, index) => [ref, index]));
  return [...connections].sort((left, right) => {
    const leftRank = rank.get(left.ref) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.ref) ?? Number.MAX_SAFE_INTEGER;
    return (
      leftRank - rightRank ||
      left.label.localeCompare(right.label) ||
      left.ref.localeCompare(right.ref)
    );
  });
}

/**
 * The text with its first letter lower-cased, to sit mid-sentence.
 *
 * @param text - The text to lower.
 */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
