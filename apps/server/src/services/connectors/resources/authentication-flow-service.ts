/** Durable owner authentication flows that survive server restarts. */
import { ulid } from 'ulidx';
import {
  and,
  connectorAuthenticationFlows,
  connectorProviderInstances,
  connections,
  eq,
  isNull,
  or,
  type Db,
} from '@dorkos/db';
import {
  ConnectorAuthenticationFlowStateSchema,
  type ConnectorAuthenticationFlowCreateRequest,
  type ConnectorAuthenticationFlowState,
} from '@dorkos/shared/connector-resource-schemas';
import type {
  ConnectionId,
  ConnectorProvider,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-provider';
import { ProviderConnectedAccountSchema } from '@dorkos/shared/connector-provider';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ConnectorRegistry } from '../registry.js';
import { connectorAuthenticationRequestHash } from './authentication-flow-request.js';

const DEFAULT_FLOW_TTL_MS = 15 * 60 * 1_000;

/** Safe durable-flow refusal exposed by the owner resource boundary. */
export class ConnectorAuthenticationFlowError extends Error {
  /** Stable machine-readable refusal. */
  readonly code:
    | 'provider_not_found'
    | 'authentication_unavailable'
    | 'flow_not_found'
    | 'idempotency_conflict'
    | 'connection_not_found'
    | 'connection_cleanup_pending';

  /** Construct one safe authentication-flow error. */
  constructor(code: ConnectorAuthenticationFlowError['code'], message: string) {
    super(message);
    this.name = 'ConnectorAuthenticationFlowError';
    this.code = code;
  }
}

/** Construction options for restart-safe local authentication flows. */
export interface ConnectorAuthenticationFlowServiceOptions {
  /** Canonical connector database. */
  readonly db: Db;
  /** Registered provider instances and stable connection reconciliation. */
  readonly registry: ConnectorRegistry;
  /** Deterministic clock seam. */
  readonly now?: () => Date;
  /** Bounded public flow lifetime. */
  readonly flowTtlMs?: number;
  /** Injectable durable flow id source. */
  readonly createId?: () => string;
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

/** SQLite-backed provider authentication flow coordinator. */
export class ConnectorAuthenticationFlowService {
  private readonly db: Db;
  private readonly registry: ConnectorRegistry;
  private readonly now: () => Date;
  private readonly flowTtlMs: number;
  private readonly createId: () => string;

  /** Construct the durable flow coordinator. */
  constructor(options: ConnectorAuthenticationFlowServiceOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.now = options.now ?? (() => new Date());
    this.flowTtlMs = options.flowTtlMs ?? DEFAULT_FLOW_TTL_MS;
    this.createId = options.createId ?? ulid;
  }

  /** Start or recover one idempotent owner authentication request. */
  async start(
    owner: ConnectorOwnerAuthority,
    input: ConnectorAuthenticationFlowCreateRequest
  ): Promise<ConnectorAuthenticationFlowState> {
    return this.startInternal(owner, input);
  }

  /** Read one owner-bound durable flow without contacting its provider. */
  status(owner: ConnectorOwnerAuthority, flowId: string): ConnectorAuthenticationFlowState {
    return this.currentPublicState(owner, flowId);
  }

  /** Find an owner-bound durable flow by its stable initiation claim without provider I/O. */
  findByIdempotencyKey(
    owner: ConnectorOwnerAuthority,
    idempotencyKey: string
  ): ConnectorAuthenticationFlowState | undefined {
    const ownerKey = ownerColumns(owner);
    const row = this.db
      .select({ id: connectorAuthenticationFlows.id })
      .from(connectorAuthenticationFlows)
      .where(
        and(
          eq(connectorAuthenticationFlows.ownerKind, ownerKey.ownerKind),
          eq(connectorAuthenticationFlows.ownerId, ownerKey.ownerId),
          eq(connectorAuthenticationFlows.idempotencyKey, idempotencyKey)
        )
      )
      .get();
    return row ? this.currentPublicState(owner, row.id) : undefined;
  }

