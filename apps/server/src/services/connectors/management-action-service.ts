/** Concrete local effects for approved P2 connector management reviews. */
import { ulid } from 'ulidx';
import {
  and,
  connectionOperationGrants,
  connectorOperationRevisions,
  eq,
  inArray,
  type Db,
} from '@dorkos/db';
import type {
  ConnectionId,
  ConnectorManagementReviewAction,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorAuthorityCleanupPort } from './authority-cleanup-port.js';
import type { ConnectorManagementActionApplier } from './management-review-service.js';
import type { ConnectorOwnerAuthority } from './principal/server-principal.js';
import type { ConnectorRegistry } from './registry.js';
import type { ConnectorLifecycleService } from './resources/lifecycle-service.js';
import type { ManagedAuthoritySyncService } from './resources/managed-authority-sync-service.js';

type AppliedAction = Exclude<ConnectorManagementReviewAction, { kind: 'connect' }>;

/** Construction dependencies for approved connector management effects. */
export interface ConnectorManagementActionServiceOptions {
  /** Canonical connector database. */
  readonly db: Db;
  /** Stable connection registry and local lifecycle writer. */
  readonly registry: ConnectorRegistry;
  /** Pending authority cleanup constructed beside the early connector stores. */
  readonly authorityCleanup: ConnectorAuthorityCleanupPort;
  /** Canonical owner lifecycle used after resource-route cutover. */
  readonly lifecycle?: Pick<
    ConnectorLifecycleService,
    'rename' | 'pause' | 'resume' | 'disconnect'
  >;
  /** Durable managed authority writer used for approved managed grant changes. */
  readonly managedAuthority?: Pick<
    ManagedAuthoritySyncService,
    'replaceAgentGrants' | 'stageAgentAccessRemoval' | 'deliverAgentGrantReplacement'
  >;
  /** Injectable clock for deterministic evidence. */
  readonly now?: () => Date;
  /** Injectable durable id source for deterministic evidence. */
  readonly createId?: () => string;
}

/** Typed refusal raised when an approved action no longer has a valid exact target. */
export class ConnectorManagementActionError extends Error {
  /** Construct a stable management-action refusal. */
  constructor(
    readonly code: 'target_not_found' | 'revision_not_found' | 'managed_sync_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'ConnectorManagementActionError';
  }
}

function ownerId(owner: ConnectorOwnerAuthority): string {
  return owner.kind === 'user' ? owner.userId : owner.installationId;
}

/** Idempotent concrete effects applied only after durable owner approval. */
export class ConnectorManagementActionService implements ConnectorManagementActionApplier {
  private readonly db: Db;
  private readonly registry: ConnectorRegistry;
  private readonly authorityCleanup: ConnectorAuthorityCleanupPort;
  private readonly lifecycle:
    Pick<ConnectorLifecycleService, 'rename' | 'pause' | 'resume' | 'disconnect'> | undefined;
  private readonly managedAuthority:
    | Pick<
        ManagedAuthoritySyncService,
        'replaceAgentGrants' | 'stageAgentAccessRemoval' | 'deliverAgentGrantReplacement'
      >
    | undefined;
  private readonly now: () => Date;
  private readonly createId: () => string;

  /** Construct the approved management action service. */
  constructor(options: ConnectorManagementActionServiceOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.authorityCleanup = options.authorityCleanup;
    this.lifecycle = options.lifecycle;
    this.managedAuthority = options.managedAuthority;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
  }

  /** Apply one already owner-bound, generation-revalidated action. */
  async apply(owner: ConnectorOwnerAuthority, action: AppliedAction): Promise<void> {
    const connectionId = action.connectionId;
    const binding = this.requireOwnedConnection(owner, connectionId);
    switch (action.kind) {
      case 'edit':
        if (this.lifecycle) {
          this.lifecycle.rename(owner, connectionId, action.label);
          return;
        }
        this.registry.setLabel(connectionId, action.label);
        return;
      case 'pause':
        if (this.lifecycle) {
          await this.lifecycle.pause(owner, connectionId, new AbortController().signal);
          return;
        }
        this.registry.setPaused(connectionId, true);
        return;
      case 'resume':
        if (this.lifecycle) {
          await this.lifecycle.resume(owner, connectionId, new AbortController().signal);
          return;
        }
        this.registry.setPaused(connectionId, false);
        return;
      case 'disconnect': {
        if (this.lifecycle) {
          await this.lifecycle.disconnect(owner, connectionId, new AbortController().signal);
          return;
        }
        const provider = this.registry.resolveProviderInstance(binding.providerInstanceId);
        const providerDisconnect = provider
          ? provider.disconnect(binding.externalAccountRef)
          : Promise.resolve();
        this.registry.recordDisconnect(connectionId);
        this.authorityCleanup.revokeConnection({
          connectionId,
          reason: 'connection_removed',
        });
        await providerDisconnect;
        return;
      }
      case 'set_agent_access':
        await this.replaceAgentGrants(
          owner,
          connectionId,
          action.agentId,
          action.operationRevisionIds
        );
        return;
      case 'remove_agent_access': {
        if (binding.mode === 'managed') {
          if (!this.managedAuthority) {
            throw new ConnectorManagementActionError(
              'managed_sync_unavailable',
              'Managed connector synchronization is unavailable. Relink and try again.'
            );
          }
          const staged = this.managedAuthority.stageAgentAccessRemoval({
            connectionId,
            managedConnectionId: binding.externalAccountRef,
            agentId: action.agentId,
            providerInstanceId: binding.providerInstanceId,
            executionConfigGeneration: binding.executionConfigGeneration,
            owner,
          });
          this.authorityCleanup.revokeAgentConnection({
            agentId: action.agentId,
            connectionId,
            reason: 'agent_connection_removed',
          });
          await this.managedAuthority.deliverAgentGrantReplacement(
            staged.commandId,
            new AbortController().signal
          );
          return;
        }
        this.registry.removeAgentConnectionAccess(action.agentId, connectionId);
        this.authorityCleanup.revokeAgentConnection({
          agentId: action.agentId,
          connectionId,
          reason: 'agent_connection_removed',
        });
      }
    }
  }

