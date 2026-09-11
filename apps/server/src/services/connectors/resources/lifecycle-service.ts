/** Owner lifecycle mutations with local close-first connector authority. */
import { and, connections, connectorProviderInstances, eq, isNull, sql, type Db } from '@dorkos/db';
import {
  ConnectorLifecycleResultSchema,
  type ConnectorAuthoritySyncState,
  type ConnectorLifecycleResult,
} from '@dorkos/shared/connector-resource-schemas';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectionId,
  type ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-schemas';
import { ConnectorExternalAccountRefSchema } from '@dorkos/shared/connector-provider';
import type { ConnectorAuthorityCleanupPort } from '../authority-cleanup-port.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ConnectorRegistry } from '../registry.js';
import type { ConnectorAuthenticationFlowService } from './authentication-flow-service.js';

/** Result of synchronizing one close-first managed lifecycle command. */
export interface ConnectorManagedLifecycleSyncResult {
  /** Durable local projection of the current hosted command. */
  readonly authoritySync: ConnectorAuthoritySyncState;
  /** Whether the current active command was acknowledged and may open locally. */
  readonly applied: boolean;
  /** Hosted credential cleanup state, separate from authority closure. */
  readonly externalCleanup: 'not_required' | 'pending' | 'complete' | 'failed';
}

/** Managed lifecycle synchronizer implemented by the durable authority outbox. */
export interface ConnectorManagedLifecyclePort {
  /** Append and attempt one monotonic hosted lifecycle transition. */
  transition(input: {
    readonly connectionId: ConnectionId;
    readonly managedConnectionId: string;
    readonly lifecycle: 'active' | 'paused' | 'disconnected';
    readonly providerInstanceId: ConnectorProviderInstanceId;
    readonly executionConfigGeneration: number;
    readonly owner: ConnectorOwnerAuthority;
    readonly signal: AbortSignal;
  }): Promise<ConnectorManagedLifecycleSyncResult>;
}

/** Safe refusal from the owner lifecycle boundary. */
export class ConnectorLifecycleError extends Error {
  /** Stable machine-readable refusal. */
  readonly code:
    | 'connection_not_found'
    | 'managed_sync_unavailable'
    | 'connection_not_disconnected'
    | 'connection_cleanup_pending';

  /** Construct one safe lifecycle refusal. */
  constructor(code: ConnectorLifecycleError['code'], message: string) {
    super(message);
    this.name = 'ConnectorLifecycleError';
    this.code = code;
  }
}

/** Construction dependencies for canonical owner lifecycle mutations. */
export interface ConnectorLifecycleServiceOptions {
  /** Canonical connector database. */
  readonly db: Db;
  /** Stable connection registry. */
  readonly registry: ConnectorRegistry;
  /** Durable authentication flow coordinator. */
  readonly authenticationFlows: ConnectorAuthenticationFlowService;
  /** Pending authority cleanup. */
  readonly authorityCleanup: ConnectorAuthorityCleanupPort;
  /** Durable hosted synchronizer when managed connectors are configured. */
  readonly managed?: ConnectorManagedLifecyclePort;
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

/** Canonical local lifecycle writer for owner resource routes. */
export class ConnectorLifecycleService {
  /** Construct lifecycle mutations over stable local authority. */
  constructor(private readonly options: ConnectorLifecycleServiceOptions) {}

  /** Rename one owned connection locally. */
  rename(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    label: string
  ): ConnectorLifecycleResult {
    const row = this.requireOwnedConnection(owner, connectionId);
    this.options.registry.setLabel(row.connectionId, label);
    return this.result(row.connectionId, 'not_required');
  }

