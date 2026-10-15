/**
 * On a Trusted install a connected app is shared with every agent (DOR-2739,
 * ADR 261006-225605, spec `trusted-by-default-flip` §5.6).
 *
 * Two moments share an app, and both go through the same owner-intent record
 * a person's "Every agent" answer writes: an `every_agent` access level
 * (`execution/access-levels.ts`, ADR 260929-071355). The grant rows are then
 * derived from the app's catalog by {@link ConnectorReconciliationService.followCatalog},
 * exactly as for a level a person chose, and that follow records the change in
 * Activity ("Shared Gmail (work) with every agent").
 *
 * - **A new connection.** The level is written inside the sign-in's own
 *   transaction, so a brand-new connection on a Trusted install is never
 *   recorded without it. Connections that existed before are the next case;
 *   one on Careful, or on a DorkOS account this server cannot reach hosted
 *   authority for, stays unshared. The catalog is read right after commit, so
 *   the grants exist now rather than at the next 12-hour follow. A reconnect
 *   never comes here: it changes no level.
 * - **Existing connections, once** ({@link TrustedConnectionSharing.upgradeStep}):
 *   each connected app nobody holds any access to gets the same level (operator
 *   decision D1, 2026-10-06). "Nobody holds any access" means the app never
 *   had a grant row for anyone, live or revoked, and hosted authority was never
 *   asked about its grants: an app someone shared and then stopped sharing, or
 *   one that was disconnected and signed in to again, is a choice already made
 *   and is left alone. The shared ids go into
 *   `permissions.sharedAtUpgrade` for the notice to name. It has its own stamp,
 *   `permissions.sharedAppsAppliedAt`, so it runs once whenever it arrives,
 *   even on an install that already applied the other Trusted defaults; a
 *   person who narrows an app afterwards keeps their choice.
 *
 * **Nothing is shared silently.** When the step shares at least one app, it
 * clears `ui.trustNoticeSeenAt`, so the one-time notice shows again with the
 * apps listed, even to a person who dismissed it before this step existed.
 * The notice lists an app by its every-agent LEVEL, not its grants, so an app
 * whose catalog could not be read yet (no grants, which the level follower
 * adds within the hour) is still named.
 *
 * The order is what keeps that true, since `config.json` is not part of the
 * database transaction. The list and the cleared notice are written to
 * `config.json` first, then the levels in one database transaction, then the
 * stamp. A failed config write throws before any level, and the step runs
 * again next boot. Failed level writes roll back the levels only: the list
 * then names apps that are not shared, which the notice leaves out because
 * they hold no level, and the next boot shares and names them. So a failure
 * can leave a stale name, never an unnamed share.
 *
 * **Careful is left untouched**, like the open mesh step: the step shares
 * nothing and still counts as applied, so existing connections are never
 * shared by it later, even after a move to Trusted.
 *
 * The level is written as Read and write, then fitted to the catalog once it
 * has been read: an app that offers no write action keeps Read, so the card
 * never claims a level the app cannot have. If that first read fails, the
 * level stays Read and write until a person changes it. That costs nothing
 * today: over an app with no write action it grants exactly what Read does.
 * If the app adds a write action later, every agent gets it, which is what the
 * share would have given had the app offered it at the time. The follower is
 * deliberately not taught to lower levels, because it cannot tell this level
 * from one a person chose. A DorkOS-account connection is shared only where
 * its access can reach hosted authority (the same rule `followLevels`
 * applies).
 *
 * @module services/connectors/access/trusted-sharing
 */
