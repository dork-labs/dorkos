/**
 * A turn a space member who is not the agent's owner started: the teammate turn (DOR-2955).
 *
 * Somebody in a space the owner shares with other people mentions the owner's agent, sends it a
 * direct message, or posts in a channel it answers in. The turn runs on the owner's computer, at the
 * agent's set level, like any other (Dorian 2026-10-30, DOR-3440). What sets it apart is a record:
 * it counts against the space's monthly limit (`core/turn-power/teammate-mark.ts`).
 *
 * Who is a teammate is `space-teammates.ts`.
 *
 * @module server/services/rooms/limits/teammate-turn
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { RoomTurnRequest } from '../room-turn-port.js';

/**
 * The per-turn bounds a room turn sends: its ceiling as the dispatcher derived it, the folders
 * placement granted it, and a mark it carries on from the work it continues (DOR-3561). A room
 * without files grants nothing.
 *
 * @param request - The turn about to start.
 */
export function turnBoundsOf(
  request: Pick<RoomTurnRequest, 'permissionCeiling' | 'additionalDirectories' | 'carriedOutsider'>
): Pick<MessageOpts, 'permissionCeiling' | 'additionalDirectories' | 'carriedMarks'> {
  return {
    ...(request.permissionCeiling !== undefined
      ? { permissionCeiling: request.permissionCeiling }
      : {}),
    ...(request.additionalDirectories.length > 0
      ? { additionalDirectories: request.additionalDirectories }
      : {}),
    ...(request.carriedOutsider ? { carriedMarks: { outsider: true as const } } : {}),
  };
}

/**
 * The marks a room turn's `roomTurn` carries about who it answers: whether a teammate started it,
 * which counts it against the space's monthly limit; and whether any message it answers was written
 * by anyone but a person on this machine (`answersUntrustedText`), which keeps the runtime from
 * running those words as a command or expanding a file reference in them.
 *
 * @param request - The turn about to start.
 */
export function roomTurnMarksOf(
  request: Pick<RoomTurnRequest, 'teammate' | 'permissionCeiling' | 'untrustedText' | 'turnStarter'>
): Pick<NonNullable<MessageOpts['roomTurn']>, 'teammate' | 'untrustedText' | 'turnStarter'> {
  return {
    ...(request.turnStarter !== undefined ? { turnStarter: request.turnStarter } : {}),
    ...(request.teammate ? { teammate: true as const } : {}),
    ...(request.untrustedText || request.permissionCeiling !== undefined || request.teammate
      ? { untrustedText: true as const }
      : {}),
  };
}
