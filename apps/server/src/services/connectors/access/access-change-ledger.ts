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
