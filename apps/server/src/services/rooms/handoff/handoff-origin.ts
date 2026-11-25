/**
 * Where a hand-off's draft came from: the room the drafting chat sits in, and who asked there.
 *
 * @module server/services/rooms/handoff/handoff-origin
 */
import { nameForAgents } from '../room-context.js';
import type { RoomCore } from '../service/room-core.js';
import { roomLabel, type HandoffOrigin } from './handoff-presentation.js';

/**
 * Where a draft came from: the room the drafting chat sits in, and who asked there.
 *
 * @param core - The room service's shared state.
 * @param sessionId - The chat that wrote the draft.
 * @param authorId - The agent.
 */
export function handoffOriginOf(
  core: RoomCore,
  sessionId: string,
  authorId: string
): HandoffOrigin {
  // The room keeps the session, or a live turn there runs on it: a first turn is named by the
  // runtime mid-turn, before the room's record of it moves.
  const binding = core.store.sessionLedger.bindingForSession(sessionId);
  const roomId =
    binding?.authorId === authorId
      ? binding.roomId
      : [...core.triggers.claimed.values()].find(
          (claim) => claim.authorId === authorId && claim.sessionId === sessionId
        )?.roomId;
  if (roomId === undefined) {
    return {
      sessionId,
      roomId: null,
      label: roomLabel(null, core.bridges),
      requester: null,
      memberJoinedAt: null,
    };
  }
  const room = core.store.getRoom(roomId);
  const turn = core.triggers.activeTurnHere(roomId, authorId);
  const asked = turn ? core.store.getEntryById(roomId, turn.entryId) : null;
  const requester =
    asked && asked.kind === 'post' && asked.authorId !== authorId
      ? nameForAgents(core, asked.authorId)
      : null;
  return {
    sessionId,
    roomId,
    label: roomLabel(room, core.bridges),
    requester,
    memberJoinedAt: core.store.getMember(roomId, authorId)?.joinedAt ?? null,
  };
}
