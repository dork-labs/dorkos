/**
 * The step that runs before a DorkOS account is erased, whoever erases it.
 *
 * Erasing an account cascades away every managed-connection row it owns,
 * including the only record of which sign-ins it holds at the service. So
 * before the erasure, every app the account connected is ended at the service
 * first ({@link endOwnerConnectionsBeforeErasure}), and the erasure is refused
 * while any sign-in is still live there ({@link refuseErasureWhileAppsSignedIn}).
 * The person, or the admin, tries again a little later; nothing is lost in
 * between.
 *
 * @module lib/connectors/managed/instance-revocation/erasure
 */
import { APIError } from 'better-auth/api';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { schema } from '@/db/client';
import { getTransactionDb } from '@/db/transaction-client';
import type { ManagedConnectorDatabase } from '../authority-service';
import { cleanUpRevokedInstance } from './cleanup';
import { closeRevokedInstance } from './close';
import { withDefaults, type RevokedInstanceCleanupOptions } from './policy';

const connections = schema.managedConnectorConnection;
const tenants = schema.connectorTenant;

/**
 * Before an account is erased: revoke every instance it has linked, end all of
 * their managed connections, and report how many provider accounts are still
 * live at the service. Erasure cascades every managed row away, so a nonzero
 * result means erasing now would leave a sign-in live with no record of it,
 * and the caller must refuse.
 *
 * @param db - The site database.
 * @param ownerId - The account about to be erased.
 * @param options - Signal, provider seam and clock.
 * @returns The number of the owner's provider accounts not yet deleted.
 */
export async function endOwnerConnectionsBeforeErasure(
  db: ManagedConnectorDatabase,
  ownerId: string,
  options: RevokedInstanceCleanupOptions
): Promise<number> {
  const resolved = withDefaults(options);
  const now = resolved.clock();
  await db
    .update(schema.instance)
    .set({ revokedAt: now })
    .where(and(eq(schema.instance.userId, ownerId), isNull(schema.instance.revokedAt)));
  const owned = await db
    .select({ id: schema.instance.id })
    .from(schema.instance)
    .where(eq(schema.instance.userId, ownerId));
  for (const { id } of owned) {
    await closeRevokedInstance(db, id, now, { ignoreGrace: true });
    await cleanUpRevokedInstance(db, id, resolved);
  }
  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(connections)
    .innerJoin(tenants, and(eq(tenants.id, connections.tenantId), eq(tenants.ownerUserId, ownerId)))
    .where(
      sql`NOT EXISTS (
        SELECT 1 FROM managed_connector_authority_command k
        WHERE k.tenant_id = ${connections.tenantId}
          AND k.instance_id = ${connections.originatingInstanceId}
          AND k.connection_id = ${connections.id}
          AND k.kind = 'set_connection_lifecycle'
          AND k.state = 'applied'
          AND k.external_cleanup = 'complete'
          AND k.cleanup_binding ->> 'externalAccountRef' = ${connections.externalAccountRef}
          AND (k.cleanup_binding ->> 'bindingGeneration')::int = ${connections.bindingGeneration}
      )`
    );
  return remaining?.count ?? 0;
}

/** How long an erasure waits on the service to end the account's app sign-ins. */
const ERASURE_CLEANUP_BUDGET_MS = 20_000;

/** Shown when an erasure is refused because a sign-in is still live at the service. */
export const ERASURE_REFUSED_MESSAGE =
  "We couldn't sign you out of every app you connected through your DorkOS account yet, " +
  "so your account hasn't been deleted. Your linked instances are already revoked. " +
  'Please try deleting your account again in a few minutes.';

/**
 * End every app sign-in the account holds at the service, and refuse the
 * erasure if any is still live.
 *
 * @param userId - The account about to be erased.
 * @param end - The cleanup to run; production ends them in the site database.
 * @throws APIError (503) when a sign-in is still live, so the account is kept.
 */
export async function refuseErasureWhileAppsSignedIn(
  userId: string,
  end: (userId: string) => Promise<number> = (owner) =>
    endOwnerConnectionsBeforeErasure(getTransactionDb(), owner, {
      signal: AbortSignal.timeout(ERASURE_CLEANUP_BUDGET_MS),
    })
): Promise<void> {
  const remaining = await end(userId);
  if (remaining > 0) {
    throw new APIError('SERVICE_UNAVAILABLE', { message: ERASURE_REFUSED_MESSAGE });
  }
}
