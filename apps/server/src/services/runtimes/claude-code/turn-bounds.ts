/**
 * The per-turn fields a Claude Code session carries for the turn in flight, assigned together on
 * every send so none of them outlives the turn that asked for it.
 *
 * @module services/runtimes/claude-code/turn-bounds
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AgentSession } from './agent-types.js';
import { sharedFolderOf } from '../../core/turn-power/shared-folder.js';

/**
 * Assign this turn's bounds onto the session, clearing any the previous turn left.
 *
 * @param session - The session the turn is about to run in.
 * @param opts - The send's options.
 */
export function assignTurnBounds(
  session: Pick<
    AgentSession,
    'unattendedApprovals' | 'unattendedTurn' | 'turnPermissionCeiling' | 'teammateTier'
  >,
  opts: MessageOpts | undefined
): void {
  // Unconditionally, `false` included: a warm session a person later talks
  // to must hold for their answer again (spec `agent-permissions` D6).
  session.unattendedApprovals = opts?.unattendedApprovals === true;
  // Per turn too, for the same reason: an automatic carry-over's first turn
  // has nobody to ask, and the person who opens it next does.
  session.unattendedTurn = opts?.unattended === true;
  // Per turn as well, and the one of the three that bounds what the turn may
  // DO: a turn another agent's post or a stranger's message started runs no
  // looser than its sender (spec `trusted-by-default-flip` §4). Cleared when
  // absent, so a person's next turn runs at the level they chose.
  if (opts?.permissionCeiling !== undefined) {
    session.turnPermissionCeiling = opts.permissionCeiling;
  } else {
    delete session.turnPermissionCeiling;
  }
  // And the room a teammate's turn is fenced to (DOR-2955), with the one folder
  // its space shares, read now so a change applies from the next turn (DOR-2956).
  // Cleared the same way, so the owner's next turn reaches what it did.
  if (opts?.roomTurn?.teammate === true) {
    session.teammateTier = {
      roomId: opts.roomTurn.roomId,
      sharedFolder: sharedFolderOf(opts.roomTurn.roomId),
      authorId: opts.roomTurn.authorId,
      // Who asked, for `ask_owner`, and the one call the owner allowed, for this send only
      // (DOR-2956): copied, so spending it here never touches the caller's options.
      ...(opts.roomTurn.teammateAsker ? { asker: { ...opts.roomTurn.teammateAsker } } : {}),
      ...(opts.roomTurn.teammatePass ? { pass: { ...opts.roomTurn.teammatePass } } : {}),
    };
  } else {
    delete session.teammateTier;
  }
}
