/**
 * Connect the teammate settings (DOR-2956) to the rest of the server at startup: each finished
 * teammate turn's cost reaches its space's monthly counter, the owner is told once a month when
 * the limit is reached, and a teammate's turn in a space room finds the folder that space shares.
 *
 * @module services/communities/remote/wake/teammate-spend-wiring
 */
import { setTeammateTurnCostSink } from '../../../core/turn-power/teammate-turn-cost.js';
import { setSharedFolderResolver } from '../../../core/turn-power/shared-folder.js';
import { notify } from '../../../notifications/notification-service.js';
import { logger } from '../../../../lib/logger.js';
import type { RemoteMirrorStore } from '../mirror-store.js';
import { getRemoteConnectionStore, getTeammateSpend, setTeammateSpendNotices } from '../state.js';

/**
 * Count each teammate turn against the space whose room it answered, and tell the owner when
 * that space's limit is reached. A turn in a room that mirrors no space counts against nothing.
 *
 * @param mirrors - The mirror store, which knows which space each local room copies.
 */
export function wireTeammateSpend(mirrors: Pick<RemoteMirrorStore, 'connectionOf'>): void {
  // A room that mirrors no space shares nothing.
  setSharedFolderResolver((roomId) => {
    const connection = mirrors.connectionOf(roomId);
    return connection
      ? getTeammateSpend().sharedFolder(connection.communityRef, connection.ownerAuthorId)
      : null;
  });
  setTeammateSpendNotices({
    // Rejects when the owner could not be told, so the counter tries again next time.
    reached: async ({ ref, ownerKey, limitUsd, month }) => {
      const connection = await getRemoteConnectionStore().get(ref, ownerKey);
      const told = await notify('community.teammate-limit', {
        ref,
        communityLabel: connection.label,
        limitUsd,
        month,
      });
      if (!told.notification && !told.deduped) throw new Error('No notification was raised');
    },
    reset: () => {
      void notify('community.teammate-limits-reset', {}).catch((error: unknown) => {
        logger.warn('[teammate-spend] Could not tell the owner their limits were reset', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });
  setTeammateTurnCostSink(({ roomId, costUsd }) => {
    const connection = mirrors.connectionOf(roomId);
    if (!connection) return;
    void getTeammateSpend()
      .record(connection.communityRef, connection.ownerAuthorId, costUsd)
      .catch((error: unknown) => {
        logger.warn('[teammate-spend] Could not count a teammate turn', {
          communityRef: connection.communityRef,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}
