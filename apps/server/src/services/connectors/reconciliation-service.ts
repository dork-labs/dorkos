/**
 * Complete operation discovery and named-agent and every-agent grant
 * reconciliation. A grant given by level keeps its level (ADR 260929-071355):
 * every time the catalog is read here, each level's grant rows are re-derived
 * from it, so new actions of the level's class join and actions reclassified
 * out of it leave.
 */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  and,
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReconciliationAgents,
  connectorReconciliationCandidates,
  connectorReconciliationDefaults,
  connectorReconciliationPreviews,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  inArray,
  isNull,
  or,
  type Db,
  type DbTransaction,
  type SQL,
} from '@dorkos/db';
import { ManagedConnectorAuthorityCommandSchema } from '@dorkos/shared/connector-managed-schemas';
import {
  ConnectorReconciliationApplyRequestSchema,
  ConnectorReconciliationApplyResponseSchema,
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
  ConnectorReconciliationPreviewRequestSchema,
  ConnectorReconciliationPreviewSchema,
  accessLevelRevisionIds,
  type ConnectorAccessLevel,
  type ConnectorOperationClassification,
  type ConnectorOperationPage,
  type ConnectorReconciliationAgent,
  type ConnectorReconciliationApplyRequest,
  type ConnectorReconciliationApplyResponse,
  type ConnectorReconciliationPreview,
  type ConnectorReconciliationPreviewRequest,
} from '@dorkos/shared/connector-schemas';
import { logger } from '../../lib/logger.js';
import {
  endEveryAgentAccessLevels,
  readAccessLevels,
  recordAccessLevel,
  replaceNamedAgentGrants,
  type StoredAccessLevel,
} from './execution/access-levels.js';
import {
  everyAgentGrantSubject,
  replaceEveryAgentGrants,
  revokeEveryAgentGrants,
} from './every-agent-grants.js';
import {
  recordEveryAgentChange,
  type EveryAgentActivitySink,
  type EveryAgentChange,
  type EveryAgentChangeWriter,
} from './every-agent-activity.js';
import type { ConnectorOwnerAuthority } from './principal/server-principal.js';
import type { ConnectorRegistry } from './registry.js';
import type { ManagedAuthoritySyncService } from './resources/managed-authority-sync-service.js';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_PREVIEW_TTL_MS = 10 * 60_000;

/** Stable refusal codes returned by the reconciliation HTTP boundary. */
export type ConnectorReconciliationErrorCode =
  | 'connection_not_found'
  | 'operations_unsupported'
  | 'catalog_incomplete'
  | 'preview_stale'
  | 'invalid_selection'
  | 'every_agent_unavailable';

/** A secret-free, typed reconciliation refusal. */
export class ConnectorReconciliationError extends Error {
  /**
   * Construct one typed refusal.
   *
   * @param code - Stable refusal category.
   * @param message - Operator-facing safe explanation.
   */
  constructor(
    readonly code: ConnectorReconciliationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ConnectorReconciliationError';
  }
}

/** Current agent identity safe to include in an owner-only preview. */
export interface ConnectorReconciliationAgentSource {
  /** Stable registered agent id. */
  readonly agentId: string;
  /** Current owner-facing display name. */
  readonly displayName: string;
}

