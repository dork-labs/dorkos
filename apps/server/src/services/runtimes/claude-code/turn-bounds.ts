/**
 * The per-turn fields a Claude Code session carries for the turn in flight, assigned together on
 * every send so none of them outlives the turn that asked for it.
 *
 * @module services/runtimes/claude-code/turn-bounds
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { ceilingOnlyRecords } from '../../core/turn-power/turn-marks.js';
import type { AgentSession } from './agent-types.js';

/**
 * Assign this turn's bounds onto the session, clearing any the previous turn left.
 *
 * @param session - The session the turn is about to run in.
 * @param opts - The send's options.
 */
export function assignTurnBounds(
  session: Pick<
    AgentSession,
    'unattendedApprovals' | 'unattendedTurn' | 'turnPermissionCeiling' | 'turnLevelMode'
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
  // A ceiling that only carries a teammate's record is no ceiling here (DOR-3440).
  if (opts?.permissionCeiling !== undefined && !ceilingOnlyRecords(opts.permissionCeiling)) {
    session.turnPermissionCeiling = opts.permissionCeiling;
  } else {
    delete session.turnPermissionCeiling;
  }
  // The agent's level a chat that follows its agent up starts from (DOR-3175).
  // Cleared when absent, so a later turn starts from the stored mode again.
  if (opts?.levelPermissionMode !== undefined) {
    session.turnLevelMode = opts.levelPermissionMode;
  } else {
    delete session.turnLevelMode;
  }
}
