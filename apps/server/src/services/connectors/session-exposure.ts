/**
 * Read-only projection of durable session connector overrides.
 *
 * Connector operations execute only through DorkOS's broker. This service does
 * not resolve or cache provider endpoints and does not expose vendor MCP servers
 * to a runtime. It keeps the retained P1 session-status route honest while P3
 * moves all access editing into the Connections workspace.
 *
 * @module services/connectors/session-exposure
 */
import type {
  ConnectedAccountId,
  SessionConnectorAccountStatus,
  SessionConnectorStatus,
  SessionConnectorWarning,
} from '@dorkos/shared/connector-provider';
import { and, connectionOperationGrants, eq, isNull, or, type Db } from '@dorkos/db';
import type { ConnectorRegistry } from './registry.js';
import {
  SessionConnectorOwnerUnavailableError,
  type AgentConnectorAttachmentStore,
  type SessionConnectorAttachmentStore,
} from './attachment-store.js';
import type { ConnectorMigrationResult } from './legacy-connection-migration.js';

/** Construction options for {@link SessionConnectorService}. */
export interface SessionConnectorServiceOpts {
  /** Canonical operation-grant store used to report effective access. */
  db: Db;
  /** Canonical registry used for stable connection labels and lifecycle. */
  registry: ConnectorRegistry;
  /** Retained legacy agent rows surfaced only as reconciliation evidence. */
  agentAttachments: AgentConnectorAttachmentStore;
  /** Durable per-session override store. */
  sessionAttachments: SessionConnectorAttachmentStore;
}

/** Read-only session connector status and canonical-id migration. */
export class SessionConnectorService {
  private readonly db: Db;
  private readonly registry: ConnectorRegistry;
  private readonly agentAttachments: AgentConnectorAttachmentStore;
  private readonly sessionAttachments: SessionConnectorAttachmentStore;

  /** Construct the projection over canonical connection and override stores. */
  constructor(options: SessionConnectorServiceOpts) {
    this.db = options.db;
    this.registry = options.registry;
    this.agentAttachments = options.agentAttachments;
    this.sessionAttachments = options.sessionAttachments;
  }

  /** Current connector migration health for the retained status route. */
  migrationHealth(): ConnectorMigrationResult {
    return this.registry.migrationHealth();
  }

  /**
   * Return the durable access ladder for one session without resolving provider
   * transport. An explicit session row always wins over inherited agent access;
   * a detached row remains visible because later agent grants cannot override it.
   *
   * @param sessionId - Session whose retained access state is projected.
   */
  status(sessionId: string): SessionConnectorStatus {
    const overrides = this.sessionAttachments.listForSession(sessionId);
    let owner: string | undefined;
    try {
      owner = this.sessionAttachments.requireOwner(sessionId);
    } catch (error) {
      if (!(error instanceof SessionConnectorOwnerUnavailableError)) throw error;
      const candidates = new Set(overrides.flatMap((row) => (row.agentId ? [row.agentId] : [])));
      if (candidates.size === 1) owner = [...candidates][0];
    }

    const accessByConnection = new Map<
      ConnectedAccountId,
      SessionConnectorAccountStatus['access']
    >();
    const agentGrantConnections = new Set<ConnectedAccountId>();
    const sessionGrantConnections = new Set<ConnectedAccountId>();
    if (owner) {
      const grants = this.db
        .select({
          subjectType: connectionOperationGrants.subjectType,
          connectionId: connectionOperationGrants.connectionId,
        })
        .from(connectionOperationGrants)
        .where(
          and(
            isNull(connectionOperationGrants.revokedAt),
            eq(connectionOperationGrants.agentId, owner),
            or(
              and(
                eq(connectionOperationGrants.subjectType, 'agent'),
                eq(connectionOperationGrants.subjectId, owner)
              ),
              and(
                eq(connectionOperationGrants.subjectType, 'session'),
                eq(connectionOperationGrants.subjectId, sessionId)
              )
            )
          )
        )
        .all();
      for (const grant of grants) {
        const connections =
          grant.subjectType === 'session' ? sessionGrantConnections : agentGrantConnections;
        connections.add(grant.connectionId as ConnectedAccountId);
      }

      for (const attachment of this.agentAttachments.listForAgent(owner)) {
        accessByConnection.set(
          attachment.accountId,
          agentGrantConnections.has(attachment.accountId) ? 'inherited' : 'needs_reconciliation'
        );
      }
      for (const accountId of agentGrantConnections) {
        accessByConnection.set(accountId, 'inherited');
      }
    }
    for (const override of overrides) {
      accessByConnection.set(
        override.accountId,
        override.needsReconciliation || override.agentId !== owner
          ? 'needs_reconciliation'
          : override.state === 'attached'
            ? sessionGrantConnections.has(override.accountId)
              ? 'session_allowed'
              : 'needs_reconciliation'
            : 'session_blocked'
      );
    }

    const accounts: SessionConnectorAccountStatus[] = [];
    const warnings: SessionConnectorWarning[] = [];
    for (const [accountId, access] of accessByConnection) {
      const binding = this.registry.accountBinding(accountId);
      const row: SessionConnectorAccountStatus = binding
        ? {
            accountId,
            toolkit: binding.toolkit,
            label: binding.label,
            status: binding.status,
            access,
          }
        : {
            accountId,
            toolkit: 'unknown',
            label: 'Connected account no longer available',
            status: 'revoked',
            access,
          };
      accounts.push(row);
      if (access !== 'session_blocked' && row.status !== 'active') {
        warnings.push({
          accountId,
          label: row.label,
          reason:
            row.status === 'expired' || row.status === 'paused' || row.status === 'revoked'
              ? row.status
              : 'unavailable',
        });
      }
    }
    accounts.sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.accountId.localeCompare(right.accountId)
    );
    warnings.sort((left, right) => left.label.localeCompare(right.label));
    return { accounts, warnings };
  }

  /** Move retained session overrides onto a runtime's canonical session id. */
  migrateSession(oldId: string, newId: string): void {
    this.sessionAttachments.rekey(oldId, newId);
  }
}
