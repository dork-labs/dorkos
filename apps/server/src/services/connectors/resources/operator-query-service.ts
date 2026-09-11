/** Provider-neutral owner catalog, connection, access, and lifecycle projections. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  projectConnectorAuthentication,
  type ConnectorAuthenticationSetup,
} from '@dorkos/shared/connector-provider';
import {
  agents,
  and,
  connectionOperationGrants,
  connections,
  connectorEventInbox,
  connectorEventSubscriptions,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  eq,
  isNull,
  or,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import {
  ConnectorCatalogResourcePageSchema,
  ConnectorConnectionDetailSchema,
  ConnectorConnectionSummarySchema,
  ConnectorDisconnectImpactSchema,
  ConnectorAgentConnectionsSchema,
  ConnectorSessionConnectionsSchema,
  type ConnectorAgentConnections,
  type ConnectorAuthoritySyncState,
  type ConnectorCatalogResourcePage,
  type ConnectorConnectionDetail,
  type ConnectorConnectionSummary,
  type ConnectorDisconnectImpact,
  type ConnectorProviderDisclosure,
  type ConnectorSessionConnections,
  type ConnectorUsageCounts,
} from '@dorkos/shared/connector-resource-schemas';
import {
  ConnectorProviderCapabilitySetSchema,
  type ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type {
  ManagedConnectorUsageRequest,
  ManagedConnectorUsageResponse,
} from '@dorkos/shared/connector-managed-usage-schemas';
import { custodyDisclosure } from '../custody-disclosure.js';
import type { ConnectorAgentOwnershipPort } from '../execution/authorization-service.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ConnectorRegistry } from '../registry.js';
import type { RelayAdapterCatalog } from '../routing.js';

const CATALOG_PROVIDER_PAGE_SIZE = 100;
const CATALOG_PROVIDER_PAGE_LIMIT = 100;
const CatalogCursorSchema = z
  .object({ offset: z.number().int().nonnegative(), queryHash: z.string().length(64) })
  .strict();

/** Safe owner-resource query refusal. */
export class ConnectorOperatorQueryError extends Error {
  /** Stable machine-readable refusal. */
  readonly code:
    'connection_not_found' | 'agent_not_found' | 'session_not_found' | 'invalid_cursor';

  /** Construct one safe owner-resource error. */
  constructor(code: ConnectorOperatorQueryError['code'], message: string) {
    super(message);
    this.name = 'ConnectorOperatorQueryError';
    this.code = code;
  }
}

/** Canonical session ownership resolver used by the owner-only session projection. */
export interface ConnectorSessionOwnerResolver {
  /** Resolve the current canonical agent for an owned session. */
  resolveSessionAgent(
    owner: ConnectorOwnerAuthority,
    sessionId: string
  ): { agentId: string } | undefined | Promise<{ agentId: string } | undefined>;
}

