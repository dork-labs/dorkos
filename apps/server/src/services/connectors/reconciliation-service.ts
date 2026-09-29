/** Complete operation discovery and exact named-agent and every-agent grant reconciliation. */
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
  LINK_NEEDED_TO_CHANGE_ACCESS_COPY,
  WAY_CAPABILITY_COPY,
  type ConnectorOperationPage,
  type ConnectorReconciliationAgent,
  type ConnectorReconciliationApplyRequest,
  type ConnectorReconciliationApplyResponse,
  type ConnectorReconciliationPreview,
  type ConnectorReconciliationPreviewRequest,
} from '@dorkos/shared/connector-schemas';
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
        WAY_CAPABILITY_COPY.cannotListActions
      );
    }

    const version = await provider.resolveToolkitVersion(context.toolkit, signal);
    if (version.status === 'unsupported') {
      throw new ConnectorReconciliationError('operations_unsupported', version.reason);
    }
    if (version.toolkit !== context.toolkit) {
      throw new ConnectorReconciliationError(
        'catalog_incomplete',
        'DorkOS got another app’s actions back. Try again.'
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
    const candidateIds = this.db.transaction((tx) => {
      const supportById = new Map<string, boolean>();
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
      }

      for (const row of existingGrantRows) {
        ids.push(row.id);
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
      return uniqueIds;
    });

    return ConnectorReconciliationPreviewSchema.parse(
      this.readPreview(
        previewId,
        request.connectionId,
        agents,
        candidateIds,
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
            'DorkOS got actions back from a different version of this app. Try again.'
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
        'DorkOS couldn’t get this app’s full list of actions. Try again.'
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
      }
      if (request.everyAgent) {
        // A managed connection's owner-wide grant lives in hosted authority
        // too (DOR-2439), so it needs the synchronizer that carries it there.
        if (provider.mode === 'managed' && !this.managedAuthority) {
          throw new ConnectorReconciliationError(
            'every_agent_unavailable',
            'Every agent isn’t available for this app right now. Pick the agents one by one, or link this computer to your DorkOS account again and try again.'
          );
        }
        if (request.everyAgent.operationRevisionIds.some((id) => !supported.has(id))) {
          throw new ConnectorReconciliationError(
            'invalid_selection',
            'The selected action was not part of this complete permission review.'
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
        if (provider.mode === 'managed') {
          if (!this.managedAuthority) {
            throw new ConnectorReconciliationError(
              'preview_stale',
              LINK_NEEDED_TO_CHANGE_ACCESS_COPY
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
        const selected = new Set(selection.operationRevisionIds);
        const existing = tx
          .select({
            id: connectionOperationGrants.id,
            operationRevisionId: connectionOperationGrants.operationRevisionId,
          })
          .from(connectionOperationGrants)
          .where(
            and(
              eq(connectionOperationGrants.subjectType, 'agent'),
              eq(connectionOperationGrants.subjectId, selection.agentId),
              eq(connectionOperationGrants.connectionId, preview.connectionId)
            )
          )
          .all();
        for (const grant of existing) {
          tx.update(connectionOperationGrants)
            .set({ revokedAt: selected.has(grant.operationRevisionId) ? null : now })
            .where(eq(connectionOperationGrants.id, grant.id))
            .run();
          selected.delete(grant.operationRevisionId);
        }
        for (const operationRevisionId of selected) {
          tx.insert(connectionOperationGrants)
            .values({
              id: this.createId(),
              subjectType: 'agent',
              subjectId: selection.agentId,
              agentId: selection.agentId,
              connectionId: preview.connectionId,
              operationRevisionId,
              createdBy: ownerRow.ownerId,
              createdAt: now,
            })
            .run();
        }
      }
      let everyAgentChange: EveryAgentChange | undefined;
      if (request.everyAgent) {
        const before = readEveryAgentState(tx, preview.connectionId);
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
        ? this.lastRequestedEveryAgent(tx, row.managedConnectionId, row.providerInstanceId)
        : undefined;
      const revokedCount = revokeEveryAgentGrants(tx, [connectionId], now);
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
   * What the last owner-wide command sent to hosted authority for this managed
   * connection asked for, whether or not it was applied. `sharing` is true when
   * it shared anything, or when it can no longer be read (a compacted command
   * cannot prove the sharing ended).
   */
  private lastRequestedEveryAgent(
    tx: DbTransaction,
    managedConnectionId: string,
    providerInstanceId: string
  ): { sharing: boolean; operationRevisionIds: string[] } | undefined {
    const last = tx
      .select({ requestJson: connectorManagedAuthorityOutbox.requestJson })
      .from(connectorManagedAuthorityScopes)
      .innerJoin(
        connectorManagedAuthorityOutbox,
        eq(connectorManagedAuthorityOutbox.commandId, connectorManagedAuthorityScopes.lastCommandId)
      )
      .where(
        and(
          eq(connectorManagedAuthorityScopes.managedConnectionId, managedConnectionId),
          eq(connectorManagedAuthorityScopes.scopeKind, 'every_agent_grants')
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
    if (!parsed.success || parsed.data.kind !== 'replace_every_agent_grants') {
      return { sharing: true, operationRevisionIds: [] };
    }
    const wanted = new Set(
      parsed.data.revisions.map(
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
          .where(eq(connectorOperationRevisions.providerInstanceId, providerInstanceId))
          .all()
          .filter((row) => wanted.has(`${row.ref}\0${row.slug}\0${row.version}\0${row.hash}`))
          .map((row) => row.id)
      : [];
    return { sharing: parsed.data.revisions.length > 0, operationRevisionIds };
  }

  private async record(change: EveryAgentChange): Promise<void> {
    if (!this.activity) return;
    await recordEveryAgentChange(this.activity, this.writer(), change);
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
    return {
      previewId,
      connection,
      candidates,
      agents,
      currentGrants: [...grouped]
        .map(([agentId, operationRevisionIds]) => ({
          agentId,
          operationRevisionIds: operationRevisionIds.sort(),
        }))
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),
      everyAgent: {
        available: everyAgentAvailable,
        operationRevisionIds: everyAgentAvailable
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
          : [],
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
