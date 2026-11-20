/** Authoritative seat scope checks, independent of timestamp uniqueness. */
import type { RoomCore } from '../service/room-core.js';
import { isLiveAuthor } from '../handles/author-handles.js';
import type { SeatMessagePending, SeatMessageTarget } from './seat-message-types.js';

/** Resolve only a currently bound ledger identity, including genuine native retirement links. */
export function resolveSeatMessageTarget(
  core: RoomCore,
  sessionId: string
): SeatMessageTarget | null {
  const binding = core.store.sessionLedger.bindingForSession(sessionId);
  if (!binding) return null;
  const room = core.store.getRoom(binding.roomId);
  const member = core.store.getMember(binding.roomId, binding.authorId);
  const author = core.authors.getById(binding.authorId);
  if (
    !room ||
    room.archived ||
    !member ||
    author?.kind !== 'agent' ||
    !isLiveAuthor(author, core.agents)
  )
    return null;
  const bridge = core.bridges.findBridgeByRoom(binding.roomId);
  return {
    ...binding,
    bridged: bridge !== null,
    ...(bridge?.archivedAt === null
      ? {
          bridgeOwnership: {
            bindingId: bridge.bindingId,
            adapterId: bridge.adapterId,
            chatId: bridge.chatId,
          },
        }
      : {}),
    sessionId,
    canonicalSessionId: binding.sessionId,
    joinedAt: member.joinedAt,
    agentPath: author.naturalKey,
    aliases: [binding.sessionId, ...core.store.sessionLedger.retiredIdsFor(binding.sessionId)],
  };
}

/**
 * A removed/recreated binding cannot inherit admission, even when joinedAt is unchanged.
 *
 * Any field compared here must also be in {@link seatTargetKey}, or {@link seatBatchStillCurrent}
 * would treat a stale target as already checked and let it through.
 */
export function currentSeatMessageTarget(
  core: RoomCore,
  expected: SeatMessageTarget
): string | null {
  const current = resolveSeatMessageTarget(core, expected.sessionId);
  if (
    !current ||
    current.roomId !== expected.roomId ||
    current.authorId !== expected.authorId ||
    current.joinedAt !== expected.joinedAt ||
    current.agentPath !== expected.agentPath ||
    (expected.bridgeOwnership !== undefined &&
      (current.bridgeOwnership?.bindingId !== expected.bridgeOwnership.bindingId ||
        current.bridgeOwnership?.adapterId !== expected.bridgeOwnership.adapterId ||
        current.bridgeOwnership?.chatId !== expected.bridgeOwnership.chatId))
  )
    return null;
  return core.store.getRoomSession(expected.roomId, expected.authorId);
}

/** Every field {@link currentSeatMessageTarget} compares, so equal keys always get equal answers. */
function seatTargetKey(target: SeatMessageTarget): string {
  const bridge = target.bridgeOwnership;
  return JSON.stringify([
    target.roomId,
    target.authorId,
    target.sessionId,
    target.joinedAt,
    target.agentPath,
    bridge ? [bridge.bindingId, bridge.adapterId, bridge.chatId] : null,
  ]);
}

/**
 * Whether a whole batch may still run: each distinct admitted seat is still current, and no
 * unsolicited item's room has become bridged. One stale target refuses the whole batch.
 *
 * Each distinct target and room is read once per call, not once per item: a busy seat rechecks
 * its full batch every 30 seconds for up to an hour (DOR-4722).
 *
 * @param core - The room core the seat lives in.
 * @param batch - The pending items about to share one private turn.
 * @returns `true` when every item may still be delivered.
 */
export function seatBatchStillCurrent(
  core: RoomCore,
  batch: readonly SeatMessagePending[]
): boolean {
  const checked = new Set<string>();
  const unbridged = new Set<string>();
  for (const item of batch) {
    const key = seatTargetKey(item.target);
    if (!checked.has(key)) {
      if (currentSeatMessageTarget(core, item.target) === null) return false;
      checked.add(key);
    }
    if (!item.unsolicited || unbridged.has(item.target.roomId)) continue;
    if (core.bridges.findBridgeByRoom(item.target.roomId) !== null) return false;
    unbridged.add(item.target.roomId);
  }
  return true;
}