/** Hosted authoritative usage reader for managed connection summaries. */
export interface ConnectorManagedUsageQueryPort {
  /** Read one bounded hosted usage page and its lifetime counts. */
  listManagedConnectorUsage(
    request: ManagedConnectorUsageRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorUsageResponse>;
}

/** Construction options for owner connector resource reads. */
export interface ConnectorOperatorQueryServiceOptions {
  /** Canonical connector database. */
  readonly db: Db;
  /** Registered provider instances. */
  readonly registry: ConnectorRegistry;
  /** Optional Relay catalog for message-intent rows. */
  readonly relay?: RelayAdapterCatalog;
  /** Verified canonical session-to-agent resolver. */
  readonly sessions: ConnectorSessionOwnerResolver;
  /** Owner-aware agent lookup shared with program execution authorization. */
  readonly agentOwnership: ConnectorAgentOwnershipPort;
  /** Hosted authoritative counts for DorkOS-managed connections. */
  readonly managedUsage?: ConnectorManagedUsageQueryPort;
  /** Recover an absent hosted provider before a normal catalog read. */
  readonly recoverManagedProvider?: () => Promise<void>;
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

function lifecycle(row: { lifecycleState: 'connected' | 'disconnected'; enabled: boolean }) {
  return row.lifecycleState === 'disconnected'
    ? ('disconnected' as const)
    : row.enabled
      ? ('connected' as const)
      : ('paused' as const);
}

function queryHash(query: string): string {
  return createHash('sha256').update(query).digest('hex');
}

function decodeCatalogCursor(cursor: string | undefined, query: string): number {
  if (!cursor) return 0;
  try {
    const decoded = CatalogCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    );
    if (decoded.queryHash !== queryHash(query)) throw new Error('query changed');
    return decoded.offset;
  } catch {
    throw new ConnectorOperatorQueryError(
      'invalid_cursor',
      'This catalog page is invalid. Use the next page link from the previous result.'
    );
  }
}

function encodeCatalogCursor(offset: number, query: string): string {
  return Buffer.from(JSON.stringify({ offset, queryHash: queryHash(query) }), 'utf8').toString(
    'base64url'
  );
}

/** SQLite-backed owner resource projection service. */
export class ConnectorOperatorQueryService {
  private readonly db: Db;
  private readonly registry: ConnectorRegistry;
  private readonly relay: RelayAdapterCatalog | undefined;
  private readonly sessions: ConnectorSessionOwnerResolver;
  private readonly agentOwnership: ConnectorAgentOwnershipPort;
  private readonly managedUsage: ConnectorManagedUsageQueryPort | undefined;
  private readonly recoverManagedProvider: (() => Promise<void>) | undefined;

  /** Construct owner projections over canonical connector state. */
  constructor(options: ConnectorOperatorQueryServiceOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.relay = options.relay;
    this.sessions = options.sessions;
    this.agentOwnership = options.agentOwnership;
    this.managedUsage = options.managedUsage;
    this.recoverManagedProvider = options.recoverManagedProvider;
  }