  /** Start or recover one idempotent reconnect for an owned stable connection. */
  async reconnect(
    owner: ConnectorOwnerAuthority,
    connectionId: ConnectionId,
    idempotencyKey: string
  ): Promise<ConnectorAuthenticationFlowState> {
    const owned = this.ownedConnection(owner, connectionId, { includeDisconnected: true });
    if (!owned) {
      throw new ConnectorAuthenticationFlowError('connection_not_found', 'Connection not found.');
    }
    if (
      owned.lifecycleState === 'disconnected' &&
      owned.externalCleanupState !== 'complete' &&
      owned.externalCleanupState !== 'not_required'
    ) {
      throw new ConnectorAuthenticationFlowError(
        'connection_cleanup_pending',
        'Finish disconnecting this account before signing in again.'
      );
    }
    return this.startInternal(
      owner,
      {
        providerInstanceId: owned.providerInstanceId as ConnectorProviderInstanceId,
        toolkit: owned.toolkit,
        label: owned.label,
        idempotencyKey,
      },
      connectionId,
      () => this.registry.setPaused(connectionId, true)
    );
  }

  /** Poll one exact owner flow through its durable private provider binding. */
  async poll(
    owner: ConnectorOwnerAuthority,
    flowId: string
  ): Promise<ConnectorAuthenticationFlowState> {
    let row = this.ownedFlow(owner, flowId);
    if (!row) {
      throw new ConnectorAuthenticationFlowError('flow_not_found', 'Sign-in request not found.');
    }
    if (row.state !== 'starting' && row.state !== 'pending') return this.toPublic(row);

    const now = this.now();
    if (Date.parse(row.expiresAt) <= now.getTime()) {
      this.finishPending(row.id, 'expired', now);
      row = this.ownedFlow(owner, flowId)!;
      return this.toPublic(row);
    }
    if (row.cleanupSnapshotJson === null) {
      this.finishPending(
        row.id,
        'failed',
        now,
        'This saved sign-in can no longer be used. Start a new sign-in from Accounts.'
      );
      return this.toPublic(this.ownedFlow(owner, flowId)!);
    }
    if (row.state === 'starting' || !row.providerFlowId) return this.toPublic(row);

    const provider = this.registry.resolveProviderInstance(
      row.providerInstanceId as ConnectorProviderInstanceId
    );
    if (!provider || !this.sameProviderGeneration(provider, row.executionConfigGeneration)) {
      this.finishPending(
        row.id,
        'failed',
        now,
        'This service setup changed while you were signing in. Start again.'
      );
      return this.toPublic(this.ownedFlow(owner, flowId)!);
    }

    const polledProviderFlowId = row.providerFlowId;
    const result = await provider.pollConnect(polledProviderFlowId);

    // Another poll, boot recovery, expiry, or provider reload may have won
    // while the provider request was in flight. Re-read every live predicate;
    // a stale response never overwrites the first durable terminal result.
    row = this.ownedFlow(owner, flowId);
    if (!row) {
      throw new ConnectorAuthenticationFlowError('flow_not_found', 'Sign-in request not found.');
    }
    if (row.state !== 'pending') return this.toPublic(row);
    const afterPoll = this.now();
    if (Date.parse(row.expiresAt) <= afterPoll.getTime()) {
      this.finishPending(row.id, 'expired', afterPoll, undefined, polledProviderFlowId);
      return this.toPublic(this.ownedFlow(owner, flowId)!);
    }
    const currentProvider = this.ownedProvider(
      owner,
      row.providerInstanceId as ConnectorProviderInstanceId
    );
    if (
      currentProvider !== provider ||
      row.providerFlowId !== polledProviderFlowId ||
      !this.sameProviderGeneration(provider, row.executionConfigGeneration)
    ) {
      this.finishPending(
        row.id,
        'failed',
        afterPoll,
        'This service setup changed while you were signing in. Start again.',
        polledProviderFlowId
      );
      return this.toPublic(this.ownedFlow(owner, flowId)!);
    }
    if (result.status === 'pending') return this.toPublic(row);
    if (result.status === 'failed' || !result.account) {
      this.finishPending(
        row.id,
        'failed',
        afterPoll,
        'The service could not complete sign-in. Try again.',
        polledProviderFlowId
      );
      return this.toPublic(this.ownedFlow(owner, flowId)!);
    }

    const accountResult = ProviderConnectedAccountSchema.safeParse(result.account);
    const capabilities = provider.getCapabilities();
    if (
      !accountResult.success ||
      accountResult.data.toolkit !== row.toolkit ||
      accountResult.data.custody !== capabilities.custody
    ) {
      this.finishPending(
        row.id,
        'failed',
        afterPoll,
        'This sign-in request belongs to a different service setup. Start again from Connections.',
        polledProviderFlowId
      );
      return this.toPublic(this.ownedFlow(owner, flowId)!);
    }

    const accountData = accountResult.data;
    const previous = row.reconnectConnectionId
      ? this.registry.accountBinding(row.reconnectConnectionId as ConnectionId)
      : undefined;
    const sameAccount =
      previous !== undefined &&
      previous.providerInstanceId === provider.instanceId &&
      previous.externalAccountRef === accountData.externalAccountRef;
    const completedAt = this.now().toISOString();
    this.db.transaction(() => {
      if (!this.cleanupSnapshotCurrent(owner, row, accountData.externalAccountRef)) {
        this.finishPending(
          row.id,
          'failed',
          afterPoll,
          'This account changed while you were signing in. Finish disconnecting if needed, then start a new sign-in.',
          polledProviderFlowId
        );
        return;
      }
      const account = this.registry.recordConnect(provider, accountData, {
        allowRemovedReplacement: true,
      });
      if (sameAccount && row.reconnectConnectionId === account.id) {
        this.registry.setPaused(account.id, false);
      }
      const transition = this.db
        .update(connectorAuthenticationFlows)
        .set({
          state: 'connected',
          resultConnectionId: account.id,
          providerFlowId: null,
          authorizeUrl: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(connectorAuthenticationFlows.id, row.id),
            eq(connectorAuthenticationFlows.state, 'pending'),
            eq(connectorAuthenticationFlows.providerFlowId, polledProviderFlowId)
          )
        )
        .run();
      if (transition.changes !== 1) {
        throw new Error('Authentication flow changed before its connection could be recorded.');
      }
    });
    return this.toPublic(this.ownedFlow(owner, flowId)!);
  }

