/** Durable local-to-hosted managed connector authority synchronization. */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  and,
  agentConnectionAttachments,
  connectionOperationGrants,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorEventSubscriptions,
  connectorProviderInstances,
  connections,
  eq,
  isNull,
  inArray,
  lte,
  or,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import {
  ManagedConnectorAuthorityCommandSchema,
  ManagedConnectorAuthorityCommandStatusSchema,
  type ManagedConnectorAuthorityCommand,
  type ManagedConnectorAuthorityCommandStatus,
  type ManagedConnectorOperationSelector,
} from '@dorkos/shared/connector-managed-schemas';
import type { ConnectionId, ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import type { ManagedConnectorCloudError } from '../../core/auth/cloud-link-client.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type {
  ConnectorManagedLifecyclePort,
  ConnectorManagedLifecycleSyncResult,
} from './lifecycle-service.js';

const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
const STALLED_RETRY_MS = 60 * 60_000;
const STALLED_AFTER_MS = 24 * 60 * 60_000;
const LEASE_MS = 60_000;

type ManagedAuthorityRejectionCode = Extract<
  ManagedConnectorAuthorityCommandStatus,
  { state: 'rejected' }
>['rejectionCode'];

type ConnectorDbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Linked-instance cloud methods needed by authority synchronization. */
export interface ManagedAuthorityCloudPort {
  /** Submit one exact idempotent command. */
  submitConnectorAuthorityCommand(
    command: ManagedConnectorAuthorityCommand,
    signal?: AbortSignal
  ): Promise<ManagedConnectorAuthorityCommandStatus>;
  /** Read a prior command before deciding whether its POST may be repeated. */
  readConnectorAuthorityCommand(
    commandId: string,
    signal?: AbortSignal
  ): Promise<ManagedConnectorAuthorityCommandStatus>;
}

/** Input for replacing one managed agent's complete hosted operation grant set. */
export interface ManagedAgentGrantReplacementInput {
  /** Stable local connection. */
  readonly connectionId: ConnectionId;
  /** Site-owned connection identity held only in the provider binding. */
  readonly managedConnectionId: string;
  /** Named local agent whose complete grant set changes. */
  readonly agentId: string;
  /** Complete sorted and deduplicated provider-neutral selection. */
  readonly revisions: ManagedConnectorOperationSelector[];
  /** Local immutable revision ids paired positionally with `revisions`. */
  readonly operationRevisionIds: string[];
  /** Exact provider registration used to derive the command. */
  readonly providerInstanceId: ConnectorProviderInstanceId;
  /** Exact provider material generation used to derive the command. */
  readonly executionConfigGeneration: number;
  /** Verified connection owner. */
  readonly owner: ConnectorOwnerAuthority;
  /** Request cancellation signal. */
  readonly signal: AbortSignal;
}

/** Construction dependencies for the durable authority outbox. */
export interface ManagedAuthoritySyncServiceOptions {
  /** Canonical local connector database. */
  readonly db: Db;
  /** Linked-instance cloud boundary. */
  readonly cloud: ManagedAuthorityCloudPort;
  /** Deterministic clock seam. */
  readonly now?: () => Date;
  /** Deterministic durable id seam. */
  readonly createId?: () => string;
  /** Deterministic retry-jitter seam in the inclusive range 0..1. */
  readonly random?: () => number;
}

/** Locally closed agent authority and its durable hosted command. */
export interface StagedManagedAgentAccessRemoval {
  /** Exact durable command to deliver after runtime authority is revoked. */
  readonly commandId: string;
}

/** Safe refusal for a managed command whose local binding is no longer current. */
export class ManagedAuthoritySyncError extends Error {
  /** Construct one local managed-authority refusal. */
  constructor(
    readonly code: 'connection_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'ManagedAuthoritySyncError';
  }
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

function canonicalCommand(command: ManagedConnectorAuthorityCommand): string {
  return JSON.stringify(command);
}

function commandHash(commandJson: string): string {
  return createHash('sha256').update(commandJson).digest('hex');
}

function isManagedCloudError(error: unknown): error is ManagedConnectorCloudError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    [
      'unauthorized',
      'permission_upgrade_required',
      'not_found',
      'conflict',
      'network_error',
      'request_failed',
      'invalid_response',
    ].includes(error.code)
  );
}

