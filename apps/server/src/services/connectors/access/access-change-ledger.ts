/**
 * The person's read of the access-change ledger (spec `agent-grant-autonomy`
 * §6.2): every change agents made on the owner's apps, with the agents' own
 * reasons. Only the person's routes call this; agents get
 * `connectors.list_access_changes`, which never carries a reason.
 *
 * @module services/connectors/access/access-change-ledger
 */
import {
  and,
  connectionGrantChanges,
  connections,
  connectorProviderInstances,
  desc,
  eq,
  or,
  type Db,
} from '@dorkos/db';
import type { ConnectorAccessChange } from '@dorkos/shared/connector-exclusion-schemas';
import type { ConnectorAgentApproval } from '@dorkos/shared/connector-schemas';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';

/**
 * The owner's access changes, newest first.
 *
 * @param db - Canonical connector database.
 * @param owner - The verified owner.
 * @param filters - An app, an agent (as actor or target), and a page size.
 */
export function listAccessChangesForOwner(
  db: Db,
  owner: ConnectorOwnerAuthority,
  filters: { connectionId?: string; agentId?: string; limit?: number; changeId?: string } = {}
): ConnectorAccessChange[] {
  const ownerKind = owner.kind;
  const ownerId = owner.kind === 'user' ? owner.userId : owner.installationId;
  return db
    .select({ change: connectionGrantChanges })
    .from(connectionGrantChanges)
    .innerJoin(connections, eq(connections.id, connectionGrantChanges.connectionId))
    .innerJoin(
      connectorProviderInstances,
      eq(connectorProviderInstances.id, connections.providerInstanceId)
    )
    .where(
      and(
        eq(connectorProviderInstances.ownerKind, ownerKind),
        eq(connectorProviderInstances.ownerId, ownerId),
        filters.connectionId
          ? eq(connectionGrantChanges.connectionId, filters.connectionId)
          : undefined,
        filters.changeId ? eq(connectionGrantChanges.id, filters.changeId) : undefined,
        filters.agentId
          ? or(
              eq(connectionGrantChanges.actorId, filters.agentId),
              eq(connectionGrantChanges.targetAgentId, filters.agentId)
            )
          : undefined
      )
    )
    .orderBy(desc(connectionGrantChanges.createdAt))
    .limit(filters.limit ?? 50)
    .all()
    .map(({ change }) => ({
      changeId: change.id,
      kind: change.kind,
      outcome: change.outcome,
      refusalCode: change.refusalCode,
      actorKind: change.actorKind,
      actorId: change.actorId,
      targetAgentId: change.targetAgentId,
      connectionId: change.connectionId,
      reason: change.reason,
      requestId: change.requestId,
      undoOf: change.undoOf,
      undoneBy: change.undoneBy,
      createdAt: change.createdAt,
    }));
}

/**
 * One of the owner's access changes, or `undefined` when there is no such
 * change on the owner's apps.
 *
 * @param db - Canonical connector database.
 * @param owner - The verified owner.
 * @param changeId - The ledger row.
 */
export function findAccessChangeForOwner(
  db: Db,
  owner: ConnectorOwnerAuthority,
  changeId: string
): ConnectorAccessChange | undefined {
  return listAccessChangesForOwner(db, owner, { changeId, limit: 1 })[0];
}

/**
 * Another agent's approval of one request for Read, as the request's owner sees it on the card:
 * the approver as it looked then, when, and when the person undid it. Read by the request's own
 * id through its index, never through a window of recent rows, so no number of other rows (a
 * flood of refusals, say) can hide it (Security M1 on #3575). The caller has already read the
 * request as its owner's.
 *
 * @param db - Canonical connector database.
 * @param requestId - The request.
 */
export function agentApprovalOf(db: Db, requestId: string): ConnectorAgentApproval | undefined {
  const row = db
    .select()
    .from(connectionGrantChanges)
    .where(
      and(
        eq(connectionGrantChanges.requestId, requestId),
        eq(connectionGrantChanges.kind, 'approve_read'),
        eq(connectionGrantChanges.outcome, 'applied'),
        eq(connectionGrantChanges.actorKind, 'agent')
      )
    )
    .orderBy(desc(connectionGrantChanges.createdAt))
    .limit(1)
    .get();
  if (!row) return undefined;
  const snapshot = parseSnapshot(row.actorSnapshotJson);
  const undo = row.undoneBy
    ? db
        .select({ createdAt: connectionGrantChanges.createdAt })
        .from(connectionGrantChanges)
        .where(eq(connectionGrantChanges.id, row.undoneBy))
        .get()
    : undefined;
  return {
    agentId: row.actorId,
    displayName: snapshot?.displayName ?? null,
    ...(snapshot?.color ? { color: snapshot.color } : {}),
    ...(snapshot?.icon ? { icon: snapshot.icon } : {}),
    approvedAt: row.createdAt,
    ...(undo ? { undoneAt: undo.createdAt } : {}),
  };
}

/** A stored approver snapshot, or `undefined` for none or one that doesn't read. */
function parseSnapshot(
  json: string | null
): { displayName?: string; color?: string; icon?: string } | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const text = (key: string) =>
      typeof value[key] === 'string' && value[key] !== '' ? (value[key] as string) : undefined;
    return { displayName: text('displayName'), color: text('color'), icon: text('icon') };
  } catch {
    return undefined;
  }
}

/**
 * {@link agentApprovalOf} as the field a request item spreads in: `{ approvedBy }`, or nothing.
 *
 * @param db - Canonical connector database.
 * @param requestId - The request.
 */
export function approvedByField(
  db: Db,
  requestId: string
): { approvedBy?: ConnectorAgentApproval } {
  const approvedBy = agentApprovalOf(db, requestId);
  return approvedBy ? { approvedBy } : {};
}
