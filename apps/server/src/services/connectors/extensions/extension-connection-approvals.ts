/**
 * A person's yes for one extension install to read one connected app, and the
 * grant rows it writes (DOR-3547).
 *
 * - **Keyed on the install** (Security N2): scope, real path, origin and the
 *   files digest the person approved. A same-id copy elsewhere matches nothing.
 * - **Grants follow the approval** (P4-2): an approval writes one `extension`
 *   grant per declared read operation, and revoking it revokes them in the
 *   same transaction, unless another live approval of the same extension
 *   still covers that account.
 * - **Read only** (M5): a declared operation whose current revision isn't
 *   `read` is never granted. The database refuses it too.
 *
 * @module services/connectors/extensions/extension-connection-approvals
 */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  and,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  desc,
  eq,
  extensionConnectionApprovals,
  inArray,
  isNull,
  type Db,
  type DbTransaction,
  type ExtensionConnectionApprovalRow,
} from '@dorkos/db';
import { ExtensionConnectionError } from '@dorkos/extension-api/server';
import type { LiveExtensionInstall } from './live-extension-install.js';

/** What one approval granted, and what it couldn't. */
export interface ExtensionApprovalResult {
  /** The new approval's id. */
  readonly approvalId: string;
  /** The declared operations now granted. */
  readonly granted: readonly string[];
  /** Declared operations whose current revision can change something, so they aren't granted. */
  readonly notRead: readonly string[];
  /** Declared operations the account doesn't offer right now. */
  readonly missing: readonly string[];
}

/**
 * A digest of the operations a person approved: the sorted slugs.
 *
 * @param operations - The declared operation slugs.
 */
export function operationsDigestOf(operations: readonly string[]): string {
  const sorted = [...new Set(operations)].sort();
  return `sha256:${createHash('sha256').update(JSON.stringify(sorted)).digest('hex')}`;
}

/** Refuse with a typed extension connection error. */
function refuse(code: ExtensionConnectionError['code'], message: string): never {
  throw new ExtensionConnectionError(code, message);
}

/** SQLite-backed store of extension connection approvals and their grants. */
export class ExtensionConnectionApprovalStore {
  /**
   * Construct the store.
   *
   * @param db - Canonical DorkOS database.
   * @param now - Clock, for tests.
   */
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * The live approval for this install and service: the same extension, scope,
   * real path and origin, not revoked. Says nothing about whether the files
   * still match; the reader checks `approved_files_digest` against the live one.
   *
   * @param install - The running copy.
   * @param service - A declared service.
   * @param db - The database or an open transaction.
   */
  liveApproval(
    install: LiveExtensionInstall,
    service: string,
    db: Db | DbTransaction = this.db
  ): ExtensionConnectionApprovalRow | undefined {
    if (!install.origin) return undefined;
    return db
      .select()
      .from(extensionConnectionApprovals)
      .where(
        and(
          eq(extensionConnectionApprovals.extensionId, install.extensionId),
          eq(extensionConnectionApprovals.installScope, install.scope),
          eq(extensionConnectionApprovals.installRealPath, install.realPath),
          eq(extensionConnectionApprovals.installOrigin, install.origin),
          eq(extensionConnectionApprovals.service, service),
          isNull(extensionConnectionApprovals.revokedAt)
        )
      )
      .get();
  }

