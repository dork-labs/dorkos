/** Authoritative seat scope checks, independent of timestamp uniqueness. */
import type { RoomCore } from '../service/room-core.js';
import { isLiveAuthor } from '../handles/author-handles.js';
import type { SeatMessageTarget } from './seat-message-types.js';

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

/** A removed/recreated binding cannot inherit admission, even when joinedAt is unchanged. */
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
