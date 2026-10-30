/**
 * The marks a managed execution carries to the owner's approval card (#3196
 * review, S2). The broker derives them from the calling turn, never from
 * anything the agent sends, so an injected turn cannot ask for a clean card:
 * `outsider` when the turn read words from outside the owner's circle or a
 * stranger started it, `tool_read` when it got a third party's text through a
 * tool's result (an email, a web page; DOR-3291), and `teammate` when a
 * teammate in a shared space started the chain.
 *
 * @module services/connectors/execution/managed-turn-marks
 */
import type { ManagedConnectorTurnMark } from '@dorkos/shared/connector-managed-schemas';
import { marksOf } from '../../core/turn-power/turn-levels.js';
import { startedByOutsider, type TurnMarks } from '../../core/turn-power/turn-marks.js';

/**
 * The contract's marks for a turn's marks.
 *
 * @param marks - The marks the calling turn carries.
 * @param startedByStranger - Whether a stranger started the calling turn.
 */
export function managedTurnMarks(
  marks: TurnMarks,
  startedByStranger: boolean
): ManagedConnectorTurnMark[] {
  const found: ManagedConnectorTurnMark[] = [];
  if (marks.outsider === true || startedByStranger) found.push('outsider');
  if (marks.toolRead === true) found.push('tool_read');
  // Present, even empty, means marked (`TurnPermissionLevel.teammate`).
  if (marks.teammate !== undefined) found.push('teammate');
  return found;
}

/**
 * The marks of the calling session's turn on this server, or none when the
 * call names no session this server recorded.
 *
 * @param sessionId - The calling session, when the surface verified one.
 */
export function liveTurnMarks(sessionId: string | undefined): ManagedConnectorTurnMark[] {
  return managedTurnMarks(
    marksOf(sessionId, undefined),
    sessionId !== undefined && startedByOutsider(sessionId)
  );
}
