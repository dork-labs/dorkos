/**
 * The step that runs before a DorkOS account is erased, whoever erases it.
 *
 * Erasing an account cascades away every managed-connection row it owns,
 * including the only record of which sign-ins it holds at the service. So
 * before the erasure, every app the account connected is ended at the service
 * first ({@link endOwnerConnectionsBeforeErasure}). What happens to anything
 * still owed after that is {@link prepareAccountErasure}'s decision: the
 * person's own deletion waits while the cleanup is still young enough to be
 * making progress, and never waits forever; an admin's removal always goes
 * ahead. Either way, an erasure that leaves a sign-in live first writes an
 * operator log naming exactly what to delete by hand.
 *
 * @module lib/connectors/managed/instance-revocation/erasure
 */
import { APIError } from 'better-auth/api';
import { and, eq, inArray, isNull, not, sql } from 'drizzle-orm';

import { schema } from '@/db/client';
import { getTransactionDb } from '@/db/transaction-client';
import type { ManagedConnectorDatabase } from '../authority-service';
import { cleanUpRevokedInstance } from './cleanup';
import { accountDeletionDone, closeRevokedInstance } from './close';
import { withDefaults, type RevokedInstanceCleanupOptions } from './policy';

const connections = schema.managedConnectorConnection;
const tenants = schema.connectorTenant;

/** One provider account an account still holds at the service. */
export interface OwedProviderAccount {
  /** The hosted provider the account lives at. */
  providerInstanceId: string;
  /** The server-derived provider user the account belongs to. */
  providerUserId: string;
  /** The provider's own id for the account: what an operator deletes by hand. */
  externalAccountRef: string;
  /** When the service started owing its deletion: the later of the revocation and the newest owed receipt. */
  owedSince: Date;
}

/**
 * Before an account is erased: revoke every instance it has linked (stamping
 * `revokedAt` and deleting its key, as `revokeInstance` does), end all of
 * their managed connections, and list the provider accounts still live at
 * the service. Each step is best effort per instance; what it could not
 * finish shows up in the list.
 *
 * @param db - The site database.
 * @param ownerId - The account about to be erased.
 * @param options - Signal, provider seam and clock.
 * @returns The owner's provider accounts whose deletion is not yet done.
 */
export async function endOwnerConnectionsBeforeErasure(
  db: ManagedConnectorDatabase,
  ownerId: string,
  options: RevokedInstanceCleanupOptions
): Promise<OwedProviderAccount[]> {
  const resolved = withDefaults(options);
  const now = resolved.clock();
  const owned = await db
    .select({ id: schema.instance.id })
    .from(schema.instance)
    .where(eq(schema.instance.userId, ownerId));
  const ids = owned.map(({ id }) => id);
  if (ids.length > 0) {
    await db
      .update(schema.instance)
      .set({ revokedAt: now })
      .where(and(eq(schema.instance.userId, ownerId), isNull(schema.instance.revokedAt)));
    await db
      .delete(schema.apikey)
      .where(
        and(
          eq(schema.apikey.referenceId, ownerId),
          inArray(sql`${schema.apikey.metadata}::jsonb ->> 'instanceId'`, ids)
        )
      );
  }
  for (const id of ids) {
    try {
      await closeRevokedInstance(db, id, now, { ignoreGrace: true });
      await cleanUpRevokedInstance(db, id, resolved);
    } catch {
      /* Whatever this instance still owes is listed below. */
    }
  }
  const owed = await db
    .select({
      providerInstanceId: connections.providerInstanceId,
      providerUserId: connections.providerUserId,
      externalAccountRef: connections.externalAccountRef,
      revokedAt: schema.instance.revokedAt,
      latestReceipt: sql<Date | string | null>`(
        SELECT max(k.created_at) FROM managed_connector_authority_command k
        WHERE k.tenant_id = ${connections.tenantId}
          AND k.instance_id = ${connections.originatingInstanceId}
          AND k.connection_id = ${connections.id}
          AND k.kind = 'set_connection_lifecycle' AND k.state = 'applied'
          AND k.external_cleanup IN ('pending', 'failed')
      )`,
    })
    .from(connections)
    .innerJoin(tenants, and(eq(tenants.id, connections.tenantId), eq(tenants.ownerUserId, ownerId)))
    .innerJoin(schema.instance, eq(schema.instance.id, connections.originatingInstanceId))
    .where(not(accountDeletionDone()));
  return owed.map(({ latestReceipt, revokedAt, ...account }) => ({
    ...account,
    owedSince: owedSince(latestReceipt, revokedAt ?? now),
  }));
}