  private requireOwnedConnection(owner: ConnectorOwnerAuthority, connectionId: ConnectionId) {
    const binding = this.registry.accountBinding(connectionId);
    if (!binding) {
      throw new ConnectorManagementActionError('target_not_found', 'Connector target not found.');
    }
    const row = this.db.$client
      .prepare(
        `SELECT p.owner_kind, p.owner_id, p.mode, p.execution_config_generation
         FROM connections c
         JOIN connector_provider_instances p ON p.id = c.provider_instance_id
         WHERE c.id = ? AND c.lifecycle_state = 'connected'`
      )
      .get(connectionId) as
      | {
          owner_kind: string | null;
          owner_id: string | null;
          mode: 'managed' | 'byo';
          execution_config_generation: number;
        }
      | undefined;
    if (!row || row.owner_kind !== owner.kind || row.owner_id !== ownerId(owner)) {
      throw new ConnectorManagementActionError('target_not_found', 'Connector target not found.');
    }
    return {
      ...binding,
      mode: row.mode,
      executionConfigGeneration: row.execution_config_generation,
    };
  }

  private async replaceAgentGrants(
    owner: ConnectorOwnerAuthority,
    connectionId: ConnectionId,
    agentId: string,
    operationRevisionIds: string[]
  ): Promise<void> {
    const requested = [...new Set(operationRevisionIds)];
    if (requested.length !== operationRevisionIds.length) {
      throw new ConnectorManagementActionError(
        'revision_not_found',
        'Connector operation selection is invalid.'
      );
    }
    const binding = this.requireOwnedConnection(owner, connectionId);
    const valid = this.db
      .select({
        id: connectorOperationRevisions.id,
        operationSlug: connectorOperationRevisions.operationSlug,
        toolkitVersion: connectorOperationRevisions.toolkitVersion,
        schemaHash: connectorOperationRevisions.schemaHash,
        providerRevisionRef: connectorOperationRevisions.providerRevisionRef,
      })
      .from(connectorOperationRevisions)
      .where(
        and(
          inArray(connectorOperationRevisions.id, requested),
          eq(connectorOperationRevisions.providerInstanceId, binding.providerInstanceId),
          eq(connectorOperationRevisions.toolkit, binding.toolkit)
        )
      )
      .all();
    if (valid.length !== requested.length) {
      throw new ConnectorManagementActionError(
        'revision_not_found',
        'Connector operation selection is no longer available.'
      );
    }

    if (binding.mode === 'managed') {
      if (!this.managedAuthority) {
        throw new ConnectorManagementActionError(
          'managed_sync_unavailable',
          'Managed connector synchronization is unavailable. Relink and try again.'
        );
      }
      const byId = new Map(valid.map((revision) => [revision.id, revision]));
      await this.managedAuthority.replaceAgentGrants({
        connectionId,
        managedConnectionId: binding.externalAccountRef,
        agentId,
        revisions: requested.map((id) => {
          const revision = byId.get(id)!;
          return {
            operationSlug: revision.operationSlug,
            toolkitVersion: revision.toolkitVersion,
            schemaHash: revision.schemaHash,
            hostedRevisionId: revision.providerRevisionRef,
          };
        }),
        operationRevisionIds: requested,
        providerInstanceId: binding.providerInstanceId,
        executionConfigGeneration: binding.executionConfigGeneration,
        owner,
        signal: new AbortController().signal,
      });
      return;
    }

    const now = this.now().toISOString();
    this.db.transaction((tx) => {
      const existing = tx
        .select({
          id: connectionOperationGrants.id,
          operationRevisionId: connectionOperationGrants.operationRevisionId,
        })
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.subjectType, 'agent'),
            eq(connectionOperationGrants.subjectId, agentId),
            eq(connectionOperationGrants.connectionId, connectionId)
          )
        )
        .all();
      const pending = new Set(requested);
      for (const grant of existing) {
        tx.update(connectionOperationGrants)
          .set({ revokedAt: pending.has(grant.operationRevisionId) ? null : now })
          .where(eq(connectionOperationGrants.id, grant.id))
          .run();
        pending.delete(grant.operationRevisionId);
      }
      for (const operationRevisionId of pending) {
        tx.insert(connectionOperationGrants)
          .values({
            id: this.createId(),
            subjectType: 'agent',
            subjectId: agentId,
            agentId,
            connectionId,
            operationRevisionId,
            createdBy: `owner:${owner.kind}:${ownerId(owner)}`,
            createdAt: now,
          })
          .run();
      }
    });
  }
}