/** Construction options for exact operation reconciliation. */
export interface ConnectorReconciliationServiceOptions {
  /** Canonical connector database. */
  readonly db: Db;
  /** Exact provider registry. */
  readonly registry: ConnectorRegistry;
  /** Current process generation returned by the runtime authority boot barrier. */
  readonly bootEpoch: string;
  /** List registered agents at the instant a preview is created. */
  readonly listAgents: () => ConnectorReconciliationAgentSource[];
  /** Durable hosted authority synchronizer for managed provider instances. */
  readonly managedAuthority?: Pick<
    ManagedAuthoritySyncService,
    | 'stageAgentGrantReplacement'
    | 'stageEveryAgentGrantReplacement'
    | 'deliverAgentGrantReplacement'
    | 'restageRefused'
  >;
  /** Activity trail for every-agent changes; absent in a process that has none. */
  readonly activity?: EveryAgentActivitySink;
  /** Who is changing a grant right now, as honestly as DorkOS can say. */
  readonly writer?: () => EveryAgentChangeWriter;
  /** Injectable clock for expiry tests. */
  readonly now?: () => Date;
  /** Injectable id source for deterministic tests. */
  readonly createId?: () => string;
  /** Maximum complete-discovery pages. */
  readonly maxPages?: number;
  /** Provider page size. */
  readonly pageSize?: number;
  /** Preview validity window. */
  readonly previewTtlMs?: number;
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

function revisionSetHash(ids: readonly string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

type DiscoveredOperation = ConnectorOperationPage['operations'][number];

function operationIdentity(operation: DiscoveredOperation): string {
  return [
    operation.providerInstanceId,
    operation.toolkit,
    operation.operationSlug,
    operation.toolkitVersion,
    operation.schemaHash,
    operation.capabilityClassification,
    operation.retryPolicy,
    operation.providerRevisionRef ?? '',
  ].join('\n');
}

/**
 * The hosted selectors of the chosen local revisions, paired positionally with
 * their local ids, in selection order.
 */
function managedSelectors(
  tx: DbTransaction,
  operationRevisionIds: readonly string[]
): {
  revisions: Array<{
    operationSlug: string;
    toolkitVersion: string;
    schemaHash: string;
    hostedRevisionId: string;
  }>;
  operationRevisionIds: string[];
} {
  const rows = operationRevisionIds.length
    ? tx
        .select({
          id: connectorOperationRevisions.id,
          operationSlug: connectorOperationRevisions.operationSlug,
          toolkitVersion: connectorOperationRevisions.toolkitVersion,
          schemaHash: connectorOperationRevisions.schemaHash,
          providerRevisionRef: connectorOperationRevisions.providerRevisionRef,
        })
        .from(connectorOperationRevisions)
        .where(inArray(connectorOperationRevisions.id, [...operationRevisionIds]))
        .all()
    : [];
  const byId = new Map(rows.map((revision) => [revision.id, revision]));
  const ordered = operationRevisionIds.map((id) => byId.get(id)!);
  return {
    revisions: ordered.map((revision) => ({
      operationSlug: revision.operationSlug,
      toolkitVersion: revision.toolkitVersion,
      schemaHash: revision.schemaHash,
      hostedRevisionId: revision.providerRevisionRef,
    })),
    operationRevisionIds: ordered.map((revision) => revision.id),
  };
}

/** How long stopping a managed share waits on hosted authority before answering. */
const HOSTED_STOP_WAIT_MS = 10_000;

/** Who the Activity trail names when a level follows the app, not a person. */
const LEVEL_FOLLOWER: EveryAgentChangeWriter = { actorType: 'system', actorLabel: 'DorkOS' };

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** One level subject's live grant revisions on one connection, sorted. */
function liveGrantIds(
  tx: DbTransaction,
  connectionId: string,
  stored: StoredAccessLevel
): string[] {
  return tx
    .select({ id: connectionOperationGrants.operationRevisionId })
    .from(connectionOperationGrants)
    .where(
      and(
        eq(connectionOperationGrants.connectionId, connectionId),
        stored.subject.kind === 'agent'
          ? and(
              eq(connectionOperationGrants.subjectType, 'agent'),
              eq(connectionOperationGrants.subjectId, stored.subject.agentId)
            )
          : everyAgentGrantSubject(),
        isNull(connectionOperationGrants.revokedAt)
      )
    )
    .all()
    .map((row) => row.id)
    .sort();
}

interface EveryAgentState {
  readonly operationRevisionIds: readonly string[];
  readonly classifications: EveryAgentChange['after'];
}

function readEveryAgentState(tx: DbTransaction, connectionId: string): EveryAgentState {
  return everyAgentStateWhere(
    tx,
    and(
      eq(connectionOperationGrants.connectionId, connectionId),
      everyAgentGrantSubject(),
      isNull(connectionOperationGrants.revokedAt)
    )!
  );
}

/**
 * The state a managed every-agent replacement asks for. Its rows stay closed
 * until hosted authority applies the command, so the live rows cannot say it.
 */
function requestedEveryAgentState(
  tx: DbTransaction,
  connectionId: string,
  operationRevisionIds: readonly string[]
): EveryAgentState {
  if (operationRevisionIds.length === 0) return { operationRevisionIds: [], classifications: [] };
  return everyAgentStateWhere(
    tx,
    and(
      eq(connectionOperationGrants.connectionId, connectionId),
      everyAgentGrantSubject(),
      inArray(connectionOperationGrants.operationRevisionId, [...operationRevisionIds])
    )!
  );
}

function everyAgentStateWhere(tx: DbTransaction, where: SQL): EveryAgentState {
  const rows = tx
    .select({
      id: connectionOperationGrants.operationRevisionId,
      classification: connectorOperationRevisions.capabilityClassification,
    })
    .from(connectionOperationGrants)
    .innerJoin(
      connectorOperationRevisions,
      eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
    )
    .where(where)
    .all();
  return {
    operationRevisionIds: [...new Set(rows.map((row) => row.id))].sort(),
    classifications: [...new Set(rows.map((row) => row.classification))].sort(),
  };
}

/** The Activity-worthy difference, or undefined when nothing changed. */
function describeEveryAgentChange(
  tx: DbTransaction,
  connectionId: string,
  before: EveryAgentState,
  after: EveryAgentState = readEveryAgentState(tx, connectionId)
): EveryAgentChange | undefined {
  if (after.operationRevisionIds.join('\n') === before.operationRevisionIds.join('\n')) {
    return undefined;
  }
  const connection = tx
    .select({ toolkit: connections.toolkit, label: connections.label })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  return {
    connectionId,
    toolkit: connection?.toolkit ?? 'account',
    label: connection?.label ?? connectionId,
    before: before.classifications,
    after: after.classifications,
    operationCount: after.operationRevisionIds.length,
  };
}

/** SQLite-backed complete-catalog preview and atomic named-agent grant service. */
export class ConnectorReconciliationService {
  private readonly db: Db;
  private readonly registry: ConnectorRegistry;
  private readonly bootEpoch: string;
  private readonly listAgents: () => ConnectorReconciliationAgentSource[];
  private readonly managedAuthority:
    | Pick<
        ManagedAuthoritySyncService,
        | 'stageAgentGrantReplacement'
        | 'stageEveryAgentGrantReplacement'
        | 'deliverAgentGrantReplacement'
        | 'restageRefused'
      >
    | undefined;
  private readonly activity: EveryAgentActivitySink | undefined;
  private readonly writer: () => EveryAgentChangeWriter;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxPages: number;
  private readonly pageSize: number;
  private readonly previewTtlMs: number;

  /** Construct a reconciliation service from current process authority. */
  constructor(options: ConnectorReconciliationServiceOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.bootEpoch = options.bootEpoch;
    this.listAgents = options.listAgents;
    this.managedAuthority = options.managedAuthority;
    this.activity = options.activity;
    this.writer =
      options.writer ?? (() => ({ actorType: 'user', actorLabel: 'Someone on this computer' }));
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
  }

  /** Discover a bounded complete catalog and persist an owner-bound preview. */
  async preview(
    owner: ConnectorOwnerAuthority,
    input: ConnectorReconciliationPreviewRequest,
    signal: AbortSignal
  ): Promise<ConnectorReconciliationPreview> {
    const request = ConnectorReconciliationPreviewRequestSchema.parse(input);
    const context = this.resolveOwnedConnection(owner, request.connectionId);
    const provider = this.registry.resolveProviderInstance(
      ConnectorProviderInstanceIdSchema.parse(context.providerInstanceId)
    );
    if (!provider || provider.getCapabilities().capabilities.operations.status !== 'available') {
      throw new ConnectorReconciliationError(
        'operations_unsupported',
        'This connection does not provide reviewable operation schemas.'
      );
    }

    const version = await provider.resolveToolkitVersion(context.toolkit, signal);
    if (version.status === 'unsupported') {
      throw new ConnectorReconciliationError('operations_unsupported', version.reason);
    }
    if (version.toolkit !== context.toolkit) {
      throw new ConnectorReconciliationError(
        'catalog_incomplete',
        'The provider returned operation metadata for a different service.'
      );
    }

    const discovered = await this.discoverVersion(
      provider,
      ConnectorProviderInstanceIdSchema.parse(context.providerInstanceId),
      context.toolkit,
      version.toolkitVersion,
      signal
    );
    const existingGrantRows = this.db
      .select({
        id: connectorOperationRevisions.id,
        providerInstanceId: connectorOperationRevisions.providerInstanceId,
        toolkit: connectorOperationRevisions.toolkit,
        operationSlug: connectorOperationRevisions.operationSlug,
        toolkitVersion: connectorOperationRevisions.toolkitVersion,
        schemaHash: connectorOperationRevisions.schemaHash,
        providerRevisionRef: connectorOperationRevisions.providerRevisionRef,
        capabilityClassification: connectorOperationRevisions.capabilityClassification,
        retryPolicy: connectorOperationRevisions.retryPolicy,
        inputSchemaJson: connectorOperationRevisions.inputSchemaJson,
      })
      .from(connectionOperationGrants)
      .innerJoin(
        connectorOperationRevisions,
        eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
      )
      .where(
        and(
          eq(connectionOperationGrants.connectionId, request.connectionId),
          // Every-agent revisions are re-verified exactly like named-agent ones,
          // so a revision the provider no longer offers shows as unsupported.
          or(eq(connectionOperationGrants.subjectType, 'agent'), everyAgentGrantSubject()),
          isNull(connectionOperationGrants.revokedAt),
          eq(connectorOperationRevisions.providerInstanceId, context.providerInstanceId),
          eq(connectorOperationRevisions.toolkit, context.toolkit)
        )
      )
      .all();
    const verifiedByVersion = new Map<string, Set<string>>([
      [version.toolkitVersion, new Set(discovered.map(operationIdentity))],
    ]);
    for (const toolkitVersion of new Set(existingGrantRows.map((row) => row.toolkitVersion))) {
      if (verifiedByVersion.has(toolkitVersion)) continue;
      const exact = await this.discoverVersion(
        provider,
        ConnectorProviderInstanceIdSchema.parse(context.providerInstanceId),
        context.toolkit,
        toolkitVersion,
        signal
      );
      verifiedByVersion.set(toolkitVersion, new Set(exact.map(operationIdentity)));
    }

    const createdAt = this.now();
    const previewId = this.createId();
    const agents = this.snapshotAgents();
    const recorded = this.db.transaction((tx) => {
      const supportById = new Map<string, boolean>();
      const classificationById = new Map<string, ConnectorOperationClassification>();
      const ids: string[] = [];
      for (const operation of discovered) {
        const existing = tx
          .select({ id: connectorOperationRevisions.id })
          .from(connectorOperationRevisions)
          .where(
            and(
              eq(connectorOperationRevisions.providerInstanceId, operation.providerInstanceId),
              eq(connectorOperationRevisions.toolkit, operation.toolkit),
              eq(connectorOperationRevisions.operationSlug, operation.operationSlug),
              eq(connectorOperationRevisions.toolkitVersion, operation.toolkitVersion),
              eq(connectorOperationRevisions.schemaHash, operation.schemaHash),
              eq(
                connectorOperationRevisions.capabilityClassification,
                operation.capabilityClassification
              ),
              eq(connectorOperationRevisions.retryPolicy, operation.retryPolicy),
              eq(
                connectorOperationRevisions.providerRevisionRef,
                operation.providerRevisionRef ?? ''
              )
            )
          )
          .get();
        const id = existing?.id ?? this.createId();
        if (!existing) {
          tx.insert(connectorOperationRevisions)
            .values({
              id,
              ...operation,
              inputSchemaJson: JSON.stringify(operation.inputSchema),
              discoveredAt: createdAt.toISOString(),
            })
            .run();
        }
        ids.push(id);
        supportById.set(id, true);
        classificationById.set(id, operation.capabilityClassification);
      }

      for (const row of existingGrantRows) {
        ids.push(row.id);
        classificationById.set(row.id, row.capabilityClassification);
        const evidence = verifiedByVersion.get(row.toolkitVersion);
        supportById.set(
          row.id,
          Boolean(
            evidence?.has(
              operationIdentity({
                providerInstanceId: ConnectorProviderInstanceIdSchema.parse(row.providerInstanceId),
                toolkit: row.toolkit,
                operationSlug: row.operationSlug,
                toolkitVersion: row.toolkitVersion,
                schemaHash: row.schemaHash,
                providerRevisionRef: row.providerRevisionRef,
                capabilityClassification: row.capabilityClassification,
                retryPolicy: row.retryPolicy,
                inputSchema: JSON.parse(row.inputSchemaJson) as Record<string, unknown>,
              })
            )
          )
        );
      }
      const uniqueIds = [...new Set(ids)].sort();

      tx.insert(connectorReconciliationPreviews)
        .values({
          id: previewId,
          ...ownerColumns(owner),
          connectionId: request.connectionId,
          providerInstanceId: context.providerInstanceId,
          bootEpoch: this.bootEpoch,
          executionConfigGeneration: context.executionConfigGeneration,
          completeRevisionSetHash: revisionSetHash(uniqueIds),
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + this.previewTtlMs).toISOString(),
        })
        .run();
      if (uniqueIds.length > 0) {
        tx.insert(connectorReconciliationCandidates)
          .values(
            uniqueIds.map((operationRevisionId) => ({
              previewId,
              operationRevisionId,
              supported: supportById.get(operationRevisionId) ?? false,
            }))
          )
          .run();
      }
      if (agents.length > 0) {
        tx.insert(connectorReconciliationAgents)
          .values(agents.map((agent) => ({ previewId, agentId: agent.agentId })))
          .run();
      }
      // The catalog just read is the one every level follows: re-derive each
      // level's grants from it before this snapshot records what agents hold.
      const followed = this.followLevels(tx, {
        connectionId: request.connectionId,
        providerInstanceId: context.providerInstanceId,
        managedConnectionId: context.managedConnectionId,
        mode: context.mode,
        executionConfigGeneration: context.executionConfigGeneration,
        owner,
        agentIds: new Set(agents.map((agent) => agent.agentId)),
        candidates: uniqueIds.map((operationRevisionId) => ({
          operationRevisionId,
          capabilityClassification: classificationById.get(operationRevisionId)!,
          supported: supportById.get(operationRevisionId) ?? false,
        })),
        now: createdAt.toISOString(),
      });
      const defaults = tx
        .select({
          agentId: connectionOperationGrants.subjectId,
          operationRevisionId: connectionOperationGrants.operationRevisionId,
        })
        .from(connectionOperationGrants)
        .innerJoin(
          connectorOperationRevisions,
          eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
        )
        .where(
          and(
            eq(connectionOperationGrants.connectionId, request.connectionId),
            eq(connectionOperationGrants.subjectType, 'agent'),
            isNull(connectionOperationGrants.revokedAt),
            eq(connectorOperationRevisions.providerInstanceId, context.providerInstanceId),
            eq(connectorOperationRevisions.toolkit, context.toolkit)
          )
        )
        .all()
        .filter((row) => agents.some((agent) => agent.agentId === row.agentId));
      if (defaults.length > 0) {
        tx.insert(connectorReconciliationDefaults)
          .values(defaults.map((row) => ({ previewId, ...row })))
          .run();
      }
      return { uniqueIds, ...followed };
    });
    if (recorded.everyAgentChange) {
      await this.record(recorded.everyAgentChange, LEVEL_FOLLOWER);
    }
    for (const commandId of recorded.commandIds) {
      // The change is staged and retried from the outbox; a slow or failed
      // delivery must not keep the owner from seeing who can use the account.
      try {
        await this.managedAuthority!.deliverAgentGrantReplacement(commandId, signal);
      } catch (error) {
        logger.warn('[Connectors] Could not deliver a level change yet', {
          commandId,
          err: String(error),
        });
      }
    }

    return ConnectorReconciliationPreviewSchema.parse(
      this.readPreview(
        previewId,
        request.connectionId,
        agents,
        recorded.uniqueIds,
        createdAt,
        context.mode !== 'managed' || this.managedAuthority !== undefined
      )
    );
  }

  private async discoverVersion(
    provider: NonNullable<ReturnType<ConnectorRegistry['resolveProviderInstance']>>,
    providerInstanceId: ReturnType<typeof ConnectorProviderInstanceIdSchema.parse>,
    toolkit: string,
    toolkitVersion: string,
    signal: AbortSignal
  ): Promise<DiscoveredOperation[]> {
    const discovered: DiscoveredOperation[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let complete = false;
    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      signal.throwIfAborted();
      const result = await provider.listOperationSchemas({
        toolkit,
        toolkitVersion,
        ...(cursor && { cursor }),
        limit: this.pageSize,
        signal,
      });
      if (result.status === 'unsupported') {
        throw new ConnectorReconciliationError('operations_unsupported', result.reason);
      }
      for (const operation of result.page.operations) {
        if (
          operation.providerInstanceId !== providerInstanceId ||
          operation.toolkit !== toolkit ||
          operation.toolkitVersion !== toolkitVersion
        ) {
          throw new ConnectorReconciliationError(
            'catalog_incomplete',
            'The provider returned operation metadata outside the requested version.'
          );
        }
        discovered.push(operation);
      }
      const next = result.page.nextCursor;
      if (!result.page.truncated && next === undefined) {
        complete = true;
        break;
      }
      if (!next || cursors.has(next)) break;
      cursors.add(next);
      cursor = next;
    }
    if (!complete) {
      throw new ConnectorReconciliationError(
        'catalog_incomplete',
        'The provider did not return a complete bounded operation catalog.'
      );
    }
    return discovered;
  }

  /** Atomically consume a current preview and replace only named-agent grants. */
  async apply(
    owner: ConnectorOwnerAuthority,
    input: ConnectorReconciliationApplyRequest,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ConnectorReconciliationApplyResponse> {
    const request = ConnectorReconciliationApplyRequestSchema.parse(input);
    this.assertUniqueSelections(request);
    const ownerRow = ownerColumns(owner);
    const now = this.now().toISOString();
    const response = this.db.transaction((tx) => {
      const preview = tx
        .select()
        .from(connectorReconciliationPreviews)
        .where(eq(connectorReconciliationPreviews.id, request.previewId))
        .get();
      if (
        !preview ||
        preview.ownerKind !== ownerRow.ownerKind ||
        preview.ownerId !== ownerRow.ownerId
      ) {
        throw new ConnectorReconciliationError(
          'preview_stale',
          'This permission review is no longer available. Refresh and review it again.'
        );
      }
      const provider = tx
        .select({
          generation: connectorProviderInstances.executionConfigGeneration,
          ownerKind: connectorProviderInstances.ownerKind,
          ownerId: connectorProviderInstances.ownerId,
          status: connectorProviderInstances.status,
          lifecycleState: connections.lifecycleState,
          mode: connectorProviderInstances.mode,
          managedConnectionId: connections.externalAccountRef,
        })
        .from(connectorProviderInstances)
        .innerJoin(connections, eq(connections.providerInstanceId, connectorProviderInstances.id))
        .where(
          and(
            eq(connectorProviderInstances.id, preview.providerInstanceId),
            eq(connections.id, preview.connectionId)
          )
        )
        .get();
      if (
        preview.consumedAt ||
        preview.bootEpoch !== this.bootEpoch ||
        Date.parse(preview.expiresAt) <= this.now().getTime() ||
        !provider ||
        provider.generation !== preview.executionConfigGeneration ||
        provider.ownerKind !== ownerRow.ownerKind ||
        provider.ownerId !== ownerRow.ownerId ||
        provider.status !== 'available' ||
        provider.lifecycleState !== 'connected'
      ) {
        throw new ConnectorReconciliationError(
          'preview_stale',
          'This permission review is stale. Refresh and review the current actions.'
        );
      }

      const currentAgentIds = new Set(this.snapshotAgents().map((agent) => agent.agentId));
      if (request.grants.some((selection) => !currentAgentIds.has(selection.agentId))) {
        throw new ConnectorReconciliationError(
          'preview_stale',
          'An agent in this permission review is no longer available. Refresh and review again.'
        );
      }

      const agentRows = tx
        .select({ agentId: connectorReconciliationAgents.agentId })
        .from(connectorReconciliationAgents)
        .where(eq(connectorReconciliationAgents.previewId, preview.id))
        .all();
      const allowedAgents = new Set(agentRows.map((row) => row.agentId));
      const candidateRows = tx
        .select({
          operationRevisionId: connectorReconciliationCandidates.operationRevisionId,
          supported: connectorReconciliationCandidates.supported,
        })
        .from(connectorReconciliationCandidates)
        .where(eq(connectorReconciliationCandidates.previewId, preview.id))
        .all();
      if (
        revisionSetHash(candidateRows.map((row) => row.operationRevisionId)) !==
        preview.completeRevisionSetHash
      ) {
        throw new ConnectorReconciliationError(
          'preview_stale',
          'This permission review is incomplete. Refresh and review it again.'
        );
      }
      const supported = new Set(
        candidateRows.filter((row) => row.supported).map((row) => row.operationRevisionId)
      );
      const classificationById = new Map(
        (candidateRows.length > 0
          ? tx
              .select({
                id: connectorOperationRevisions.id,
                classification: connectorOperationRevisions.capabilityClassification,
              })
              .from(connectorOperationRevisions)
              .where(
                inArray(
                  connectorOperationRevisions.id,
                  candidateRows.map((row) => row.operationRevisionId)
                )
              )
              .all()
          : []
        ).map((row) => [row.id, row.classification] as const)
      );
      // A level is granted with exactly its set in this review, never more:
      // a selection that names a level and anything else is refused.
      const matchesLevel = (ids: readonly string[], level: ConnectorAccessLevel | undefined) =>
        level === undefined ||
        sameIds(
          ids,
          accessLevelRevisionIds(
            candidateRows.map((row) => ({
              operationRevisionId: row.operationRevisionId,
              supported: row.supported,
              capabilityClassification: classificationById.get(row.operationRevisionId)!,
            })),
            level
          )
        );
      for (const selection of request.grants) {
        if (
          !allowedAgents.has(selection.agentId) ||
          selection.operationRevisionIds.some((id) => !supported.has(id))
        ) {
          throw new ConnectorReconciliationError(
            'invalid_selection',
            'The selected agent or action was not part of this complete permission review.'
          );
        }
        if (!matchesLevel(selection.operationRevisionIds, selection.level)) {
          throw new ConnectorReconciliationError(
            'invalid_selection',
            'The chosen level no longer matches this app’s actions. Refresh and choose again.'
          );
        }
      }
      if (request.everyAgent) {
        // A managed connection's owner-wide grant lives in hosted authority
        // too (DOR-2439), so it needs the synchronizer that carries it there.
        if (provider.mode === 'managed' && !this.managedAuthority) {
          throw new ConnectorReconciliationError(
            'every_agent_unavailable',
            'Every agent isn’t available for this app right now. Pick the agents one by one, or relink this computer and try again.'
          );
        }
        if (request.everyAgent.operationRevisionIds.some((id) => !supported.has(id))) {
          throw new ConnectorReconciliationError(
            'invalid_selection',
            'The selected action was not part of this complete permission review.'
          );
        }
        if (
          request.everyAgent.operationRevisionIds.length > 0 &&
          !matchesLevel(request.everyAgent.operationRevisionIds, request.everyAgent.level)
        ) {
          throw new ConnectorReconciliationError(
            'invalid_selection',
            'The chosen level no longer matches this app’s actions. Refresh and choose again.'
          );
        }
      }

      const consumed = tx
        .update(connectorReconciliationPreviews)
        .set({ consumedAt: now })
        .where(
          and(
            eq(connectorReconciliationPreviews.id, preview.id),
            isNull(connectorReconciliationPreviews.consumedAt)
          )
        )
        .run();
      if (consumed.changes !== 1) {
        throw new ConnectorReconciliationError(
          'preview_stale',
          'This permission review was already applied.'
        );
      }

      const managedCommandIds: string[] = [];
      for (const selection of request.grants) {
        // The level is the owner's intent and is kept at once; on a DorkOS
        // account the grants it derives open once hosted authority applies them.
        recordAccessLevel(tx, {
          connectionId: preview.connectionId,
          subject: { kind: 'agent', agentId: selection.agentId },
          level: selection.level,
          createdBy: ownerRow.ownerId,
          now,
        });
        if (provider.mode === 'managed') {
          if (!this.managedAuthority) {
            throw new ConnectorReconciliationError(
              'preview_stale',
              'Managed connection synchronization is unavailable. Relink and try again.'
            );
          }
          const selectors = managedSelectors(tx, selection.operationRevisionIds);
          managedCommandIds.push(
            this.managedAuthority.stageAgentGrantReplacement(tx, {
              connectionId: ConnectionIdSchema.parse(preview.connectionId),
              managedConnectionId: provider.managedConnectionId,
              agentId: selection.agentId,
              ...selectors,
              providerInstanceId: ConnectorProviderInstanceIdSchema.parse(
                preview.providerInstanceId
              ),
              executionConfigGeneration: preview.executionConfigGeneration,
              owner,
            })
          );
          continue;
        }
        replaceNamedAgentGrants(tx, {
          connectionId: preview.connectionId,
          agentId: selection.agentId,
          operationRevisionIds: selection.operationRevisionIds,
          createdBy: ownerRow.ownerId,
          now,
          createId: this.createId,
        });
      }
      let everyAgentChange: EveryAgentChange | undefined;
      if (request.everyAgent) {
        const before = readEveryAgentState(tx, preview.connectionId);
        // An empty set stops sharing, whatever level it names.
        recordAccessLevel(tx, {
          connectionId: preview.connectionId,
          subject: { kind: 'every_agent' },
          level:
            request.everyAgent.operationRevisionIds.length > 0
              ? request.everyAgent.level
              : undefined,
          createdBy: ownerRow.ownerId,
          now,
        });
        if (provider.mode === 'managed') {
          // Close-first: what is left out stops now, and what is newly shared
          // opens once hosted authority applies the owner-wide command.
          managedCommandIds.push(
            this.managedAuthority!.stageEveryAgentGrantReplacement(tx, {
              connectionId: ConnectionIdSchema.parse(preview.connectionId),
              managedConnectionId: provider.managedConnectionId,
              ...managedSelectors(tx, request.everyAgent.operationRevisionIds),
              providerInstanceId: ConnectorProviderInstanceIdSchema.parse(
                preview.providerInstanceId
              ),
              executionConfigGeneration: preview.executionConfigGeneration,
              owner,
              createdBy: ownerRow.ownerId,
            })
          );
          everyAgentChange = describeEveryAgentChange(
            tx,
            preview.connectionId,
            before,
            requestedEveryAgentState(
              tx,
              preview.connectionId,
              request.everyAgent.operationRevisionIds
            )
          );
        } else {
          replaceEveryAgentGrants(tx, {
            connectionId: preview.connectionId,
            operationRevisionIds: request.everyAgent.operationRevisionIds,
            createdBy: ownerRow.ownerId,
            now,
            createId: this.createId,
          });
          everyAgentChange = describeEveryAgentChange(tx, preview.connectionId, before);
        }
      }
      if (provider.mode === 'managed' && this.managedAuthority) {
        // Confirming who can use the account settles every change to it the
        // service refused, with exactly the access this review showed, so
        // "Check who can use it" is always a way out of a refused change. The
        // agents decided above already have a newer change pending, so they
        // are no longer refused and are left alone.
        managedCommandIds.push(
          ...this.managedAuthority.restageRefused(tx, {
            connectionId: ConnectionIdSchema.parse(preview.connectionId),
            why: 'confirmed',
          })
        );
      }
      if (provider.mode !== 'managed' || managedCommandIds.length === 0) {
        tx.update(connections)
          .set({ grantReconciliationStatus: 'ready', updatedAt: now })
          .where(eq(connections.id, preview.connectionId))
          .run();
      }
      return {
        connectionId: preview.connectionId,
        managedCommandIds,
        everyAgentChange,
      };
    });
    if (response.everyAgentChange) await this.record(response.everyAgentChange);
    const results = [];
    for (const commandId of response.managedCommandIds) {
      results.push(await this.managedAuthority!.deliverAgentGrantReplacement(commandId, signal));
    }
    const failed = results.find((result) => result.authoritySync.status === 'failed');
    const pending = results.some((result) => result.authoritySync.status === 'pending');
    const connection = this.db
      .select({ reconciliationStatus: connections.grantReconciliationStatus })
      .from(connections)
      .where(eq(connections.id, response.connectionId))
      .get();
    return ConnectorReconciliationApplyResponseSchema.parse({
      connectionId: response.connectionId,
      reconciliationStatus: connection?.reconciliationStatus ?? 'migration_needs_reconcile',
      authoritySync:
        failed?.authoritySync ?? (pending ? { status: 'pending' } : { status: 'ready' }),
      grants: request.grants,
      ...(request.everyAgent ? { everyAgent: request.everyAgent } : {}),
    });
  }

  /**
   * Stop sharing one connection with every agent. Taking access away needs no
   * reviewed catalog, so unlike {@link apply} this works while the provider is
   * unavailable or its configuration changed; it still requires the owner.
   *
   * @param owner - The verified connection owner.
   * @param connectionId - The connection that stops being shared.
   * @returns How many shared actions ended; zero when it was not shared.
   */
  async revokeEveryAgent(
    owner: ConnectorOwnerAuthority,
    connectionId: string
  ): Promise<{ connectionId: string; revokedCount: number }> {
    const expected = ownerColumns(owner);
    const readBinding = (db: Db | DbTransaction) =>
      db
        .select({
          ownerKind: connectorProviderInstances.ownerKind,
          ownerId: connectorProviderInstances.ownerId,
          mode: connectorProviderInstances.mode,
          providerInstanceId: connectorProviderInstances.id,
          executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
          managedConnectionId: connections.externalAccountRef,
        })
        .from(connections)
        .innerJoin(
          connectorProviderInstances,
          eq(connectorProviderInstances.id, connections.providerInstanceId)
        )
        .where(and(eq(connections.id, connectionId), isNull(connections.removedAt)))
        .get();
    const owned = (row: ReturnType<typeof readBinding>) =>
      row !== undefined && row.ownerKind === expected.ownerKind && row.ownerId === expected.ownerId;
    if (!owned(readBinding(this.db))) {
      throw new ConnectorReconciliationError('connection_not_found', 'Connection not found.');
    }
    const now = this.now().toISOString();
    const managedAuthority = this.managedAuthority;
    const result = this.db.transaction((tx) => {
      // Read the binding again inside the transaction, so the hosted command
      // below is derived from exactly the binding this revocation sees.
      const row = readBinding(tx);
      if (!row || !owned(row)) {
        throw new ConnectorReconciliationError('connection_not_found', 'Connection not found.');
      }
      const managed = row.mode === 'managed' && managedAuthority ? managedAuthority : null;
      const live = readEveryAgentState(tx, connectionId);
      const requested = managed
        ? this.lastRequestedGrants(tx, {
            managedConnectionId: row.managedConnectionId,
            providerInstanceId: row.providerInstanceId,
            subject: { kind: 'every_agent' },
          })
        : undefined;
      const revokedCount = revokeEveryAgentGrants(tx, [connectionId], now);
      endEveryAgentAccessLevels(tx, [connectionId]);
      // Local access ends here, on the next call. A managed connection also
      // tells hosted authority, which re-checks every call on its side; the
      // command waits in the outbox if the service cannot be reached. A share
      // hosted authority has not applied yet is stopped too, or it would open
      // when it lands.
      const commandId =
        managed && (revokedCount > 0 || requested?.sharing)
          ? managed.stageEveryAgentGrantReplacement(tx, {
              connectionId: ConnectionIdSchema.parse(connectionId),
              managedConnectionId: row.managedConnectionId,
              revisions: [],
              operationRevisionIds: [],
              providerInstanceId: ConnectorProviderInstanceIdSchema.parse(row.providerInstanceId),
              executionConfigGeneration: row.executionConfigGeneration,
              owner,
              createdBy: expected.ownerId,
            })
          : undefined;
      // The trail says what the owner stopped: what every agent had plus any
      // share still on its way to hosted authority.
      const before = requested
        ? requestedEveryAgentState(tx, connectionId, [
            ...new Set([...live.operationRevisionIds, ...requested.operationRevisionIds]),
          ])
        : live;
      return {
        revokedCount,
        commandId,
        managed,
        change: describeEveryAgentChange(tx, connectionId, before, {
          operationRevisionIds: [],
          classifications: [],
        }),
      };
    });
    if (result.change) await this.record(result.change);
    if (result.managed && result.commandId) {
      // Access already ended locally; don't hold the owner's request on a slow
      // service. An undelivered stop stays pending and is retried.
      await result.managed.deliverAgentGrantReplacement(
        result.commandId,
        AbortSignal.timeout(HOSTED_STOP_WAIT_MS)
      );
    }
    return { connectionId, revokedCount: result.revokedCount };
  }

  /**
   * What the last grant command sent to hosted authority for one subject of
   * this managed connection asked for, whether or not it was applied.
   * `sharing` is true when it granted anything, or when it can no longer be
   * read (a compacted command cannot prove the access ended). `undefined` when
   * no command was ever sent for the subject.
   */
  private lastRequestedGrants(
    tx: DbTransaction,
    input: {
      readonly managedConnectionId: string;
      readonly providerInstanceId: string;
      readonly subject: StoredAccessLevel['subject'];
    }
  ): { sharing: boolean; operationRevisionIds: string[] } | undefined {
    const every = input.subject.kind === 'every_agent';
    const last = tx
      .select({ requestJson: connectorManagedAuthorityOutbox.requestJson })
      .from(connectorManagedAuthorityScopes)
      .innerJoin(
        connectorManagedAuthorityOutbox,
        eq(connectorManagedAuthorityOutbox.commandId, connectorManagedAuthorityScopes.lastCommandId)
      )
      .where(
        and(
          eq(connectorManagedAuthorityScopes.managedConnectionId, input.managedConnectionId),
          eq(
            connectorManagedAuthorityScopes.scopeKind,
            every ? 'every_agent_grants' : 'agent_grants'
          ),
          eq(
            connectorManagedAuthorityScopes.subjectId,
            input.subject.kind === 'agent' ? input.subject.agentId : EVERY_AGENT_GRANT_SUBJECT_ID
          )
        )
      )
      .get();
    if (!last) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(last.requestJson);
    } catch {
      json = undefined;
    }
    const parsed = ManagedConnectorAuthorityCommandSchema.safeParse(json);
    if (
      !parsed.success ||
      parsed.data.kind !== (every ? 'replace_every_agent_grants' : 'replace_agent_grants')
    ) {
      return { sharing: true, operationRevisionIds: [] };
    }
    const revisions = 'revisions' in parsed.data ? parsed.data.revisions : [];
    const wanted = new Set(
      revisions.map(
        (revision) =>
          `${revision.hostedRevisionId}\0${revision.operationSlug}\0${revision.toolkitVersion}\0${revision.schemaHash}`
      )
    );
    const operationRevisionIds = wanted.size
      ? tx
          .select({
            id: connectorOperationRevisions.id,
            ref: connectorOperationRevisions.providerRevisionRef,
            slug: connectorOperationRevisions.operationSlug,
            version: connectorOperationRevisions.toolkitVersion,
            hash: connectorOperationRevisions.schemaHash,
          })
          .from(connectorOperationRevisions)
          .where(eq(connectorOperationRevisions.providerInstanceId, input.providerInstanceId))
          .all()
          .filter((row) => wanted.has(`${row.ref}\0${row.slug}\0${row.version}\0${row.hash}`))
          .map((row) => row.id)
          .sort()
      : [];
    return { sharing: revisions.length > 0, operationRevisionIds };
  }

  private async record(
    change: EveryAgentChange,
    writer: EveryAgentChangeWriter = this.writer()
  ): Promise<void> {
    if (!this.activity) return;
    await recordEveryAgentChange(this.activity, writer, change);
  }

  /**
   * Re-derive every level grant on one connection from the catalog a preview
   * just recorded (ADR 260929-071355), inside that preview's transaction.
   *
   * A level's grant set is exactly `accessLevelRevisionIds` of that catalog:
   * a new action of its class joins, and an action the app no longer offers
   * that way (reclassified wider, or gone) leaves. On this computer's own
   * authority the rows change at once. On a DorkOS account the change is
   * staged close-first through the hosted synchronizer, like any owner
   * change: what leaves stops now, and what joins opens only once hosted
   * authority applies it. A subject whose last requested set already matches
   * is left alone, so reading the catalog again stages nothing new.
   *
   * @returns Hosted commands to deliver, and the every-agent change to record.
   */
  private followLevels(
    tx: DbTransaction,
    input: {
      readonly connectionId: string;
      readonly providerInstanceId: string;
      readonly managedConnectionId: string;
      readonly mode: 'managed' | 'byo';
      readonly executionConfigGeneration: number;
      readonly owner: ConnectorOwnerAuthority;
      /** Agents registered now; a level of an agent that is gone is left alone. */
      readonly agentIds: ReadonlySet<string>;
      readonly candidates: ReadonlyArray<{
        readonly operationRevisionId: string;
        readonly capabilityClassification: ConnectorOperationClassification;
        readonly supported: boolean;
      }>;
      readonly now: string;
    }
  ): { commandIds: string[]; everyAgentChange?: EveryAgentChange } {
    const commandIds: string[] = [];
    let everyAgentChange: EveryAgentChange | undefined;
    const managed = input.mode === 'managed' ? this.managedAuthority : undefined;
    // A DorkOS account's grants live in hosted authority too. Without the
    // synchronizer that carries a change there, nothing may change here.
    if (input.mode === 'managed' && !managed) return { commandIds };
    for (const stored of readAccessLevels(tx, input.connectionId)) {
      if (stored.subject.kind === 'agent' && !input.agentIds.has(stored.subject.agentId)) continue;
      const target = accessLevelRevisionIds(input.candidates, stored.level);
      const held = managed
        ? (this.lastRequestedGrants(tx, { ...input, subject: stored.subject })
            ?.operationRevisionIds ?? liveGrantIds(tx, input.connectionId, stored))
        : liveGrantIds(tx, input.connectionId, stored);
      if (sameIds(held, target)) continue;
      const before =
        stored.subject.kind === 'every_agent'
          ? readEveryAgentState(tx, input.connectionId)
          : undefined;
      const base = {
        connectionId: ConnectionIdSchema.parse(input.connectionId),
        managedConnectionId: input.managedConnectionId,
        providerInstanceId: ConnectorProviderInstanceIdSchema.parse(input.providerInstanceId),
        executionConfigGeneration: input.executionConfigGeneration,
        owner: input.owner,
      };
      if (stored.subject.kind === 'agent') {
        if (managed) {
          commandIds.push(
            managed.stageAgentGrantReplacement(tx, {
              ...base,
              agentId: stored.subject.agentId,
              ...managedSelectors(tx, target),
            })
          );
        } else {
          replaceNamedAgentGrants(tx, {
            connectionId: input.connectionId,
            agentId: stored.subject.agentId,
            operationRevisionIds: target,
            createdBy: stored.createdBy,
            now: input.now,
            createId: this.createId,
          });
        }
        continue;
      }
      if (managed) {
        commandIds.push(
          managed.stageEveryAgentGrantReplacement(tx, {
            ...base,
            ...managedSelectors(tx, target),
            createdBy: stored.createdBy,
          })
        );
      } else {
        replaceEveryAgentGrants(tx, {
          connectionId: input.connectionId,
          operationRevisionIds: target,
          createdBy: stored.createdBy,
          now: input.now,
          createId: this.createId,
        });
      }
      everyAgentChange = describeEveryAgentChange(
        tx,
        input.connectionId,
        before!,
        managed ? requestedEveryAgentState(tx, input.connectionId, target) : undefined
      );
    }
    return { commandIds, ...(everyAgentChange ? { everyAgentChange } : {}) };
  }

  private resolveOwnedConnection(owner: ConnectorOwnerAuthority, connectionId: string) {
    const expected = ownerColumns(owner);
    const row = this.db
      .select({
        connectionId: connections.id,
        providerInstanceId: connections.providerInstanceId,
        toolkit: connections.toolkit,
        label: connections.label,
        status: connections.status,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        reconciliationStatus: connections.grantReconciliationStatus,
        custody: connectorProviderInstances.custody,
        mode: connectorProviderInstances.mode,
        providerStatus: connectorProviderInstances.status,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
        executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
        managedConnectionId: connections.externalAccountRef,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connections.id, connectionId))
      .get();
    if (
      !row ||
      row.ownerKind !== expected.ownerKind ||
      row.ownerId !== expected.ownerId ||
      row.lifecycleState !== 'connected' ||
      row.providerStatus !== 'available'
    ) {
      throw new ConnectorReconciliationError('connection_not_found', 'Connection not found.');
    }
    return row;
  }

  private snapshotAgents(): ConnectorReconciliationAgent[] {
    const byId = new Map<string, ConnectorReconciliationAgent>();
    for (const agent of this.listAgents()) {
      if (!byId.has(agent.agentId)) byId.set(agent.agentId, { ...agent });
    }
    return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private readPreview(
    previewId: string,
    connectionId: string,
    agents: ConnectorReconciliationAgent[],
    candidateIds: string[],
    createdAt: Date,
    everyAgentAvailable: boolean
  ) {
    const connection = this.resolveConnectionView(connectionId);
    const supportedById = new Map(
      this.db
        .select()
        .from(connectorReconciliationCandidates)
        .where(eq(connectorReconciliationCandidates.previewId, previewId))
        .all()
        .map((row) => [row.operationRevisionId, row.supported] as const)
    );
    const candidates = candidateIds.length
      ? this.db
          .select()
          .from(connectorOperationRevisions)
          .where(inArray(connectorOperationRevisions.id, candidateIds))
          .all()
          .map((row) => ({
            operationRevisionId: row.id,
            toolkit: row.toolkit,
            operationSlug: row.operationSlug,
            toolkitVersion: row.toolkitVersion,
            capabilityClassification: row.capabilityClassification,
            retryPolicy: row.retryPolicy,
            inputSchema: JSON.parse(row.inputSchemaJson) as Record<string, unknown>,
            supported: supportedById.get(row.id) ?? false,
          }))
      : [];
    const defaults = this.db
      .select()
      .from(connectorReconciliationDefaults)
      .where(eq(connectorReconciliationDefaults.previewId, previewId))
      .all();
    const grouped = new Map<string, string[]>();
    for (const row of defaults) {
      const ids = grouped.get(row.agentId) ?? [];
      ids.push(row.operationRevisionId);
      grouped.set(row.agentId, ids);
    }
    // The level each subject holds is what the owner chose, never read back
    // from which actions happen to match today.
    const levels = readAccessLevels(this.db, connectionId);
    const agentLevels = new Map<string, ConnectorAccessLevel>();
    let everyAgentLevel: ConnectorAccessLevel | undefined;
    for (const stored of levels) {
      if (stored.subject.kind === 'every_agent') everyAgentLevel = stored.level;
      else {
        const { agentId } = stored.subject;
        if (!agents.some((agent) => agent.agentId === agentId)) continue;
        agentLevels.set(agentId, stored.level);
        // A level can hold no action yet (an app with nothing to read); it is still held.
        if (!grouped.has(agentId)) grouped.set(agentId, []);
      }
    }
    const everyAgentIds = everyAgentAvailable
      ? this.db
          .select({ id: connectionOperationGrants.operationRevisionId })
          .from(connectionOperationGrants)
          .where(
            and(
              eq(connectionOperationGrants.connectionId, connectionId),
              everyAgentGrantSubject(),
              isNull(connectionOperationGrants.revokedAt)
            )
          )
          .all()
          .map((row) => row.id)
          .filter((id) => candidateIds.includes(id))
          .sort()
      : [];
    return {
      previewId,
      connection,
      candidates,
      agents,
      currentGrants: [...grouped]
        .map(([agentId, operationRevisionIds]) => {
          const level = agentLevels.get(agentId);
          return {
            agentId,
            operationRevisionIds: operationRevisionIds.sort(),
            ...(level && { level }),
          };
        })
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),
      everyAgent: {
        available: everyAgentAvailable,
        operationRevisionIds: everyAgentIds,
        ...(everyAgentAvailable && everyAgentLevel && { level: everyAgentLevel }),
      },
      catalogComplete: true as const,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.previewTtlMs).toISOString(),
    };
  }