  /** Remove one disconnected account from inventory without deleting history or cleanup. */
  remove(owner: ConnectorOwnerAuthority, connectionId: string): void {
    const parsed = ConnectionIdSchema.parse(connectionId);
    this.options.db.transaction((tx) => {
      const row = this.ownedConnection(owner, parsed);
      if (!row) throw new ConnectorLifecycleError('connection_not_found', 'Connection not found.');
      if (row.removedAt) return;
      if (row.lifecycleState !== 'disconnected') {
        throw new ConnectorLifecycleError(
          'connection_not_disconnected',
          'Disconnect this account before removing it.'
        );
      }
      if (row.externalCleanupState !== 'complete' && row.externalCleanupState !== 'not_required') {
        throw new ConnectorLifecycleError(
          'connection_cleanup_pending',
          'Finish disconnecting this account before removing it.'
        );
      }
      this.options.authenticationFlows.invalidateConnectionFlows(owner, parsed);
      tx.update(connections)
        .set({
          removedAt: new Date().toISOString(),
          enabled: false,
          cleanupGeneration: sql`${connections.cleanupGeneration} + 1`,
        })
        .where(
          and(
            eq(connections.id, parsed),
            eq(connections.lifecycleState, 'disconnected'),
            isNull(connections.removedAt)
          )
        )
        .run();
    });
  }

  /** Close one owned connection immediately, then synchronize hosted authority if needed. */
  async pause(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    signal: AbortSignal
  ): Promise<ConnectorLifecycleResult> {
    const row = this.requireOwnedConnection(owner, connectionId);
    if (row.mode === 'byo') {
      this.options.registry.setPaused(row.connectionId, true);
      return this.result(row.connectionId, 'not_required');
    }
    if (!this.options.managed) {
      this.options.registry.setPaused(row.connectionId, true);
    }
    const sync = await this.syncManaged(owner, row, 'paused', signal);
    return this.result(row.connectionId, sync.externalCleanup, sync.authoritySync);
  }

  /** Open one managed connection only after the current hosted command is acknowledged. */
  async resume(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    signal: AbortSignal
  ): Promise<ConnectorLifecycleResult> {
    const row = this.requireOwnedConnection(owner, connectionId);
    if (row.mode === 'byo') {
      this.options.registry.setPaused(row.connectionId, false);
      return this.result(row.connectionId, 'not_required');
    }
    const sync = await this.syncManaged(owner, row, 'active', signal);
    if (sync.applied && this.isCurrentForResume(owner, row)) {
      this.options.registry.setPaused(row.connectionId, false);
    }
    return this.result(row.connectionId, sync.externalCleanup, sync.authoritySync);
  }

  /** Tombstone local authority before any provider or hosted cleanup await. */
  async disconnect(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    signal: AbortSignal
  ): Promise<ConnectorLifecycleResult> {
    const row = this.requireOwnedConnection(owner, connectionId);
    this.options.authenticationFlows.invalidateConnectionFlows(owner, row.connectionId);
    const provider = this.options.registry.resolveProviderInstance(row.providerInstanceId);
    const providerDisconnect =
      row.mode === 'byo' && provider
        ? provider.disconnect(row.externalAccountRef)
        : row.mode === 'byo'
          ? Promise.reject(new Error('Connector provider is unavailable for external cleanup.'))
          : Promise.resolve();
    if (row.mode === 'byo' || !this.options.managed) {
      this.options.registry.recordDisconnect(row.connectionId);
    }
    const managedSync =
      row.mode === 'managed' ? this.syncManaged(owner, row, 'disconnected', signal) : undefined;
    this.options.authorityCleanup.revokeConnection({
      connectionId: row.connectionId,
      reason: 'connection_removed',
    });

    if (managedSync) {
      const sync = await managedSync;
      return this.result(row.connectionId, sync.externalCleanup, sync.authoritySync);
    }
    try {
      await providerDisconnect;
      return this.result(row.connectionId, 'complete');
    } catch {
      return ConnectorLifecycleResultSchema.parse({
        ...this.result(row.connectionId, 'failed'),
        warning: {
          code: 'external_cleanup_failed',
          message: 'Local access is closed. The service could not confirm account cleanup.',
        },
      });
    }
  }

