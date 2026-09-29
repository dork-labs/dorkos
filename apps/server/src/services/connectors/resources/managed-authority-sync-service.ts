/** Durable local-to-hosted managed connector authority synchronization. */
import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';
import { ulid } from 'ulidx';
import {
  and,
  agentConnectionAttachments,
  connectionOperationGrants,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorEventSubscriptions,
  connectorEventDefinitions,
  connectorEventBindings,
  sql,
  connectorProviderInstances,
  connections,
  desc,
  eq,
  isNull,
  inArray,
  lt,
  lte,
  or,
  sessionConnectionOverrides,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  type Db,
  type SQL,
} from '@dorkos/db';
import {
  ManagedConnectorAuthorityCommandSchema,
  ManagedConnectorAuthorityCommandStatusSchema,
  type ManagedConnectorAuthorityCommand,
  type ManagedConnectorAuthorityCommandStatus,
  type ManagedConnectorOperationSelector,
} from '@dorkos/shared/connector-managed-schemas';
import {
  ConnectorJsonObjectSchema,
  type ConnectionId,
  type ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-schemas';
import type {
  ManagedConnectorCloudError,
  ManagedConnectorCloudErrorCode,
} from '../../core/auth/cloud-link-client.js';
import { logger } from '../../../lib/logger.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import { everyAgentGrantSubject } from '../every-agent-grants.js';
import type {
  ConnectorManagedLifecyclePort,
  ConnectorManagedLifecycleSyncResult,
} from './lifecycle-service.js';

const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
const STALLED_RETRY_MS = 60 * 60_000;
const STALLED_AFTER_MS = 24 * 60 * 60_000;
const LEASE_MS = 60_000;
/** One delivery (read, then maybe a repeat) must finish well inside its lease. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A command that keeps failing the same way is logged again at most this often. */
const FAILURE_LOG_INTERVAL_MS = 15 * 60_000;

/** Plain reason stored while the hosted side has not finished signing an account out. */
const CLEANUP_PENDING_REASON = 'DorkOS’s servers haven’t finished disconnecting this account.';
/** Plain reason stored while the hosted side holds any other change as still pending. */
const HOSTED_PENDING_REASON = 'DorkOS’s servers haven’t finished this change yet.';
/**
 * The generic text an earlier version stored for every retryable failure. It
 * says nothing a person can use, so a reader treats a row carrying it as having
 * no reason at all.
 */
export const LEGACY_PENDING_REASON = 'Managed connection synchronization is pending.';

/** Why one delivery attempt did not settle, in terms a log line and a reason can use. */
interface DeliveryFailure {
  readonly code: ManagedConnectorCloudErrorCode | 'timeout' | 'interrupted' | 'local_error';
  /** HTTP status of the hosted response, when there was one. */
  readonly status?: number;
  /** The thrown error's class name, for a failure that happened on this computer. */
  readonly errorName?: string;
}

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

/** Input for replacing one managed connection's complete every-agent grant set. */
export interface ManagedEveryAgentGrantReplacementInput extends Omit<
  ManagedAgentGrantReplacementInput,
  'agentId'
> {
  /** Recorded author of newly inserted local rows. */
  readonly createdBy: string;
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
  /** Deadline seam for one delivery; defaults to `AbortSignal.timeout`. */
  readonly timeoutSignal?: (timeoutMs: number) => AbortSignal;
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

function isManagedCloudError(
  error: unknown
): error is Pick<ManagedConnectorCloudError, 'code' | 'status'> {
  return (
    typeof error === 'object' &&
    error !== null &&
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

/** One selected hosted revision paired with its local immutable revision id. */
interface OrderedRevision {
  readonly revision: ManagedConnectorOperationSelector;
  readonly id: string;
}

function selectorKey(revision: ManagedConnectorOperationSelector): string {
  return `${revision.hostedRevisionId}\0${revision.operationSlug}\0${revision.toolkitVersion}\0${revision.schemaHash}`;
}

/**
 * Pair, deduplicate-check and canonically order one complete selection, so the
 * same set always produces the same command bytes.
 */
function orderedSelection(input: {
  readonly revisions: readonly ManagedConnectorOperationSelector[];
  readonly operationRevisionIds: readonly string[];
}): OrderedRevision[] {
  if (input.revisions.length !== input.operationRevisionIds.length) {
    throw new ManagedAuthoritySyncError(
      'connection_unavailable',
      'The managed action selection changed. Refresh and try again.'
    );
  }
  const byIdentity = new Map<string, OrderedRevision>();
  input.revisions.forEach((revision, index) => {
    byIdentity.set(selectorKey(revision), { revision, id: input.operationRevisionIds[index]! });
  });
  if (byIdentity.size !== input.revisions.length) {
    throw new ManagedAuthoritySyncError(
      'connection_unavailable',
      'The managed action selection contains duplicate actions.'
    );
  }
  return [...byIdentity.values()].sort((a, b) =>
    selectorKey(a.revision).localeCompare(selectorKey(b.revision))
  );
}

/** Durable synchronizer shared by managed lifecycle and grant writers. */
export class ManagedAuthoritySyncService implements ConnectorManagedLifecyclePort {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly random: () => number;
  private readonly timeoutSignal: (timeoutMs: number) => AbortSignal;
  private recoveryRunning = false;
  /** Last failure logged per command, so a long outage logs a line, not a flood. */
  private readonly failureLog = new Map<string, { signature: string; loggedAt: number }>();

  /** Construct the local managed authority synchronizer. */
  constructor(private readonly options: ManagedAuthoritySyncServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
    this.random = options.random ?? Math.random;
    this.timeoutSignal = options.timeoutSignal ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
  }

  /** Synchronize one exact stored receive generation through the existing authority outbox. */
  async reconcileEventSubscription(
    subscriptionId: string,
    subscriptionVersion: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const commandId = this.stageEventSubscription(subscriptionId, subscriptionVersion);
    if (!commandId) return false;
    if (!this.eventSubscriptionReady(subscriptionId, subscriptionVersion))
      await this.deliverClaimed(commandId, signal, true);
    return this.eventSubscriptionReady(subscriptionId, subscriptionVersion);
  }

  private stageEventSubscription(
    subscriptionId: string,
    subscriptionVersion: number
  ): string | undefined {
    const selected = this.eventSelection(subscriptionId, subscriptionVersion);
    if (!selected) return undefined;
    return this.options.db.transaction((tx) => {
      const prior = tx
        .select({ row: connectorManagedAuthorityOutbox })
        .from(connectorManagedAuthorityScopes)
        .innerJoin(
          connectorManagedAuthorityOutbox,
          eq(
            connectorManagedAuthorityOutbox.commandId,
            connectorManagedAuthorityScopes.lastCommandId
          )
        )
        .where(
          and(
            eq(connectorManagedAuthorityScopes.managedConnectionId, selected.managedConnectionId),
            eq(connectorManagedAuthorityScopes.scopeKind, 'event_subscription'),
            eq(connectorManagedAuthorityScopes.subjectId, subscriptionId)
          )
        )
        .get()?.row;
      if (prior) {
        const parsed = ManagedConnectorAuthorityCommandSchema.safeParse(
          JSON.parse(prior.requestJson)
        );
        if (
          parsed.success &&
          parsed.data.kind === 'set_event_subscription' &&
          parsed.data.subscriptionVersion === subscriptionVersion
        )
          return prior.commandId;
      }
      return this.appendCommandInTransaction(tx, {
        scopeKind: 'event_subscription',
        subjectId: subscriptionId,
        connectionId: selected.connectionId as ConnectionId,
        managedConnectionId: selected.managedConnectionId,
        providerInstanceId: selected.providerInstanceId as ConnectorProviderInstanceId,
        executionConfigGeneration: selected.generation,
        owner: selected.owner,
        command: (base) => ({ ...base, ...selected.command }),
      });
    });
  }

  private stageEventRevocations(limit: number): void {
    const rows = this.options.db.$client
      .prepare(
        `SELECT s.id, s.scope_version FROM connector_event_subscriptions s
      JOIN connections c ON c.id = s.connection_id JOIN connector_provider_instances p ON p.id = c.provider_instance_id
      WHERE p.mode = 'managed' AND s.revoked_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM connector_managed_authority_scopes scope JOIN connector_managed_authority_outbox o ON o.command_id = scope.last_command_id
        WHERE scope.managed_connection_id = c.external_account_ref AND scope.scope_kind = 'event_subscription' AND scope.subject_id = s.id
        AND json_extract(o.request_json, '$.subscriptionVersion') = s.scope_version AND json_extract(o.request_json, '$.enabled') = 0
      ) ORDER BY s.updated_at LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 100))) as Array<{ id: string; scope_version: number }>;
    for (const row of rows) this.stageEventSubscription(row.id, row.scope_version);
  }

  /** Exact applied event receipt, never an arbitrary successful authority response. */
  eventSubscriptionReady(subscriptionId: string, subscriptionVersion: number): boolean {
    const selected = this.eventSelection(subscriptionId, subscriptionVersion);
    if (!selected) return false;
    const row = this.options.db
      .select({ row: connectorManagedAuthorityOutbox })
      .from(connectorManagedAuthorityScopes)
      .innerJoin(
        connectorManagedAuthorityOutbox,
        eq(connectorManagedAuthorityOutbox.commandId, connectorManagedAuthorityScopes.lastCommandId)
      )
      .where(
        and(
          eq(connectorManagedAuthorityScopes.managedConnectionId, selected.managedConnectionId),
          eq(connectorManagedAuthorityScopes.scopeKind, 'event_subscription'),
          eq(connectorManagedAuthorityScopes.subjectId, subscriptionId)
        )
      )
      .get()?.row;
    if (!row || row.state !== 'applied') return false;
    const parsed = ManagedConnectorAuthorityCommandSchema.safeParse(JSON.parse(row.requestJson));
    return (
      parsed.success &&
      parsed.data.kind === 'set_event_subscription' &&
      parsed.data.subscriptionVersion === subscriptionVersion &&
      this.isCurrent(this.options.db, row) &&
      this.isBindingCurrent(this.options.db, row, parsed.data)
    );
  }

  private eventSelection(subscriptionId: string, subscriptionVersion: number) {
    const row = this.options.db
      .select({
        subscription: connectorEventSubscriptions,
        definition: connectorEventDefinitions,
        connection: connections,
        provider: connectorProviderInstances,
      })
      .from(connectorEventSubscriptions)
      .innerJoin(connections, eq(connections.id, connectorEventSubscriptions.connectionId))
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .innerJoin(
        connectorEventDefinitions,
        eq(connectorEventDefinitions.id, connectorEventSubscriptions.definitionId)
      )
      .where(
        and(
          eq(connectorEventSubscriptions.id, subscriptionId),
          eq(connectorEventSubscriptions.scopeVersion, subscriptionVersion),
          eq(connectorProviderInstances.mode, 'managed')
        )
      )
      .get();
    if (
      !row ||
      !row.provider.ownerId ||
      !row.provider.ownerKind ||
      !row.definition.providerDefinitionRef
    )
      return undefined;
    const { subscription, connection, provider, definition } = row;
    return {
      connectionId: connection.id,
      managedConnectionId: connection.externalAccountRef,
      providerInstanceId: provider.id,
      generation: provider.executionConfigGeneration,
      owner:
        provider.ownerKind === 'user'
          ? { kind: 'user' as const, userId: provider.ownerId! }
          : { kind: 'local_install' as const, installationId: provider.ownerId! },
      command: {
        kind: 'set_event_subscription' as const,
        subscriptionId,
        subscriptionVersion,
        hostedDefinitionId: definition.providerDefinitionRef,
        agentId: subscription.agentId,
        destination: { kind: subscription.destinationKind, id: subscription.destinationId },
        filter: ConnectorJsonObjectSchema.parse(JSON.parse(subscription.filterJson)),
        enabled: subscription.revokedAt === null,
      },
    };
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
    // A pending disconnect already owns cleanup of this exact binding. Retrying
    // reads its receipt rather than issuing another delete that could finish late.
    if (input.lifecycle === 'disconnected') {
      const owned = ownerColumns(input.owner);
      const pending = this.options.db
        .select()
        .from(connectorManagedAuthorityOutbox)
        .where(
          and(
            eq(connectorManagedAuthorityOutbox.connectionId, input.connectionId),
            eq(connectorManagedAuthorityOutbox.state, 'pending'),
            eq(connectorManagedAuthorityOutbox.scopeKind, 'connection_lifecycle'),
            eq(connectorManagedAuthorityOutbox.ownerKind, owned.ownerKind),
            eq(connectorManagedAuthorityOutbox.ownerId, owned.ownerId),
            eq(connectorManagedAuthorityOutbox.providerInstanceId, input.providerInstanceId),
            eq(
              connectorManagedAuthorityOutbox.executionConfigGeneration,
              input.executionConfigGeneration
            ),
            eq(connectorManagedAuthorityOutbox.managedConnectionId, input.managedConnectionId)
          )
        )
        .all()
        .find((row) => {
          const command = ManagedConnectorAuthorityCommandSchema.parse(JSON.parse(row.requestJson));
          return (
            command.kind === 'set_connection_lifecycle' &&
            command.lifecycle === 'disconnected' &&
            this.isCurrent(this.options.db, row) &&
            this.isBindingCurrent(this.options.db, row, command)
          );
        });
      if (pending) {
        const result = await this.deliverClaimed(pending.commandId, input.signal, true);
        return {
          ...result,
          externalCleanup:
            result.externalCleanup === 'not_required' ? 'pending' : result.externalCleanup,
        };
      }
    }
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
    const ordered = orderedSelection(input);
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

  /**
   * Stage one complete owner-wide every-agent replacement (ADR 260926-192625,
   * DOR-2439) and its hosted command in the caller's transaction.
   *
   * Close-first, exactly like a named-agent replacement: a revision left out
   * stops at once, and a newly shared one stays off until hosted authority
   * applies the command. An empty selection ends the sharing.
   */
  stageEveryAgentGrantReplacement(
    tx: ConnectorDbTransaction,
    input: Omit<ManagedEveryAgentGrantReplacementInput, 'signal'>
  ): string {
    const ordered = orderedSelection(input);
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
          everyAgentGrantSubject(),
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
          subjectType: 'every_agent',
          subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
          agentId: null,
          connectionId: input.connectionId,
          operationRevisionId,
          createdBy: input.createdBy,
          createdAt: now,
          revokedAt: now,
        })
        .run();
    }
    return this.appendCommandInTransaction(tx, {
      scopeKind: 'every_agent_grants',
      subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
      connectionId: input.connectionId,
      managedConnectionId: input.managedConnectionId,
      providerInstanceId: input.providerInstanceId,
      executionConfigGeneration: input.executionConfigGeneration,
      owner: input.owner,
      command: (base) => ({
        ...base,
        kind: 'replace_every_agent_grants',
        revisions: ordered.map((entry) => entry.revision),
      }),
    });
  }

  /** Deliver one already committed grant command, named-agent or every-agent. */
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
        .set({ enabled: false, pausedBy: 'owner', updatedAt: now })
        .where(eq(connections.id, connectionId))
        .run();
      return;
    }
    tx.update(connections)
      .set({
        lifecycleState: 'disconnected',
        enabled: false,
        externalCleanupState: 'pending',
        cleanupGeneration: sql`${connections.cleanupGeneration} + 1`,
        updatedAt: now,
      })
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
      .set({
        enabled: false,
        revokedAt: now,
        scopeVersion: sql`${connectorEventSubscriptions.scopeVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(connectorEventSubscriptions.connectionId, connectionId),
          isNull(connectorEventSubscriptions.revokedAt)
        )
      )
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
        .set({
          enabled: false,
          revokedAt: this.now().toISOString(),
          scopeVersion: sql`${connectorEventSubscriptions.scopeVersion} + 1`,
          updatedAt: this.now().toISOString(),
        })
        .where(
          and(
            eq(connectorEventSubscriptions.agentId, input.agentId),
            eq(connectorEventSubscriptions.connectionId, input.connectionId),
            isNull(connectorEventSubscriptions.revokedAt)
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
      this.stageEventRevocations(limit);
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
          isNull(connectorManagedAuthorityOutbox.compactedAt),
          sql`NOT (${connectorManagedAuthorityOutbox.scopeKind} = 'event_subscription' AND EXISTS (SELECT 1 FROM connector_managed_authority_scopes current_scope WHERE current_scope.last_command_id = ${connectorManagedAuthorityOutbox.commandId}))`
        )
      )
      .orderBy(connectorManagedAuthorityOutbox.resolvedAt)
      .limit(Math.max(1, Math.min(limit, 500)))
      .all()
      .map((row) => row.commandId);
    if (commandIds.length === 0) return 0;
    const compactedAt = this.now().toISOString();
    for (const commandId of commandIds) this.failureLog.delete(commandId);
    return this.options.db
      .update(connectorManagedAuthorityOutbox)
      .set({ requestJson: '{}', compactedAt, updatedAt: compactedAt })
      .where(inArray(connectorManagedAuthorityOutbox.commandId, commandIds))
      .run().changes;
  }

  /**
   * Send again, in the caller's transaction, the changes the hosted side
   * refused (or never applied) for one account, bound to its current link.
   *
   * - `relinked` — the DorkOS account was linked again: every change refused
   *   because the link was gone (or needed linking again), and every change
   *   the old link never applied, goes again as the owner last saved it, so
   *   the same account keeps the access it was given. When anything changed
   *   that agent's access here since (it was removed, say), what it holds now
   *   goes instead: nothing sent is ever wider than the owner's latest choice.
   *   A disconnect still owed goes again even for an account removed from
   *   the owner's list, so DorkOS still ends its access at the service.
   * - `confirmed` — the owner confirmed who can use the account: every
   *   refused change is settled with exactly the access the owner was shown
   *   (what each agent holds now), never the refused selection. An agent the
   *   owner just decided for already has a newer change pending, so it is
   *   not refused any more and is left alone.
   *
   * A change for an account the service no longer has is never sent again.
   * Nothing is sent for a scope whose current state can't be expressed (an
   * action that is gone locally too).
   *
   * @returns The commands to deliver after the transaction commits.
   */
  restageRefused(
    tx: ConnectorDbTransaction,
    input: {
      readonly connectionId: ConnectionId;
      readonly why: 'relinked' | 'confirmed';
    }
  ): string[] {
    const binding = tx
      .select({
        managedConnectionId: connections.externalAccountRef,
        providerInstanceId: connections.providerInstanceId,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        cleanupState: connections.externalCleanupState,
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
      .where(eq(connections.id, input.connectionId))
      .get();
    if (!binding || binding.mode !== 'managed' || !binding.ownerKind || !binding.ownerId) return [];
    const owner: ConnectorOwnerAuthority =
      binding.ownerKind === 'user'
        ? { kind: 'user', userId: binding.ownerId }
        : { kind: 'local_install', installationId: binding.ownerId };
    const providerInstanceId = binding.providerInstanceId as ConnectorProviderInstanceId;
    const base = {
      connectionId: input.connectionId,
      managedConnectionId: binding.managedConnectionId,
      providerInstanceId,
      executionConfigGeneration: binding.generation,
      owner,
    };
    const scopes = tx
      .select({
        scopeKind: connectorManagedAuthorityOutbox.scopeKind,
        subjectId: connectorManagedAuthorityOutbox.subjectId,
        state: connectorManagedAuthorityOutbox.state,
        rejectionCode: connectorManagedAuthorityOutbox.rejectionCode,
        generation: connectorManagedAuthorityOutbox.executionConfigGeneration,
        requestJson: connectorManagedAuthorityOutbox.requestJson,
        compactedAt: connectorManagedAuthorityOutbox.compactedAt,
        createdAt: connectorManagedAuthorityOutbox.createdAt,
      })
      .from(connectorManagedAuthorityScopes)
      .innerJoin(
        connectorManagedAuthorityOutbox,
        eq(connectorManagedAuthorityOutbox.commandId, connectorManagedAuthorityScopes.lastCommandId)
      )
      .where(
        and(
          eq(connectorManagedAuthorityScopes.managedConnectionId, binding.managedConnectionId),
          inArray(connectorManagedAuthorityScopes.scopeKind, [
            'agent_grants',
            'every_agent_grants',
            'connection_lifecycle',
          ])
        )
      )
      .all();
    const commandIds: string[] = [];
    for (const scope of scopes) {
      if (!sendAgain(scope, input.why, binding.generation)) continue;
      const command =
        scope.compactedAt === null
          ? ManagedConnectorAuthorityCommandSchema.parse(JSON.parse(scope.requestJson))
          : undefined;
      if (scope.scopeKind === 'connection_lifecycle') {
        // Only a close is sent again: a disconnect still owed at the service,
        // or a pause still in place here. A refused resume stays paused, and
        // Resume is the one fix readiness offers for it.
        if (command?.kind !== 'set_connection_lifecycle') continue;
        const owed =
          command.lifecycle === 'disconnected' &&
          binding.lifecycleState === 'disconnected' &&
          (binding.cleanupState === 'pending' || binding.cleanupState === 'failed');
        const paused =
          command.lifecycle === 'paused' &&
          binding.lifecycleState === 'connected' &&
          !binding.enabled;
        if (!owed && !paused) continue;
        commandIds.push(
          this.appendCommandInTransaction(tx, {
            ...base,
            scopeKind: 'connection_lifecycle',
            subjectId: 'connection',
            command: (next) => ({
              ...next,
              kind: 'set_connection_lifecycle',
              lifecycle: command.lifecycle,
            }),
          })
        );
        continue;
      }
      // A grant change is only current while the account is on (see isBindingCurrent).
      if (binding.lifecycleState !== 'connected' || !binding.enabled) continue;
      const everyAgent = scope.scopeKind === 'every_agent_grants';
      const subject = everyAgent ? undefined : scope.subjectId;
      // The owner's last saved choice goes again only after a relink, only
      // while nothing has changed this agent's access since, and only when
      // the service still offers its actions. Otherwise what the agent holds
      // now goes: never more than the owner last saw.
      const saved =
        input.why === 'relinked' &&
        command &&
        scope.rejectionCode !== 'revision_unavailable' &&
        (command.kind === 'replace_agent_grants' ||
          command.kind === 'replace_every_agent_grants') &&
        !this.accessChangedSince(tx, input.connectionId, subject, scope.createdAt)
          ? this.localSelection(tx, providerInstanceId, command.revisions)
          : undefined;
      const selection = saved ?? this.liveSelection(tx, input.connectionId, subject);
      if (!selection) continue;
      commandIds.push(
        everyAgent
          ? this.stageEveryAgentGrantReplacement(tx, {
              ...base,
              ...selection,
              createdBy: `owner:${owner.kind}:${binding.ownerId}`,
            })
          : this.stageAgentGrantReplacement(tx, { ...base, ...selection, agentId: scope.subjectId })
      );
    }
    return commandIds;
  }

  /**
   * After the DorkOS account was linked again: send again, for every account
   * connected through it, what the old link refused or never applied (see
   * {@link restageRefused}), then deliver it.
   *
   * @param providerInstanceId - The DorkOS account's instance.
   * @param signal - Stops delivery between commands.
   * @returns How many changes were sent again.
   */
  async restageAfterRelink(
    providerInstanceId: ConnectorProviderInstanceId,
    signal: AbortSignal
  ): Promise<number> {
    const accounts = this.options.db
      .select({ id: connections.id })
      .from(connections)
      // Removed accounts too: a disconnect still owed at the service is sent
      // again for them (their grant changes are skipped: they are closed).
      .where(eq(connections.providerInstanceId, providerInstanceId))
      .all();
    const commandIds = this.options.db.transaction((tx) =>
      accounts.flatMap((account) =>
        this.restageRefused(tx, { connectionId: account.id as ConnectionId, why: 'relinked' })
      )
    );
    for (const commandId of commandIds) {
      if (signal.aborted) break;
      await this.deliverClaimed(commandId, signal, false);
    }
    return commandIds.length;
  }

  /**
   * The local revision ids of one refused selection, paired with it, when
   * every one of its actions is still known here.
   */
  private localSelection(
    tx: ConnectorDbTransaction,
    providerInstanceId: ConnectorProviderInstanceId,
    revisions: readonly ManagedConnectorOperationSelector[]
  ):
    { revisions: ManagedConnectorOperationSelector[]; operationRevisionIds: string[] } | undefined {
    const byIdentity = new Map(
      tx
        .select({
          id: connectorOperationRevisions.id,
          operationSlug: connectorOperationRevisions.operationSlug,
          toolkitVersion: connectorOperationRevisions.toolkitVersion,
          schemaHash: connectorOperationRevisions.schemaHash,
          hostedRevisionId: connectorOperationRevisions.providerRevisionRef,
        })
        .from(connectorOperationRevisions)
        .where(eq(connectorOperationRevisions.providerInstanceId, providerInstanceId))
        .all()
        .map((revision) => [selectorKey(revision), revision.id])
    );
    const operationRevisionIds = revisions.map((revision) => byIdentity.get(selectorKey(revision)));
    if (operationRevisionIds.some((id) => id === undefined)) return undefined;
    return { revisions: [...revisions], operationRevisionIds: operationRevisionIds as string[] };
  }

  /**
   * Whether anything changed one agent's (or every agent's) access to an
   * account after a command was staged: a grant given or taken away later.
   */
  private accessChangedSince(
    tx: ConnectorDbTransaction,
    connectionId: ConnectionId,
    agentId: string | undefined,
    since: string
  ): boolean {
    return (
      tx
        .select({ id: connectionOperationGrants.id })
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.connectionId, connectionId),
            agentId === undefined
              ? everyAgentGrantSubject()
              : and(
                  eq(connectionOperationGrants.subjectType, 'agent'),
                  eq(connectionOperationGrants.subjectId, agentId)
                ),
            or(
              sql`${connectionOperationGrants.createdAt} > ${since}`,
              sql`${connectionOperationGrants.revokedAt} > ${since}`
            )
          )
        )
        .get() !== undefined
    );
  }

  /** The actions one agent (or every agent) holds on an account right now, as a selection. */
  private liveSelection(
    tx: ConnectorDbTransaction,
    connectionId: ConnectionId,
    agentId: string | undefined
  ): { revisions: ManagedConnectorOperationSelector[]; operationRevisionIds: string[] } {
    const rows = tx
      .select({
        id: connectorOperationRevisions.id,
        operationSlug: connectorOperationRevisions.operationSlug,
        toolkitVersion: connectorOperationRevisions.toolkitVersion,
        schemaHash: connectorOperationRevisions.schemaHash,
        hostedRevisionId: connectorOperationRevisions.providerRevisionRef,
      })
      .from(connectionOperationGrants)
      .innerJoin(
        connectorOperationRevisions,
        eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
      )
      .where(
        and(
          eq(connectionOperationGrants.connectionId, connectionId),
          isNull(connectionOperationGrants.revokedAt),
          agentId === undefined
            ? everyAgentGrantSubject()
            : and(
                eq(connectionOperationGrants.subjectType, 'agent'),
                eq(connectionOperationGrants.subjectId, agentId)
              )
        )
      )
      .all();
    return {
      revisions: rows.map((row) => ({
        operationSlug: row.operationSlug,
        toolkitVersion: row.toolkitVersion,
        schemaHash: row.schemaHash,
        hostedRevisionId: row.hostedRevisionId,
      })),
      operationRevisionIds: rows.map((row) => row.id),
    };
  }

  /**
   * The hosted side refused a change with `connection_unavailable`. What that
   * means depends on the change, and only one case is read as "gone":
   *
   * - A resume: the hosted side also refuses one this way when the account's
   *   sign-in there isn't active or doesn't match, so the first refusal is
   *   not read as gone. The account stays paused here and its sign-in is
   *   recorded as ended, so "Sign in again" is its one fix. When a resume is
   *   refused again after the account was signed in again since (it reads
   *   signed in once more), signing in can't fix it: the account closes as
   *   gone, which ends the Resume, Sign in again, Resume loop.
   * - A disconnect: its access can't be confirmed ended, so the cleanup stays
   *   owed as unknown and the person is shown where to end it themselves.
   * - Any other change (who can use it, a pause, a notification): the hosted
   *   side found no connection for this link at all, which is what "gone"
   *   means here. The account closes locally with one fix, connecting it
   *   again, and its cleanup is `unknown`, never "nothing owed": whether the
   *   sign-in still lives at the service is not known, so it is never
   *   silently orphaned.
   */
  private closeGoneAccount(
    tx: ConnectorDbTransaction,
    row: typeof connectorManagedAuthorityOutbox.$inferSelect,
    command: ManagedConnectorAuthorityCommand,
    now: string
  ): void {
    if (command.kind === 'set_connection_lifecycle' && command.lifecycle === 'disconnected') {
      tx.update(connections)
        .set({ externalCleanupState: 'unknown', updatedAt: now })
        .where(
          and(
            eq(connections.id, row.connectionId),
            eq(connections.cleanupGeneration, row.cleanupGeneration),
            eq(connections.lifecycleState, 'disconnected')
          )
        )
        .run();
      return;
    }
    if (command.kind === 'set_connection_lifecycle' && command.lifecycle === 'active') {
      const account = tx
        .select({ status: connections.status })
        .from(connections)
        .where(eq(connections.id, row.connectionId))
        .get();
      // Refused again only when the account's lifecycle change just before
      // this one was itself a resume refused the same way. Anything between
      // (a resume that applied, a pause, one still pending) means signing in
      // did help once, so this refusal starts over rather than closing it.
      const previous = tx
        .select({
          state: connectorManagedAuthorityOutbox.state,
          rejectionCode: connectorManagedAuthorityOutbox.rejectionCode,
          requestJson: connectorManagedAuthorityOutbox.requestJson,
          compactedAt: connectorManagedAuthorityOutbox.compactedAt,
        })
        .from(connectorManagedAuthorityOutbox)
        .where(
          and(
            eq(connectorManagedAuthorityOutbox.managedConnectionId, row.managedConnectionId),
            eq(connectorManagedAuthorityOutbox.scopeKind, 'connection_lifecycle'),
            eq(connectorManagedAuthorityOutbox.subjectId, row.subjectId),
            lt(connectorManagedAuthorityOutbox.scopeVersion, row.scopeVersion)
          )
        )
        .orderBy(desc(connectorManagedAuthorityOutbox.scopeVersion))
        .limit(1)
        .get();
      const refusedBefore =
        previous?.state === 'rejected' &&
        previous.rejectionCode === 'connection_unavailable' &&
        previous.compactedAt === null &&
        isResume(previous.requestJson);
      if (refusedBefore && account?.status === 'active') {
        this.closeAsGone(tx, row.connectionId as ConnectionId, now);
        return;
      }
      tx.update(connections)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            eq(connections.id, row.connectionId),
            eq(connections.lifecycleState, 'connected'),
            eq(connections.status, 'active')
          )
        )
        .run();
      return;
    }
    const open = tx
      .select({ lifecycleState: connections.lifecycleState })
      .from(connections)
      .where(eq(connections.id, row.connectionId))
      .get();
    if (open?.lifecycleState !== 'connected') return;
    this.closeAsGone(tx, row.connectionId as ConnectionId, now);
  }

  /** Close one account here as gone for this link, its end at the service unconfirmed. */
  private closeAsGone(tx: ConnectorDbTransaction, connectionId: ConnectionId, now: string): void {
    this.stageLocalLifecycle(tx, connectionId, 'disconnected');
    tx.update(connections)
      .set({ externalCleanupState: 'unknown', closedBecause: 'service_gone', updatedAt: now })
      .where(eq(connections.id, connectionId))
      .run();
  }

  private appendCommand(input: {
    scopeKind:
      'agent_grants' | 'every_agent_grants' | 'connection_lifecycle' | 'event_subscription';
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
      scopeKind:
        'agent_grants' | 'every_agent_grants' | 'connection_lifecycle' | 'event_subscription';
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
        cleanupGeneration: connections.cleanupGeneration,
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
        cleanupGeneration: connection!.cleanupGeneration,
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
    // A hung hosted request must not hold this command forever; the deadline
    // covers the read and any repeat together. A recovery pass delivers its
    // batch one command at a time, so a pass of 50 hung commands still takes up
    // to 50 × 30s before the next pass can start, but it always ends.
    const deadline = this.timeoutSignal(REQUEST_TIMEOUT_MS);
    const requestSignal = AbortSignal.any([signal, deadline]);
    try {
      let status: ManagedConnectorAuthorityCommandStatus;
      if (recoverFirst) {
        try {
          status = await this.options.cloud.readConnectorAuthorityCommand(commandId, requestSignal);
          if (this.progressesOnlyWhenRepeated(command, status))
            status = await this.options.cloud.submitConnectorAuthorityCommand(
              command,
              requestSignal
            );
        } catch (error) {
          if (!isManagedCloudError(error) || error.code !== 'not_found') throw error;
          status = await this.options.cloud.submitConnectorAuthorityCommand(command, requestSignal);
        }
      } else {
        status = await this.options.cloud.submitConnectorAuthorityCommand(command, requestSignal);
      }
      return this.recordStatus(row, leaseOwner, command, status);
    } catch (error) {
      return this.recordFailure(row, leaseOwner, this.classifyFailure(error, signal, deadline));
    }
  }

  /**
   * Whether the hosted side only moves this command forward when the same
   * command is sent again; reading its status never does. That holds for a
   * pending event subscription, for a resume the hosted side still holds as
   * pending, and for a disconnect whose credential cleanup is still pending
   * (the POST that owned the cleanup died, or a concurrent claim won): there is
   * no hosted sweeper to finish either lifecycle change. Repeating the exact
   * command is safe: the hosted handler matches it by id and request hash, then
   * retries a disconnect's cleanup under its own lease, or re-checks a resume's
   * account and settles it only while it is still pending
   * (`applyManagedAuthorityCommand` and `finishDisconnectCleanup` in
   * `apps/site/src/lib/connectors/managed/authority-service.ts`).
   */
  private progressesOnlyWhenRepeated(
    command: ManagedConnectorAuthorityCommand,
    status: ManagedConnectorAuthorityCommandStatus
  ): boolean {
    if (command.kind === 'set_event_subscription') return status.state === 'pending';
    if (command.kind !== 'set_connection_lifecycle') return false;
    if (command.lifecycle === 'active') return status.state === 'pending';
    return (
      command.lifecycle === 'disconnected' &&
      status.state === 'applied' &&
      status.externalCleanup === 'pending'
    );
  }

  private classifyFailure(
    error: unknown,
    signal: AbortSignal,
    deadline: AbortSignal
  ): DeliveryFailure {
    if (signal.aborted) return { code: 'interrupted' };
    if (deadline.aborted) return { code: 'timeout' };
    if (isManagedCloudError(error)) return { code: error.code, status: error.status };
    return { code: 'local_error', errorName: error instanceof Error ? error.name : typeof error };
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
    if (
      command.kind === 'set_event_subscription' &&
      status.state === 'applied' &&
      status.appliedEventScopeHash !==
        createHash('sha256').update(stableStringify(command)).digest('hex')
    ) {
      return this.recordFailure(row, leaseOwner, { code: 'invalid_response' });
    }
    const now = this.now().toISOString();
    const resolution = this.options.db.transaction((tx) => {
      const current = this.isCurrent(tx, row) && this.isBindingCurrent(tx, row, command);
      const cleanupPending =
        command.kind === 'set_connection_lifecycle' &&
        command.lifecycle === 'disconnected' &&
        status.state === 'applied' &&
        status.externalCleanup === 'pending';
      // Keep repeating the exact command until credential cleanup also settles.
      const state = current ? (cleanupPending ? 'pending' : status.state) : 'superseded';
      const safeReason =
        state === 'rejected'
          ? this.rejectionReason(status.state === 'rejected' ? status.rejectionCode : undefined)
          : state === 'pending'
            ? cleanupPending
              ? CLEANUP_PENDING_REASON
              : // Only a command recovery will send again is "trying again"; a
                // read-only re-check gets no reason, so no retry time is shown.
                this.progressesOnlyWhenRepeated(command, status)
                ? HOSTED_PENDING_REASON
                : null
            : null;
      const nextAttemptAt = state === 'pending' ? this.nextAttempt(row, now) : null;
      const rejectionCode =
        state === 'rejected' && status.state === 'rejected' ? status.rejectionCode : null;
      const updated = tx
        .update(connectorManagedAuthorityOutbox)
        .set({
          state,
          safeReason,
          rejectionCode,
          attemptCount: row.attemptCount + 1,
          nextAttemptAt,
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
      if (committed && current && rejectionCode === 'connection_unavailable') {
        this.closeGoneAccount(tx, row, command, now);
      }
      if (
        committed &&
        current &&
        command.kind === 'set_connection_lifecycle' &&
        command.lifecycle === 'disconnected' &&
        status.state === 'applied'
      ) {
        tx.update(connections)
          .set({ externalCleanupState: status.externalCleanup, updatedAt: now })
          .where(
            and(
              eq(connections.id, row.connectionId),
              eq(connections.externalAccountRef, row.managedConnectionId),
              eq(connections.cleanupGeneration, row.cleanupGeneration),
              eq(connections.lifecycleState, 'disconnected')
            )
          )
          .run();
      }

      if (committed && state === 'applied') {
        if (command.kind === 'replace_agent_grants') {
          this.activateCurrentAgentGrants(tx, row, command);
        } else if (command.kind === 'replace_every_agent_grants') {
          this.activateCurrentEveryAgentGrants(tx, row, command);
        } else if (command.kind === 'set_event_subscription') {
          tx.update(connectorEventSubscriptions)
            .set({ enabled: command.enabled, updatedAt: now })
            .where(
              and(
                eq(connectorEventSubscriptions.id, command.subscriptionId),
                eq(connectorEventSubscriptions.scopeVersion, command.subscriptionVersion)
              )
            )
            .run();
          if (command.enabled) {
            const subscription = tx
              .select({ bindingId: connectorEventSubscriptions.bindingId })
              .from(connectorEventSubscriptions)
              .where(eq(connectorEventSubscriptions.id, command.subscriptionId))
              .get();
            if (subscription?.bindingId)
              tx.update(connectorEventBindings)
                .set({ state: 'ready', updatedAt: now })
                .where(eq(connectorEventBindings.id, subscription.bindingId))
                .run();
          }
        } else if (command.lifecycle === 'active') {
          tx.update(connections)
            .set({ enabled: true, pausedBy: null, updatedAt: now })
            .where(eq(connections.id, row.connectionId))
            .run();
        }
      }
      return { state, safeReason, nextAttemptAt, committed };
    });
    const { state, safeReason, nextAttemptAt, committed } = resolution;
    if (!committed) {
      return {
        authoritySync: { status: 'pending' },
        applied: false,
        externalCleanup: 'not_required',
      };
    }
    if (state === 'pending') {
      const code = safeReason === CLEANUP_PENDING_REASON ? 'cleanup_pending' : 'hosted_pending';
      this.logUnsettled(row, { code }, nextAttemptAt, 'info');
    } else {
      this.failureLog.delete(row.commandId);
    }
    return {
      authoritySync:
        state === 'applied'
          ? { status: 'ready' }
          : state === 'pending'
            ? pendingSync(safeReason, nextAttemptAt)
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
    failure: DeliveryFailure
  ): ConnectorManagedLifecycleSyncResult {
    const now = this.now().toISOString();
    const terminal =
      failure.code === 'conflict' ||
      failure.code === 'permission_upgrade_required' ||
      failure.code === 'unauthorized';
    const safeReason = this.failureReason(failure);
    const nextAttemptAt = terminal ? null : this.nextAttempt(row, now);
    const updated = this.options.db
      .update(connectorManagedAuthorityOutbox)
      .set({
        state: terminal ? 'rejected' : 'pending',
        safeReason,
        rejectionCode: terminal ? failure.code : null,
        attemptCount: row.attemptCount + 1,
        nextAttemptAt,
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
    if (updated.changes === 1) this.logUnsettled(row, failure, nextAttemptAt, 'warn');
    if (terminal) this.failureLog.delete(row.commandId);
    return {
      authoritySync: terminal
        ? { status: 'failed', reason: safeReason }
        : pendingSync(safeReason, nextAttemptAt),
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

  /**
   * Log one unsettled delivery: the first time a command fails, whenever the
   * way it fails changes, and otherwise at most once per
   * {@link FAILURE_LOG_INTERVAL_MS}. Ids and codes only, never hosted text.
   */
  private logUnsettled(
    row: typeof connectorManagedAuthorityOutbox.$inferSelect,
    failure: { readonly code: string; readonly status?: number; readonly errorName?: string },
    nextAttemptAt: string | null,
    level: 'warn' | 'info'
  ): void {
    const signature = `${failure.code}:${failure.status ?? ''}`;
    const now = this.now().getTime();
    const last = this.failureLog.get(row.commandId);
    if (last && last.signature === signature && now - last.loggedAt < FAILURE_LOG_INTERVAL_MS)
      return;
    this.failureLog.set(row.commandId, { signature, loggedAt: now });
    const context = {
      code: failure.code,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.errorName === undefined ? {} : { errorName: failure.errorName }),
      commandId: row.commandId,
      scopeKind: row.scopeKind,
      attempt: row.attemptCount + 1,
      nextAttemptAt,
    };
    if (level === 'warn') {
      logger.warn(
        nextAttemptAt
          ? '[Connectors] Managed authority command did not settle; retrying'
          : '[Connectors] Managed authority command was refused; not retrying',
        context
      );
    } else {
      logger.info(
        '[Connectors] Managed authority command still pending on the hosted side; retrying',
        context
      );
    }
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
        cleanupGeneration: connections.cleanupGeneration,
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
    if (command.kind === 'set_event_subscription') {
      const selected = this.eventSelection(command.subscriptionId, command.subscriptionVersion);
      if (
        !selected ||
        stableStringify(selected.command) !==
          stableStringify({
            kind: command.kind,
            subscriptionId: command.subscriptionId,
            subscriptionVersion: command.subscriptionVersion,
            hostedDefinitionId: command.hostedDefinitionId,
            agentId: command.agentId,
            destination: command.destination,
            filter: command.filter,
            enabled: command.enabled,
          })
      )
        return false;
      if (!command.enabled) return true;
      const definition = db
        .select({ current: connectorEventDefinitions.current })
        .from(connectorEventDefinitions)
        .innerJoin(
          connectorEventSubscriptions,
          eq(connectorEventSubscriptions.definitionId, connectorEventDefinitions.id)
        )
        .where(eq(connectorEventSubscriptions.id, command.subscriptionId))
        .get();
      return (
        definition?.current === true &&
        binding.lifecycleState === 'connected' &&
        binding.enabled &&
        binding.authenticationStatus === 'active'
      );
    }
    if (command.kind === 'replace_agent_grants' || command.kind === 'replace_every_agent_grants') {
      return binding.lifecycleState === 'connected' && binding.enabled;
    }
    if (command.lifecycle === 'disconnected')
      return (
        binding.lifecycleState === 'disconnected' &&
        binding.cleanupGeneration === row.cleanupGeneration
      );
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
    this.activateCurrentGrants(
      tx,
      row,
      command.revisions,
      and(
        eq(connectionOperationGrants.subjectType, 'agent'),
        eq(connectionOperationGrants.subjectId, command.agentId)
      )!
    );
  }

  private activateCurrentEveryAgentGrants(
    tx: ConnectorDbTransaction,
    row: typeof connectorManagedAuthorityOutbox.$inferSelect,
    command: Extract<ManagedConnectorAuthorityCommand, { kind: 'replace_every_agent_grants' }>
  ): void {
    this.activateCurrentGrants(tx, row, command.revisions, everyAgentGrantSubject()!);
  }

  /** Open exactly the applied revisions of one still-current grant command. */
  private activateCurrentGrants(
    tx: ConnectorDbTransaction,
    row: typeof connectorManagedAuthorityOutbox.$inferSelect,
    revisions: readonly ManagedConnectorOperationSelector[],
    subject: SQL
  ): void {
    const identities = new Set(revisions.map(selectorKey));
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
            subject,
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
          inArray(connectorManagedAuthorityScopes.scopeKind, ['agent_grants', 'every_agent_grants'])
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

  private failureReason(failure: DeliveryFailure): string {
    switch (failure.code) {
      case 'permission_upgrade_required':
        return 'Relink this instance to enable managed connections.';
      case 'unauthorized':
        return 'This instance is no longer linked.';
      case 'conflict':
        return 'The hosted service refused a conflicting authority command.';
      case 'network_error':
        return 'Couldn’t reach DorkOS’s servers.';
      case 'timeout':
        return 'DorkOS’s servers didn’t answer in time.';
      case 'invalid_response':
        return 'DorkOS’s servers sent back an answer that didn’t make sense.';
      case 'request_failed':
      case 'not_found':
        return failure.status !== undefined && failure.status >= 500
          ? 'DorkOS’s servers had a problem.'
          : 'DorkOS’s servers turned the request down.';
      case 'interrupted':
        return 'The last try was stopped before it finished.';
      case 'local_error':
        return 'Something went wrong on this computer during the last try.';
    }
  }
}

/** A pending sync, carrying its plain reason and next try only when there is one. */
function pendingSync(
  reason: string | null,
  retryAt: string | null
): ConnectorManagedLifecycleSyncResult['authoritySync'] {
  return reason && retryAt ? { status: 'pending', reason, retryAt } : { status: 'pending' };
}

/**
 * Whether one scope's latest command is sent again (see
 * {@link ManagedAuthoritySyncService.restageRefused}).
 */
function sendAgain(
  scope: {
    readonly state: 'pending' | 'applied' | 'rejected' | 'superseded';
    readonly rejectionCode: string | null;
    readonly generation: number;
  },
  why: 'relinked' | 'confirmed',
  currentGeneration: number
): boolean {
  if (scope.state === 'rejected' && scope.rejectionCode === 'connection_unavailable') return false;
  if (why === 'confirmed') return scope.state === 'rejected';
  if (scope.state === 'rejected') {
    return (
      scope.rejectionCode === 'unauthorized' ||
      scope.rejectionCode === 'permission_upgrade_required'
    );
  }
  // Staged under the old link and never applied: under the new one it would
  // only be set aside as superseded, and the access it carried lost.
  return (
    scope.state === 'superseded' ||
    (scope.state === 'pending' && scope.generation !== currentGeneration)
  );
}

/** Whether a stored lifecycle command asked to resume the account. */
function isResume(requestJson: string): boolean {
  const parsed = ManagedConnectorAuthorityCommandSchema.safeParse(JSON.parse(requestJson));
  return (
    parsed.success &&
    parsed.data.kind === 'set_connection_lifecycle' &&
    parsed.data.lifecycle === 'active'
  );
}