  private resolveConnectionView(connectionId: string) {
    const row = this.db
      .select({
        connectionId: connections.id,
        toolkit: connections.toolkit,
        label: connections.label,
        status: connections.status,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        custody: connectorProviderInstances.custody,
        reconciliationStatus: connections.grantReconciliationStatus,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connections.id, connectionId))
      .get();
    if (!row) {
      throw new ConnectorReconciliationError('connection_not_found', 'Connection not found.');
    }
    return {
      connectionId: row.connectionId,
      toolkit: row.toolkit,
      label: row.label,
      status:
        row.lifecycleState === 'disconnected'
          ? ('revoked' as const)
          : row.enabled
            ? row.status
            : ('paused' as const),
      custody: row.custody,
      reconciliationStatus: row.reconciliationStatus,
    };
  }

  private assertUniqueSelections(request: ConnectorReconciliationApplyRequest): void {
    const everyAgentIds = request.everyAgent?.operationRevisionIds ?? [];
    if (new Set(everyAgentIds).size !== everyAgentIds.length) {
      throw new ConnectorReconciliationError(
        'invalid_selection',
        'Each selected action may appear only once for every agent.'
      );
    }
    const agentIds = new Set<string>();
    for (const selection of request.grants) {
      if (agentIds.has(selection.agentId)) {
        throw new ConnectorReconciliationError(
          'invalid_selection',
          'Each named agent may appear only once.'
        );
      }
      agentIds.add(selection.agentId);
      if (new Set(selection.operationRevisionIds).size !== selection.operationRevisionIds.length) {
        throw new ConnectorReconciliationError(
          'invalid_selection',
          'Each selected action may appear only once for an agent.'
        );
      }
    }
  }
}