  /** Mark process-interrupted starts unknown without replaying their upstream create. */
  invalidateInterruptedStarts(): number {
    const now = this.now().toISOString();
    return this.db
      .update(connectorAuthenticationFlows)
      .set({
        state: 'start_unknown',
        failureReason:
          'DorkOS restarted before the service confirmed sign-in setup. Check Connections before trying again.',
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(connectorAuthenticationFlows.state, 'starting'))
      .run().changes;
  }

  /** Invalidate reconnects, and all pending checks for a single-account raw toolkit, before close. */
  invalidateConnectionFlows(owner: ConnectorOwnerAuthority, connectionId: ConnectionId): number {
    const ownerKey = ownerColumns(owner);
    const owned = this.ownedConnection(owner, connectionId);
    const rawToolkit =
      owned?.providerType === 'mcp'
        ? and(
            eq(connectorAuthenticationFlows.providerInstanceId, owned.providerInstanceId),
            eq(connectorAuthenticationFlows.toolkit, owned.toolkit)
          )
        : undefined;
    const now = this.now().toISOString();
    return this.db
      .update(connectorAuthenticationFlows)
      .set({
        state: 'failed',
        providerFlowId: null,
        authorizeUrl: null,
        failureReason: 'The connection was closed before authentication completed.',
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(connectorAuthenticationFlows.ownerKind, ownerKey.ownerKind),
          eq(connectorAuthenticationFlows.ownerId, ownerKey.ownerId),
          or(eq(connectorAuthenticationFlows.reconnectConnectionId, connectionId), rawToolkit),
          or(
            eq(connectorAuthenticationFlows.state, 'starting'),
            eq(connectorAuthenticationFlows.state, 'pending')
          )
        )
      )
      .run().changes;
  }

  private async startInternal(
    owner: ConnectorOwnerAuthority,
    input: ConnectorAuthenticationFlowCreateRequest,
    reconnectConnectionId?: ConnectionId,
    afterClaim?: () => void
  ): Promise<ConnectorAuthenticationFlowState> {
    const ownerKey = ownerColumns(owner);
    const hash = connectorAuthenticationRequestHash({
      providerInstanceId: input.providerInstanceId,
      toolkit: input.toolkit,
      ...(input.label !== undefined && { label: input.label }),
      ...(reconnectConnectionId !== undefined && { reconnectConnectionId }),
    });
    const existing = this.db
      .select()
      .from(connectorAuthenticationFlows)
      .where(
        and(
          eq(connectorAuthenticationFlows.ownerKind, ownerKey.ownerKind),
          eq(connectorAuthenticationFlows.ownerId, ownerKey.ownerId),
          eq(connectorAuthenticationFlows.idempotencyKey, input.idempotencyKey)
        )
      )
      .get();
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new ConnectorAuthenticationFlowError(
          'idempotency_conflict',
          'This sign-in request was already used for different account details. Start a new request.'
        );
      }
      return this.currentPublicState(owner, existing.id);
    }

