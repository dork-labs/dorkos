/** Complete operation discovery and exact named-agent grant reconciliation. */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  and,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReconciliationAgents,
  connectorReconciliationCandidates,
  connectorReconciliationDefaults,
  connectorReconciliationPreviews,
  eq,
  inArray,
  isNull,
  type Db,
} from '@dorkos/db';
import {
  ConnectorReconciliationApplyRequestSchema,
  ConnectorReconciliationApplyResponseSchema,
  ConnectorProviderInstanceIdSchema,
  ConnectorReconciliationPreviewRequestSchema,
  ConnectorReconciliationPreviewSchema,
  type ConnectorOperationRevision,
  type ConnectorReconciliationAgent,
  type ConnectorReconciliationApplyRequest,
  type ConnectorReconciliationApplyResponse,
  type ConnectorReconciliationPreview,
  type ConnectorReconciliationPreviewRequest,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorOwnerAuthority } from './principal/server-principal.js';
import type { ConnectorRegistry } from './registry.js';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_PREVIEW_TTL_MS = 10 * 60_000;

/** Stable refusal codes returned by the reconciliation HTTP boundary. */
export type ConnectorReconciliationErrorCode =
  | 'connection_not_found'
  | 'operations_unsupported'
  | 'catalog_incomplete'
  | 'preview_stale'
  | 'invalid_selection';

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

type DiscoveredOperation = Omit<ConnectorOperationRevision, 'id' | 'discoveredAt'>;

function operationIdentity(operation: DiscoveredOperation): string {
  return [
    operation.providerInstanceId,
    operation.toolkit,
    operation.operationSlug,
    operation.toolkitVersion,
    operation.schemaHash,
    operation.capabilityClassification,
    operation.retryPolicy,
  ].join('\n');
}

/** SQLite-backed complete-catalog preview and atomic named-agent grant service. */
export class ConnectorReconciliationService {
  private readonly db: Db;
  private readonly registry: ConnectorRegistry;
  private readonly bootEpoch: string;
  private readonly listAgents: () => ConnectorReconciliationAgentSource[];
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
          eq(connectionOperationGrants.subjectType, 'agent'),
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
              eq(connectorOperationRevisions.retryPolicy, operation.retryPolicy)
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
      this.readPreview(previewId, request.connectionId, agents, candidateIds, createdAt)
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
  apply(
    owner: ConnectorOwnerAuthority,
    input: ConnectorReconciliationApplyRequest
  ): ConnectorReconciliationApplyResponse {
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

      for (const selection of request.grants) {
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
      tx.update(connections)
        .set({ grantReconciliationStatus: 'ready', updatedAt: now })
        .where(eq(connections.id, preview.connectionId))
        .run();
      return {
        connectionId: preview.connectionId,
        reconciliationStatus: 'ready' as const,
        grants: request.grants,
      };
    });
    return ConnectorReconciliationApplyResponseSchema.parse(response);
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
    createdAt: Date
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
