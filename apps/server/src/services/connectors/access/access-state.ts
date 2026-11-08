/**
 * One agent's own access on one app, as stored, and the one property every
 * narrowing keeps: the state after never gives more than the state before
 * (spec `agent-grant-autonomy` §4.1).
 *
 * @module services/connectors/access/access-state
 */
import {
  and,
  connectionAccessLevels,
  connectionGrantExclusions,
  connectionOperationGrants,
  eq,
  isNull,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { ConnectorAccessLevel } from '@dorkos/shared/connector-schemas';

/** One agent's own access on one app. */
export interface AccessState {
  /** Its level, or `null` when it holds exact actions (or none). */
  readonly level: ConnectorAccessLevel | null;
  /** The actions it holds by name. */
  readonly revisionIds: readonly string[];
  /** Whether it is left out of the app's every-agent share. */
  readonly excluded: boolean;
}
const LEVEL_RANK: Record<string, number> = { 'read-write': 2, read: 1 };

/**
 * True when `after` gives no more than `before`: the property every write keeps.
 *
 * @param before - The access now.
 * @param after - The access a change would leave.
 */
export function isNarrowing(before: AccessState, after: AccessState): boolean {
  const held = new Set(before.revisionIds);
  if (!after.revisionIds.every((id) => held.has(id))) return false;
  if (before.excluded && !after.excluded) return false;
  if (after.level === null) return true;
  return before.level !== null && LEVEL_RANK[after.level]! <= LEVEL_RANK[before.level]!;
}

/**
 * Whether two action lists hold the same actions, in any order.
 *
 * @param a - One list.
 * @param b - The other.
 */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/**
 * Whether two access states are the same.
 *
 * @param a - One state.
 * @param b - The other.
 */
export function sameState(a: AccessState, b: AccessState): boolean {
  return a.level === b.level && a.excluded === b.excluded && sameIds(a.revisionIds, b.revisionIds);
}
/**
 * One agent's own access on one app, as stored now.
 *
 * @param db - The database or open transaction.
 * @param agentId - The agent.
 * @param connectionId - The app.
 */
export function readAccessState(
  db: Db | DbTransaction,
  agentId: string,
  connectionId: string
): AccessState {
  const revisionIds = db
    .select({ id: connectionOperationGrants.operationRevisionId })
    .from(connectionOperationGrants)
    .where(
      and(
        eq(connectionOperationGrants.connectionId, connectionId),
        eq(connectionOperationGrants.subjectType, 'agent'),
        eq(connectionOperationGrants.subjectId, agentId),
        isNull(connectionOperationGrants.revokedAt)
      )
    )
    .all()
    .map((row) => row.id)
    .sort();
  const level =
    db
      .select({ level: connectionAccessLevels.level })
      .from(connectionAccessLevels)
      .where(
        and(
          eq(connectionAccessLevels.connectionId, connectionId),
          eq(connectionAccessLevels.subjectType, 'agent'),
          eq(connectionAccessLevels.subjectId, agentId)
        )
      )
      .get()?.level ?? null;
  const excluded =
    db
      .select({ id: connectionGrantExclusions.id })
      .from(connectionGrantExclusions)
      .where(
        and(
          eq(connectionGrantExclusions.agentId, agentId),
          eq(connectionGrantExclusions.connectionId, connectionId),
          isNull(connectionGrantExclusions.revokedAt)
        )
      )
      .get() !== undefined;
  return { level, revisionIds: [...new Set(revisionIds)], excluded };
}