    const provider = this.ownedProvider(owner, input.providerInstanceId);
    if (!provider) {
      throw new ConnectorAuthenticationFlowError(
        'provider_not_found',
        'This service setup option is not available. Choose another option and try again.'
      );
    }
    const authentication = provider.getCapabilities().capabilities.authentication;
    if (authentication.status !== 'available') {
      throw new ConnectorAuthenticationFlowError(
        'authentication_unavailable',
        authentication.reason
      );
    }
    const generation = this.registry.providerExecutionConfigGeneration(provider);
    if (generation === undefined) {
      throw new ConnectorAuthenticationFlowError(
        'provider_not_found',
        'This service setup option is not available. Choose another option and try again.'
      );
    }

    const now = this.now();
    const flowId = this.createId();
    this.db.transaction(() => {
      const cleanupSnapshot = this.captureCleanupSnapshot(
        owner,
        input.providerInstanceId,
        input.toolkit
      );
      if (
        reconnectConnectionId &&
        (!this.ownedConnection(owner, reconnectConnectionId, { includeDisconnected: true }) ||
          cleanupSnapshot[reconnectConnectionId] === undefined)
      ) {
        throw new ConnectorAuthenticationFlowError(
          'connection_cleanup_pending',
          'Finish disconnecting this account before signing in again.'
        );
      }
      this.db
        .insert(connectorAuthenticationFlows)
        .values({
          id: flowId,
          ...ownerKey,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          providerInstanceId: input.providerInstanceId,
          executionConfigGeneration: generation,
          providerFlowId: null,
          toolkit: input.toolkit,
          label: input.label,
          reconnectConnectionId,
          cleanupSnapshotJson: JSON.stringify(cleanupSnapshot),
          state: 'starting',
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + this.flowTtlMs).toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();

      afterClaim?.();
    });

    try {
      const started = await provider.startConnect(
        input.toolkit,
        input.label ? { label: input.label } : undefined
      );
      const afterStart = this.now();
      if (afterStart.getTime() >= now.getTime() + this.flowTtlMs) {
        this.finishPending(flowId, 'expired', afterStart);
      } else if (
        this.ownedProvider(owner, input.providerInstanceId) !== provider ||
        !this.sameProviderGeneration(provider, generation)
      ) {
        this.finishStarting(
          flowId,
          'start_unknown',
          afterStart,
          'This service setup changed while you were signing in. Start again.'
        );
      } else {
        this.db
          .update(connectorAuthenticationFlows)
          .set({
            state: 'pending',
            providerFlowId: started.flowId,
            authorizeUrl: started.authorizeUrl,
            updatedAt: afterStart.toISOString(),
          })
          .where(
            and(
              eq(connectorAuthenticationFlows.id, flowId),
              eq(connectorAuthenticationFlows.state, 'starting')
            )
          )
          .run();
      }
    } catch {
      this.finishStarting(
        flowId,
        'start_unknown',
        this.now(),
        'The service did not confirm whether sign-in started. Check Connections before trying again.'
      );
    }
    return this.toPublic(this.ownedFlow(owner, flowId)!);
  }

