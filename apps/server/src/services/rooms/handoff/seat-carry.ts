/**
 * What a turn in an agent's room seat carries from the chat it came from, joined with the room's
 * own marks. A hand-off (`room-handoff.ts`, DOR-3397) and a spin-off's report (`seat-report.ts`,
 * DOR-3488) are both a turn in the seat that started somewhere else, and both are held this way.
 *
 * @module server/services/rooms/handoff/seat-carry
 */
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { marksOf } from '../../core/turn-power/turn-levels.js';
import {
  ceilingCarrying,
  marksHold,
  mergeMarks,
  type TurnMarks,
} from '../../core/turn-power/turn-marks.js';
import { teammateOf } from '../limits/space-teammates.js';
import { ceilingForEntries, isEntryAuthorExternal } from '../limits/turn-ceiling.js';
import { STALE_POST_SHOWN_MAX } from '../messages/room-freshness.js';
import type { AsideCarry } from '../room-trigger/aside.js';
import type { RoomCore } from '../service/room-core.js';

/**
 * A chat's marks joined with the room's own (Security, DOR-3397), for a seat turn that re-reads
 * the room: it is held as a triggered turn answering the room's recent posts would be, a
 * stranger's among them included. Every bound holds at once, so the narrowest wins.
 *
 * @param core - The room service's shared state.
 * @param authorId - The seat's agent.
 * @param carried - What the chat the turn came from carried.
 * @param room - The room.
 * @param latest - The room's latest entry, read when it holds no posts by others.
 */
export function withRoomMarks(
  core: RoomCore,
  authorId: string,
  carried: AsideCarry,
  room: Room,
  latest: RoomEntry
): AsideCarry {
  // The same window the stale-post check hands the seat back when it re-reads, by the same
  // constant, so the posts that mark this turn and the posts it is shown cannot drift apart.
  const recent = core.store
    .listEntries(room.id, { limit: STALE_POST_SHOWN_MAX })
    .filter((entry) => entry.kind === 'post' && entry.authorId !== authorId);
  const read = recent.length > 0 ? recent : [latest];
  const inSpaceRoom = core.triggers.deps.isSpaceRoom?.(room.id) === true;
  const authors = core.authors;
  const ceiling = joinCeilings(
    carried.permissionCeiling,
    ceilingForEntries(authors, read, inSpaceRoom, room.id).permissionCeiling
  );
  const teammate = carried.teammate ?? teammateOf(authors, read, inSpaceRoom, room.id).teammate;
  return {
    externalAuthor:
      carried.externalAuthor ||
      read.some((entry) => isEntryAuthorExternal(authors, entry.authorId)),
    ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}),
    ...(teammate ? { teammate: true } : {}),
    ...(carried.outsider ? { outsider: true } : {}),
  };
}

/**
 * What a chat's turn carries into a seat's (DOR-3397 scenario E): a stranger's words, the
 * ceiling every bound work it starts is held to, and a mark that holds. A Wi-Fi sign-in's hold
 * marks the seat's turn so every raise gate refuses it, and caps nothing (Security on DOR-3561):
 * a report must not launder the mark away, nor lower the seat's level.
 *
 * A report can run long after the turn it speaks for, and `marksOf` reads the chat's latest turn,
 * so a later unmarked turn would launder the words of a marked one (DOR-3720). `atTurnEnd` is what
 * that turn carried; marks only add up, so it joins whatever the chat carries now.
 *
 * @param sessionId - The chat the turn came from.
 * @param agentPath - Its agent's home.
 * @param atTurnEnd - The marks of the turn whose words these are, read when it ended.
 */
export function carryFrom(sessionId: string, agentPath: string, atTurnEnd?: TurnMarks): AsideCarry {
  const live = marksOf(sessionId, agentPath);
  const marks = atTurnEnd ? mergeMarks(live, atTurnEnd) : live;
  const ceiling = ceilingCarrying(marks);
  return {
    externalAuthor: marks.outsider === true,
    ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}),
    ...(marks.teammate !== undefined && marks.teammate.length > 0 ? { teammate: true } : {}),
    ...(marksHold(marks) ? { outsider: true } : {}),
  };
}

/** Two ceilings as one: every bound of each holds, so the runtime keeps the strictest. */
function joinCeilings(
  a: TurnPermissionCeiling | undefined,
  b: TurnPermissionCeiling | undefined
): TurnPermissionCeiling | undefined {
  const bounds = [a, b].flatMap((ceiling): TurnPermissionBound[] =>
    ceiling === undefined
      ? []
      : Array.isArray(ceiling)
        ? [...ceiling]
        : [ceiling as TurnPermissionBound]
  );
  if (bounds.length === 0) return undefined;
  return bounds.length === 1 ? bounds[0]! : bounds;
}