  /**
   * Record a person's yes: this install may read `service` on this account.
   * Replaces any live approval for the same install and service, and writes
   * one grant per declared read operation, all in one transaction.
   *
   * @param input - The install, the service, the account the person picked, and who said yes.
   */
  approve(input: {
    install: LiveExtensionInstall;
    service: string;
    connectionId: string;
    approvedBy: string;
  }): ExtensionApprovalResult {
    const { install, service } = input;
    const declaration = install.declarations.find((d) => d.service === service);
    if (!declaration) {
      return refuse(
        'EXTENSION_CONNECTION_NOT_DECLARED',
        `This extension doesn't declare ${service} in its manifest.`
      );
    }
    if (!install.origin || !install.liveFilesDigest) {
      return refuse(
        'EXTENSION_CONNECTION_NOT_ALLOWED',
        "This copy of the extension can't hold connections: DorkOS can't vouch that its code won't change without you."
      );
    }
    const at = this.now().toISOString();
    return this.db.transaction((tx) => {
      const connection = tx
        .select({
          id: connections.id,
          toolkit: connections.toolkit,
          providerInstanceId: connections.providerInstanceId,
          lifecycleState: connections.lifecycleState,
          mode: connectorProviderInstances.mode,
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
        connection.toolkit !== service ||
        connection.lifecycleState !== 'connected'
      ) {
        return refuse(
          'EXTENSION_CONNECTION_UNAVAILABLE',
          `That account isn't a connected ${service} account.`
        );
      }
      if (connection.mode === 'managed') {
        // Cloud checks hosted grants by subject, and doesn't take an extension
        // subject until its contract is deployed (design §6).
        return refuse(
          'EXTENSION_CONNECTION_UNAVAILABLE',
          'Accounts connected through your DorkOS account can’t be shared with mini apps yet.'
        );
      }
      this.revokeWhere(
        tx,
        install.extensionId,
        and(
          eq(extensionConnectionApprovals.installScope, install.scope),
          eq(extensionConnectionApprovals.installRealPath, install.realPath),
          eq(extensionConnectionApprovals.service, service)
        )!,
        at
      );
      const granted: string[] = [];
      const notRead: string[] = [];
      const missing: string[] = [];
      const grantIds: string[] = [];
      for (const slug of declaration.operations) {
        const revision = tx
          .select({
            id: connectorOperationRevisions.id,
            classification: connectorOperationRevisions.capabilityClassification,
          })
          .from(connectorOperationRevisions)
          .where(
            and(
              eq(connectorOperationRevisions.providerInstanceId, connection.providerInstanceId),
              eq(connectorOperationRevisions.toolkit, service),
              eq(connectorOperationRevisions.operationSlug, slug)
            )
          )
          .orderBy(desc(connectorOperationRevisions.discoveredAt))
          .get();
        if (!revision) {
          missing.push(slug);
          continue;
        }
        if (revision.classification !== 'read') {
          notRead.push(slug);
          continue;
        }
        const existing = tx
          .select({ id: connectionOperationGrants.id })
          .from(connectionOperationGrants)
          .where(
            and(
              eq(connectionOperationGrants.subjectType, 'extension'),
              eq(connectionOperationGrants.extensionId, install.extensionId),
              eq(connectionOperationGrants.connectionId, connection.id),
              eq(connectionOperationGrants.operationRevisionId, revision.id)
            )
          )
          .get();
        if (existing) {
          tx.update(connectionOperationGrants)
            .set({ revokedAt: null, createdBy: input.approvedBy, createdAt: at })
            .where(eq(connectionOperationGrants.id, existing.id))
            .run();
          grantIds.push(existing.id);
        } else {
          const id = ulid();
          tx.insert(connectionOperationGrants)
            .values({
              id,
              subjectType: 'extension',
              subjectId: install.extensionId,
              agentId: null,
              extensionId: install.extensionId,
              connectionId: connection.id,
              operationRevisionId: revision.id,
              createdBy: input.approvedBy,
              createdAt: at,
            })
            .run();
          grantIds.push(id);
        }
        granted.push(slug);
      }
      const approvalId = ulid();
      tx.insert(extensionConnectionApprovals)
        .values({
          id: approvalId,
          extensionId: install.extensionId,
          installScope: install.scope,
          installRealPath: install.realPath,
          installOrigin: install.origin!,
          originSource: install.origin === 'trusted_source' ? (install.originSource ?? null) : null,
          approvedFilesDigest: install.liveFilesDigest!,
          approvedVersion: install.version,
          service,
          connectionId: connection.id,
          approvedOperationsDigest: operationsDigestOf(declaration.operations),
          approvedBy: input.approvedBy,
          approvedAt: at,
        })
        .run();
      return { approvalId, granted, notRead, missing };
    });
  }

  /**
   * Revoke every live approval this extension holds (uninstall), or only the
   * ones for one install (a change of runtime, install or origin; Security
   * N3), with their grants, in one transaction.
   *
   * @param extensionId - The extension.
   * @param install - When given, only approvals for this scope and real path.
   * @returns How many approvals were revoked.
   */
  revoke(extensionId: string, install?: { scope: string; realPath: string }): number {
    const at = this.now().toISOString();
    return this.db.transaction((tx) =>
      this.revokeWhere(
        tx,
        extensionId,
        install
          ? and(
              eq(extensionConnectionApprovals.installScope, install.scope as 'global' | 'local'),
              eq(extensionConnectionApprovals.installRealPath, install.realPath)
            )!
          : undefined,
        at
      )
    );
  }

  /**
   * Revoke the live approvals for one account, and the extension grants on it
   * (the person took it back on the Connections page).
   *
   * @param extensionId - The extension.
   * @param connectionId - The account.
   */
  revokeForConnection(extensionId: string, connectionId: string): number {
    const at = this.now().toISOString();
    return this.db.transaction((tx) =>
      this.revokeWhere(
        tx,
        extensionId,
        eq(extensionConnectionApprovals.connectionId, connectionId),
        at
      )
    );
  }

  /**
   * Revoke one approval, and its grants unless another live approval of the
   * same extension still covers that account.
   *
   * @param approvalId - The approval.
   */
  revokeApproval(approvalId: string): number {
    const at = this.now().toISOString();
    return this.db.transaction((tx) => {
      const row = tx
        .select({ extensionId: extensionConnectionApprovals.extensionId })
        .from(extensionConnectionApprovals)
        .where(eq(extensionConnectionApprovals.id, approvalId))
        .get();
      if (!row) return 0;
      return this.revokeWhere(
        tx,
        row.extensionId,
        eq(extensionConnectionApprovals.id, approvalId),
        at
      );
    });
  }

  /**
   * Every live approval this extension holds, any install.
   *
   * @param extensionId - The extension.
   */
  liveApprovalsOf(extensionId: string): ExtensionConnectionApprovalRow[] {
    return this.db
      .select()
      .from(extensionConnectionApprovals)
      .where(
        and(
          eq(extensionConnectionApprovals.extensionId, extensionId),
          isNull(extensionConnectionApprovals.revokedAt)
        )
      )
      .all();
  }

  /**
   * Revoke matching live approvals, then the extension's grants on each
   * account no other live approval of it still covers.
   */
  private revokeWhere(
    tx: DbTransaction,
    extensionId: string,
    extra: ReturnType<typeof and> | undefined,
    at: string
  ): number {
    const match = and(
      eq(extensionConnectionApprovals.extensionId, extensionId),
      isNull(extensionConnectionApprovals.revokedAt),
      ...(extra ? [extra] : [])
    );
    const rows = tx
      .select({
        id: extensionConnectionApprovals.id,
        connectionId: extensionConnectionApprovals.connectionId,
      })
      .from(extensionConnectionApprovals)
      .where(match)
      .all();
    if (rows.length === 0) return 0;
    tx.update(extensionConnectionApprovals)
      .set({ revokedAt: at })
      .where(
        inArray(
          extensionConnectionApprovals.id,
          rows.map((row) => row.id)
        )
      )
      .run();
    for (const connectionId of new Set(rows.map((row) => row.connectionId))) {
      const stillCovered = tx
        .select({ id: extensionConnectionApprovals.id })
        .from(extensionConnectionApprovals)
        .where(
          and(
            eq(extensionConnectionApprovals.extensionId, extensionId),
            eq(extensionConnectionApprovals.connectionId, connectionId),
            isNull(extensionConnectionApprovals.revokedAt)
          )
        )
        .get();
      if (stillCovered) continue;
      tx.update(connectionOperationGrants)
        .set({ revokedAt: at })
        .where(
          and(
            eq(connectionOperationGrants.subjectType, 'extension'),
            eq(connectionOperationGrants.extensionId, extensionId),
            eq(connectionOperationGrants.connectionId, connectionId),
            isNull(connectionOperationGrants.revokedAt)
          )
        )
        .run();
    }
    return rows.length;
  }
}