/**
 * When an owed deletion started owing, for the stuck bound: the later of its
 * instance's revocation and its newest owed receipt.
 *
 * Anchored at the revocation because only a revoked instance's deletion is
 * ever retried by the service: a receipt an instance wrote while it was still
 * live may be days old with not one service retry behind it. Nothing a sweep
 * touches can move this (the sweep stamps `updatedAt`, never these), so a
 * cleanup that keeps failing cannot push the deadline back either.
 *
 * @param latestReceipt - The newest pending or failed receipt's `created_at`, if any.
 * @param revokedAt - When the connection's instance was revoked.
 */
function owedSince(latestReceipt: Date | string | null, revokedAt: Date): Date {
  const receipt = latestReceipt === null ? null : new Date(latestReceipt);
  return receipt && receipt.getTime() > revokedAt.getTime() ? receipt : revokedAt;
}

/**
 * How long the person's own account deletion waits on an owed account
 * deletion at the service: 24 hours from when the service started owing it
 * (the later of the instance's revocation and the newest owed receipt; an
 * erasure revokes every live instance first, so a just-revoked instance always
 * gets the full day).
 *
 * Inside that window the service retries the deletion (the erasure attempt
 * itself, and every hourly sweep after it), and a deletion that goes ahead
 * would erase the only record of a sign-in that may well end on its own
 * soon. Past it, the cleanup has had about two dozen tries and is plainly
 * stuck (a service outage that long, or an account moved to another project),
 * and holding the person's right to erasure hostage to it would be worse: the
 * erasure goes ahead, and the operator log names what to finish by hand.
 */
export const ERASURE_STUCK_CLEANUP_MS = 24 * 60 * 60 * 1000;

/** How long an erasure waits on the service to end the account's app sign-ins. */
const ERASURE_CLEANUP_BUDGET_MS = 20_000;

/**
 * Where the person lands when their own deletion is postponed. The emailed
 * link's one-time token is already spent by then, so the account page says to
 * request deletion again from there.
 */
export const ERASURE_POSTPONED_LOCATION = '/account?deletion=postponed';

/** Who is erasing the account. */
export type AccountErasureActor = 'owner' | 'admin';

/** The seams {@link prepareAccountErasure} runs through; production defaults to the site's own. */
export interface AccountErasureDeps {
  /** End the account's connections and list what is still owed. */
  end: (userId: string) => Promise<OwedProviderAccount[]>;
  /** The current time. */
  clock: () => Date;
  /** The operator-visible error log. */
  logError: (message: string, details: Record<string, unknown>) => void;
}

const productionDeps: AccountErasureDeps = {
  end: (owner) =>
    endOwnerConnectionsBeforeErasure(getTransactionDb(), owner, {
      signal: AbortSignal.timeout(ERASURE_CLEANUP_BUDGET_MS),
    }),
  clock: () => new Date(),
  logError: (message, details) => console.error(message, details),
};

/** The redirect that postpones the person's own deletion. */
function postponed(): APIError {
  return new APIError('FOUND', undefined, new Headers({ location: ERASURE_POSTPONED_LOCATION }));
}

/**
 * End every app sign-in the account holds at the service, then decide whether
 * the erasure goes ahead.
 *
 * - Nothing owed: it goes ahead.
 * - The person's own deletion, with a deletion put on record less than
 *   {@link ERASURE_STUCK_CLEANUP_MS} ago (or the cleanup could not even be
 *   read): it is postponed by redirecting to the account page.
 * - Otherwise (every owed deletion is stuck, or an admin is removing the
 *   account): it goes ahead, after an operator log listing each provider
 *   account still live, so it can be deleted by hand. The log carries only
 *   provider ids, no name, email or account id.
 *
 * @param userId - The account about to be erased.
 * @param actor - The person themselves, or an admin.
 * @param deps - Seams for tests; production uses the site's own.
 * @throws APIError (302 to the account page) when the person's deletion is postponed.
 */
export async function prepareAccountErasure(
  userId: string,
  actor: AccountErasureActor,
  deps: AccountErasureDeps = productionDeps
): Promise<void> {
  let owed: OwedProviderAccount[];
  try {
    owed = await deps.end(userId);
  } catch {
    if (actor === 'owner') throw postponed();
    deps.logError(
      '[account-erasure] Account removed without confirming its app sign-ins ended at the service',
      { actor, reason: 'cleanup_unavailable' }
    );
    return;
  }
  if (owed.length === 0) return;
  const now = deps.clock().getTime();
  if (
    actor === 'owner' &&
    owed.some((account) => now - account.owedSince.getTime() < ERASURE_STUCK_CLEANUP_MS)
  ) {
    throw postponed();
  }
  deps.logError(
    '[account-erasure] Account erased with app sign-ins still live at the service; delete them by hand',
    {
      actor,
      accounts: owed.map((account) => ({
        providerInstanceId: account.providerInstanceId,
        providerUserId: account.providerUserId,
        externalAccountRef: account.externalAccountRef,
        owedSince: account.owedSince.toISOString(),
      })),
    }
  );
}
