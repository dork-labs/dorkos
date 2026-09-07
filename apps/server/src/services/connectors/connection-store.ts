/** Authoritative stable connector identity and access store. */
import { ulid } from 'ulidx';
import {
  agentConnectionAttachments,
  connectionOperationGrants,
  connections,
  connectorEventSubscriptions,
  connectorLegacyAgentRevocations,
  connectorProviderInstances,
  and,
  eq,
  inArray,
  or,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import type {
  ConnectedAccount,
  ConnectedAccountStatus,
  ConnectorCustody,
  ConnectorExternalAccountRef,
  ConnectorProvider,
  ConnectorProviderInstanceId,
  ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import {
  runLegacyConnectionMigration,
  type ConnectorMigrationResult,
  type LegacyConnectionMigrationInput,
} from './legacy-connection-migration.js';

/** Raised when connector identity migration failed and mixed-store writes are blocked. */
export class ConnectorMigrationUnavailableError extends Error {
  /** Stable machine-readable health state. */
  readonly code = 'migration_failed';

  /** Construct the typed connector migration failure. */
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorMigrationUnavailableError';
  }
}

/** Private server-side stable connection binding. */
export interface StableConnectionBinding {
  /** Stable public connection id. */
  accountId: ConnectedAccount['id'];
  /** Stable configured provider instance. */
  providerInstanceId: ConnectorProviderInstanceId;
  /** Provider implementation type used only for compatibility routing. */
  provider: string;
  /** Private provider account reference. */
  externalAccountRef: ConnectorExternalAccountRef;
  /** Service slug. */
  toolkit: string;
  /** Operator-facing account label. */
  label: string;
  /** Custody disclosure category. */
  custody: ConnectorCustody;
  /** Durable connection lifecycle, including operator pause. */
  status: ConnectedAccountStatus;
}

/** Construction options for the authoritative connection store. */
export interface ConnectionStoreOptions {
  /** DorkOS database. */
  db: Db;
  /** Plain pre-resolved migration inputs. */
  migration?: LegacyConnectionMigrationInput;
  /** Test seam for a deterministic migration result. */
  runMigration?: (db: Db, input?: LegacyConnectionMigrationInput) => ConnectorMigrationResult;
  /** Verified account or installation that owns newly configured provider instances. */
  configuredOwner?: {
    readonly ownerKind: 'user' | 'local_install';
    readonly ownerId: string;
  };
}

/** Stable connection store and sole writer after the application backfill. */
export class ConnectionStore {
  private readonly db: Db;
  private readonly migrationResult: ConnectorMigrationResult;
  private readonly configuredOwner:
    { readonly ownerKind: 'user' | 'local_install'; readonly ownerId: string } | undefined;

  /** Run the backfill boundary before exposing any stable reads or writes. */
  constructor(options: ConnectionStoreOptions) {
    this.db = options.db;
    this.configuredOwner = options.configuredOwner;
    this.migrationResult = (options.runMigration ?? runLegacyConnectionMigration)(
      options.db,
      options.migration
    );
  }

  /** Current connector migration health. */
  health(): ConnectorMigrationResult {
    return this.migrationResult;
  }

  /** Throw the typed error that prevents mixed old/new reads and writes. */
  assertAvailable(): void {
    if (this.migrationResult.status === 'migration_failed') {
      throw new ConnectorMigrationUnavailableError(this.migrationResult.error);
    }
  }

  /** Persist or refresh one configured provider instance without deleting connections. */
  registerProvider(provider: ConnectorProvider, executionConfigDigest: string): number {
    this.assertAvailable();
    const capabilities = provider.getCapabilities();
    const now = new Date().toISOString();
    // This bootstrap configures a provider owned by this DorkOS install.
    // Custody describes its vault; a future managed service must declare its
    // deployment mode explicitly instead of inferring it from custody.
    const mode = 'byo' as const;
    return this.db.transaction((tx) => {
      const existing = tx
        .select({
          createdAt: connectorProviderInstances.createdAt,
          executionConfigDigest: connectorProviderInstances.executionConfigDigest,
          executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
          ownerKind: connectorProviderInstances.ownerKind,
          ownerId: connectorProviderInstances.ownerId,
        })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, provider.instanceId))
        .get();
      if (
        existing?.ownerKind &&
        existing.ownerId &&
        this.configuredOwner &&
        (existing.ownerKind !== this.configuredOwner.ownerKind ||
          existing.ownerId !== this.configuredOwner.ownerId)
      ) {
        throw new Error('Configured connector provider belongs to a different owner.');
      }
      const materialChanged =
        existing !== undefined && existing.executionConfigDigest !== executionConfigDigest;
      const executionConfigGeneration =
        existing?.executionConfigDigest === executionConfigDigest
          ? existing.executionConfigGeneration
          : Math.max(1, (existing?.executionConfigGeneration ?? 0) + 1);
      tx.insert(connectorProviderInstances)
        .values({
          id: provider.instanceId,
          type: provider.type,
          mode,
          displayName: provider.type,
          custody: capabilities.custody,
          capabilityJson: JSON.stringify(capabilities.capabilities),
          status: 'available',
          executionConfigDigest,
          executionConfigGeneration,
          ownerKind: this.configuredOwner?.ownerKind ?? existing?.ownerKind,
          ownerId: this.configuredOwner?.ownerId ?? existing?.ownerId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: connectorProviderInstances.id,
          set: {
            type: provider.type,
            mode,
            displayName: provider.type,
            custody: capabilities.custody,
            capabilityJson: JSON.stringify(capabilities.capabilities),
            status: 'available',
            error: null,
            executionConfigDigest,
            executionConfigGeneration,
            ownerKind: this.configuredOwner?.ownerKind ?? existing?.ownerKind,
            ownerId: this.configuredOwner?.ownerId ?? existing?.ownerId,
            updatedAt: now,
          },
        })
        .run();
      if (materialChanged) {
        tx.update(connections)
          .set({ grantReconciliationStatus: 'migration_needs_reconcile', updatedAt: now })
          .where(eq(connections.providerInstanceId, provider.instanceId))
          .run();
      }
      return executionConfigGeneration;
    });
  }

  /** Read the material generation for one configured provider instance. */
  providerExecutionConfigGeneration(instanceId: ConnectorProviderInstanceId): number | undefined {
    return this.db
      .select({ generation: connectorProviderInstances.executionConfigGeneration })
      .from(connectorProviderInstances)
      .where(eq(connectorProviderInstances.id, instanceId))
      .get()?.generation;
  }

  /** Mark a provider unavailable while retaining its identity and connections. */
  unregisterProvider(instanceId: ConnectorProviderInstanceId): void {
    this.assertAvailable();
    this.db
      .update(connectorProviderInstances)
      .set({ status: 'unavailable', updatedAt: new Date().toISOString() })
      .where(eq(connectorProviderInstances.id, instanceId))
      .run();
  }

  /** Reconcile one private provider account to a stable DorkOS connection. */
  reconcile(
    provider: ConnectorProvider,
    account: ProviderConnectedAccount,
    options: { restoreDisconnected?: boolean } = {}
  ): ConnectedAccount {
    this.assertAvailable();
    const existing = this.db.$client
      .prepare(
        `SELECT id, created_at, enabled, lifecycle_state
         FROM connections
         WHERE provider_instance_id = ? AND external_account_ref = ?`
      )
      .get(provider.instanceId, account.externalAccountRef) as
      { id: string; created_at: string; enabled: number; lifecycle_state: string } | undefined;
    const now = new Date().toISOString();
    const id = existing?.id ?? ulid();
    this.db
      .insert(connections)
      .values({
        id,
        providerInstanceId: provider.instanceId,
        externalAccountRef: account.externalAccountRef,
        toolkit: account.toolkit,
        label: account.label,
        status: account.status,
        grantReconciliationStatus: 'migration_needs_reconcile',
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
        lastVerifiedAt: now,
      })
      .onConflictDoUpdate({
        target: [connections.providerInstanceId, connections.externalAccountRef],
        set: {
          toolkit: account.toolkit,
          label: account.label,
          status: account.status,
          ...(options.restoreDisconnected && { lifecycleState: 'connected' as const }),
          updatedAt: now,
          lastVerifiedAt: now,
        },
      })
      .run();
    return {
      id: id as ConnectedAccount['id'],
      provider: provider.type,
      toolkit: account.toolkit,
      label: account.label,
      status:
        existing?.lifecycle_state === 'disconnected' && !options.restoreDisconnected
          ? 'revoked'
          : existing?.enabled === 0
            ? 'paused'
            : account.status,
      custody: account.custody,
    };
  }

  /** Read one private binding by stable public connection id. */
  binding(accountId: ConnectedAccount['id']): StableConnectionBinding | undefined {
    this.assertAvailable();
    const row = this.db.$client
      .prepare(
        `SELECT c.id, c.provider_instance_id, c.external_account_ref, c.toolkit, c.label,
                c.status, c.lifecycle_state, c.enabled, p.type AS provider, p.custody
         FROM connections c
         JOIN connector_provider_instances p ON p.id = c.provider_instance_id
         WHERE c.id = ?`
      )
      .get(accountId) as
      | {
          id: string;
          provider_instance_id: string;
          external_account_ref: string;
          toolkit: string;
          label: string;
          status: ConnectedAccountStatus;
          lifecycle_state: 'connected' | 'disconnected';
          enabled: number;
          provider: string;
          custody: ConnectorCustody;
        }
      | undefined;
    if (!row) return undefined;
    return {
      accountId: row.id as ConnectedAccount['id'],
      providerInstanceId: row.provider_instance_id as ConnectorProviderInstanceId,
      provider: row.provider,
      externalAccountRef: row.external_account_ref as ConnectorExternalAccountRef,
      toolkit: row.toolkit,
      label: row.label,
      status:
        row.lifecycle_state === 'disconnected'
          ? 'revoked'
          : row.enabled === 0
            ? 'paused'
            : row.status,
      custody: row.custody,
    };
  }

  /**
   * Resolve an unambiguous disconnected connection targeted by a new connect
   * flow. A label narrows multi-account providers; without one, exactly one
   * disconnected connection for the provider and toolkit must exist.
   */
  disconnectedConnectionFor(
    providerInstanceId: ConnectorProviderInstanceId,
    toolkit: string,
    label?: string
  ): ConnectedAccount['id'] | undefined {
    this.assertAvailable();
    const rows = this.db.$client
      .prepare(
        `SELECT id FROM connections
         WHERE provider_instance_id = ? AND toolkit = ? AND lifecycle_state = 'disconnected'
           AND (? IS NULL OR label = ?)
         ORDER BY id
         LIMIT 2`
      )
      .all(providerInstanceId, toolkit, label ?? null, label ?? null) as Array<{ id: string }>;
    return rows.length === 1 ? (rows[0]!.id as ConnectedAccount['id']) : undefined;
  }

  /** Pause or resume local use without overwriting provider authentication status. */
  setPaused(accountId: ConnectedAccount['id'], paused: boolean): void {
    this.assertAvailable();
    this.db
      .update(connections)
      .set({ enabled: !paused, updatedAt: new Date().toISOString() })
      .where(eq(connections.id, accountId))
      .run();
  }

  /** Replace the operator-facing label of one stable connection. */
  setLabel(accountId: ConnectedAccount['id'], label: string): void {
    this.assertAvailable();
    this.db
      .update(connections)
      .set({ label, updatedAt: new Date().toISOString() })
      .where(eq(connections.id, accountId))
      .run();
  }

  /** Tombstone a connection and synchronously revoke local active access. */
  revokeConnection(accountId: ConnectedAccount['id']): void {
    this.assertAvailable();
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.update(connections)
        .set({ lifecycleState: 'disconnected', updatedAt: now })
        .where(eq(connections.id, accountId))
        .run();
      tx.delete(agentConnectionAttachments)
        .where(eq(agentConnectionAttachments.connectionId, accountId))
        .run();
      tx.delete(sessionConnectionOverrides)
        .where(eq(sessionConnectionOverrides.connectionId, accountId))
        .run();
      tx.update(connectionOperationGrants)
        .set({ revokedAt: now })
        .where(eq(connectionOperationGrants.connectionId, accountId))
        .run();
      tx.update(connectorEventSubscriptions)
        .set({ enabled: false, updatedAt: now })
        .where(eq(connectorEventSubscriptions.connectionId, accountId))
        .run();
    });
  }

  /** Revoke every connection authority row owned by one removed agent. */
  removeAgentAccess(agentId: string): string[] {
    this.assertAvailable();
    const sessionRows = this.db
      .select({ sessionId: sessionConnectionOverrides.sessionId })
      .from(sessionConnectionOverrides)
      .where(eq(sessionConnectionOverrides.agentId, agentId))
      .all();
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.delete(agentConnectionAttachments)
        .where(eq(agentConnectionAttachments.agentId, agentId))
        .run();
      tx.delete(sessionConnectionOverrides)
        .where(eq(sessionConnectionOverrides.agentId, agentId))
        .run();
      tx.update(connectionOperationGrants)
        .set({ revokedAt: now })
        .where(eq(connectionOperationGrants.agentId, agentId))
        .run();
      tx.update(connectorEventSubscriptions)
        .set({ enabled: false, updatedAt: now })
        .where(eq(connectorEventSubscriptions.agentId, agentId))
        .run();
    });
    return [...new Set(sessionRows.map((row) => row.sessionId))];
  }

  /**
   * Revoke one agent's authority for one connection while preserving every
   * other agent and connection.
   *
   * @param agentId - Agent losing access.
   * @param accountId - Exact stable connection being detached.
   */
  removeAgentConnectionAccess(agentId: string, accountId: ConnectedAccount['id']): void {
    this.assertAvailable();
    const sessionRows = this.db
      .select({ sessionId: sessionConnectionOverrides.sessionId })
      .from(sessionConnectionOverrides)
      .where(
        and(
          eq(sessionConnectionOverrides.agentId, agentId),
          eq(sessionConnectionOverrides.connectionId, accountId)
        )
      )
      .all();
    const sessionIds = [...new Set(sessionRows.map((row) => row.sessionId))];
    const grantOwners = [
      eq(connectionOperationGrants.agentId, agentId),
      and(
        eq(connectionOperationGrants.subjectType, 'agent'),
        eq(connectionOperationGrants.subjectId, agentId)
      ),
      ...(sessionIds.length > 0
        ? [
            and(
              eq(connectionOperationGrants.subjectType, 'session'),
              inArray(connectionOperationGrants.subjectId, sessionIds)
            ),
          ]
        : []),
    ];
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.delete(agentConnectionAttachments)
        .where(
          and(
            eq(agentConnectionAttachments.agentId, agentId),
            eq(agentConnectionAttachments.connectionId, accountId)
          )
        )
        .run();
      tx.update(connectionOperationGrants)
        .set({ revokedAt: now })
        .where(and(eq(connectionOperationGrants.connectionId, accountId), or(...grantOwners)))
        .run();
      tx.update(connectorEventSubscriptions)
        .set({ enabled: false, updatedAt: now })
        .where(
          and(
            eq(connectorEventSubscriptions.agentId, agentId),
            eq(connectorEventSubscriptions.connectionId, accountId)
          )
        )
        .run();
      tx.delete(sessionConnectionOverrides)
        .where(
          and(
            eq(sessionConnectionOverrides.agentId, agentId),
            eq(sessionConnectionOverrides.connectionId, accountId)
          )
        )
        .run();
    });
  }

  /**
   * Fence retained legacy consent for an agent before its removal is observed.
   *
   * The marker bypasses application-migration health because the Drizzle table
   * already exists and must be durable precisely when the legacy backfill is
   * unavailable. It does not block later explicit canonical consent.
   */
  recordAgentRemoval(agentId: string): void {
    this.db
      .insert(connectorLegacyAgentRevocations)
      .values({ agentId, revokedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }
}
