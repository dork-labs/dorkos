/**
 * The one way an agent-made access change is written (spec
 * `agent-grant-autonomy` §5): find the app the owner holds, then move one
 * agent's own access from one state to another through the existing grant
 * helpers, inside the caller's transaction, so the change and its ledger row
 * land together or not at all.
 *
 * Narrowing, an agent's read approval and every Undo use these, so there is
 * one writer to read and one to test.
 *
 * @module services/connectors/access/access-writes
 */
import {
  and,
  connectionGrantExclusions,
  connections,
  connectorProviderInstances,
  eq,
  isNull,
  type DbTransaction,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import { recordAccessLevel, replaceNamedAgentGrants } from '../execution/access-levels.js';
import { managedSelectors } from '../reconciliation-service.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ManagedAuthoritySyncService } from '../resources/managed-authority-sync-service.js';
import { sameIds, type AccessState } from './access-state.js';

/** One app the owner holds, as a change needs it. */
export interface AccessBinding {
  readonly id: string;
  readonly toolkit: string;
  readonly label: string;
  readonly managed: boolean;
  readonly managedConnectionId: string;
  readonly providerInstanceId: string;
  readonly executionConfigGeneration: number;
}

/** Hosted authority, for apps connected through a DorkOS account. */
export type AccessManagedAuthority = Pick<
  ManagedAuthoritySyncService,
  'stageAgentGrantReplacement' | 'deliverAgentGrantReplacement'
>;

/**
 * The owner's columns for one authority.
 *
 * @param owner - The verified owner.
 */
export function ownerColumns(owner: ConnectorOwnerAuthority) {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

/**
 * The live app with this id, when the owner holds it.
 *
 * @param tx - The open transaction.
 * @param owner - The verified owner.
 * @param connectionId - The app.
 * @returns The app, or `null` when it is gone or someone else's.
 */
export function findBinding(
  tx: DbTransaction,
  owner: ConnectorOwnerAuthority,
  connectionId: string
): AccessBinding | null {
  const expected = ownerColumns(owner);
  const row = tx
    .select({
      id: connections.id,
      toolkit: connections.toolkit,
      label: connections.label,
      managedConnectionId: connections.externalAccountRef,
      ownerKind: connectorProviderInstances.ownerKind,
      ownerId: connectorProviderInstances.ownerId,
      mode: connectorProviderInstances.mode,
      providerInstanceId: connectorProviderInstances.id,
      executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
    })
    .from(connections)
    .innerJoin(
      connectorProviderInstances,
      eq(connectorProviderInstances.id, connections.providerInstanceId)
    )
    .where(and(eq(connections.id, connectionId), isNull(connections.removedAt)))
    .get();
  if (!row || row.ownerKind !== expected.ownerKind || row.ownerId !== expected.ownerId) {
    return null;
  }
  return {
    id: row.id,
    toolkit: row.toolkit,
    label: row.label,
    managed: row.mode === 'managed',
    managedConnectionId: row.managedConnectionId,
    providerInstanceId: row.providerInstanceId,
    executionConfigGeneration: row.executionConfigGeneration,
  };
}

/**
 * Move one agent's own access on one app from `before` to `after`. Never
 * writes an every-agent row: the subject is always the one named agent.
 *
 * @param tx - The open transaction the ledger row is written in too.
 * @param input - The app, whose access, from and to, who did it, and when.
 * @returns A hosted command to deliver after the commit, if the app is hosted.
 * @throws When the app is hosted and no hosted authority is wired; the caller
 *   turns that into its own refusal.
 */
export function writeAccessState(
  tx: DbTransaction,
  input: {
    readonly binding: AccessBinding;
    readonly owner: ConnectorOwnerAuthority;
    readonly agentId: string;
    readonly before: AccessState;
    readonly after: AccessState;
    readonly author: string;
    readonly now: string;
    readonly managedAuthority?: AccessManagedAuthority;
    readonly createId: () => string;
    readonly onManagedUnavailable: () => never;
  }
): string | undefined {
  const { binding, after, before } = input;
  let commandId: string | undefined;
  const grantsChanged =
    before.level !== after.level || !sameIds(before.revisionIds, after.revisionIds);
  if (grantsChanged) {
    recordAccessLevel(tx, {
      connectionId: binding.id,
      subject: { kind: 'agent', agentId: input.agentId },
      level: after.level ?? undefined,
      createdBy: input.author,
      now: input.now,
    });
    if (binding.managed) {
      if (!input.managedAuthority) input.onManagedUnavailable();
      commandId = input.managedAuthority!.stageAgentGrantReplacement(tx, {
        connectionId: ConnectionIdSchema.parse(binding.id),
        managedConnectionId: binding.managedConnectionId,
        agentId: input.agentId,
        ...managedSelectors(tx, after.revisionIds),
        providerInstanceId: ConnectorProviderInstanceIdSchema.parse(binding.providerInstanceId),
        executionConfigGeneration: binding.executionConfigGeneration,
        owner: input.owner,
      });
    } else {
      replaceNamedAgentGrants(tx, {
        connectionId: binding.id,
        agentId: input.agentId,
        operationRevisionIds: after.revisionIds,
        createdBy: input.author,
        now: input.now,
        createId: input.createId,
      });
    }
  }
  if (!before.excluded && after.excluded) {
    tx.insert(connectionGrantExclusions)
      .values({
        id: input.createId(),
        agentId: input.agentId,
        connectionId: binding.id,
        createdBy: input.author,
        createdAt: input.now,
      })
      .run();
  }
  if (before.excluded && !after.excluded) {
    tx.update(connectionGrantExclusions)
      .set({ revokedAt: input.now, revokedBy: input.author })
      .where(
        and(
          eq(connectionGrantExclusions.agentId, input.agentId),
          eq(connectionGrantExclusions.connectionId, binding.id),
          isNull(connectionGrantExclusions.revokedAt)
        )
      )
      .run();
  }
  return commandId;
}
