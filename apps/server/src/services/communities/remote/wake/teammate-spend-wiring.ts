/**
 * Connect the card limit (DOR-2956) to the rest of the server at startup: each finished teammate
 * turn's cost reaches its space's monthly counter, and the owner is told once a month when the
 * limit is reached.
 *
 * @module services/communities/remote/wake/teammate-spend-wiring
 */
import { UNPROVEN_TEAMMATE_ORIGIN } from '@dorkos/shared/permission-semantics';
import {
  setTeammateTurnCostSink,
  type TeammateTurnCost,
} from '../../../core/turn-power/teammate-turn-cost.js';
import { setTeammateSpaceGate } from '../../../core/turn-power/teammate-mark.js';
import { notify } from '../../../notifications/notification-service.js';
import { logger } from '../../../../lib/logger.js';
import type { RemoteMirrorStore } from '../mirror-store.js';
import { getRemoteConnectionStore, getTeammateSpend, setTeammateSpendNotices } from '../state.js';
import type { TeammateSpend } from './teammate-spend.js';

/** Which space each local room copies, as the mirror store knows it. */
type Mirrors = Pick<RemoteMirrorStore, 'connectionOf'>;

/**
 * Whether a teammate's turn from this room may still run this month. A room that mirrors no space
 * limits nothing; a chain DorkOS can't prove the rooms of runs only while every space allows it.
 *
 * @param mirrors - Which space each local room copies.
 * @param spend - The counter.
 */
export function teammateSpaceGate(
  mirrors: Mirrors,
  spend: () => TeammateSpend
): (roomId: string) => boolean {
  return (roomId) => {
    if (roomId === UNPROVEN_TEAMMATE_ORIGIN.roomId) return spend().allowsEvery();
    const connection = mirrors.connectionOf(roomId);
    return !connection || spend().allows(connection.communityRef, connection.ownerAuthorId);
  };
}

/**
 * Count a finished teammate turn against the space whose room it answered. A turn in a room that
 * mirrors no space counts against nothing; a chain DorkOS can't prove the rooms of counts against
 * every space with a limit.
 *
 * @param mirrors - Which space each local room copies.
 * @param spend - The counter.
 */
export function teammateSpendSink(
  mirrors: Mirrors,
  spend: () => TeammateSpend
): (turn: TeammateTurnCost) => void {
  return ({ roomId, costUsd }) => {
    const unproven = roomId === UNPROVEN_TEAMMATE_ORIGIN.roomId;
    const connection = unproven ? undefined : mirrors.connectionOf(roomId);
    if (!unproven && !connection) return;
    const counted = connection
      ? spend().record(connection.communityRef, connection.ownerAuthorId, costUsd)
      : spend().recordEvery(costUsd);
    void counted.catch((error: unknown) => {
      logger.warn('[teammate-spend] Could not count a teammate turn', {
        ...(connection ? { communityRef: connection.communityRef } : { unproven: true }),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
}

/**
 * Count each teammate turn against the space whose room it answered, and tell the owner when
 * that space's limit is reached. A turn in a room that mirrors no space counts against nothing.
 *
 * @param mirrors - The mirror store, which knows which space each local room copies.
 */
export function wireTeammateSpend(mirrors: Mirrors): void {
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
  // A turn carrying a teammate's mark, however many hops on, does not start once a space in its
  // chain is at its limit (DOR-3036).
  setTeammateSpaceGate(teammateSpaceGate(mirrors, getTeammateSpend));
  setTeammateTurnCostSink(teammateSpendSink(mirrors, getTeammateSpend));
}
