/**
 * The marks a managed execution carries to the owner's approval card (#3196
 * review, S2). The broker derives them from the calling turn, never from
 * anything the agent sends: `outsider` when the turn read words from outside the
 * team (its mark or its outside-words note, `turnReadOutsideWords`, DOR-4587), and `teammate` when a teammate in a shared space started the chain.
 * `tool_read` is reserved in the contract for the tool-read mark, which DorkOS
 * does not record yet.
 *
 * @module services/connectors/execution/managed-turn-marks
 */
import type { ManagedConnectorTurnMark } from '@dorkos/shared/connector-managed-schemas';
import { marksOf } from '../../core/turn-power/turn-levels.js';
import { turnReadOutsideWords } from '../../core/turn-power/outsider-turn.js';
import type { TurnMarks } from '../../core/turn-power/turn-marks.js';

/**
 * The contract's marks for a turn's marks.
 *
 * @param marks - The marks the calling turn carries.
 */
export function managedTurnMarks(marks: TurnMarks): ManagedConnectorTurnMark[] {
  const found: ManagedConnectorTurnMark[] = [];
  if (marks.outsider === true) found.push('outsider');
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
  const marks = marksOf(sessionId, undefined);
  return managedTurnMarks(
    turnReadOutsideWords(sessionId, undefined) ? { ...marks, outsider: true } : marks
  );
}
