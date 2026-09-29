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
 * It never touches a copy whose connection still exists, in any state: those are the access
 * check's to decide.
 *
 * @module services/communities/remote/orphaned-mirror-sweep
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../lib/logger.js';
import type { RemoteMirrorStore } from './mirror-store.js';

/** What the sweep reads and calls. */
export interface OrphanedMirrorSweepDeps {
  mirrors: Pick<RemoteMirrorStore, 'mirroredConnections'>;
  /** Whether the owner still has a connection record for the ref. */
  hasConnection: (communityRef: CommunityRef, ownerAuthorId: string) => Promise<boolean>;
  /** The full revoke-and-purge path for one owner's connection. */
  revoke: (communityRef: CommunityRef, ownerAuthorId: string) => Promise<void>;
}

/**
 * Revoke and purge every mirrored connection with no connection record. Never throws: a failure
 * is logged, and the next start tries again.
 *
 * @returns How many connections' copies were handed to the revoke path.
 */
export async function sweepOrphanedMirrors(deps: OrphanedMirrorSweepDeps): Promise<number> {
  let swept = 0;
  for (const { communityRef, ownerAuthorId } of deps.mirrors.mirroredConnections()) {
    try {
      if (await deps.hasConnection(communityRef, ownerAuthorId)) continue;
      await deps.revoke(communityRef, ownerAuthorId);
      swept += 1;
    } catch (error) {
      logger.warn('[communities] could not remove the copies of a disconnected community', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return swept;
}
