/**
 * A turn a space member who is not the agent's owner started: the teammate turn (DOR-2955).
 *
 * ## What it is
 *
 * Somebody in a space the owner shares with other people mentions the owner's agent, sends it a
 * direct message, or posts in a channel it answers in. The turn runs on the owner's computer. Until
 * the teammate tier lands (C7 of `specs/everything-is-a-space`), such a turn gets the narrowest
 * power DorkOS already has, all at once:
 *
 * - **Nobody is asked** (`MessageOpts.unattended`). A teammate cannot make the owner's computer
 *   raise approval cards, so there is no card to click by habit and no "Always allow" to win.
 * - **Read-only.** The turn is held to the runtime's default AND to read access
 *   (`READ_ONLY_LEVEL`); see `turn-ceiling.ts`.
 * - **This room only, and no files.** The DorkOS tools it may use reach only the room it answers,
 *   and it reads no files at all (`core/turn-power/teammate-tier.ts`), so it cannot read the
 *   owner's other rooms, chats or files and post them back.
 * - **None of the owner's notes.** Its prompt leaves the agent's memory out
 *   (`core/turn-power/teammate-turn-context.ts`).
 * - **Only on a runtime that honours all three** (`TEAMMATE_TURN_RUNTIMES`). Elsewhere the
 *   post stays history and starts no turn.
 *
 * The owner's own posts in the space are not teammate turns and keep today's behaviour.
 *
 * Who is a teammate, and why that fails closed, is `space-teammates.ts`.
 *
 * @module server/services/rooms/limits/teammate-turn
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { RoomTurnRequest } from '../room-turn-port.js';
import { outsiderInViewOf } from './turn-ceiling.js';
import { runsTeammateTurns, teammateRuntimeRefusal } from '../../core/turn-power/teammate-mark.js';

/**
 * Refuse a teammate turn on a runtime that cannot hold it to every bound. The stream bridge
 * already keeps such posts as history; this is the backstop for a conversation bound to another
 * runtime than the agent's own, and a refusal before any model runs.
 *
 * @param request - The turn about to start.
 * @param runtimeType - The runtime it resolved to.
 * @throws {Error} When the turn is a teammate's and the runtime is not one that may run it.
 */
export function refuseTeammateTurnOn(
  request: Pick<RoomTurnRequest, 'teammate'>,
  runtimeType: string
): void {
  if (request.teammate && !runsTeammateTurns(runtimeType)) {
    throw new Error(teammateRuntimeRefusal(runtimeType));
  }
}

/**
 * The per-turn bounds a room turn sends: its ceiling as the dispatcher derived it, the folders
 * placement granted it ({@link turnDirectoriesOf}), and for a teammate's turn `unattended`, so
 * nothing it does can ask anybody.
 *
 * @param request - The turn about to start.
 */
export function turnBoundsOf(
  request: Pick<RoomTurnRequest, 'permissionCeiling' | 'teammate' | 'additionalDirectories'>
): Pick<MessageOpts, 'permissionCeiling' | 'unattended' | 'additionalDirectories'> {
  return {
    ...(request.permissionCeiling !== undefined
      ? { permissionCeiling: request.permissionCeiling }
      : {}),
    ...turnDirectoriesOf(request),
    ...(request.teammate ? { unattended: true } : {}),
  };
}

/**
 * The folders a room turn reaches beyond the agent's own (`MessageOpts.additionalDirectories`).
 * A teammate's turn reaches none (DOR-2956): Claude Code reads without asking inside every folder
 * it is granted, so a grant would be a read the teammate tier never decided on. Every other turn
 * gets exactly what placement granted it, and a room without files grants nothing.
 *
 * @param request - The turn's grants and whether a teammate started it.
 */
function turnDirectoriesOf(
  request: Pick<RoomTurnRequest, 'additionalDirectories' | 'teammate'>
): Pick<MessageOpts, 'additionalDirectories'> {
  if (request.teammate || request.additionalDirectories.length === 0) return {};
  return { additionalDirectories: request.additionalDirectories };
}

/**
 * The marks a room turn's `roomTurn` carries about who it answers: whether it is shown an
 * outsider's words (`outsiderInViewOf`); whether a teammate started it, which fences its DorkOS
 * tools to `roomTurn.roomId`; and whether any message it answers was written by anyone but a
 * person on this machine, which keeps the runtime from running those words as a command or
 * expanding a file reference in them (`untrustedText`).
 *
 * `untrustedText` reads the ceiling the dispatcher already derived from who wrote the messages
 * (`turn-ceiling.ts`): it is set for every author except a person here, a stranger in a bridged
 * Telegram or Slack chat, a space member and another agent alike, and that is the same set.
 *
 * @param request - The turn about to start.
 */
export function roomTurnMarksOf(
  request: Pick<RoomTurnRequest, 'roomContext' | 'teammate' | 'permissionCeiling'> & {
    room?: { id: string };
  }
): Pick<NonNullable<MessageOpts['roomTurn']>, 'outsiderInView' | 'teammate' | 'untrustedText'> {
  return {
    ...outsiderInViewOf(request.roomContext, request.room?.id),
    ...(request.teammate ? { teammate: true as const } : {}),
    ...(request.permissionCeiling !== undefined || request.teammate
      ? { untrustedText: true as const }
      : {}),
  };
}
