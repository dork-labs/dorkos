/**
 * Purge mirrored copies whose connection no longer exists (DOR-2334).
 *
 * Disconnecting a Community runs the revoke-and-purge path before the credential goes, but two
 * kinds of copy can still outlive their connection: one whose purge failed during a disconnect
 * (the disconnect completes anyway, so a credential is never kept), and every copy left by a
 * disconnect made before disconnecting purged at all. Nothing reaches a copy with no connection
 * behind it — no access check, no stream, no redaction feed — so it would stay forever. This runs
 * once at startup and hands each such connection to the same revoke path.
 *
 * **Fail closed, because this deletes.** It sweeps only when the connection list positively
 * loaded: a missing, unreadable or invalid file sweeps nothing, since "could not read the
 * connections" must never read as "there are none". And it never touches a copy whose
 * connection still exists, in any state: those are the access check's to decide.
 *
 * @module services/communities/remote/orphaned-mirror-sweep
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../lib/logger.js';
import type { RemoteConnectionStore } from './connection-store.js';
import type { RemoteMirrorStore } from './mirror-store.js';

/** One owner's connection to one Community. */
interface OwnerConnection {
  communityRef: CommunityRef;
  ownerAuthorId: string;
}

/** What the sweep reads and calls. */
export interface OrphanedMirrorSweepDeps {
  mirrors: Pick<RemoteMirrorStore, 'mirroredConnections'>;
  /** Every connection record, or `null` when there is no connection list to read. */
  connections: () => Promise<readonly OwnerConnection[] | null>;
  /** The full revoke-and-purge path for one owner's connection. */
  revoke: (communityRef: CommunityRef, ownerAuthorId: string) => Promise<void>;
}

/**
 * The sweep as production wires it, over the real connection store.
 *
 * @param store - The encrypted connection store whose file lists every connection.
 * @param mirrors - The mirror store.
 * @param revoke - The subscription runtime's `revokeConnection`.
 */
export function orphanedMirrorSweepDeps(
  store: Pick<RemoteConnectionStore, 'connectionsIfLoaded'>,
  mirrors: OrphanedMirrorSweepDeps['mirrors'],
  revoke: OrphanedMirrorSweepDeps['revoke']
): OrphanedMirrorSweepDeps {
  return { mirrors, connections: () => store.connectionsIfLoaded(), revoke };
}

const keyOf = (connection: OwnerConnection) =>
  `${connection.communityRef}\0${connection.ownerAuthorId}`;

/**
 * Revoke and purge every mirrored connection with no connection record. Never throws: a failure
 * is logged, and the next start tries again.
 *
 * @returns How many connections' copies were handed to the revoke path.
 */
export async function sweepOrphanedMirrors(deps: OrphanedMirrorSweepDeps): Promise<number> {
  const mirrored = deps.mirrors.mirroredConnections();
  if (mirrored.length === 0) return 0;
  let present: readonly OwnerConnection[] | null;
  try {
    present = await deps.connections();
  } catch (error) {
    logger.warn('[communities] could not read the connection list; left every copy in place', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
  if (present === null) {
    logger.warn('[communities] no connection list to check copies against; left them in place');
    return 0;
  }
  const known = new Set(present.map(keyOf));
  let swept = 0;
  for (const connection of mirrored) {
    if (known.has(keyOf(connection))) continue;
    try {
      await deps.revoke(connection.communityRef, connection.ownerAuthorId);
      swept += 1;
    } catch (error) {
      logger.warn('[communities] could not remove the copies of a disconnected community', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return swept;
}