  private async syncManaged(
    owner: ConnectorOwnerAuthority,
    row: ReturnType<ConnectorLifecycleService['requireOwnedConnection']>,
    lifecycle: 'active' | 'paused' | 'disconnected',
    signal: AbortSignal
  ): Promise<ConnectorManagedLifecycleSyncResult> {
    if (!this.options.managed) {
      return {
        authoritySync: {
          status: 'failed',
          reason: 'DorkOS cannot sync this connection until this installation is linked.',
        },
        applied: false,
        externalCleanup: lifecycle === 'disconnected' ? 'pending' : 'not_required',
      };
    }
    return this.options.managed.transition({
      connectionId: row.connectionId,
      managedConnectionId: row.externalAccountRef,
      lifecycle,
      providerInstanceId: row.providerInstanceId,
      executionConfigGeneration: row.executionConfigGeneration,
      owner,
      signal,
    });
  }

  private isCurrentForResume(
    owner: ConnectorOwnerAuthority,
    expected: ReturnType<ConnectorLifecycleService['requireOwnedConnection']>
  ): boolean {
    const current = this.ownedConnection(owner, expected.connectionId);
    return Boolean(
      current &&
      current.lifecycleState === 'connected' &&
      current.authenticationStatus === 'active' &&
      current.reconciliationStatus === 'ready' &&
      current.providerInstanceId === expected.providerInstanceId &&
      current.executionConfigGeneration === expected.executionConfigGeneration
    );
  }

  private result(
    connectionId: ConnectionId,
    externalCleanup: 'not_required' | 'pending' | 'complete' | 'failed',
    authoritySync?: ConnectorAuthoritySyncState
  ): ConnectorLifecycleResult {
    const row = this.options.db
      .select({
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        authenticationStatus: connections.status,
      })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .get();
    if (!row) {
      throw new ConnectorLifecycleError('connection_not_found', 'Connection not found.');
    }
    return ConnectorLifecycleResultSchema.parse({
      connectionId,
      lifecycle:
        row.lifecycleState === 'disconnected'
          ? 'disconnected'
          : row.enabled
            ? 'connected'
            : 'paused',
      authenticationStatus: row.authenticationStatus,
      authoritySync: authoritySync ?? { status: 'ready' },
      externalCleanup,
    });
  }

  private requireOwnedConnection(owner: ConnectorOwnerAuthority, connectionId: string) {
    const parsed = ConnectionIdSchema.parse(connectionId);
    const row = this.ownedConnection(owner, parsed);
    if (!row || row.removedAt || row.lifecycleState === 'disconnected') {
      throw new ConnectorLifecycleError('connection_not_found', 'Connection not found.');
    }
    return row;
  }

  private ownedConnection(owner: ConnectorOwnerAuthority, connectionId: ConnectionId) {
    const owned = ownerColumns(owner);
    const row = this.options.db
      .select({
        connectionId: connections.id,
        providerInstanceId: connectorProviderInstances.id,
        externalAccountRef: connections.externalAccountRef,
        lifecycleState: connections.lifecycleState,
        removedAt: connections.removedAt,
        externalCleanupState: connections.externalCleanupState,
        authenticationStatus: connections.status,
        reconciliationStatus: connections.grantReconciliationStatus,
        executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
        mode: connectorProviderInstances.mode,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connectorProviderInstances.ownerKind, owned.ownerKind),
          eq(connectorProviderInstances.ownerId, owned.ownerId)
        )
      )
      .get();
    return row
      ? {
          ...row,
          connectionId: ConnectionIdSchema.parse(row.connectionId),
          providerInstanceId: ConnectorProviderInstanceIdSchema.parse(row.providerInstanceId),
          externalAccountRef: ConnectorExternalAccountRefSchema.parse(row.externalAccountRef),
        }
      : undefined;
  }
}
