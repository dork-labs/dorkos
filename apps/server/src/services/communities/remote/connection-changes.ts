/**
 * What a committed connection write tells its listeners, and what a stored connection's access
 * reads as, beside `connection-store.ts`, which owns the records.
 *
 * @module services/communities/remote/connection-changes
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import {
  CommunityConnectionAccessSchema,
  type CommunityConnectionAccess,
} from '@dorkos/shared/community-wire';

/** Where one connection points, by its local ref: enough to decide whether it is official. */
export interface ConnectionPlace {
  /** The local connection ref. */
  ref: CommunityRef;
  /** The origin the connection is pinned to. */
  pinnedOrigin: string;
  /** The community id discovery returned at pairing. */
  remoteCommunityId: string;
}

/**
 * The place a stored connection points at.
 *
 * @param record - The stored connection.
 */
export function placeOf({
  ref,
  pinnedOrigin,
  remoteCommunityId,
}: ConnectionPlace): ConnectionPlace {
  return { ref, pinnedOrigin, remoteCommunityId };
}

/** Where a stored connection is. */
type ConnectionStatus = 'pending' | 'connected' | 'reconnect-required';

/** The fields of a stored connection a change names. */
interface ChangedRecord {
  ownerKey: string;
  ref: CommunityRef;
  pinnedOrigin: string;
  remoteCommunityId: string;
}

/**
 * Whether a connection points at the official space, judged against the link configured now.
 * Never stored: a connection keeps only its pinned origin and community id.
 */
export type OfficialConnectionPredicate = (place: {
  pinnedOrigin: string;
  remoteCommunityId: string;
}) => boolean;

/**
 * One committed change to an owner's connection list, told in-process only.
 *
 * `status` is where the row ended up; `removed` means the row is gone. Only
 * the list's shape counts — a row appearing, changing status or disappearing.
 * An access re-verification ({@link RemoteConnectionStore.updateAccess}) is
 * deliberately not a change: listing verifies every row, so announcing it
 * would make every list read ask every window to list again.
 */
export interface RemoteConnectionChange {
  /** The local owner whose list changed. */
  ownerKey: string;
  /** The connection that changed. */
  ref: CommunityRef;
  /** Where the connection is now. */
  status: ConnectionStatus | 'removed';
  /** The origin the connection is pinned to, so a listener can tell the official one. */
  pinnedOrigin: string;
  /** The community id discovery returned at pairing. */
  remoteCommunityId: string;
}

/**
 * Subscriber to {@link RemoteConnectionStore.onChange}: called once per
 * committed write, with every change that write made (never empty).
 */
export type RemoteConnectionChangeListener = (changes: readonly RemoteConnectionChange[]) => void;

/**
 * One {@link RemoteConnectionChange}, from the record the write touched.
 *
 * @param record - The record the write touched.
 * @param status - Where the record ended up.
 */
export function change(
  record: ChangedRecord,
  status: RemoteConnectionChange['status']
): RemoteConnectionChange {
  return {
    ownerKey: record.ownerKey,
    ref: record.ref,
    status,
    pinnedOrigin: record.pinnedOrigin,
    remoteCommunityId: record.remoteCommunityId,
  };
}

/** The access a connection has while it is pending or must reconnect: none at all. */
export const noEffectiveAccess = {
  read: false,
  post: false,
  enrollAgent: false,
  stream: false,
} as const;

/**
 * What a connection's access reads as to the browser: nothing while pending, no access while it
 * must reconnect, and unverified until a check has answered.
 *
 * @param record - The stored connection.
 */
export function projectedAccess(record: {
  status: ConnectionStatus;
  access?: CommunityConnectionAccess | null;
}): CommunityConnectionAccess | null {
  if (record.status === 'pending') return null;
  if (record.status === 'reconnect-required') {
    return CommunityConnectionAccessSchema.parse({
      state: 'reconnect-required',
      effective: noEffectiveAccess,
      lastKnown: record.access?.lastKnown ?? null,
    });
  }
  return (
    record.access ??
    CommunityConnectionAccessSchema.parse({
      state: 'unverified',
      effective: noEffectiveAccess,
      lastKnown: null,
    })
  );
}