/** Durable synchronizer shared by managed lifecycle and grant writers. */
export class ManagedAuthoritySyncService implements ConnectorManagedLifecyclePort {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly random: () => number;
  private recoveryRunning = false;

  /** Construct the local managed authority synchronizer. */
  constructor(private readonly options: ManagedAuthoritySyncServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
    this.random = options.random ?? Math.random;
  }

  /** Append and attempt one monotonic hosted lifecycle transition. */
  async transition(input: {
    readonly connectionId: ConnectionId;
    readonly managedConnectionId: string;
    readonly lifecycle: 'active' | 'paused' | 'disconnected';
    readonly providerInstanceId: ConnectorProviderInstanceId;
    readonly executionConfigGeneration: number;
    readonly owner: ConnectorOwnerAuthority;
    readonly signal: AbortSignal;
  }): Promise<ConnectorManagedLifecycleSyncResult> {
    const commandId = this.options.db.transaction((tx) => {
      this.stageLocalLifecycle(tx, input.connectionId, input.lifecycle);
      return this.appendCommandInTransaction(tx, {
        scopeKind: 'connection_lifecycle',
        subjectId: 'connection',
        connectionId: input.connectionId,
        managedConnectionId: input.managedConnectionId,
        providerInstanceId: input.providerInstanceId,
        executionConfigGeneration: input.executionConfigGeneration,
        owner: input.owner,
        command: (base) => ({
          ...base,
          kind: 'set_connection_lifecycle',
          lifecycle: input.lifecycle,
        }),
      });
    });
    return this.deliverClaimed(commandId, input.signal, false);
  }

  /** Append and attempt one complete managed agent-grant replacement. */
  async replaceAgentGrants(
    input: ManagedAgentGrantReplacementInput
  ): Promise<ConnectorManagedLifecycleSyncResult> {
    const commandId = this.options.db.transaction((tx) =>
      this.stageAgentGrantReplacement(tx, input)
    );
    return this.deliverClaimed(commandId, input.signal, false);
  }

  /** Stage close-first local grant changes and their hosted command in one transaction. */
  stageAgentGrantReplacement(
    tx: ConnectorDbTransaction,
    input: Omit<ManagedAgentGrantReplacementInput, 'signal'>
  ): string {
    if (input.revisions.length !== input.operationRevisionIds.length) {
      throw new ManagedAuthoritySyncError(
        'connection_unavailable',
        'The managed action selection changed. Refresh and try again.'
      );
    }
    const byIdentity = new Map<
      string,
      { revision: ManagedConnectorOperationSelector; id: string }
    >();
    input.revisions.forEach((revision, index) => {
      byIdentity.set(
        `${revision.hostedRevisionId}\0${revision.operationSlug}\0${revision.toolkitVersion}\0${revision.schemaHash}`,
        { revision, id: input.operationRevisionIds[index]! }
      );
    });
    if (byIdentity.size !== input.revisions.length) {
      throw new ManagedAuthoritySyncError(
        'connection_unavailable',
        'The managed action selection contains duplicate actions.'
      );
    }
    const ordered = [...byIdentity.values()].sort((a, b) =>
      `${a.revision.hostedRevisionId}\0${a.revision.operationSlug}\0${a.revision.toolkitVersion}\0${a.revision.schemaHash}`.localeCompare(
        `${b.revision.hostedRevisionId}\0${b.revision.operationSlug}\0${b.revision.toolkitVersion}\0${b.revision.schemaHash}`
      )
    );
    const now = this.now().toISOString();
    const selectedIds = new Set(ordered.map((entry) => entry.id));
    const existing = tx
      .select({
        id: connectionOperationGrants.id,
        operationRevisionId: connectionOperationGrants.operationRevisionId,
        revokedAt: connectionOperationGrants.revokedAt,
      })
      .from(connectionOperationGrants)
      .where(
        and(
          eq(connectionOperationGrants.subjectType, 'agent'),
          eq(connectionOperationGrants.subjectId, input.agentId),
          eq(connectionOperationGrants.connectionId, input.connectionId)
        )
      )
      .all();
    for (const grant of existing) {
      if (selectedIds.has(grant.operationRevisionId)) {
        selectedIds.delete(grant.operationRevisionId);
      } else if (grant.revokedAt === null) {
        tx.update(connectionOperationGrants)
          .set({ revokedAt: now })
          .where(eq(connectionOperationGrants.id, grant.id))
          .run();
      }
    }
    for (const operationRevisionId of selectedIds) {
      tx.insert(connectionOperationGrants)
        .values({
          id: this.createId(),
          subjectType: 'agent',
          subjectId: input.agentId,
          agentId: input.agentId,
          connectionId: input.connectionId,
          operationRevisionId,
          createdBy: `owner:${input.owner.kind}:${ownerColumns(input.owner).ownerId}`,
          createdAt: now,
          revokedAt: now,
        })
        .run();
    }
    return this.appendCommandInTransaction(tx, {
      scopeKind: 'agent_grants',
      subjectId: input.agentId,
      connectionId: input.connectionId,
      managedConnectionId: input.managedConnectionId,
      providerInstanceId: input.providerInstanceId,
      executionConfigGeneration: input.executionConfigGeneration,
      owner: input.owner,
      command: (base) => ({
        ...base,
        kind: 'replace_agent_grants',
        agentId: input.agentId,
        revisions: ordered.map((entry) => entry.revision),
      }),
    });
  }

