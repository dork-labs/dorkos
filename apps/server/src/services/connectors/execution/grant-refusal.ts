/**
 * Whether the grants an agent holds let it run one operation (DOR-4204).
 *
 * Its own grant (or its chat's, or its extension's) counts, and so does
 * the owner's every-agent share. Money actions cannot come through a share
 * or an access level. Repository-control changes require the agent's own exact
 * action, as do history replacement and new branches requested in arguments,
 * and X uploads or posts whose arguments reach past the owner's own account
 * (DOR-4332). A level, a chat grant or a shared grant cannot replace it.
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
import {
  isPaidOperation,
  type ConnectorOperationClassification,
} from '@dorkos/shared/connector-schemas';
import { accountReachArguments } from './account-reach-arguments.js';
import { changesRepositoryControlFiles, changesRepositoryHistory } from './workflow-files.js';
import {
  isOutsideLevels,
  loweredWriteLine,
  outsideLevelsRefusalFor,
} from '../access/level-gap-lines.js';

/** The action being run: its app, its id and its stored classification. */
export interface GrantRefusalOperation {
  readonly toolkit: string;
  readonly operationSlug: string;
  readonly classification: ConnectorOperationClassification;
}

/** Why an action the agent holds no grant for was refused, when nothing more is known. */
const NOT_GRANTED = 'This agent is not granted the selected operation.';

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
 * @param operation - The service, operation and classification being run.
 */
export function grantRefusal(
  db: Db,
  agentId: string,
  target: { connectionId: string; operationRevisionId: string; arguments: Record<string, unknown> },
  granted: { named: boolean; everyAgent: boolean },
  operation: GrantRefusalOperation
): string | null {
  if (
    (changesRepositoryControlFiles(target.arguments) ||
      changesRepositoryHistory(target.arguments)) &&
    !holdsOwnExactAction(db, agentId, target)
  ) {
    return 'Changing repository control files needs this action given to this agent on its own.';
  }
  const reach = accountReachArguments(operation, target.arguments);
  if (reach && !holdsOwnExactAction(db, agentId, target)) return reach;
  if (!granted.named && !granted.everyAgent) {
    return notGrantedRefusal(db, agentId, target, operation);
  }
  if (!isPaidOperation(operation)) return null;
  if (granted.named && !agentHoldsLevel(db, agentId, target.connectionId)) return null;
  return PAID_NEEDS_OWN_GRANT;
}

/**
 * Why an action the agent holds no grant for was refused, with the reason a
 * level could not have covered it, or the one-time lowering that took its
 * writes, when either is true (DOR-4678).
 */
function notGrantedRefusal(
  db: Db,
  agentId: string,
  target: { connectionId: string; operationRevisionId: string },
  operation: GrantRefusalOperation
): string {
  if (isOutsideLevels(operation)) {
    return (
      outsideLevelsRefusalFor(db, target.connectionId, target.operationRevisionId, operation) ??
      NOT_GRANTED
    );
  }
  const lowered =
    operation.classification === 'write'
      ? loweredWriteLine(db, agentId, target.connectionId)
      : null;
  return lowered ? `${NOT_GRANTED} ${lowered}` : NOT_GRANTED;
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