  private finishStarting(
    flowId: string,
    state: 'start_unknown',
    now: Date,
    failureReason: string
  ): void {
    this.db
      .update(connectorAuthenticationFlows)
      .set({
        state,
        providerFlowId: null,
        authorizeUrl: null,
        failureReason,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          eq(connectorAuthenticationFlows.id, flowId),
          eq(connectorAuthenticationFlows.state, 'starting')
        )
      )
      .run();
  }

  private finishPending(
    flowId: string,
    state: 'failed' | 'expired',
    now: Date,
    failureReason?: string,
    providerFlowId?: string
  ): void {
    this.db
      .update(connectorAuthenticationFlows)
      .set({
        state,
        providerFlowId: null,
        authorizeUrl: null,
        failureReason: failureReason ?? null,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          eq(connectorAuthenticationFlows.id, flowId),
          or(
            eq(connectorAuthenticationFlows.state, 'starting'),
            eq(connectorAuthenticationFlows.state, 'pending')
          ),
          ...(providerFlowId
            ? [eq(connectorAuthenticationFlows.providerFlowId, providerFlowId)]
            : [])
        )
      )
      .run();
  }

  private currentPublicState(
    owner: ConnectorOwnerAuthority,
    flowId: string
  ): ConnectorAuthenticationFlowState {
    let row = this.ownedFlow(owner, flowId);
    if (!row) {
      throw new ConnectorAuthenticationFlowError('flow_not_found', 'Sign-in request not found.');
    }
    if (row.state === 'starting' || row.state === 'pending') {
      const now = this.now();
      if (row.cleanupSnapshotJson === null) {
        this.finishPending(
          row.id,
          'failed',
          now,
          'This saved sign-in can no longer be used. Start a new sign-in from Accounts.'
        );
        row = this.ownedFlow(owner, flowId)!;
      } else if (Date.parse(row.expiresAt) <= now.getTime()) {
        this.finishPending(row.id, 'expired', now);
        row = this.ownedFlow(owner, flowId)!;
      } else {
        const provider = this.ownedProvider(
          owner,
          row.providerInstanceId as ConnectorProviderInstanceId
        );
        if (!provider || !this.sameProviderGeneration(provider, row.executionConfigGeneration)) {
          this.finishPending(
            row.id,
            'failed',
            now,
            'This service setup changed while you were signing in. Start again.'
          );
          row = this.ownedFlow(owner, flowId)!;
        }
      }
    }
    return this.toPublic(row);
  }

  private ownedProvider(
    owner: ConnectorOwnerAuthority,
    instanceId: ConnectorProviderInstanceId
  ): ConnectorProvider | undefined {
    const ownerKey = ownerColumns(owner);
    const row = this.db
      .select({ id: connectorProviderInstances.id, status: connectorProviderInstances.status })
      .from(connectorProviderInstances)
      .where(
        and(
          eq(connectorProviderInstances.id, instanceId),
          eq(connectorProviderInstances.ownerKind, ownerKey.ownerKind),
          eq(connectorProviderInstances.ownerId, ownerKey.ownerId)
        )
      )
      .get();
    return row?.status === 'available'
      ? this.registry.resolveProviderInstance(instanceId)
      : undefined;
  }

  private captureCleanupSnapshot(
    owner: ConnectorOwnerAuthority,
    providerId: string,
    toolkit: string
  ): Record<string, number> {
    const owned = ownerColumns(owner);
    const rows = this.db
      .select({
        id: connections.id,
        generation: connections.cleanupGeneration,
        state: connections.externalCleanupState,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(connections.providerInstanceId, providerId),
          eq(connections.toolkit, toolkit),
          eq(connectorProviderInstances.ownerKind, owned.ownerKind),
          eq(connectorProviderInstances.ownerId, owned.ownerId)
        )
      )
      .all();
    return Object.fromEntries(
      rows
        .filter((row) => row.state === 'complete' || row.state === 'not_required')
        .map((row) => [row.id, row.generation])
    );
  }

