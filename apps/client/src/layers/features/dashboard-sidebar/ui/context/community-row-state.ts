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