  /** Deliver one already committed grant command. */
  deliverAgentGrantReplacement(
    commandId: string,
    signal: AbortSignal
  ): Promise<ConnectorManagedLifecycleSyncResult> {
    return this.deliverClaimed(commandId, signal, false);
  }

  private stageLocalLifecycle(
    tx: ConnectorDbTransaction,
    connectionId: ConnectionId,
    lifecycle: 'active' | 'paused' | 'disconnected'
  ): void {
    if (lifecycle === 'active') return;
    const now = this.now().toISOString();
    if (lifecycle === 'paused') {
      tx.update(connections)
        .set({ enabled: false, updatedAt: now })
        .where(eq(connections.id, connectionId))
        .run();
      return;
    }
    tx.update(connections)
      .set({ lifecycleState: 'disconnected', enabled: false, updatedAt: now })
      .where(eq(connections.id, connectionId))
      .run();
    tx.delete(agentConnectionAttachments)
      .where(eq(agentConnectionAttachments.connectionId, connectionId))
      .run();
    tx.delete(sessionConnectionOverrides)
      .where(eq(sessionConnectionOverrides.connectionId, connectionId))
      .run();
    tx.update(connectionOperationGrants)
      .set({ revokedAt: now })
      .where(eq(connectionOperationGrants.connectionId, connectionId))
      .run();
    tx.update(connectorEventSubscriptions)
      .set({ enabled: false, updatedAt: now })
      .where(eq(connectorEventSubscriptions.connectionId, connectionId))
      .run();
  }

  /** Atomically close all one-agent authority and append an empty hosted grant replacement. */
  stageAgentAccessRemoval(
    input: Omit<ManagedAgentGrantReplacementInput, 'signal' | 'revisions' | 'operationRevisionIds'>
  ): StagedManagedAgentAccessRemoval {
    return this.options.db.transaction((tx) => {
      const ownedSessionIds = [
        ...new Set(
          tx
            .select({ sessionId: sessionConnectionOverrides.sessionId })
            .from(sessionConnectionOverrides)
            .where(
              and(
                eq(sessionConnectionOverrides.agentId, input.agentId),
                eq(sessionConnectionOverrides.connectionId, input.connectionId)
              )
            )
            .all()
            .map((row) => row.sessionId)
        ),
      ];
      const commandId = this.stageAgentGrantReplacement(tx, {
        ...input,
        revisions: [],
        operationRevisionIds: [],
      });
      tx.delete(agentConnectionAttachments)
        .where(
          and(
            eq(agentConnectionAttachments.agentId, input.agentId),
            eq(agentConnectionAttachments.connectionId, input.connectionId)
          )
        )
        .run();
      if (ownedSessionIds.length > 0) {
        tx.update(connectionOperationGrants)
          .set({ revokedAt: this.now().toISOString() })
          .where(
            and(
              eq(connectionOperationGrants.connectionId, input.connectionId),
              eq(connectionOperationGrants.subjectType, 'session'),
              inArray(connectionOperationGrants.subjectId, ownedSessionIds)
            )
          )
          .run();
      }
      tx.update(connectorEventSubscriptions)
        .set({ enabled: false, updatedAt: this.now().toISOString() })
        .where(
          and(
            eq(connectorEventSubscriptions.agentId, input.agentId),
            eq(connectorEventSubscriptions.connectionId, input.connectionId)
          )
        )
        .run();
      tx.delete(sessionConnectionOverrides)
        .where(
          and(
            eq(sessionConnectionOverrides.agentId, input.agentId),
            eq(sessionConnectionOverrides.connectionId, input.connectionId)
          )
        )
        .run();
      return { commandId };
    });
  }