  private cleanupSnapshotCurrent(
    owner: ConnectorOwnerAuthority,
    flow: typeof connectorAuthenticationFlows.$inferSelect,
    externalRef: string
  ): boolean {
    if (flow.cleanupSnapshotJson === null) return false;
    let snapshot: Record<string, unknown>;
    try {
      snapshot = JSON.parse(flow.cleanupSnapshotJson);
    } catch {
      return false;
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
    const owned = ownerColumns(owner);
    const rows = this.db
      .select({
        id: connections.id,
        generation: connections.cleanupGeneration,
        state: connections.externalCleanupState,
        lifecycle: connections.lifecycleState,
        removedAt: connections.removedAt,
        ref: connections.externalAccountRef,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(connections.providerInstanceId, flow.providerInstanceId),
          eq(connections.toolkit, flow.toolkit),
          eq(connectorProviderInstances.ownerKind, owned.ownerKind),
          eq(connectorProviderInstances.ownerId, owned.ownerId)
        )
      )
      .all();
    const acknowledged = (row: (typeof rows)[number]) =>
      snapshot[row.id] === row.generation &&
      (row.state === 'complete' || row.state === 'not_required');
    if (flow.reconnectConnectionId) {
      const target = rows.find((row) => row.id === flow.reconnectConnectionId);
      if (!target || target.removedAt !== null || !acknowledged(target)) return false;
    }
    return rows.filter((row) => row.ref === externalRef).every(acknowledged);
  }

  private ownedConnection(
    owner: ConnectorOwnerAuthority,
    connectionId: ConnectionId,
    options: { includeDisconnected?: boolean } = {}
  ) {
    const ownerKey = ownerColumns(owner);
    return this.db
      .select({
        connectionId: connections.id,
        lifecycleState: connections.lifecycleState,
        externalCleanupState: connections.externalCleanupState,
        providerInstanceId: connectorProviderInstances.id,
        providerType: connectorProviderInstances.type,
        toolkit: connections.toolkit,
        label: connections.label,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(connections.id, connectionId),
          isNull(connections.removedAt),
          ...(options.includeDisconnected ? [] : [eq(connections.lifecycleState, 'connected')]),
          eq(connectorProviderInstances.ownerKind, ownerKey.ownerKind),
          eq(connectorProviderInstances.ownerId, ownerKey.ownerId)
        )
      )
      .get();
  }

  private ownedFlow(owner: ConnectorOwnerAuthority, flowId: string) {
    const ownerKey = ownerColumns(owner);
    return this.db
      .select()
      .from(connectorAuthenticationFlows)
      .where(
        and(
          eq(connectorAuthenticationFlows.id, flowId),
          eq(connectorAuthenticationFlows.ownerKind, ownerKey.ownerKind),
          eq(connectorAuthenticationFlows.ownerId, ownerKey.ownerId)
        )
      )
      .get();
  }

  private sameProviderGeneration(provider: ConnectorProvider, generation: number): boolean {
    return this.registry.providerExecutionConfigGeneration(provider) === generation;
  }

  private toPublic(
    row: NonNullable<ReturnType<ConnectorAuthenticationFlowService['ownedFlow']>>
  ): ConnectorAuthenticationFlowState {
    const base = {
      flowId: row.id,
      providerInstanceId: row.providerInstanceId,
      toolkit: row.toolkit,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
    switch (row.state) {
      case 'starting':
        return ConnectorAuthenticationFlowStateSchema.parse({ ...base, state: row.state });
      case 'pending':
        return ConnectorAuthenticationFlowStateSchema.parse({
          ...base,
          state: row.state,
          ...(row.authorizeUrl ? { authorizeUrl: row.authorizeUrl } : {}),
        });
      case 'connected':
        return ConnectorAuthenticationFlowStateSchema.parse({
          ...base,
          state: row.state,
          connectionId: row.resultConnectionId,
          completedAt: row.completedAt,
        });
      case 'failed':
      case 'start_unknown':
        return ConnectorAuthenticationFlowStateSchema.parse({
          ...base,
          state: row.state,
          reason: row.failureReason,
          completedAt: row.completedAt,
        });
      case 'expired':
        return ConnectorAuthenticationFlowStateSchema.parse({
          ...base,
          state: row.state,
          completedAt: row.completedAt,
        });
    }
  }
}
