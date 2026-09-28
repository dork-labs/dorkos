/**
 * The one-off for connections left behind by revokes made before revocation
 * ended them at the service: a read-only count, and an explicit cleanup.
 *
 * @module lib/connectors/managed/instance-revocation/orphans
 */
import { sql } from 'drizzle-orm';

import type { ManagedConnectorDatabase } from '../authority-service';
import { recoverManagedEventCleanup } from '../event-cleanup-service';
import { sweepRevokedInstances } from './cleanup';
import { accountDeletionDone, accountDeletionOwed } from './close';
import { withDefaults, type RevokedInstanceCleanupOptions } from './policy';

/** What revoked instances still hold open or owe, across every tenant. */
export interface RevokedInstanceOrphans {
  /** Revoked instances with anything below still open or owed. */
  instances: number;
  /** Connections of revoked instances that are not yet closed. */
  openConnections: number;
  /**
   * Closed connections of revoked instances whose account deletion is neither
   * done nor on record as owed (their disconnect receipt was superseded, or
   * never written). A clean run writes each one a fresh receipt.
   */
  closedWithoutCleanup: number;
  /** Event subscriptions targeting revoked instances that are still on. */
  openSubscriptions: number;
  /** Provider accounts that closed connections of revoked instances still owe deletion of. */
  accountsOwed: number;
}

/**
 * Count, without changing anything, what revoked instances still hold open or
 * owe at the service. Revokes made before revocation ended connections left
 * exactly these behind.
 *
 * @param db - The site database.
 */
export async function countRevokedInstanceOrphans(
  db: ManagedConnectorDatabase
): Promise<RevokedInstanceOrphans> {
  const [row] = await db
    .execute<{
      instances: number;
      open_connections: number;
      closed_without_cleanup: number;
      open_subscriptions: number;
      accounts_owed: number;
    }>(
      sql`
    WITH revoked AS (SELECT id FROM instance WHERE revoked_at IS NOT NULL),
    open_connections AS (
      SELECT c.originating_instance_id AS instance_id FROM managed_connector_connection c
      JOIN revoked r ON r.id = c.originating_instance_id
      WHERE c.lifecycle <> 'disconnected'
    ),
    closed_without_cleanup AS (
      SELECT c.originating_instance_id AS instance_id FROM managed_connector_connection c
      JOIN revoked r ON r.id = c.originating_instance_id
      WHERE c.lifecycle = 'disconnected'
        AND NOT (${accountDeletionDone('c')} OR ${accountDeletionOwed('c')})
    ),
    open_subscriptions AS (
      SELECT s.target_instance_id AS instance_id FROM managed_connector_event_subscription s
      JOIN revoked r ON r.id = s.target_instance_id
      WHERE s.revoked_at IS NULL
    ),
    accounts_owed AS (
      SELECT k.instance_id FROM managed_connector_authority_command k
      JOIN revoked r ON r.id = k.instance_id
      WHERE k.kind = 'set_connection_lifecycle' AND k.state = 'applied'
        AND k.external_cleanup IN ('pending', 'failed') AND k.cleanup_binding IS NOT NULL
    )
    SELECT
      (SELECT count(DISTINCT instance_id)::int FROM (
        SELECT instance_id FROM open_connections
        UNION SELECT instance_id FROM closed_without_cleanup
        UNION SELECT instance_id FROM open_subscriptions
        UNION SELECT instance_id FROM accounts_owed
      ) owed) AS instances,
      (SELECT count(*)::int FROM open_connections) AS open_connections,
      (SELECT count(*)::int FROM closed_without_cleanup) AS closed_without_cleanup,
      (SELECT count(*)::int FROM open_subscriptions) AS open_subscriptions,
      (SELECT count(*)::int FROM accounts_owed) AS accounts_owed
  `
    )
    .then((result) => result.rows);
  return {
    instances: Number(row?.instances ?? 0),
    openConnections: Number(row?.open_connections ?? 0),
    closedWithoutCleanup: Number(row?.closed_without_cleanup ?? 0),
    openSubscriptions: Number(row?.open_subscriptions ?? 0),
    accountsOwed: Number(row?.accounts_owed ?? 0),
  };
}

/**
 * The one-off for connections left behind by revokes made before this module
 * existed. Read-only by default: it prints what is left. With `clean`, it runs
 * the same cleanup the scheduled sweep runs, pass after pass until a pass makes
 * no progress, then prints what is left again.
 *
 * @param db - The site database.
 * @param options - `clean` to change anything; `print` for each report line.
 * @returns The counts before and, with `clean`, after.
 */
export async function runRevokedInstanceOrphanCleanup(
  db: ManagedConnectorDatabase,
  options: RevokedInstanceCleanupOptions & {
    clean: boolean;
    print: (line: string) => void;
    maxPasses?: number;
  }
): Promise<{ before: RevokedInstanceOrphans; after?: RevokedInstanceOrphans }> {
  const report = (label: string, counts: RevokedInstanceOrphans) =>
    options.print(
      `${label}: ${counts.instances} revoked instance(s); ${counts.openConnections} open connection(s), ` +
        `${counts.closedWithoutCleanup} closed connection(s) with no cleanup on record, ` +
        `${counts.openSubscriptions} open event subscription(s), ${counts.accountsOwed} account deletion(s) owed.`
    );
  const before = await countRevokedInstanceOrphans(db);
  report('Before', before);
  if (!options.clean) {
    options.print('Read-only: nothing was changed. Pass --clean to end them.');
    return { before };
  }
  const resolved = withDefaults(options);
  for (let pass = 0; pass < (options.maxPasses ?? 20) && !resolved.signal.aborted; pass++) {
    const triggers = await recoverManagedEventCleanup(
      db,
      resolved.signal,
      resolved.resolveProvider,
      100,
      resolved.clock
    );
    const swept = await sweepRevokedInstances(db, { ...resolved, limit: 100 });
    if (triggers.completed + swept.instancesClosed + swept.accountsCompleted === 0) break;
  }
  const after = await countRevokedInstanceOrphans(db);
  report('After', after);
  return { before, after };
}
