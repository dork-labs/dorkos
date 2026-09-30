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
  isNull,
  notInArray,
  sql,
  or,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import {
  endAgentAccessLevels,
  endConnectionAccessLevels,
  endEveryAgentAccessLevels,
} from './execution/access-levels.js';
import {
  liveEveryAgentConnections,
  revokeEveryAgentGrants,
  type EndedEveryAgentGrant,
} from './every-agent-grants.js';
import { notifyEveryAgentEnded } from './every-agent-activity.js';
import type {
  ConnectedAccount,
  ConnectedAccountStatus,
  ConnectorCustody,
  ConnectorExternalAccountRef,
  ConnectorProvider,
  ConnectorProviderInstanceId,
  ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import { connectionWayName, type ConnectionId } from '@dorkos/shared/connector-schemas';
import {
  runLegacyConnectionMigration,
  type ConnectorMigrationResult,
  type LegacyConnectionMigrationInput,
} from './legacy-connection-migration.js';

/**
 * The test-mode provider type the credential route accepts under
 * `DORKOS_TEST_RUNTIME`. Defined here — the lowest layer that needs it — and
 * re-exported from `bootstrap.js`, which is where every other consumer
 * (`test-mode.ts`, `index.ts`) already imports it from; this store is what
 * enforces {@link ConnectionStore.purgeTestConnectorConnections}'s "only this
 * type" guard, so it owns the constant rather than reaching up into
 * `bootstrap.ts` for it.
 */
export const TEST_CONNECTOR_PROVIDER_TYPE = 'test-connector';

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
  connectionId: ConnectionId;
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

/** Server-owned deployment and payer mode for a configured provider instance. */
export type ConnectorProviderDeploymentMode = 'managed' | 'byo';

/** How registering a provider instance treats the accounts it already keeps. */
export interface RegisterProviderOptions {
  /**
   * Accounts (by their private reference) that keep the access they were
   * given through a change of the instance's setup, because the caller knows
   * the same account is reached again through the same service.
   */
  readonly keepAccessFor?: ReadonlySet<string>;
}

/** One account {@link ConnectionStore.closeUnlistedConnections} closed. */
export interface ClosedConnection {
  /** Stable connection id. */
  readonly connectionId: ConnectionId;
  /** The service, e.g. `gmail`. */
  readonly toolkit: string;
  /** The owner's label for the account. */
  readonly label: string;
}

/** A sign-in status the service reports once an account is connected; `pending` is mid-sign-in. */
export type SignInStatus = Extract<ConnectedAccountStatus, 'active' | 'expired' | 'revoked'>;

/** One kept account whose sign-in status a fresh fact from the service changed. */
export interface SignInStatusChange {
  /** Stable connection id. */
  readonly connectionId: ConnectionId;
  /** The status recorded before. */
  readonly from: ConnectedAccountStatus;
  /** The status the service reports now. */
  readonly to: SignInStatus;
}

/** Whether a listed status is a settled sign-in status (not mid-sign-in, not unknown). */
function isSignInStatus(status: ProviderConnectedAccount['status']): status is SignInStatus {
  return status === 'active' || status === 'expired' || status === 'revoked';
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
  registerProvider(
    provider: ConnectorProvider,
    executionConfigDigest: string,
    mode: ConnectorProviderDeploymentMode,
    options: RegisterProviderOptions = {}
  ): number {
    this.assertAvailable();
    const capabilities = provider.getCapabilities();
    const now = new Date().toISOString();
    let ended: EndedEveryAgentGrant[] = [];
    const generation = this.db.transaction((tx) => {
      const existing = tx
        .select({
          createdAt: connectorProviderInstances.createdAt,
          executionConfigDigest: connectorProviderInstances.executionConfigDigest,
          executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
          mode: connectorProviderInstances.mode,
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
        existing !== undefined &&
        (existing.executionConfigDigest !== executionConfigDigest || existing.mode !== mode);
      const executionConfigGeneration =
        existing?.executionConfigDigest === executionConfigDigest && existing.mode === mode
          ? existing.executionConfigGeneration
          : Math.max(1, (existing?.executionConfigGeneration ?? 0) + 1);
      tx.insert(connectorProviderInstances)
        .values({
          id: provider.instanceId,
          type: provider.type,
          mode,
          displayName: connectionWayName(provider.type),
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
            displayName: connectionWayName(provider.type),
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
        // Only access someone was given can have gone stale. A connection
        // nobody holds a live grant on (named, session or every-agent) has
        // nothing to re-check, so it stays ready and usable to grant. Nor has
        // an account the caller vouches for: the same account, reached again
        // through the same service (a DorkOS account linked again that still
        // lists it), keeps the access it was given.
        const kept = [...(options.keepAccessFor ?? [])];
        tx.update(connections)
          .set({ grantReconciliationStatus: 'migration_needs_reconcile', updatedAt: now })
          .where(
            and(
              eq(connections.providerInstanceId, provider.instanceId),
              sql`EXISTS (SELECT 1 FROM ${connectionOperationGrants}
                WHERE ${connectionOperationGrants.connectionId} = ${connections.id}
                AND ${connectionOperationGrants.revokedAt} IS NULL)`,
              ...(kept.length > 0 ? [notInArray(connections.externalAccountRef, kept)] : [])
            )
          )
          .run();
      }
      if (existing && existing.mode !== 'managed' && mode === 'managed') {
        // A grant given on the owner's own key was never sent to hosted
        // authority, which now decides every call (ADR 260926-192625). Moving
        // an instance to managed ends it for good rather than leaving it
        // dormant to reappear if the instance ever moves back; the owner shares
        // again through a review, which reaches hosted authority (DOR-2439).
        const instanceConnections = tx
          .select({ id: connections.id })
          .from(connections)
          .where(eq(connections.providerInstanceId, provider.instanceId))
          .all()
          .map((row) => row.id);
        ended = liveEveryAgentConnections(tx, instanceConnections);
        revokeEveryAgentGrants(tx, instanceConnections, now);
        endEveryAgentAccessLevels(tx, instanceConnections);
      }
      return executionConfigGeneration;
    });
    notifyEveryAgentEnded(ended, 'moved_to_dorkos_account');
    return generation;
  }

  /** Read the material generation for one configured provider instance. */
  providerExecutionConfigGeneration(instanceId: ConnectorProviderInstanceId): number | undefined {
    return this.db
      .select({ generation: connectorProviderInstances.executionConfigGeneration })
      .from(connectorProviderInstances)
      .where(eq(connectorProviderInstances.id, instanceId))
      .get()?.generation;
  }

  /**
   * The execution-material fingerprint last stored for one instance, kept
   * across unregistering and restarts; `undefined` for an instance never
   * registered.
   *
   * @param instanceId - The configured instance.
   */
  storedExecutionConfigDigest(instanceId: ConnectorProviderInstanceId): string | undefined {
    return (
      this.db
        .select({ digest: connectorProviderInstances.executionConfigDigest })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, instanceId))
        .get()?.digest ?? undefined
    );
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

  /**
   * Tombstone every live connection ONE `test-connector` provider instance
   * ever reconciled, and revoke or drop everything that hangs off one
   * (grants, agent attachments, session overrides, event subscriptions) — the
   * deliberate opposite of {@link unregisterProvider}, which keeps a real
   * provider's history on purpose so re-entering a rotated key doesn't forget
   * which accounts were connected. `connections` rows cannot be hard-deleted
   * (a DB trigger enforces tombstone-only), so this sets `removedAt` exactly
   * as an owner's own remove would, rather than deleting the row — but unlike
   * an owner's remove, it writes no audit trail or Activity record: this is a
   * blunt test-isolation reset nobody asked for on purpose, not a user action
   * worth narrating back to them.
   *
   * Refuses (throws) an instance whose persisted type is not
   * `TEST_CONNECTOR_PROVIDER_TYPE` — this is a scripted-provider-only reset,
   * never a general-purpose "erase a provider's connections" tool a real
   * (`composio`/`nango`) instance could reach by a wrong id.
   *
   * For an ephemeral, scripted provider only, whose own reload already
   * promises a clean slate (the test-mode connector's account map is
   * in-memory and starts fresh on every credential save). Once its account
   * ids stopped repeating across key saves (DOR-2451), a stale row from an
   * earlier key save would otherwise sit there — still `removedAt IS NULL`,
   * still joined into every owner and agent query — under a
   * `providerInstanceId` that outlives any one save: forever a second
   * "Gmail (work)" no test ever asked for.
   *
   * @param instanceId - The ephemeral `test-connector` instance whose connections to tombstone.
   * @throws {Error} If a persisted provider instance exists at `instanceId` and its type isn't `test-connector`.
   */
  purgeTestConnectorConnections(instanceId: ConnectorProviderInstanceId): void {
    this.assertAvailable();
    const provider = this.db
      .select({ type: connectorProviderInstances.type })
      .from(connectorProviderInstances)
      .where(eq(connectorProviderInstances.id, instanceId))
      .get();
    if (provider && provider.type !== TEST_CONNECTOR_PROVIDER_TYPE) {
      throw new Error(
        `purgeTestConnectorConnections refuses provider type '${provider.type}' — only '${TEST_CONNECTOR_PROVIDER_TYPE}' connections may be purged this way.`
      );
    }
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      const ids = tx
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.providerInstanceId, instanceId), isNull(connections.removedAt)))
        .all()
        .map((row) => row.id);
      if (ids.length === 0) return;
      tx.update(connections)
        .set({
          lifecycleState: 'disconnected',
          externalCleanupState: 'not_required',
          enabled: false,
          removedAt: now,
          cleanupGeneration: sql`${connections.cleanupGeneration} + 1`,
          updatedAt: now,
        })
        .where(inArray(connections.id, ids))
        .run();
      tx.delete(agentConnectionAttachments)
        .where(inArray(agentConnectionAttachments.connectionId, ids))
        .run();
      tx.delete(sessionConnectionOverrides)
        .where(inArray(sessionConnectionOverrides.connectionId, ids))
        .run();
      tx.update(connectionOperationGrants)
        .set({ revokedAt: now })
        .where(
          and(
            inArray(connectionOperationGrants.connectionId, ids),
            isNull(connectionOperationGrants.revokedAt)
          )
        )
        .run();
      endConnectionAccessLevels(tx, ids);
      tx.update(connectorEventSubscriptions)
        .set({
          enabled: false,
          revokedAt: now,
          scopeVersion: sql`${connectorEventSubscriptions.scopeVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            inArray(connectorEventSubscriptions.connectionId, ids),
            isNull(connectorEventSubscriptions.revokedAt)
          )
        )
        .run();
    });
  }

  /** Reconcile one private provider account to a stable DorkOS connection. */
  reconcile(
    provider: ConnectorProvider,
    account: ProviderConnectedAccount,
    options: { restoreDisconnected?: boolean; allowRemovedReplacement?: boolean } = {}
  ): ConnectedAccount {
    this.assertAvailable();
    let existing = this.db.$client
      .prepare(
        `SELECT id, created_at, enabled, lifecycle_state, removed_at, external_cleanup_state
         FROM connections
         WHERE provider_instance_id = ? AND external_account_ref = ?
         ORDER BY removed_at IS NULL DESC, removed_at DESC, id DESC
         LIMIT 1`
      )
      .get(provider.instanceId, account.externalAccountRef) as
      | {
          id: string;
          created_at: string;
          enabled: number;
          lifecycle_state: string;
          removed_at: string | null;
          external_cleanup_state: string;
        }
      | undefined;
    if (existing?.removed_at) {
      if (options.allowRemovedReplacement) {
        if (!['complete', 'not_required'].includes(existing.external_cleanup_state))
          throw new Error('Account cleanup is not confirmed.');
        existing = undefined;
      } else {
        return {
          id: existing.id as ConnectedAccount['id'],
          provider: provider.type,
          toolkit: account.toolkit,
          label: account.label,
          status: 'revoked',
          custody: account.custody,
        };
      }
    }
    const now = new Date().toISOString();
    const id = existing?.id ?? ulid();
    const accountKey = this.storedExecutionConfigDigest(provider.instanceId) ?? null;
    // Closing an account clears `enabled` as well as the lifecycle state
    // (`ConnectorLifecycleService.disconnect`), so bringing one back has to
    // restore BOTH. Restoring only the lifecycle state lands a row that reads
    // `connected` everywhere and is still refused by every executability check,
    // which is a reconnected account no agent can use. A merely PAUSED row is
    // deliberately left alone: pausing is an explicit owner choice, and a
    // sign-in does not overrule it.
    const restoringDisconnected =
      Boolean(options.restoreDisconnected) && existing?.lifecycle_state === 'disconnected';
    // Reconcile runs when a sign-in has just finished, which is itself the
    // fact: a service that does not say a status has still just signed in.
    const status = account.status === 'unknown' ? 'active' : account.status;
    this.db
      .insert(connections)
      .values({
        id,
        providerInstanceId: provider.instanceId,
        externalAccountRef: account.externalAccountRef,
        toolkit: account.toolkit,
        label: account.label,
        status,
        // A new connection has no grants, so there is nothing to reconcile:
        // it is ready to be granted. Stale access is marked where it arises
        // (a material provider change, a legacy migration), never here.
        grantReconciliationStatus: 'ready',
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
        lastVerifiedAt: now,
        accountKey,
      })
      .onConflictDoUpdate({
        target: [connections.providerInstanceId, connections.externalAccountRef],
        targetWhere: sql`${connections.removedAt} IS NULL`,
        set: {
          toolkit: account.toolkit,
          label: account.label,
          status,
          ...(options.restoreDisconnected && { lifecycleState: 'connected' as const }),
          ...(restoringDisconnected && { enabled: true, pausedBy: null }),
          updatedAt: now,
          lastVerifiedAt: now,
          accountKey,
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
          : !restoringDisconnected && existing?.enabled === 0
            ? 'paused'
            : status,
      custody: account.custody,
    };
  }

  /** Read one private binding by stable public connection id. */
  binding(connectionId: ConnectionId): StableConnectionBinding | undefined {
    this.assertAvailable();
    const row = this.db.$client
      .prepare(
        `SELECT c.id, c.provider_instance_id, c.external_account_ref, c.toolkit, c.label,
                c.status, c.lifecycle_state, c.enabled, p.type AS provider, p.custody
         FROM connections c
         JOIN connector_provider_instances p ON p.id = c.provider_instance_id
         WHERE c.id = ?`
      )
      .get(connectionId) as
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
      connectionId: row.id as ConnectionId,
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
   * Whether any account connected through one provider instance is still kept
   * (not disconnected, not removed). A missing instance has none.
   *
   * @param providerInstanceId - The instance the accounts were connected through.
   */
  hasLiveConnections(providerInstanceId: ConnectorProviderInstanceId): boolean {
    this.assertAvailable();
    return (
      this.db.$client
        .prepare(
          `SELECT 1 FROM connections
           WHERE provider_instance_id = ? AND lifecycle_state = 'connected' AND removed_at IS NULL
           LIMIT 1`
        )
        .get(providerInstanceId) !== undefined
    );
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
         WHERE provider_instance_id = ? AND toolkit = ? AND lifecycle_state = 'disconnected' AND removed_at IS NULL
           AND (? IS NULL OR label = ?)
         ORDER BY id
         LIMIT 2`
      )
      .all(providerInstanceId, toolkit, label ?? null, label ?? null) as Array<{ id: string }>;
    return rows.length === 1 ? (rows[0]!.id as ConnectedAccount['id']) : undefined;
  }

  /**
   * Pause or resume local use without overwriting provider authentication
   * status. A pause records who chose it: the owner's always wins, and a
   * sign-in's pause is never recorded over the owner's (see {@link holdForSignIn}).
   */
  setPaused(connectionId: ConnectionId, paused: boolean): void {
    this.assertAvailable();
    this.db
      .update(connections)
      .set({
        enabled: !paused,
        pausedBy: paused ? 'owner' : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connections.id, connectionId))
      .run();
  }

  /**
   * Pause a connected account while a "Sign in again" runs, unless it is
   * already paused (the owner's pause, or another sign-in's, stays as it is).
   */
  holdForSignIn(connectionId: ConnectionId): void {
    this.assertAvailable();
    this.db
      .update(connections)
      .set({ enabled: false, pausedBy: 'sign_in', updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.lifecycleState, 'connected'),
          eq(connections.enabled, true)
        )
      )
      .run();
  }

  /**
   * Lift a sign-in's pause: the account is usable again exactly as it was
   * before the sign-in started. A pause the owner chose is never lifted here.
   *
   * @returns Whether the account was released.
   */
  releaseSignInHold(connectionId: ConnectionId): boolean {
    this.assertAvailable();
    return (
      this.db
        .update(connections)
        .set({ enabled: true, pausedBy: null, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(connections.id, connectionId),
            eq(connections.lifecycleState, 'connected'),
            eq(connections.pausedBy, 'sign_in')
          )
        )
        .run().changes > 0
    );
  }

  /**
   * Move saved accounts from a service id their provider no longer lists them
   * under to the one it does, so each keeps matching its app (a Nango Gmail
   * integration saved as `google-mail` before it joined the popular Gmail row,
   * DOR-2436). Every row of this instance still under an old id moves,
   * disconnected ones included, so reconnecting one later still finds it; a
   * removed row stays as history. A label that was only the old id (the name
   * an account nobody named carries) follows it; a name the person chose stays.
   * One transaction, so no reader sees half the accounts moved.
   *
   * @param instanceId - The provider instance the accounts belong to.
   * @param renames - Old service id → new service id.
   */
  renameServices(
    instanceId: ConnectorProviderInstanceId,
    renames: ReadonlyMap<string, string>
  ): void {
    this.assertAvailable();
    if (renames.size === 0) return;
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const [from, to] of renames) {
        tx.update(connections)
          .set({
            label: sql`CASE WHEN ${connections.label} = ${connections.toolkit} THEN ${to} ELSE ${connections.label} END`,
            toolkit: to,
            updatedAt: now,
          })
          .where(
            and(
              eq(connections.providerInstanceId, instanceId),
              eq(connections.toolkit, from),
              isNull(connections.removedAt)
            )
          )
          .run();
      }
    });
  }

  /** Replace the operator-facing label of one stable connection. */
  setLabel(connectionId: ConnectionId, label: string): void {
    this.assertAvailable();
    this.db
      .update(connections)
      .set({ label, updatedAt: new Date().toISOString() })
      .where(eq(connections.id, connectionId))
      .run();
  }

  /** Tombstone a connection and synchronously revoke local active access. */
  revokeConnection(connectionId: ConnectionId): void {
    this.assertAvailable();
    this.closeConnections([connectionId]);
  }

  /**
   * Close every kept account of one instance that a complete, successful
   * listing from that instance no longer contains: the route cannot reach it,
   * so nothing here can use it and the owner connects the app again. The
   * account may still be live at the service — the listing only shows what
   * this route can reach — so cleanup there is still owed and cannot be done
   * from here: it is recorded as `unknown`, exactly as a local revoke is.
   * Closed, not removed, so the account's history stays. Callers pass only a
   * listing that succeeded in full — a failed or partial read must never
   * reach here.
   *
   * @param instanceId - The instance the listing came from.
   * @param listedRefs - Every account the listing returned.
   * @returns The accounts closed, for the caller's record of it.
   */
  closeUnlistedConnections(
    instanceId: ConnectorProviderInstanceId,
    listedRefs: ReadonlySet<string>
  ): ClosedConnection[] {
    this.assertAvailable();
    const unlisted = this.db
      .select({
        connectionId: connections.id,
        toolkit: connections.toolkit,
        label: connections.label,
        externalAccountRef: connections.externalAccountRef,
      })
      .from(connections)
      .where(
        and(
          eq(connections.providerInstanceId, instanceId),
          eq(connections.lifecycleState, 'connected'),
          isNull(connections.removedAt)
        )
      )
      .all()
      .filter((row) => !listedRefs.has(row.externalAccountRef))
      .map(({ connectionId, toolkit, label }) => ({
        connectionId: connectionId as ConnectionId,
        toolkit,
        label,
      }));
    if (unlisted.length > 0) {
      this.closeConnections(
        unlisted.map((row) => row.connectionId),
        { status: 'revoked', enabled: false }
      );
    }
    return unlisted;
  }

  /**
   * Record the sign-in status a successful account listing from one instance
   * reports for each kept account it lists, and when the service said so
   * (`lastVerifiedAt`). Only the status and that time change: never the label,
   * the app, the owner's pause or whether the account is kept. An account the
   * listing leaves out is untouched, so a partial listing is safe; one it
   * reports mid-sign-in (`pending`) is untouched too. A fact recorded after
   * the listing began (a sign-in finishing, an action the service refused for
   * an ended sign-in) is fresher than the listing and wins over it. Callers
   * pass only a listing that succeeded: a failed one never reaches here.
   *
   * @param instanceId - The instance the listing came from.
   * @param listed - Every account that listing returned.
   * @param listingStartedAt - When the listing was requested (ISO-8601).
   * @returns The accounts whose recorded status changed.
   */
  refreshSignInStatus(
    instanceId: ConnectorProviderInstanceId,
    listed: readonly ProviderConnectedAccount[],
    listingStartedAt: string
  ): SignInStatusChange[] {
    this.assertAvailable();
    const reported = new Map<string, SignInStatus>();
    for (const account of listed) {
      if (isSignInStatus(account.status)) reported.set(account.externalAccountRef, account.status);
    }
    const now = new Date().toISOString();
    // Every account this listing includes is reachable through the instance's
    // current key: that key is the one that can end its access at the service.
    const accountKey = this.storedExecutionConfigDigest(instanceId);
    const listedRefs = [...new Set(listed.map((account) => account.externalAccountRef))];
    if (accountKey !== undefined && listedRefs.length > 0) {
      this.db
        .update(connections)
        .set({ accountKey })
        .where(
          and(
            eq(connections.providerInstanceId, instanceId),
            eq(connections.lifecycleState, 'connected'),
            isNull(connections.removedAt),
            inArray(connections.externalAccountRef, listedRefs)
          )
        )
        .run();
    }
    if (reported.size === 0) return [];
    return this.db.transaction((tx) => {
      const kept = tx
        .select({
          connectionId: connections.id,
          externalAccountRef: connections.externalAccountRef,
          status: connections.status,
          lastVerifiedAt: connections.lastVerifiedAt,
        })
        .from(connections)
        .where(
          and(
            eq(connections.providerInstanceId, instanceId),
            eq(connections.lifecycleState, 'connected'),
            isNull(connections.removedAt)
          )
        )
        .all();
      const changes: SignInStatusChange[] = [];
      for (const row of kept) {
        const status = reported.get(row.externalAccountRef);
        if (status === undefined) continue;
        if (row.lastVerifiedAt !== null && row.lastVerifiedAt > listingStartedAt) continue;
        const changed = row.status !== status;
        tx.update(connections)
          .set({ status, lastVerifiedAt: now, ...(changed && { updatedAt: now }) })
          .where(eq(connections.id, row.connectionId))
          .run();
        if (changed) {
          changes.push({
            connectionId: row.connectionId as ConnectionId,
            from: row.status,
            to: status,
          });
        }
      }
      return changes;
    });
  }

  /**
   * Record that the service refused an action because this account's sign-in
   * has ended. Only a kept account still recorded as signed in changes; the
   * owner's pause and whether the account is kept are left alone.
   *
   * @param connectionId - The account the action used.
   * @param status - What the service reported: expired, or turned off.
   * @returns Whether the recorded status changed.
   */
  markSignInEnded(connectionId: ConnectionId, status: 'expired' | 'revoked'): boolean {
    this.assertAvailable();
    const now = new Date().toISOString();
    const result = this.db
      .update(connections)
      .set({ status, lastVerifiedAt: now, updatedAt: now })
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.status, 'active'),
          eq(connections.lifecycleState, 'connected'),
          isNull(connections.removedAt)
        )
      )
      .run();
    return result.changes > 0;
  }

  /**
   * Mark connections disconnected with their external cleanup `unknown`, and
   * synchronously end every local authority hanging off them: agent
   * attachments, session overrides, grants and event subscriptions.
   */
  private closeConnections(
    ids: readonly ConnectionId[],
    close: { status?: 'revoked'; enabled?: false } = {}
  ): void {
    const now = new Date().toISOString();
    // Read before the connection-wide revoke below ends it, so the owner is
    // told sharing with every agent stopped (ADR 260926-192625).
    const ended = this.db.transaction((tx) => {
      const endedSharing = liveEveryAgentConnections(tx, [...ids]);
      tx.update(connections)
        .set({
          lifecycleState: 'disconnected',
          externalCleanupState: 'unknown',
          ...(close.status && { status: close.status }),
          ...(close.enabled === false && { enabled: false }),
          cleanupGeneration: sql`${connections.cleanupGeneration} + 1`,
          updatedAt: now,
        })
        .where(inArray(connections.id, [...ids]))
        .run();
      tx.delete(agentConnectionAttachments)
        .where(inArray(agentConnectionAttachments.connectionId, [...ids]))
        .run();
      tx.delete(sessionConnectionOverrides)
        .where(inArray(sessionConnectionOverrides.connectionId, [...ids]))
        .run();
      tx.update(connectionOperationGrants)
        .set({ revokedAt: now })
        .where(inArray(connectionOperationGrants.connectionId, [...ids]))
        .run();
      endConnectionAccessLevels(tx, ids);
      tx.update(connectorEventSubscriptions)
        .set({
          enabled: false,
          revokedAt: now,
          scopeVersion: sql`${connectorEventSubscriptions.scopeVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            inArray(connectorEventSubscriptions.connectionId, [...ids]),
            isNull(connectorEventSubscriptions.revokedAt)
          )
        )
        .run();
      return endedSharing;
    });
    notifyEveryAgentEnded(ended, 'disconnected');
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
      endAgentAccessLevels(tx, agentId);
      tx.update(connectorEventSubscriptions)
        .set({
          enabled: false,
          revokedAt: now,
          scopeVersion: sql`${connectorEventSubscriptions.scopeVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(connectorEventSubscriptions.agentId, agentId),
            isNull(connectorEventSubscriptions.revokedAt)
          )
        )
        .run();
    });
    return [...new Set(sessionRows.map((row) => row.sessionId))];
  }

  /**
   * Revoke one agent's authority for one connection while preserving every
   * other agent and connection.
   *
   * @param agentId - Agent losing access.
   * @param connectionId - Exact stable connection being detached.
   */
  removeAgentConnectionAccess(agentId: string, connectionId: ConnectionId): void {
    this.assertAvailable();
    const sessionRows = this.db
      .select({ sessionId: sessionConnectionOverrides.sessionId })
      .from(sessionConnectionOverrides)
      .where(
        and(
          eq(sessionConnectionOverrides.agentId, agentId),
          eq(sessionConnectionOverrides.connectionId, connectionId)
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
            eq(agentConnectionAttachments.connectionId, connectionId)
          )
        )
        .run();
      tx.update(connectionOperationGrants)
        .set({ revokedAt: now })
        .where(and(eq(connectionOperationGrants.connectionId, connectionId), or(...grantOwners)))
        .run();
      endAgentAccessLevels(tx, agentId, connectionId);
      tx.update(connectorEventSubscriptions)
        .set({
          enabled: false,
          revokedAt: now,
          scopeVersion: sql`${connectorEventSubscriptions.scopeVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(connectorEventSubscriptions.agentId, agentId),
            eq(connectorEventSubscriptions.connectionId, connectionId),
            isNull(connectorEventSubscriptions.revokedAt)
          )
        )
        .run();
      tx.delete(sessionConnectionOverrides)
        .where(
          and(
            eq(sessionConnectionOverrides.agentId, agentId),
            eq(sessionConnectionOverrides.connectionId, connectionId)
          )
        )
        .run();
    });
  }

  /**
   * Fence retained legacy consent only while its application migration is unavailable.
   *
   * A successful migration retires the legacy input tables atomically, so the
   * marker becomes unnecessary and this method becomes a no-op. During a failed
   * migration the tables remain intact and the marker prevents a later retry
   * from restoring consent for an agent removed in the meantime.
   */
  recordAgentRemoval(agentId: string): void {
    if (this.migrationResult.status === 'ready') return;
    this.db
      .insert(connectorLegacyAgentRevocations)
      .values({ agentId, revokedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }
}