  /** Recover a bounded batch of pending commands, reading status before any repeated POST. */
  async recoverPending(signal: AbortSignal, limit = 50): Promise<number> {
    if (this.recoveryRunning) return 0;
    this.recoveryRunning = true;
    try {
      const now = this.now();
      const commandIds = this.options.db
        .select({ commandId: connectorManagedAuthorityOutbox.commandId })
        .from(connectorManagedAuthorityOutbox)
        .where(
          and(
            eq(connectorManagedAuthorityOutbox.state, 'pending'),
            or(
              isNull(connectorManagedAuthorityOutbox.nextAttemptAt),
              lte(connectorManagedAuthorityOutbox.nextAttemptAt, now.toISOString())
            ),
            or(
              isNull(connectorManagedAuthorityOutbox.leasedUntil),
              lte(connectorManagedAuthorityOutbox.leasedUntil, now.toISOString())
            )
          )
        )
        .orderBy(connectorManagedAuthorityOutbox.createdAt)
        .limit(Math.max(1, Math.min(limit, 100)))
        .all()
        .map((row) => row.commandId);

      let recovered = 0;
      for (const commandId of commandIds) {
        if (signal.aborted) break;
        const leaseOwner = this.claim(commandId);
        if (!leaseOwner) continue;
        await this.deliver(commandId, leaseOwner, signal, true);
        recovered += 1;
      }
      return recovered;
    } finally {
      this.recoveryRunning = false;
    }
  }

  /** Remove terminal request payloads after retention while preserving scope-version tombstones. */
  compactTerminal(resolvedBefore: string, limit = 100): number {
    const commandIds = this.options.db
      .select({ commandId: connectorManagedAuthorityOutbox.commandId })
      .from(connectorManagedAuthorityOutbox)
      .where(
        and(
          or(
            eq(connectorManagedAuthorityOutbox.state, 'applied'),
            eq(connectorManagedAuthorityOutbox.state, 'rejected'),
            eq(connectorManagedAuthorityOutbox.state, 'superseded')
          ),
          lte(connectorManagedAuthorityOutbox.resolvedAt, resolvedBefore),
          isNull(connectorManagedAuthorityOutbox.compactedAt)
        )
      )
      .orderBy(connectorManagedAuthorityOutbox.resolvedAt)
      .limit(Math.max(1, Math.min(limit, 500)))
      .all()
      .map((row) => row.commandId);
    if (commandIds.length === 0) return 0;
    const compactedAt = this.now().toISOString();
    return this.options.db
      .update(connectorManagedAuthorityOutbox)
      .set({ requestJson: '{}', compactedAt, updatedAt: compactedAt })
      .where(inArray(connectorManagedAuthorityOutbox.commandId, commandIds))
      .run().changes;
  }

  private appendCommand(input: {
    scopeKind: 'agent_grants' | 'connection_lifecycle';
    subjectId: string;
    connectionId: ConnectionId;
    managedConnectionId: string;
    providerInstanceId: ConnectorProviderInstanceId;
    executionConfigGeneration: number;
    owner: ConnectorOwnerAuthority;
    command: (
      base: Pick<
        ManagedConnectorAuthorityCommand,
        'version' | 'commandId' | 'managedConnectionId' | 'scopeVersion'
      >
    ) => ManagedConnectorAuthorityCommand;
  }): string {
    return this.options.db.transaction((tx) => this.appendCommandInTransaction(tx, input));
  }

