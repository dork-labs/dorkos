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
import type { ConnectorFlowBindings } from './flow-bindings.js';
import type { ConnectorManagementActionApplier } from './management-review-service.js';
import type { ConnectorOwnerAuthority } from './principal/server-principal.js';
import type { ConnectorRegistry } from './registry.js';

type AppliedAction = Exclude<ConnectorManagementReviewAction, { kind: 'connect' }>;

/** Construction dependencies for approved connector management effects. */
export interface ConnectorManagementActionServiceOptions {
  /** Canonical connector database. */
  readonly db: Db;
  /** Stable connection registry and local lifecycle writer. */
  readonly registry: ConnectorRegistry;
  /** Shared opaque flow bindings used to invalidate reconnect replay. */
  readonly flowBindings: ConnectorFlowBindings;
  /** Pending authority cleanup constructed beside the early connector stores. */
  readonly authorityCleanup: ConnectorAuthorityCleanupPort;
  /** Injectable clock for deterministic evidence. */
  readonly now?: () => Date;
  /** Injectable durable id source for deterministic evidence. */
  readonly createId?: () => string;
}

/** Typed refusal raised when an approved action no longer has a valid exact target. */
export class ConnectorManagementActionError extends Error {
  /** Construct a stable management-action refusal. */
  constructor(
    readonly code: 'target_not_found' | 'revision_not_found',
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
  private readonly flowBindings: ConnectorFlowBindings;
  private readonly authorityCleanup: ConnectorAuthorityCleanupPort;
  private readonly now: () => Date;
  private readonly createId: () => string;

  /** Construct the approved management action service. */
  constructor(options: ConnectorManagementActionServiceOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.flowBindings = options.flowBindings;
    this.authorityCleanup = options.authorityCleanup;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
  }

  /** Apply one already owner-bound, generation-revalidated action. */
  async apply(owner: ConnectorOwnerAuthority, action: AppliedAction): Promise<void> {
    const connectionId = action.connectionId;
    const binding = this.requireOwnedConnection(owner, connectionId);
    switch (action.kind) {
      case 'edit':
        this.registry.setLabel(connectionId, action.label);
        return;
      case 'pause':
        this.registry.setPaused(connectionId, true);
        return;
      case 'resume':
        this.registry.setPaused(connectionId, false);
        return;
      case 'disconnect': {
        const provider = this.registry.resolveProviderInstance(binding.providerInstanceId);
        const providerDisconnect = this.flowBindings.disconnectAccount(
          connectionId,
          binding.externalAccountRef,
          provider
        );
        this.registry.recordDisconnect(connectionId);
        this.authorityCleanup.revokeConnection({
          connectionId,
          reason: 'connection_removed',
        });
        await providerDisconnect;
        return;
      }
      case 'set_agent_access':
        this.replaceAgentGrants(owner, connectionId, action.agentId, action.operationRevisionIds);
        return;
      case 'remove_agent_access': {
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
        `SELECT p.owner_kind, p.owner_id
         FROM connections c
         JOIN connector_provider_instances p ON p.id = c.provider_instance_id
         WHERE c.id = ? AND c.lifecycle_state = 'connected'`
      )
      .get(connectionId) as { owner_kind: string | null; owner_id: string | null } | undefined;
    if (!row || row.owner_kind !== owner.kind || row.owner_id !== ownerId(owner)) {
      throw new ConnectorManagementActionError('target_not_found', 'Connector target not found.');
    }
    return binding;
  }

  private replaceAgentGrants(
    owner: ConnectorOwnerAuthority,
    connectionId: ConnectionId,
    agentId: string,
    operationRevisionIds: string[]
  ): void {
    const requested = [...new Set(operationRevisionIds)];
    if (requested.length !== operationRevisionIds.length) {
      throw new ConnectorManagementActionError(
        'revision_not_found',
        'Connector operation selection is invalid.'
      );
    }
    const binding = this.requireOwnedConnection(owner, connectionId);
    const valid = this.db
      .select({ id: connectorOperationRevisions.id })
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