import {
  and,
  connectionAccessLevels,
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReconciliationCandidates,
  connectorReconciliationPreviews,
  desc,
  eq,
  isNull,
  sql,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { trustPosture } from '@dorkos/shared/permissions';
import { logger, logError } from '../../../lib/logger.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import type { TrustedStoreStep } from '../../mesh/seed-open-mesh.js';
import { recordAccessLevel } from '../execution/access-levels.js';
import type { ConnectorReconciliationService } from '../reconciliation-service.js';

/** How long one catalog read may take before the share waits for the next follow. */
const FOLLOW_TIMEOUT_MS = 60_000;

/** The two config sections sharing reads and writes, each whole. */
export interface TrustedSharingConfig {
  /** Read one config section. */
  get<K extends 'permissions' | 'ui'>(key: K): UserConfig[K];
  /** Write one config section whole. */
  set<K extends 'permissions' | 'ui'>(key: K, value: UserConfig[K]): void;
}

/** Construction options for {@link TrustedConnectionSharing}. */
export interface TrustedConnectionSharingOptions {
  /** Canonical connector database. */
  readonly db: Db;
  /** Where the posture is read and the shared ids are kept. */
  readonly config: TrustedSharingConfig;
  /** Derives a level's grants from the app's catalog. */
  readonly reconciliation: Pick<ConnectorReconciliationService, 'followCatalog'>;
  /**
   * The hosted synchronizer the reconciliation service carries. Without it a
   * DorkOS-account connection's level could never reach hosted authority, so
   * such a connection is left unshared.
   */
  readonly managedAuthority?: unknown;
  /** The running version, recorded with each follow; injectable for tests. */
  readonly appVersion?: string;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
}

/** Shares connected apps with every agent on a Trusted install. */
export class TrustedConnectionSharing {
  private readonly db: Db;
  private readonly config: TrustedSharingConfig;
  private readonly reconciliation: Pick<ConnectorReconciliationService, 'followCatalog'>;
  private readonly sharesManaged: boolean;
  private readonly appVersion: string;
  private readonly now: () => Date;

  /** Construct the sharing policy. */
  constructor(options: TrustedConnectionSharingOptions) {
    this.db = options.db;
    this.config = options.config;
    this.reconciliation = options.reconciliation;
    this.sharesManaged = options.managedAuthority !== undefined;
    this.appVersion = options.appVersion ?? SERVER_VERSION;
    this.now = options.now ?? (() => new Date());
  }

  /** Whether the install is Trusted right now. */
  private trusted(): boolean {
    return trustPosture(this.config.get('permissions')?.preset) === 'trusted';
  }

  /**
   * Share a brand-new connection with every agent, inside the transaction that
   * records it. Does nothing on a Careful install, or for a DorkOS-account
   * connection this server cannot carry to hosted authority.
   *
   * @param tx - The sign-in's open transaction.
   * @param input - The new connection and the owner recorded as the level's author.
   * @returns Whether a level was written, so the caller follows the catalog after commit.
   */
  shareNewConnection(
    tx: DbTransaction,
    input: { readonly connectionId: string; readonly createdBy: string }
  ): boolean {
    if (!this.trusted()) return false;
    const row = tx
      .select({ mode: connectorProviderInstances.mode })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connections.id, input.connectionId))
      .get();
    if (!row || (row.mode === 'managed' && !this.sharesManaged)) return false;
    this.writeLevel(tx, input.connectionId, input.createdBy);
    return true;
  }

  /**
   * Read the app's catalog so the shared level's grants exist now, then fit the
   * level to what the app offers. Never throws: a catalog that cannot be read
   * leaves the level for the next follow, which grants it then.
   *
   * @param connectionId - The connection just shared.
   */
  async follow(connectionId: string): Promise<void> {
    try {
      await this.reconciliation.followCatalog(
        connectionId,
        AbortSignal.timeout(FOLLOW_TIMEOUT_MS),
        this.appVersion
      );
      fitSharedLevel(this.db, connectionId, this.now().toISOString());
    } catch (err) {
      logger.warn('[Connectors] Could not read the app for a new share yet', {
        connectionId,
        ...logError(err),
      });
    }
  }

  /**
   * The once-per-install step that shares every connected app nobody holds
   * any access to, stamped `permissions.sharedAppsAppliedAt` by
   * {@link applyTrustedStores}. It names the apps and re-opens the notice,
   * then writes the levels, and reads the catalogs in the background so a
   * slow service never holds up the boot. On Careful it shares nothing and
   * counts as applied. Safe to repeat until stamped: an app it shared now
   * has a level, so a second run passes it by.
   */
  upgradeStep(): TrustedStoreStep {
    return {
      name: 'shared connected apps',
      run: () => {
        if (!this.trusted()) return 'applied';
        const shared = this.db.transaction((tx) => {
          const rows = unsharedConnections(tx, this.sharesManaged);
          const ids = rows.map((row) => row.connectionId);
          // Told first (config.json), shared second (this transaction): see
          // the module doc for what each failure leaves.
          if (ids.length > 0) this.tellPerson(ids);
          for (const { connectionId, ownerId } of rows) {
            this.writeLevel(tx, connectionId, ownerId);
          }
          return ids;
        });
        void Promise.all(shared.map((id) => this.follow(id)));
        return 'applied';
      },
    };
  }

  /** List the apps for the notice, and show the notice again if it was seen. */
  private tellPerson(ids: readonly string[]): void {
    const permissions = this.config.get('permissions');
    const known = new Set(permissions.sharedAtUpgrade ?? []);
    this.config.set('permissions', {
      ...permissions,
      sharedAtUpgrade: [...known, ...ids.filter((id) => !known.has(id))],
    });
    const ui = this.config.get('ui');
    if (ui.trustNoticeSeenAt != null) this.config.set('ui', { ...ui, trustNoticeSeenAt: null });
  }

  private writeLevel(tx: DbTransaction, connectionId: string, createdBy: string): void {
    recordAccessLevel(tx, {
      connectionId,
      subject: { kind: 'every_agent' },
      level: 'read-write',
      createdBy,
      now: this.now().toISOString(),
    });
  }
}