  private appendCommandInTransaction(
    tx: ConnectorDbTransaction,
    input: {
      scopeKind: 'agent_grants' | 'connection_lifecycle';
      subjectId: string;
      connectionId: ConnectionId;
      managedConnectionId: string;
      providerInstanceId: ConnectorProviderInstanceId;
      executionConfigGeneration: number;
      owner: ConnectorOwnerAuthority;
      command: (
        base: Pick<
          ManagedConnectorAuthorityCommand,
          'version' | 'commandId' | 'managedConnectionId' | 'scopeVersion'
        >
      ) => ManagedConnectorAuthorityCommand;
    }
  ): string {
    const timestamp = this.now().toISOString();
    const owned = ownerColumns(input.owner);
    const connection = tx
      .select({
        providerInstanceId: connectorProviderInstances.id,
        generation: connectorProviderInstances.executionConfigGeneration,
        managedConnectionId: connections.externalAccountRef,
        mode: connectorProviderInstances.mode,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connections.id, input.connectionId))
      .get();
    if (
      !connection ||
      connection.mode !== 'managed' ||
      connection.providerInstanceId !== input.providerInstanceId ||
      connection.generation !== input.executionConfigGeneration ||
      connection.managedConnectionId !== input.managedConnectionId ||
      connection.ownerKind !== owned.ownerKind ||
      connection.ownerId !== owned.ownerId
    ) {
      throw new ManagedAuthoritySyncError(
        'connection_unavailable',
        'The managed connection changed. Refresh and try again.'
      );
    }

    const scope = tx
      .select()
      .from(connectorManagedAuthorityScopes)
      .where(
        and(
          eq(connectorManagedAuthorityScopes.managedConnectionId, input.managedConnectionId),
          eq(connectorManagedAuthorityScopes.scopeKind, input.scopeKind),
          eq(connectorManagedAuthorityScopes.subjectId, input.subjectId)
        )
      )
      .get();
    const scopeVersion = (scope?.scopeVersion ?? 0) + 1;
    const commandId = this.createId();
    const command = ManagedConnectorAuthorityCommandSchema.parse(
      input.command({
        version: 1,
        commandId,
        managedConnectionId: input.managedConnectionId,
        scopeVersion,
      })
    );
    const requestJson = canonicalCommand(command);
    const requestHash = commandHash(requestJson);

    tx.insert(connectorManagedAuthorityOutbox)
      .values({
        commandId,
        connectionId: input.connectionId,
        providerInstanceId: input.providerInstanceId,
        executionConfigGeneration: input.executionConfigGeneration,
        ownerKind: owned.ownerKind,
        ownerId: owned.ownerId,
        managedConnectionId: input.managedConnectionId,
        scopeKind: input.scopeKind,
        subjectId: input.subjectId,
        scopeVersion,
        requestHash,
        requestJson,
        state: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    if (scope) {
      tx.update(connectorManagedAuthorityScopes)
        .set({
          scopeVersion,
          lastCommandId: commandId,
          lastCommandHash: requestHash,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(connectorManagedAuthorityScopes.managedConnectionId, input.managedConnectionId),
            eq(connectorManagedAuthorityScopes.scopeKind, input.scopeKind),
            eq(connectorManagedAuthorityScopes.subjectId, input.subjectId)
          )
        )
        .run();
    } else {
      tx.insert(connectorManagedAuthorityScopes)
        .values({
          managedConnectionId: input.managedConnectionId,
          scopeKind: input.scopeKind,
          subjectId: input.subjectId,
          scopeVersion,
          lastCommandId: commandId,
          lastCommandHash: requestHash,
          updatedAt: timestamp,
        })
        .run();
    }
    return commandId;
  }

  private claim(commandId: string): string | undefined {
    const now = this.now();
    const leaseOwner = this.createId();
    const result = this.options.db
      .update(connectorManagedAuthorityOutbox)
      .set({
        leaseOwner,
        leasedUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          eq(connectorManagedAuthorityOutbox.commandId, commandId),
          eq(connectorManagedAuthorityOutbox.state, 'pending'),
          or(
            isNull(connectorManagedAuthorityOutbox.leasedUntil),
            lte(connectorManagedAuthorityOutbox.leasedUntil, now.toISOString())
          )
        )
      )
      .run();
    return result.changes === 1 ? leaseOwner : undefined;
  }

  private async deliverClaimed(
    commandId: string,
    signal: AbortSignal,
    recoverFirst: boolean
  ): Promise<ConnectorManagedLifecycleSyncResult> {
    const leaseOwner = this.claim(commandId);
    if (!leaseOwner) {
      return {
        authoritySync: { status: 'pending' },
        applied: false,
        externalCleanup: 'not_required',
      };
    }
    return this.deliver(commandId, leaseOwner, signal, recoverFirst);
  }

  private async deliver(
    commandId: string,
    leaseOwner: string,
    signal: AbortSignal,
    recoverFirst: boolean
  ): Promise<ConnectorManagedLifecycleSyncResult> {
    const row = this.options.db
      .select()
      .from(connectorManagedAuthorityOutbox)
      .where(eq(connectorManagedAuthorityOutbox.commandId, commandId))
      .get();
    if (!row) {
      throw new ManagedAuthoritySyncError(
        'connection_unavailable',
        'The managed authority command is no longer available.'
      );
    }
    const command = ManagedConnectorAuthorityCommandSchema.parse(JSON.parse(row.requestJson));
    try {
      let status: ManagedConnectorAuthorityCommandStatus;
      if (recoverFirst) {
        try {
          status = await this.options.cloud.readConnectorAuthorityCommand(commandId, signal);
        } catch (error) {
          if (!isManagedCloudError(error) || error.code !== 'not_found') throw error;
          status = await this.options.cloud.submitConnectorAuthorityCommand(command, signal);
        }
      } else {
        status = await this.options.cloud.submitConnectorAuthorityCommand(command, signal);
      }
      return this.recordStatus(row, leaseOwner, command, status);
    } catch (error) {
      return this.recordFailure(row, leaseOwner, error);
    }
  }

  private recordStatus(
    row: typeof connectorManagedAuthorityOutbox.$inferSelect,
    leaseOwner: string,
    command: ManagedConnectorAuthorityCommand,
    input: ManagedConnectorAuthorityCommandStatus
  ): ConnectorManagedLifecycleSyncResult {
    const status = ManagedConnectorAuthorityCommandStatusSchema.parse(input);
    if (
      status.commandId !== command.commandId ||
      status.managedConnectionId !== command.managedConnectionId ||
      status.scopeVersion !== command.scopeVersion
    ) {
      return this.recordFailure(row, leaseOwner, { code: 'invalid_response' });
    }
    const now = this.now().toISOString();
    const resolution = this.options.db.transaction((tx) => {
      const current = this.isCurrent(tx, row) && this.isBindingCurrent(tx, row, command);
      const state = current ? status.state : 'superseded';
      const safeReason =
        state === 'rejected'
          ? this.rejectionReason(status.state === 'rejected' ? status.rejectionCode : undefined)
          : null;
      const updated = tx
        .update(connectorManagedAuthorityOutbox)
        .set({
          state,
          safeReason,
          attemptCount: row.attemptCount + 1,
          nextAttemptAt: state === 'pending' ? this.nextAttempt(row, now) : null,
          leaseOwner: null,
          leasedUntil: null,
          updatedAt: now,
          resolvedAt: state === 'pending' ? null : now,
        })
        .where(
          and(
            eq(connectorManagedAuthorityOutbox.commandId, row.commandId),
            eq(connectorManagedAuthorityOutbox.state, 'pending'),
            eq(connectorManagedAuthorityOutbox.leaseOwner, leaseOwner)
          )
        )
        .run();
      const committed = updated.changes === 1;
      if (committed && state === 'applied') {
        if (command.kind === 'replace_agent_grants') {
          this.activateCurrentAgentGrants(tx, row, command);
        } else if (command.lifecycle === 'active') {
          tx.update(connections)
            .set({ enabled: true, updatedAt: now })
            .where(eq(connections.id, row.connectionId))
            .run();
        }
      }
      return { state, safeReason, committed };
    });
    const { state, safeReason, committed } = resolution;
    if (!committed) {
      return {
        authoritySync: { status: 'pending' },
        applied: false,
        externalCleanup: 'not_required',
      };
    }
    return {
      authoritySync:
        state === 'applied'
          ? { status: 'ready' }
          : state === 'pending'
            ? { status: 'pending' }
            : {
                status: 'failed',
                reason: safeReason ?? 'A newer connection change replaced this request.',
              },
      applied: state === 'applied',
      externalCleanup:
        state === 'applied' && status.state === 'applied'
          ? status.externalCleanup
          : command.kind === 'set_connection_lifecycle' && command.lifecycle === 'disconnected'
            ? 'pending'
            : 'not_required',
    };
  }

  private recordFailure(
    row: typeof connectorManagedAuthorityOutbox.$inferSelect,
    leaseOwner: string,
    error: unknown
  ): ConnectorManagedLifecycleSyncResult {
    const now = this.now().toISOString();
    const code = isManagedCloudError(error) ? error.code : undefined;
    const terminal =
      code === 'conflict' || code === 'permission_upgrade_required' || code === 'unauthorized';
    const safeReason = this.failureReason(code);
    this.options.db
      .update(connectorManagedAuthorityOutbox)
      .set({
        state: terminal ? 'rejected' : 'pending',
        safeReason,
        attemptCount: row.attemptCount + 1,
        nextAttemptAt: terminal ? null : this.nextAttempt(row, now),
        leaseOwner: null,
        leasedUntil: null,
        updatedAt: now,
        resolvedAt: terminal ? now : null,
      })
      .where(
        and(
          eq(connectorManagedAuthorityOutbox.commandId, row.commandId),
          eq(connectorManagedAuthorityOutbox.state, 'pending'),
          eq(connectorManagedAuthorityOutbox.leaseOwner, leaseOwner)
        )
      )
      .run();
    return {
      authoritySync: terminal ? { status: 'failed', reason: safeReason } : { status: 'pending' },
      applied: false,
      externalCleanup:
        row.scopeKind === 'connection_lifecycle' &&
        ManagedConnectorAuthorityCommandSchema.parse(JSON.parse(row.requestJson)).kind ===
          'set_connection_lifecycle' &&
        JSON.parse(row.requestJson).lifecycle === 'disconnected'
          ? 'pending'
          : 'not_required',
    };
  }

  private isCurrent(
    db: ConnectorDbTransaction | Db,
    row: typeof connectorManagedAuthorityOutbox.$inferSelect
  ): boolean {
    const scope = db
      .select({ lastCommandId: connectorManagedAuthorityScopes.lastCommandId })
      .from(connectorManagedAuthorityScopes)
      .where(
        and(
          eq(connectorManagedAuthorityScopes.managedConnectionId, row.managedConnectionId),
          eq(connectorManagedAuthorityScopes.scopeKind, row.scopeKind),
          eq(connectorManagedAuthorityScopes.subjectId, row.subjectId),
          eq(connectorManagedAuthorityScopes.scopeVersion, row.scopeVersion)
        )
      )
      .get();
    return scope?.lastCommandId === row.commandId;
  }

  private isBindingCurrent(
    db: ConnectorDbTransaction | Db,
    row: typeof connectorManagedAuthorityOutbox.$inferSelect,
    command: ManagedConnectorAuthorityCommand
  ): boolean {
    const binding = db
      .select({
        providerInstanceId: connections.providerInstanceId,
        managedConnectionId: connections.externalAccountRef,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        authenticationStatus: connections.status,
        reconciliationStatus: connections.grantReconciliationStatus,
        generation: connectorProviderInstances.executionConfigGeneration,
        mode: connectorProviderInstances.mode,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connections.id, row.connectionId))
      .get();
    if (
      !binding ||
      binding.providerInstanceId !== row.providerInstanceId ||
      binding.managedConnectionId !== row.managedConnectionId ||
      binding.generation !== row.executionConfigGeneration ||
      binding.mode !== 'managed' ||
      binding.ownerKind !== row.ownerKind ||
      binding.ownerId !== row.ownerId
    ) {
      return false;
    }
    if (command.kind === 'replace_agent_grants') {
      return binding.lifecycleState === 'connected' && binding.enabled;
    }
    if (command.lifecycle === 'disconnected') return binding.lifecycleState === 'disconnected';
    if (command.lifecycle === 'paused') {
      return binding.lifecycleState === 'connected' && !binding.enabled;
    }
    return (
      binding.lifecycleState === 'connected' &&
      binding.authenticationStatus === 'active' &&
      binding.reconciliationStatus === 'ready'
    );
  }

  private activateCurrentAgentGrants(
    tx: ConnectorDbTransaction,
    row: typeof connectorManagedAuthorityOutbox.$inferSelect,
    command: Extract<ManagedConnectorAuthorityCommand, { kind: 'replace_agent_grants' }>
  ): void {
    const identities = new Set(
      command.revisions.map(
        (revision) =>
          `${revision.hostedRevisionId}\0${revision.operationSlug}\0${revision.toolkitVersion}\0${revision.schemaHash}`
      )
    );
    const revisionIds = tx
      .select({
        id: connectorOperationRevisions.id,
        operationSlug: connectorOperationRevisions.operationSlug,
        toolkitVersion: connectorOperationRevisions.toolkitVersion,
        schemaHash: connectorOperationRevisions.schemaHash,
        hostedRevisionId: connectorOperationRevisions.providerRevisionRef,
      })
      .from(connectorOperationRevisions)
      .where(eq(connectorOperationRevisions.providerInstanceId, row.providerInstanceId))
      .all()
      .filter((revision) =>
        identities.has(
          `${revision.hostedRevisionId}\0${revision.operationSlug}\0${revision.toolkitVersion}\0${revision.schemaHash}`
        )
      )
      .map((revision) => revision.id);
    if (!this.isCurrent(tx, row)) return;
    if (revisionIds.length > 0) {
      tx.update(connectionOperationGrants)
        .set({ revokedAt: null })
        .where(
          and(
            eq(connectionOperationGrants.subjectType, 'agent'),
            eq(connectionOperationGrants.subjectId, command.agentId),
            eq(connectionOperationGrants.connectionId, row.connectionId),
            inArray(connectionOperationGrants.operationRevisionId, revisionIds)
          )
        )
        .run();
    }
    const unresolved = tx
      .select({ state: connectorManagedAuthorityOutbox.state })
      .from(connectorManagedAuthorityScopes)
      .innerJoin(
        connectorManagedAuthorityOutbox,
        eq(connectorManagedAuthorityOutbox.commandId, connectorManagedAuthorityScopes.lastCommandId)
      )
      .where(
        and(
          eq(connectorManagedAuthorityOutbox.connectionId, row.connectionId),
          eq(connectorManagedAuthorityScopes.scopeKind, 'agent_grants')
        )
      )
      .all()
      .some((scope) => scope.state !== 'applied');
    if (!unresolved) {
      tx.update(connections)
        .set({ grantReconciliationStatus: 'ready', updatedAt: this.now().toISOString() })
        .where(eq(connections.id, row.connectionId))
        .run();
    }
  }

  private nextAttempt(
    row: typeof connectorManagedAuthorityOutbox.$inferSelect,
    nowIso: string
  ): string {
    const now = Date.parse(nowIso);
    const age = now - Date.parse(row.createdAt);
    const base =
      age >= STALLED_AFTER_MS
        ? STALLED_RETRY_MS
        : Math.min(INITIAL_RETRY_MS * 2 ** row.attemptCount, MAX_RETRY_MS);
    const jitter = 0.8 + Math.max(0, Math.min(this.random(), 1)) * 0.4;
    return new Date(now + Math.round(base * jitter)).toISOString();
  }

  private rejectionReason(code?: ManagedAuthorityRejectionCode): string {
    switch (code) {
      case 'permission_upgrade_required':
        return 'Relink this instance to enable managed connections.';
      case 'revision_unavailable':
        return 'One or more selected actions are no longer available.';
      case 'scope_conflict':
        return 'A newer connection change replaced this request.';
      case 'connection_unavailable':
      default:
        return 'The managed connection is no longer available.';
    }
  }

  private failureReason(code?: string): string {
    switch (code) {
      case 'permission_upgrade_required':
        return 'Relink this instance to enable managed connections.';
      case 'unauthorized':
        return 'This instance is no longer linked.';
      case 'conflict':
        return 'The hosted service refused a conflicting authority command.';
      default:
        return 'Managed connection synchronization is pending.';
    }
  }
}
