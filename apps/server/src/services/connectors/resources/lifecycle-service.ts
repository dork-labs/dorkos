/**
 * Owner lifecycle mutations with local close-first connector authority.
 *
 * The person's choice is final here the moment they make it: disconnecting
 * closes the account locally at once, and removing a disconnected account
 * always works. Whatever is still owed at the service (ending the account's
 * access there) is DorkOS's job, retried in the background
 * ({@link ConnectorLifecycleService.finishOwedCleanups} for an own key, the
 * durable authority outbox for the DorkOS account), and never blocks either.
 */
import {
  and,
  connections,
  connectorProviderInstances,
  eq,
  isNull,
  lte,
  or,
  sql,
  type Db,
} from '@dorkos/db';
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
import {
  CLEANUP_RETRY_DELAYS_MS,
  holdsSignInAtService,
  inFlight,
  publicCleanup,
} from './owed-cleanup.js';

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
    'connection_not_found' | 'managed_sync_unavailable' | 'connection_not_disconnected';

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
  /** Deterministic clock seam. */
  readonly now?: () => Date;
}

// Share the pending operation across service instances using the same database.
// A second delete must not outlive a newer cleanup acknowledgement and sign-in.
const pendingDisconnects = new WeakMap<Db, Map<string, Promise<ConnectorLifecycleResult>>>();

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
  private readonly now: () => Date;

  /** Construct lifecycle mutations over stable local authority. */
  constructor(private readonly options: ConnectorLifecycleServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

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

  /**
   * Remove one disconnected account from inventory without deleting history.
   * It always works: anything still owed at the service stays DorkOS's job,
   * for both kinds of account. An own-key cleanup keeps its background tries
   * ({@link finishOwedCleanups}); a DorkOS-account one keeps its hosted
   * command, which is sent again when the account is linked again if the old
   * link refused it (`restageAfterRelink` includes removed accounts).
   */
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
      const owed =
        row.externalCleanupState !== 'complete' && row.externalCleanupState !== 'not_required';
      this.options.authenticationFlows.invalidateConnectionFlows(owner, parsed);
      tx.update(connections)
        .set({
          removedAt: this.now().toISOString(),
          enabled: false,
          // A new generation stops any sign-in claimed against this account
          // before it was removed. Cleanup still owed keeps its generation, so
          // the background try that finishes it is still the current one.
          ...(!owed && { cleanupGeneration: sql`${connections.cleanupGeneration} + 1` }),
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
    const row = this.ownedConnection(owner, ConnectionIdSchema.parse(connectionId));
    if (!row || row.removedAt !== null) {
      throw new ConnectorLifecycleError('connection_not_found', 'Connection not found.');
    }
    let pending = pendingDisconnects.get(this.options.db);
    if (!pending) {
      pending = new Map();
      pendingDisconnects.set(this.options.db, pending);
    }
    const existing = pending.get(row.connectionId);
    if (existing) return existing;
    let resolve!: (result: ConnectorLifecycleResult) => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<ConnectorLifecycleResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending.set(row.connectionId, operation);
    const release = () => {
      if (pending.get(row.connectionId) === operation) pending.delete(row.connectionId);
    };
    void this.disconnectOwned(owner, row, signal).then(
      (result) => {
        release();
        resolve(result);
      },
      (error: unknown) => {
        release();
        reject(error);
      }
    );
    return operation;
  }

  private async disconnectOwned(
    owner: ConnectorOwnerAuthority,
    row: NonNullable<ReturnType<ConnectorLifecycleService['ownedConnection']>>,
    signal: AbortSignal
  ): Promise<ConnectorLifecycleResult> {
    this.options.authenticationFlows.invalidateConnectionFlows(owner, row.connectionId);
    // Managed staging closes authority and captures its cleanup generation in
    // the outbox; asked again, it reads the pending disconnect's receipt.
    if (row.mode === 'managed' && this.options.managed) {
      const managedSync = this.syncManaged(owner, row, 'disconnected', signal);
      this.options.authorityCleanup.revokeConnection({
        connectionId: row.connectionId,
        reason: 'connection_removed',
      });
      const sync = await managedSync;
      return this.result(row.connectionId, sync.externalCleanup, sync.authoritySync);
    }
    const alreadyClosed = row.lifecycleState === 'disconnected';
    let unconfirmed = false;
    if (!alreadyClosed) {
      // Only the key the account was last seen under can end its access. Not
      // the key set up now (changed, or never seen under it): no try could
      // prove anything, so the end is unconfirmed from the start.
      const currentKey = this.options.registry.storedExecutionConfigDigest(row.providerInstanceId);
      unconfirmed =
        holdsSignInAtService(row) && (row.accountKey === null || row.accountKey !== currentKey);
      this.options.db.transaction((tx) => {
        this.options.registry.recordDisconnect(row.connectionId);
        tx.update(connections)
          .set({
            enabled: false,
            pausedBy: null,
            externalCleanupState: unconfirmed ? 'unknown' : 'pending',
            externalCleanupAttempts: 0,
            externalCleanupRetryAt: null,
            externalCleanupKey: row.accountKey,
          })
          .where(eq(connections.id, row.connectionId))
          .run();
      });
    }
    this.options.authorityCleanup.revokeConnection({
      connectionId: row.connectionId,
      reason: 'connection_removed',
    });
    if (unconfirmed) return this.result(row.connectionId, 'failed');
    if (row.mode === 'managed')
      return this.result(row.connectionId, 'pending', {
        status: 'failed',
        reason: 'Link this installation before finishing account disconnection.',
      });
    // Asked again ("Try again now") for an account already closed: try the
    // cleanup DorkOS still owes, and nothing else. One DorkOS couldn't confirm
    // (`unknown`, e.g. its key changed) or gave up on is not tried again: the
    // person is shown where to end the access themselves.
    if (alreadyClosed && row.externalCleanupState !== 'pending') {
      return this.result(row.connectionId, publicCleanup(row.externalCleanupState));
    }
    return this.result(row.connectionId, await this.tryCleanup(row.connectionId));
  }

  /**
   * Try, in the background, every own-key cleanup that is due: removing a
   * disconnected (or removed) account's access at the service. A way that
   * isn't answering is skipped without counting against the account; it is
   * tried again once the way answers.
   *
   * @param signal - Stops the pass between accounts.
   * @param limit - The most accounts tried in one pass.
   * @returns How many accounts were tried.
   */
  async finishOwedCleanups(signal: AbortSignal, limit = 20): Promise<number> {
    const now = this.now().toISOString();
    const due = this.options.db
      .select({
        connectionId: connections.id,
        providerInstanceId: connections.providerInstanceId,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(connectorProviderInstances.mode, 'byo'),
          eq(connections.lifecycleState, 'disconnected'),
          eq(connections.externalCleanupState, 'pending'),
          or(
            isNull(connections.externalCleanupRetryAt),
            lte(connections.externalCleanupRetryAt, now)
          )
        )
      )
      .limit(Math.max(1, Math.min(limit, 100)))
      .all();
    let tried = 0;
    for (const row of due) {
      if (signal.aborted) break;
      if (
        !this.options.registry.resolveProviderInstance(
          ConnectorProviderInstanceIdSchema.parse(row.providerInstanceId)
        )
      ) {
        continue;
      }
      await this.tryCleanup(ConnectionIdSchema.parse(row.connectionId));
      tried += 1;
    }
    return tried;
  }

  /**
   * One try at removing a disconnected own-key account's access at the
   * service. Success settles it; a failure is scheduled to be tried again
   * ({@link CLEANUP_RETRY_DELAYS_MS}), and after the last try DorkOS stops
   * trying on its own. Every write is bound to the generation the try began
   * under, so a newer sign-in or removal is never overwritten.
   */
  private async tryCleanup(
    connectionId: ConnectionId
  ): Promise<ConnectorLifecycleResult['externalCleanup']> {
    const running = inFlight(this.options.db);
    if (running.has(connectionId)) return 'pending';
    const row = this.options.db
      .select({
        providerInstanceId: connections.providerInstanceId,
        externalAccountRef: connections.externalAccountRef,
        generation: connections.cleanupGeneration,
        attempts: connections.externalCleanupAttempts,
        state: connections.externalCleanupState,
        lifecycleState: connections.lifecycleState,
        key: connections.externalCleanupKey,
        custody: connectorProviderInstances.custody,
        mode: connectorProviderInstances.mode,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connections.id, connectionId))
      .get();
    if (!row || row.lifecycleState !== 'disconnected' || row.state !== 'pending') {
      return row ? publicCleanup(row.state) : 'pending';
    }
    const current = and(
      eq(connections.id, connectionId),
      eq(connections.externalAccountRef, row.externalAccountRef),
      eq(connections.cleanupGeneration, row.generation),
      eq(connections.lifecycleState, 'disconnected'),
      eq(connections.externalCleanupState, 'pending')
    );
    running.add(connectionId);
    try {
      const provider = this.options.registry.resolveProviderInstance(
        ConnectorProviderInstanceIdSchema.parse(row.providerInstanceId)
      );
      if (!provider) return 'pending';
      // Another key can't see this account: its "not found" would read as
      // done while the sign-in lives on. DorkOS can't confirm the end, and
      // says so.
      const key = this.options.registry.storedExecutionConfigDigest(provider.instanceId);
      if (holdsSignInAtService(row) && row.key !== null && key !== row.key) {
        this.options.db
          .update(connections)
          .set({
            externalCleanupState: 'unknown',
            externalCleanupRetryAt: null,
            updatedAt: this.now().toISOString(),
          })
          .where(current)
          .run();
        return 'failed';
      }
      await provider.disconnect(ConnectorExternalAccountRefSchema.parse(row.externalAccountRef));
      const settled = this.options.db
        .update(connections)
        .set({
          externalCleanupState: 'complete',
          externalCleanupRetryAt: null,
          updatedAt: this.now().toISOString(),
        })
        .where(current)
        .run();
      return settled.changes === 1 ? 'complete' : 'pending';
    } catch {
      const attempts = row.attempts + 1;
      const delay = CLEANUP_RETRY_DELAYS_MS[attempts - 1];
      const now = this.now();
      this.options.db
        .update(connections)
        .set({
          externalCleanupAttempts: attempts,
          // Out of tries: DorkOS stops trying on its own, and says so.
          ...(delay === undefined
            ? { externalCleanupState: 'failed' as const, externalCleanupRetryAt: null }
            : { externalCleanupRetryAt: new Date(now.getTime() + delay).toISOString() }),
          updatedAt: now.toISOString(),
        })
        .where(current)
        .run();
      return delay === undefined ? 'failed' : 'pending';
    } finally {
      running.delete(connectionId);
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
          reason:
            'This computer isn’t linked to your DorkOS account, so DorkOS can’t update this account at the service yet.',
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
        accountKey: connections.accountKey,
        authenticationStatus: connections.status,
        reconciliationStatus: connections.grantReconciliationStatus,
        executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
        mode: connectorProviderInstances.mode,
        custody: connectorProviderInstances.custody,
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
