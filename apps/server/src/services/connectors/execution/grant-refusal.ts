/**
 * Whether the grants an agent holds let it run one operation (DOR-4204).
 *
 * Its own grant (or its chat's, or its extension's) always counts, and so does
 * the owner-wide "every agent" grant, except for an operation that spends
 * money. That one runs only when it was given to the agent on its own: never
 * through "every agent", and never through an access level. A level holds no
 * paid operation now, so a paid row under a level is one written before this
 * rule, kept only until the app's catalog is read again.
 *
 * @module services/connectors/execution/grant-refusal
 */
import { and, connectionAccessLevels, eq, type Db } from '@dorkos/db';
import { isPaidOperation } from '@dorkos/shared/connector-schemas';

/** Why a paid operation was refused. */
export const PAID_NEEDS_OWN_GRANT =
  'This action spends money, so it needs to be given to this agent on its own.';

/**
 * Why the agent may not run the operation, or `null` when it may.
 *
 * @param db - The DorkOS database, read only for a paid operation.
 * @param agentId - The agent running it.
 * @param target - The connection it runs on.
 * @param granted - Which live grants matched: its own, and the every-agent one.
 * @param operation - The service and operation being run.
 */
export function grantRefusal(
  db: Db,
  agentId: string,
  target: { connectionId: string },
  granted: { named: boolean; everyAgent: boolean },
  operation: { toolkit: string; operationSlug: string }
): string | null {
  if (!isPaidOperation(operation)) {
    return granted.named || granted.everyAgent
      ? null
      : 'This agent is not granted the selected operation.';
  }
  if (granted.named && !agentHoldsLevel(db, agentId, target.connectionId)) return null;
  return granted.named || granted.everyAgent
    ? PAID_NEEDS_OWN_GRANT
    : 'This agent is not granted the selected operation.';
}

/**
 * Whether an agent holds an access level of its own on a connection. A level
 * and hand-picked actions never mix, so every one of its grants there came from
 * the level.
 *
 * @param db - The DorkOS database.
 * @param agentId - The agent.
 * @param connectionId - The connection.
 */
export function agentHoldsLevel(db: Db, agentId: string, connectionId: string): boolean {
  return (
    db
      .select({ level: connectionAccessLevels.level })
      .from(connectionAccessLevels)
      .where(
        and(
          eq(connectionAccessLevels.subjectType, 'agent'),
          eq(connectionAccessLevels.agentId, agentId),
          eq(connectionAccessLevels.connectionId, connectionId)
        )
      )
      .get() !== undefined
  );
}
