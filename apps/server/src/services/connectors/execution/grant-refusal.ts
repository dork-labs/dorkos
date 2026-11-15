/**
 * Whether the grants an agent holds let it run one operation (DOR-4204).
 *
 * Its own grant (or its chat's, or its extension's) counts, and so does
 * the owner's every-agent share. Money actions cannot come through a share
 * or an access level. Workflow-file changes require the agent's own exact
 * action: a level, a chat grant or a shared grant cannot replace it.
 *
 * A paid row under a level predates that rule and is kept only until the
 * next catalog read removes it.
 *
 * @module services/connectors/execution/grant-refusal
 */
import {
  and,
  connectionAccessLevels,
  connectionOperationGrants,
  eq,
  isNull,
  type Db,
} from '@dorkos/db';
import { isPaidOperation } from '@dorkos/shared/connector-schemas';
import { changesWorkflowFiles } from './workflow-files.js';

/** Why a paid operation was refused. */
export const PAID_NEEDS_OWN_GRANT =
  'This action spends money, so it needs to be given to this agent on its own.';

/**
 * Why the agent may not run the operation, or `null` when it may.
 *
 * @param db - The database, queried when an individual grant is required.
 * @param agentId - The agent running it.
 * @param target - The connection it runs on.
 * @param granted - Which live grants matched: its own, and the every-agent one.
 * @param operation - The service and operation being run.
 */
export function grantRefusal(
  db: Db,
  agentId: string,
  target: { connectionId: string; operationRevisionId: string; arguments: Record<string, unknown> },
  granted: { named: boolean; everyAgent: boolean },
  operation: { toolkit: string; operationSlug: string }
): string | null {
  if (
    changesWorkflowFiles(operation, target.arguments) &&
    !holdsOwnExactAction(db, agentId, target)
  ) {
    return 'Changing workflow files needs this action given to this agent on its own.';
  }
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

/** Whether this agent holds this exact action independently of any access level or shared grant. */
function holdsOwnExactAction(
  db: Db,
  agentId: string,
  target: { connectionId: string; operationRevisionId: string }
): boolean {
  if (agentHoldsLevel(db, agentId, target.connectionId)) return false;
  return (
    db
      .select({ id: connectionOperationGrants.id })
      .from(connectionOperationGrants)
      .where(
        and(
          eq(connectionOperationGrants.subjectType, 'agent'),
          eq(connectionOperationGrants.subjectId, agentId),
          eq(connectionOperationGrants.connectionId, target.connectionId),
          eq(connectionOperationGrants.operationRevisionId, target.operationRevisionId),
          isNull(connectionOperationGrants.revokedAt)
        )
      )
      .get() !== undefined
  );
}