/**
 * Connected apps (paused ones included) that nobody was ever given: no level,
 * no grant row for anyone (a revoked one counts, since grants are revoked and
 * kept, never deleted), and no grant command ever sent to hosted authority.
 * Only those whose way has an owner to record as the level's author.
 */
function unsharedConnections(
  tx: DbTransaction,
  sharesManaged: boolean
): Array<{ connectionId: string; ownerId: string }> {
  return tx
    .select({
      connectionId: connections.id,
      ownerId: connectorProviderInstances.ownerId,
      mode: connectorProviderInstances.mode,
    })
    .from(connections)
    .innerJoin(
      connectorProviderInstances,
      eq(connectorProviderInstances.id, connections.providerInstanceId)
    )
    .where(
      and(
        eq(connections.lifecycleState, 'connected'),
        isNull(connections.removedAt),
        sql`NOT EXISTS (SELECT 1 FROM ${connectionAccessLevels} WHERE ${connectionAccessLevels.connectionId} = ${connections.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${connectionOperationGrants} WHERE ${connectionOperationGrants.connectionId} = ${connections.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${connectorManagedAuthorityScopes} WHERE ${connectorManagedAuthorityScopes.managedConnectionId} = ${connections.externalAccountRef} AND ${connectorManagedAuthorityScopes.scopeKind} IN ('agent_grants', 'every_agent_grants'))`
      )
    )
    .orderBy(connections.id)
    .all()
    .filter((row) => row.ownerId !== null && (row.mode !== 'managed' || sharesManaged))
    .map((row) => ({ connectionId: row.connectionId, ownerId: row.ownerId! }));
}

/**
 * Keep a shared level at Read when the newest catalog DorkOS recorded for the
 * app offers no write action. Only ever lowers a Read and write share; the
 * grants stay as they are, since Read and write over such an app grants the
 * same actions Read does.
 *
 * @param db - Canonical connector database.
 * @param connectionId - The shared connection.
 * @param now - Timestamp of the change.
 */
export function fitSharedLevel(db: Db, connectionId: string, now: string): void {
  db.transaction((tx) => {
    const newest = tx
      .select({ id: connectorReconciliationPreviews.id })
      .from(connectorReconciliationPreviews)
      .where(eq(connectorReconciliationPreviews.connectionId, connectionId))
      .orderBy(desc(connectorReconciliationPreviews.createdAt), desc(sql`rowid`))
      .limit(1)
      .get();
    if (!newest) return;
    const offersWrite = tx
      .select({ id: connectorReconciliationCandidates.operationRevisionId })
      .from(connectorReconciliationCandidates)
      .innerJoin(
        connectorOperationRevisions,
        eq(connectorOperationRevisions.id, connectorReconciliationCandidates.operationRevisionId)
      )
      .where(
        and(
          eq(connectorReconciliationCandidates.previewId, newest.id),
          eq(connectorReconciliationCandidates.supported, true),
          eq(connectorOperationRevisions.capabilityClassification, 'write')
        )
      )
      .limit(1)
      .get();
    if (offersWrite) return;
    tx.update(connectionAccessLevels)
      .set({ level: 'read', updatedAt: now })
      .where(
        and(
          eq(connectionAccessLevels.connectionId, connectionId),
          eq(connectionAccessLevels.subjectType, 'every_agent'),
          eq(connectionAccessLevels.level, 'read-write')
        )
      )
      .run();
  });
}
