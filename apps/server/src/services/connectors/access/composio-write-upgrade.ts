/**
 * DOR-4461: review old level choices before the wider Composio catalog is read.
 * Uses the connector application-upgrade ledger (not a schema migration). The
 * marker, lowered intent, revoked writes, Activity and notices commit together.
 * A failed write rolls everything back and startup refuses until it succeeds.
 */
import { ulid } from 'ulidx';
import {
  activityEvents,
  and,
  connectionAccessLevels,
  connectionLevelFollows,
  connectionOperationGrants,
  connections,
  connectorApplicationMigrations,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorManagedAuthorityOutbox,
  eq,
  inArray,
  ne,
  notifications,
  type Db,
} from '@dorkos/db';
import { serviceNameFromToolkit } from '@dorkos/shared/connector-schemas';
import { COMPOSIO_WRITE_NOTICE_ENTRIES } from '../../notifications/emitters/composio-write-notice.js';

// Version 1 is the legacy connector foundation upgrade. Date keys keep later
// application steps distinct from the Drizzle schema migration sequence.
const VERSION = 20261115;

/**
 * Lower previously inert Composio write levels exactly once, before any catalog follower starts.
 *
 * @param db - This installation's canonical connector database.
 * @param now - One timestamp for every change in this transaction.
 * @returns The number of lowered level grants (not connections).
 */
export function upgradeComposioWriteLevels(db: Db, now = new Date().toISOString()): number {
  return db.transaction((tx) => {
    if (
      tx
        .select()
        .from(connectorApplicationMigrations)
        .where(eq(connectorApplicationMigrations.version, VERSION))
        .get()?.state === 'complete'
    )
      return 0;
    const rows = tx
      .select({
        level: connectionAccessLevels,
        app: connections,
        type: connectorProviderInstances.type,
      })
      .from(connectionAccessLevels)
      .innerJoin(connections, eq(connections.id, connectionAccessLevels.connectionId))
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connectionAccessLevels.level, 'read-write'))
      .all()
      .filter(
        ({ app, type }) =>
          ['composio', 'dorkos-managed'].includes(type) &&
          !['gmail', 'googlecalendar'].includes(app.toolkit.toLowerCase())
      );
    const told = new Set<string>();
    for (const { level, app } of rows) {
      tx.update(connectionAccessLevels)
        .set({ level: 'read', updatedAt: now, followerCommandId: null })
        .where(
          and(
            eq(connectionAccessLevels.subjectType, level.subjectType),
            eq(connectionAccessLevels.subjectId, level.subjectId),
            eq(connectionAccessLevels.connectionId, app.id)
          )
        )
        .run();
      tx.update(connectionOperationGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(connectionOperationGrants.subjectType, level.subjectType),
            eq(connectionOperationGrants.subjectId, level.subjectId),
            eq(connectionOperationGrants.connectionId, app.id),
            inArray(
              connectionOperationGrants.operationRevisionId,
              tx
                .select({ id: connectorOperationRevisions.id })
                .from(connectorOperationRevisions)
                .where(ne(connectorOperationRevisions.capabilityClassification, 'read'))
            )
          )
        )
        .run();
      // A pre-upgrade pending hosted answer must not reopen the old writes.
      // Applied history stays intact; the follower stages the new read choice.
      tx.update(connectorManagedAuthorityOutbox)
        .set({
          state: 'superseded',
          resolvedAt: now,
          updatedAt: now,
          nextAttemptAt: null,
          leaseOwner: null,
          leasedUntil: null,
        })
        .where(
          and(
            eq(connectorManagedAuthorityOutbox.connectionId, app.id),
            eq(
              connectorManagedAuthorityOutbox.scopeKind,
              level.subjectType === 'agent' ? 'agent_grants' : 'every_agent_grants'
            ),
            eq(connectorManagedAuthorityOutbox.subjectId, level.subjectId),
            eq(connectorManagedAuthorityOutbox.state, 'pending')
          )
        )
        .run();
      // Force a fresh read even on a same-version restart, including hosted
      // authority's close-first replacement of the lowered level.
      tx.delete(connectionLevelFollows)
        .where(eq(connectionLevelFollows.connectionId, app.id))
        .run();
      tx.insert(activityEvents)
        .values({
          id: ulid(),
          occurredAt: now,
          createdAt: now,
          actorType: 'system',
          actorLabel: 'DorkOS',
          category: 'permissions',
          eventType: 'connectors.write_upgrade',
          resourceType: 'connection',
          resourceId: app.id,
          resourceLabel: app.label,
          summary: `Changed ${app.label} access to Read`,
          linkPath: `/connections?app=${encodeURIComponent(app.id)}`,
          metadata: JSON.stringify({
            subjectType: level.subjectType,
            subjectId: level.subjectId,
            before: 'read-write',
            after: 'read',
          }),
        })
        .run();
      if (told.has(app.id)) continue;
      told.add(app.id);
      const payload = {
        connectionId: app.id,
        appName: serviceNameFromToolkit(app.toolkit),
        accountLabel: app.label,
      };
      const entry = COMPOSIO_WRITE_NOTICE_ENTRIES['connector.write_available'];
      // Startup writes the durable inbox row inside this transaction: the
      // global notifier is not wired yet, and a best-effort notification could
      // disappear between lowering access and stamping the upgrade.
      tx.insert(notifications)
        .values({
          id: ulid(),
          kind: 'connector.write_available',
          tier: 'notable',
          subjectType: 'system',
          subjectId: app.id,
          title: entry.title(payload),
          body: entry.body?.(payload),
          dataJson: JSON.stringify(payload),
          dedupeKey: entry.dedupeKey(payload),
          createdAt: now,
        })
        .run();
    }
    tx.insert(connectorApplicationMigrations)
      .values({ version: VERSION, state: 'complete', startedAt: now, completedAt: now })
      .onConflictDoUpdate({
        target: connectorApplicationMigrations.version,
        set: { state: 'complete', completedAt: now },
      })
      .run();
    return rows.length;
  });
}