  /** Return a bounded account-free catalog page across every live provider. */
  async catalog(input: {
    includeAuthenticationSetup?: boolean;
    query?: string;
    cursor?: string;
    limit?: number;
    signal: AbortSignal;
  }): Promise<ConnectorCatalogResourcePage> {
    this.registry.assertAvailable();
    await this.recoverManagedProvider?.();
    const query = input.query?.trim().toLowerCase() ?? '';
    const offset = decodeCatalogCursor(input.cursor, query);
    const limit = input.limit ?? 50;
    const services = new Map<
      string,
      {
        serviceSlug: string;
        displayName: string;
        iconKey: string;
        accountRoutes: Array<
          ConnectorProviderDisclosure & {
            authKind: 'oauth2' | 'api-key' | 'none';
            authenticationSetup?: ConnectorAuthenticationSetup;
          }
        >;
      }
    >();
    const warnings: Array<{ code: string; message: string }> = [];

    for (const { manifest } of this.relay?.getCatalog?.() ?? []) {
      const displayName = manifest.displayName ?? manifest.type;
      if (
        query &&
        !manifest.type.toLowerCase().includes(query) &&
        !displayName.toLowerCase().includes(query)
      ) {
        continue;
      }
      services.set(manifest.type, {
        serviceSlug: manifest.type,
        displayName,
        iconKey: manifest.type,
        accountRoutes: [],
      });
    }

    await Promise.all(
      this.registry.listProviders().map(async (provider) => {
        try {
          let cursor: string | undefined;
          for (let pageIndex = 0; pageIndex < CATALOG_PROVIDER_PAGE_LIMIT; pageIndex += 1) {
            input.signal.throwIfAborted();
            const result = await provider.listToolkitPage({
              ...(cursor ? { cursor } : {}),
              ...(query ? { query } : {}),
              limit: CATALOG_PROVIDER_PAGE_SIZE,
              signal: input.signal,
            });
            if (result.status === 'unsupported') {
              warnings.push({
                code: 'catalog_unavailable',
                message: `${this.providerDisplayName(provider)} cannot list services right now.`,
              });
              return;
            }
            for (const rawToolkit of result.toolkits) {
              const toolkit = projectConnectorAuthentication(
                rawToolkit,
                input.includeAuthenticationSetup === true
              );
              const disclosure = this.providerDisclosure(provider);
              const routeAuthentication =
                disclosure.capabilities.authentication.status === 'available'
                  ? (toolkit.authentication ?? disclosure.capabilities.authentication)
                  : disclosure.capabilities.authentication;
              const current = services.get(toolkit.slug) ?? {
                serviceSlug: toolkit.slug,
                displayName: toolkit.displayName,
                iconKey: toolkit.slug,
                accountRoutes: [],
              };
              current.accountRoutes.push({
                ...disclosure,
                ...(toolkit.authentication && {
                  capabilities: {
                    ...disclosure.capabilities,
                    authentication: routeAuthentication,
                  },
                }),
                authKind: toolkit.authKind,
                ...(toolkit.authenticationSetup
                  ? { authenticationSetup: toolkit.authenticationSetup }
                  : {}),
              });
              services.set(toolkit.slug, current);
            }
            cursor = result.nextCursor;
            if (!cursor) return;
          }
          warnings.push({
            code: 'catalog_truncated',
            message: `${this.providerDisplayName(provider)} returned more services than DorkOS can list safely.`,
          });
        } catch (error) {
          if (input.signal.aborted) throw error;
          warnings.push({
            code: 'catalog_provider_unavailable',
            message: `${this.providerDisplayName(provider)} is temporarily unavailable.`,
          });
        }
      })
    );

    const all = [...services.values()]
      .map((service) => {
        const intents: ConnectorCatalogResourcePage['services'][number]['intents'] = [];
        if (this.relay?.getManifest(service.serviceSlug)) {
          intents.push({
            kind: 'messages',
            displayName: `Messages through a ${service.displayName} bot`,
            relayAdapterType: service.serviceSlug,
          });
        }
        if (service.accountRoutes.length > 0) {
          intents.push({
            kind: 'account',
            displayName: `Use a ${service.displayName} account`,
            routes: service.accountRoutes.sort(
              (left, right) =>
                (left.mode === 'managed' ? 0 : 1) - (right.mode === 'managed' ? 0 : 1) ||
                left.displayName.localeCompare(right.displayName)
            ),
          });
        }
        return { ...service, intents };
      })
      .map(({ accountRoutes: _routes, ...service }) => service)
      .sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) ||
          left.serviceSlug.localeCompare(right.serviceSlug)
      );
    const page = all.slice(offset, offset + limit);
    return ConnectorCatalogResourcePageSchema.parse({
      services: page,
      ...(offset + page.length < all.length
        ? { nextCursor: encodeCatalogCursor(offset + page.length, query) }
        : {}),
      warnings,
    });
  }

  /** List every stable connection owned by the verified operator. */
  async listConnections(
    owner: ConnectorOwnerAuthority,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ConnectorConnectionSummary[]> {
    const owned = ownerColumns(owner);
    const rows = this.db
      .select({
        connectionId: connections.id,
        providerInstanceId: connections.providerInstanceId,
        externalAccountRef: connections.externalAccountRef,
        toolkit: connections.toolkit,
        label: connections.label,
        identityHint: connections.identityHint,
        authenticationStatus: connections.status,
        lifecycleState: connections.lifecycleState,
        externalCleanupState: connections.externalCleanupState,
        enabled: connections.enabled,
        reconciliationStatus: connections.grantReconciliationStatus,
        mode: connectorProviderInstances.mode,
        custody: connectorProviderInstances.custody,
        displayName: connectorProviderInstances.displayName,
        capabilityJson: connectorProviderInstances.capabilityJson,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          isNull(connections.removedAt),
          eq(connectorProviderInstances.ownerKind, owned.ownerKind),
          eq(connectorProviderInstances.ownerId, owned.ownerId)
        )
      )
      .all();
    return (await Promise.all(rows.map((row) => this.connectionSummary(row, signal)))).sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.connectionId.localeCompare(right.connectionId)
    );
  }

  /** Return owner-visible detail for one exact stable connection. */
  async getConnection(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ConnectorConnectionDetail> {
    const row = this.ownedConnection(owner, connectionId);
    if (!row) this.connectionNotFound();
    const summary = await this.connectionSummary(row, signal);
    const provider = this.registry.resolveProviderInstance(
      row.providerInstanceId as ConnectorProviderInstanceId
    );
    const agentsById = new Map<
      string,
      {
        agentId: string;
        displayName: string;
        operationRevisionIds: string[];
        classifications: Array<'read' | 'write' | 'destructive'>;
      }
    >();
    const grantRows = this.db
      .select({
        agentId: connectionOperationGrants.subjectId,
        displayName: agents.displayName,
        name: agents.name,
        revisionId: connectionOperationGrants.operationRevisionId,
        classification: connectorOperationRevisions.capabilityClassification,
      })
      .from(connectionOperationGrants)
      .innerJoin(agents, eq(agents.id, connectionOperationGrants.subjectId))
      .innerJoin(
        connectorOperationRevisions,
        eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
      )
      .where(
        and(
          eq(connectionOperationGrants.connectionId, connectionId),
          eq(connectionOperationGrants.subjectType, 'agent'),
          isNull(connectionOperationGrants.revokedAt)
        )
      )
      .all();
    for (const grant of grantRows) {
      const current = agentsById.get(grant.agentId) ?? {
        agentId: grant.agentId,
        displayName: grant.displayName ?? grant.name,
        operationRevisionIds: [],
        classifications: [],
      };
      current.operationRevisionIds.push(grant.revisionId);
      if (!current.classifications.includes(grant.classification)) {
        current.classifications.push(grant.classification);
      }
      agentsById.set(grant.agentId, current);
    }
    const subscriptionRows = this.db
      .select({ enabled: connectorEventSubscriptions.enabled })
      .from(connectorEventSubscriptions)
      .where(eq(connectorEventSubscriptions.connectionId, connectionId))
      .all();
    const sessions = this.db
      .select({ sessionId: sessionConnectionOverrides.sessionId })
      .from(sessionConnectionOverrides)
      .where(eq(sessionConnectionOverrides.connectionId, connectionId))
      .all();
    const disclosure = provider
      ? this.providerDisclosure(provider)
      : this.storedProviderDisclosure(row);
    return ConnectorConnectionDetailSchema.parse({
      connection: summary,
      provider: disclosure,
      agents: [...agentsById.values()].map((agent) => ({
        ...agent,
        operationRevisionIds: agent.operationRevisionIds.sort(),
        classifications: agent.classifications.sort(),
        reconciliationStatus: row.reconciliationStatus,
        authoritySync: this.authoritySync(row.mode, row.externalAccountRef),
      })),
      sessions: { affectedCount: new Set(sessions.map((session) => session.sessionId)).size },
      subscriptions: {
        totalCount: subscriptionRows.length,
        activeCount: subscriptionRows.filter((subscription) => subscription.enabled).length,
        capability: disclosure.capabilities.triggers,
      },
    });
  }

  /** Return owner-visible counts affected by disconnecting one connection. */
  disconnectImpact(
    owner: ConnectorOwnerAuthority,
    connectionId: string
  ): ConnectorDisconnectImpact {
    if (!this.ownedConnection(owner, connectionId)) this.connectionNotFound();
    const agents = this.db
      .select({ agentId: connectionOperationGrants.agentId })
      .from(connectionOperationGrants)
      .where(
        and(
          eq(connectionOperationGrants.connectionId, connectionId),
          isNull(connectionOperationGrants.revokedAt)
        )
      )
      .all();
    const sessions = this.db
      .select({ sessionId: sessionConnectionOverrides.sessionId })
      .from(sessionConnectionOverrides)
      .where(eq(sessionConnectionOverrides.connectionId, connectionId))
      .all();
    const subscriptions = this.db
      .select({ id: connectorEventSubscriptions.id })
      .from(connectorEventSubscriptions)
      .where(eq(connectorEventSubscriptions.connectionId, connectionId))
      .all();
    const pendingDeliveries = subscriptions.length
      ? this.db
          .select({ id: connectorEventInbox.id })
          .from(connectorEventInbox)
          .where(
            or(
              ...subscriptions.map((subscription) =>
                and(
                  eq(connectorEventInbox.subscriptionId, subscription.id),
                  or(
                    eq(connectorEventInbox.state, 'received'),
                    eq(connectorEventInbox.state, 'leased'),
                    eq(connectorEventInbox.state, 'dispatched')
                  )
                )
              )
            )
          )
          .all().length
      : 0;
    return ConnectorDisconnectImpactSchema.parse({
      connectionId,
      affectedAgentCount: new Set(agents.flatMap((row) => (row.agentId ? [row.agentId] : []))).size,
      affectedSessionCount: new Set(sessions.map((row) => row.sessionId)).size,
      affectedSubscriptionCount: subscriptions.length,
      pendingDeliveryCount: pendingDeliveries,
    });
  }

  /** Return exact current connection grants for one owned agent profile. */
  async agentConnections(
    owner: ConnectorOwnerAuthority,
    agentId: string
  ): Promise<ConnectorAgentConnections> {
    if (!(await this.agentOwnership.ownsAgent(owner, agentId))) {
      throw new ConnectorOperatorQueryError('agent_not_found', 'Agent not found.');
    }
    const owned = ownerColumns(owner);
    const rows = this.db
      .select({
        connectionId: connections.id,
        toolkit: connections.toolkit,
        label: connections.label,
        lifecycleState: connections.lifecycleState,
        externalCleanupState: connections.externalCleanupState,
        enabled: connections.enabled,
        authenticationStatus: connections.status,
        reconciliationStatus: connections.grantReconciliationStatus,
        externalAccountRef: connections.externalAccountRef,
        mode: connectorProviderInstances.mode,
        revisionId: connectionOperationGrants.operationRevisionId,
      })
      .from(connectionOperationGrants)
      .innerJoin(connections, eq(connections.id, connectionOperationGrants.connectionId))
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(connectionOperationGrants.subjectType, 'agent'),
          eq(connectionOperationGrants.subjectId, agentId),
          isNull(connectionOperationGrants.revokedAt),
          isNull(connections.removedAt),
          eq(connectorProviderInstances.ownerKind, owned.ownerKind),
          eq(connectorProviderInstances.ownerId, owned.ownerId)
        )
      )
      .all();
    const grouped = new Map<string, (typeof rows)[number] & { operationRevisionIds: string[] }>();
    for (const row of rows) {
      const current = grouped.get(row.connectionId) ?? { ...row, operationRevisionIds: [] };
      current.operationRevisionIds.push(row.revisionId);
      grouped.set(row.connectionId, current);
    }
    return ConnectorAgentConnectionsSchema.parse({
      agentId,
      connections: [...grouped.values()].map((row) => ({
        connectionId: row.connectionId,
        toolkit: row.toolkit,
        label: row.label,
        lifecycle: lifecycle(row),
        authenticationStatus: row.authenticationStatus,
        reconciliationStatus: row.reconciliationStatus,
        operationRevisionIds: row.operationRevisionIds.sort(),
        authoritySync: this.authoritySync(row.mode, row.externalAccountRef),
      })),
    });
  }

  /** Return effective exact grants for one verified canonical session. */
  async sessionConnections(
    owner: ConnectorOwnerAuthority,
    sessionId: string
  ): Promise<ConnectorSessionConnections> {
    const resolved = await this.sessions.resolveSessionAgent(owner, sessionId);
    if (!resolved) {
      throw new ConnectorOperatorQueryError('session_not_found', 'Session not found.');
    }
    const inherited = await this.agentConnections(owner, resolved.agentId);
    const byConnection = new Map<
      string,
      {
        connectionId: string;
        toolkit: string;
        label: string;
        access: 'inherited' | 'session_only' | 'disabled';
        operationRevisionIds: string[];
        dominatingReason:
          | 'none'
          | 'connection_paused'
          | 'connection_revoked'
          | 'authentication_required'
          | 'session_detached'
          | 'reconciliation_required'
          | 'authority_sync_required';
      }
    >(
      inherited.connections.map((connection) => [
        connection.connectionId,
        {
          connectionId: connection.connectionId,
          toolkit: connection.toolkit,
          label: connection.label,
          access:
            connection.lifecycle === 'connected' &&
            connection.authenticationStatus === 'active' &&
            connection.reconciliationStatus === 'ready' &&
            connection.authoritySync.status === 'ready'
              ? ('inherited' as const)
              : ('disabled' as const),
          operationRevisionIds: [...connection.operationRevisionIds],
          dominatingReason:
            connection.lifecycle === 'paused'
              ? ('connection_paused' as const)
              : connection.lifecycle === 'disconnected'
                ? ('connection_revoked' as const)
                : connection.authenticationStatus !== 'active'
                  ? ('authentication_required' as const)
                  : connection.reconciliationStatus !== 'ready'
                    ? ('reconciliation_required' as const)
                    : connection.authoritySync.status !== 'ready'
                      ? ('authority_sync_required' as const)
                      : ('none' as const),
        },
      ])
    );
    const overrides = this.db
      .select({
        connectionId: sessionConnectionOverrides.connectionId,
        state: sessionConnectionOverrides.state,
        agentId: sessionConnectionOverrides.agentId,
        needsReconciliation: sessionConnectionOverrides.needsReconciliation,
        toolkit: connections.toolkit,
        label: connections.label,
        lifecycleState: connections.lifecycleState,
        externalCleanupState: connections.externalCleanupState,
        enabled: connections.enabled,
        authenticationStatus: connections.status,
        reconciliationStatus: connections.grantReconciliationStatus,
        mode: connectorProviderInstances.mode,
        externalAccountRef: connections.externalAccountRef,
      })
      .from(sessionConnectionOverrides)
      .innerJoin(connections, eq(connections.id, sessionConnectionOverrides.connectionId))
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(sessionConnectionOverrides.sessionId, sessionId),
          isNull(connections.removedAt),
          eq(connectorProviderInstances.ownerKind, ownerColumns(owner).ownerKind),
          eq(connectorProviderInstances.ownerId, ownerColumns(owner).ownerId)
        )
      )
      .all();
    for (const override of overrides) {
      const validOwner = override.agentId === resolved.agentId && !override.needsReconciliation;
      const sessionRevisionRows = this.db
        .select({ revisionId: connectionOperationGrants.operationRevisionId })
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.subjectType, 'session'),
            eq(connectionOperationGrants.subjectId, sessionId),
            eq(connectionOperationGrants.connectionId, override.connectionId),
            eq(connectionOperationGrants.agentId, resolved.agentId),
            isNull(connectionOperationGrants.revokedAt)
          )
        )
        .all();
      const rowLifecycle = lifecycle(override);
      const authorityReady =
        this.authoritySync(override.mode, override.externalAccountRef).status === 'ready';
      byConnection.set(override.connectionId, {
        connectionId: override.connectionId,
        toolkit: override.toolkit,
        label: override.label,
        access:
          validOwner &&
          override.state === 'attached' &&
          sessionRevisionRows.length > 0 &&
          rowLifecycle === 'connected' &&
          override.authenticationStatus === 'active' &&
          override.reconciliationStatus === 'ready' &&
          authorityReady
            ? 'session_only'
            : 'disabled',
        operationRevisionIds:
          validOwner && override.state === 'attached'
            ? sessionRevisionRows.map((row) => row.revisionId).sort()
            : [],
        dominatingReason:
          rowLifecycle === 'paused'
            ? 'connection_paused'
            : rowLifecycle === 'disconnected'
              ? 'connection_revoked'
              : override.authenticationStatus !== 'active'
                ? 'authentication_required'
                : override.reconciliationStatus !== 'ready'
                  ? 'reconciliation_required'
                  : !validOwner
                    ? 'session_detached'
                    : override.state === 'detached'
                      ? 'session_detached'
                      : sessionRevisionRows.length === 0
                        ? 'reconciliation_required'
                        : !authorityReady
                          ? 'authority_sync_required'
                          : 'none',
      });
    }
    return ConnectorSessionConnectionsSchema.parse({
      sessionId,
      agentId: resolved.agentId,
      connections: [...byConnection.values()].sort(
        (left, right) =>
          left.label.localeCompare(right.label) ||
          left.connectionId.localeCompare(right.connectionId)
      ),
    });
  }

  private ownedConnection(owner: ConnectorOwnerAuthority, connectionId: string) {
    const owned = ownerColumns(owner);
    return this.db
      .select({
        connectionId: connections.id,
        providerInstanceId: connections.providerInstanceId,
        externalAccountRef: connections.externalAccountRef,
        toolkit: connections.toolkit,
        label: connections.label,
        identityHint: connections.identityHint,
        authenticationStatus: connections.status,
        lifecycleState: connections.lifecycleState,
        externalCleanupState: connections.externalCleanupState,
        enabled: connections.enabled,
        reconciliationStatus: connections.grantReconciliationStatus,
        mode: connectorProviderInstances.mode,
        custody: connectorProviderInstances.custody,
        displayName: connectorProviderInstances.displayName,
        capabilityJson: connectorProviderInstances.capabilityJson,
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
          eq(connectorProviderInstances.ownerKind, owned.ownerKind),
          eq(connectorProviderInstances.ownerId, owned.ownerId)
        )
      )
      .get();
  }

  private async connectionSummary(
    row: NonNullable<ReturnType<ConnectorOperatorQueryService['ownedConnection']>>,
    signal: AbortSignal
  ): Promise<ConnectorConnectionSummary> {
    const grants = this.db
      .select({ agentId: connectionOperationGrants.agentId })
      .from(connectionOperationGrants)
      .where(
        and(
          eq(connectionOperationGrants.connectionId, row.connectionId),
          eq(connectionOperationGrants.subjectType, 'agent'),
          isNull(connectionOperationGrants.revokedAt)
        )
      )
      .all();
    const subscriptions = this.db
      .select({ id: connectorEventSubscriptions.id })
      .from(connectorEventSubscriptions)
      .where(eq(connectorEventSubscriptions.connectionId, row.connectionId))
      .all();
    const usage = await this.usageCounts(row, signal);
    return ConnectorConnectionSummarySchema.parse({
      connectionId: row.connectionId,
      providerInstanceId: row.providerInstanceId,
      toolkit: row.toolkit,
      label: row.label,
      identityHint: row.identityHint,
      lifecycle: lifecycle(row),
      authenticationStatus: row.authenticationStatus,
      reconciliationStatus: row.reconciliationStatus,
      authoritySync: this.authoritySync(row.mode, row.externalAccountRef),
      mode: row.mode,
      custody: row.custody,
      payer: row.mode === 'managed' ? 'dorkos_managed' : 'operator_byo',
      agentCount: new Set(grants.flatMap((grant) => (grant.agentId ? [grant.agentId] : []))).size,
      subscriptionCount: subscriptions.length,
      usage,
      warnings: [],
    });
  }

  private async usageCounts(
    row: NonNullable<ReturnType<ConnectorOperatorQueryService['ownedConnection']>>,
    signal: AbortSignal
  ): Promise<ConnectorUsageCounts> {
    if (row.mode === 'managed') {
      if (!this.managedUsage) {
        return { status: 'unavailable', reason: 'Managed usage is temporarily unavailable.' };
      }
      try {
        const result = await this.managedUsage.listManagedConnectorUsage(
          {
            version: 1,
            managedConnectionId: row.externalAccountRef,
            limit: 1,
          },
          signal
        );
        return result.status === 'available'
          ? {
              status: 'available',
              logicalOperationCount: result.counts.logicalOperationCount,
              attemptCount: result.counts.attemptCount,
            }
          : { status: 'unavailable', reason: result.reason };
      } catch {
        return { status: 'unavailable', reason: 'Managed usage is temporarily unavailable.' };
      }
    }
    try {
      const attempts = this.db
        .select({ logicalOperationId: connectorUsageAttempts.logicalOperationId })
        .from(connectorUsageAttempts)
        .where(eq(connectorUsageAttempts.connectionId, row.connectionId))
        .all();
      return {
        status: 'available',
        logicalOperationCount: new Set(attempts.map((attempt) => attempt.logicalOperationId)).size,
        attemptCount: attempts.length,
      };
    } catch {
      return { status: 'unavailable', reason: 'Usage is temporarily unavailable.' };
    }
  }

  private authoritySync(
    mode: 'managed' | 'byo',
    managedConnectionId: string
  ): ConnectorAuthoritySyncState {
    if (mode === 'byo') return { status: 'ready' };
    const rows = this.db
      .select({
        state: connectorManagedAuthorityOutbox.state,
        safeReason: connectorManagedAuthorityOutbox.safeReason,
      })
      .from(connectorManagedAuthorityScopes)
      .innerJoin(
        connectorManagedAuthorityOutbox,
        eq(connectorManagedAuthorityOutbox.commandId, connectorManagedAuthorityScopes.lastCommandId)
      )
      .where(eq(connectorManagedAuthorityScopes.managedConnectionId, managedConnectionId))
      .all();
    if (rows.some((row) => row.state === 'pending')) return { status: 'pending' };
    const rejected = rows.find((row) => row.state === 'rejected');
    return rejected
      ? { status: 'failed', reason: rejected.safeReason ?? 'Managed access could not synchronize.' }
      : { status: 'ready' };
  }

  private providerDisclosure(provider: ConnectorProvider): ConnectorProviderDisclosure {
    const row = this.db
      .select({
        displayName: connectorProviderInstances.displayName,
        mode: connectorProviderInstances.mode,
      })
      .from(connectorProviderInstances)
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .get();
    const capabilities = provider.getCapabilities();
    return {
      providerInstanceId: provider.instanceId,
      displayName: row?.displayName ?? provider.type,
      mode: row?.mode ?? 'byo',
      custody: capabilities.custody,
      payer: row?.mode === 'managed' ? 'dorkos_managed' : 'operator_byo',
      capabilities: capabilities.capabilities,
      disclosure: custodyDisclosure(capabilities.custody, {
        service: row?.displayName ?? provider.type,
      }),
    };
  }

  private storedProviderDisclosure(
    row: NonNullable<ReturnType<ConnectorOperatorQueryService['ownedConnection']>>
  ): ConnectorProviderDisclosure {
    return {
      providerInstanceId: row.providerInstanceId as ConnectorProviderInstanceId,
      displayName: row.displayName,
      mode: row.mode,
      custody: row.custody,
      payer: row.mode === 'managed' ? 'dorkos_managed' : 'operator_byo',
      capabilities: ConnectorProviderCapabilitySetSchema.parse(JSON.parse(row.capabilityJson)),
      disclosure: custodyDisclosure(row.custody, { service: row.displayName }),
    };
  }

  private providerDisplayName(provider: ConnectorProvider): string {
    return (
      this.db
        .select({ displayName: connectorProviderInstances.displayName })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, provider.instanceId))
        .get()?.displayName ?? provider.type
    );
  }

  private connectionNotFound(): never {
    throw new ConnectorOperatorQueryError('connection_not_found', 'Connection not found.');
  }
}
