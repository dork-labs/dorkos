/** Durable owner authentication flows that survive server restarts. */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  and,
  connectorAuthenticationFlows,
  connectorProviderInstances,
  connections,
  eq,
  or,
  type Db,
} from '@dorkos/db';
import {
  ConnectorAuthenticationFlowStateSchema,
  type ConnectorAuthenticationFlowCreateRequest,
  type ConnectorAuthenticationFlowState,
} from '@dorkos/shared/connector-resource-schemas';
import type {
  ConnectedAccountId,
  ConnectorProvider,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-provider';
import { ProviderConnectedAccountSchema } from '@dorkos/shared/connector-provider';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ConnectorRegistry } from '../registry.js';

const DEFAULT_FLOW_TTL_MS = 15 * 60 * 1_000;

/** Safe durable-flow refusal exposed by the owner resource boundary. */
export class ConnectorAuthenticationFlowError extends Error {
  /** Stable machine-readable refusal. */
  readonly code:
    | 'provider_not_found'
    | 'authentication_unavailable'
    | 'flow_not_found'
    | 'idempotency_conflict'
    | 'connection_not_found';

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

function requestHash(input: {
  providerInstanceId: string;
  toolkit: string;
  label?: string;
  reconnectConnectionId?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        providerInstanceId: input.providerInstanceId,
        toolkit: input.toolkit,
        label: input.label ?? null,
        reconnectConnectionId: input.reconnectConnectionId ?? null,
      })
    )
    .digest('hex');
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
    connectionId: ConnectedAccountId,
    idempotencyKey: string
  ): Promise<ConnectorAuthenticationFlowState> {
    const owned = this.ownedConnection(owner, connectionId);
    if (!owned) {
      throw new ConnectorAuthenticationFlowError(
        'connection_not_found',
        'Connector connection not found.'
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
      throw new ConnectorAuthenticationFlowError(
        'flow_not_found',
        'Authentication flow not found.'
      );
    }
    if (row.state !== 'starting' && row.state !== 'pending') return this.toPublic(row);

    const now = this.now();
    if (Date.parse(row.expiresAt) <= now.getTime()) {
      this.finishPending(row.id, 'expired', now);
      row = this.ownedFlow(owner, flowId)!;
      return this.toPublic(row);
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
        'The provider configuration changed before authentication completed.'
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
      throw new ConnectorAuthenticationFlowError(
        'flow_not_found',
        'Authentication flow not found.'
      );
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
        'The provider configuration changed before authentication completed.',
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
        'The provider could not complete authentication.',
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
        'The provider returned an account for a different connector route.',
        polledProviderFlowId
      );
      return this.toPublic(this.ownedFlow(owner, flowId)!);
    }

    const accountData = accountResult.data;
    const previous = row.reconnectConnectionId
      ? this.registry.accountBinding(row.reconnectConnectionId as ConnectedAccountId)
      : undefined;
    const sameAccount =
      previous !== undefined &&
      previous.providerInstanceId === provider.instanceId &&
      previous.externalAccountRef === accountData.externalAccountRef;
    const completedAt = this.now().toISOString();
    this.db.transaction(() => {
      const account = this.registry.recordConnect(provider, accountData);
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
        failureReason: 'DorkOS restarted before the provider confirmed authentication setup.',
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(connectorAuthenticationFlows.state, 'starting'))
      .run().changes;
  }

  /** Invalidate every active reconnect before its stable connection is closed. */
  invalidateConnectionFlows(
    owner: ConnectorOwnerAuthority,
    connectionId: ConnectedAccountId
  ): number {
    const ownerKey = ownerColumns(owner);
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
          eq(connectorAuthenticationFlows.reconnectConnectionId, connectionId),
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
    reconnectConnectionId?: ConnectedAccountId,
    afterClaim?: () => void
  ): Promise<ConnectorAuthenticationFlowState> {
    const ownerKey = ownerColumns(owner);
    const hash = requestHash({
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
          'This authentication idempotency key belongs to a different request.'
        );
      }
      return this.toPublic(existing);
    }

    const provider = this.ownedProvider(owner, input.providerInstanceId);
    if (!provider) {
      throw new ConnectorAuthenticationFlowError(
        'provider_not_found',
        'Connector provider route not found.'
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
        'Connector provider route not found.'
      );
    }

    const now = this.now();
    const flowId = this.createId();
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
        state: 'starting',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.flowTtlMs).toISOString(),
        updatedAt: now.toISOString(),
      })
      .run();

    try {
      afterClaim?.();
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
          'The provider configuration changed while authentication was starting.'
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
        'The provider did not confirm whether authentication setup started.'
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
      throw new ConnectorAuthenticationFlowError(
        'flow_not_found',
        'Authentication flow not found.'
      );
    }
    if (row.state === 'starting' || row.state === 'pending') {
      const now = this.now();
      if (Date.parse(row.expiresAt) <= now.getTime()) {
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
            'The provider configuration changed before authentication completed.'
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

  private ownedConnection(owner: ConnectorOwnerAuthority, connectionId: ConnectedAccountId) {
    const ownerKey = ownerColumns(owner);
    return this.db
      .select({
        connectionId: connections.id,
        providerInstanceId: connectorProviderInstances.id,
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
          eq(connections.lifecycleState, 'connected'),
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
